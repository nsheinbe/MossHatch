import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tx } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { Router } from "../http/router.ts";
import { appendAudit, SYSTEM_CHAIN, verifyChain } from "../audit.ts";
import { clearJobRegistry } from "../jobs/registry.ts";
import { clearRecurringJobs, runTick } from "../jobs/engine.ts";
import { anchorAudit, auditVerifyJob, FileAnchorSink, MemoryAnchorSink, S3ObjectLockAnchorSink, verifyAnchors, verifyAllChains, type AnchorRecord } from "./anchor.ts";
import { erasureHash, eraseUser, FileErasureLedger, MemoryErasureLedger, purgeFromLedger, recordErasure } from "./erasure.ts";
import { FakeCloudTrail } from "./kms-reconcile.ts";
import { registerOpsJobs } from "./jobs.ts";
import { FakeDns } from "../mail/dns.ts";

let app: TestApp; let tmp: string;
const HOUR = 3_600_000;
const q = <T = any>(sql: string, p: unknown[] = []) => app.db.owner.query(sql, p).then((r) => r.rows as T[]);
const append = (chain: string, action: string, detail: Record<string, unknown> = {}) =>
  tx(app.ctx.cron, (c) => appendAudit(app.ctx, c, { chainId: chain, actorKind: "system", action, detail }));
const mkUser = async (email: string) => (await q("insert into users (email, status, email_verified_at) values ($1,'active',now()) returning id", [email]))[0].id as string;
async function withoutAuditGuard<T>(fn: () => Promise<T>): Promise<T> {
  // What an attacker with superuser access has to do: switch the always-on triggers off first.
  for (const t of ["audit_no_update", "audit_no_delete"]) await q(`alter table audit_log disable trigger ${t}`);
  try { return await fn(); } finally { for (const t of ["audit_no_update", "audit_no_delete"]) await q(`alter table audit_log enable always trigger ${t}`); }
}

beforeAll(async () => { app = await createTestApp(new Router()); tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-audit-")); }, 60_000);
afterAll(async () => { await app?.drop(); fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(async () => {
  clearJobRegistry(); clearRecurringJobs();
  await q("delete from alerts; delete from jobs; delete from audit_anchors; delete from flags where name like 'audit.%';");
  app.clock.set(new Date("2026-10-01T12:00:00Z"));
});

describe("audit anchors", () => {
  it("anchors every chain head with a KMS MAC, writes the sink first, and the sink refuses to overwrite", async () => {
    const u1 = await mkUser("a1@example.com");
    await append(u1, "x.one"); await append(u1, "x.two"); await append(SYSTEM_CHAIN, "sys.one");
    const dir = path.join(tmp, "sink1"); const sink = new FileAnchorSink(dir);
    const rec = await anchorAudit(app.ctx, sink);
    expect(rec.heads.find((h) => h.chain_id === u1)!.seq).toBe(2);
    expect(rec.anchorMac).toMatch(/^[0-9a-f]{64}$/);
    const row = (await q("select * from audit_anchors where id = $1", [rec.id]))[0];
    expect(row.external_ref).toMatch(/^file:/);
    expect(Buffer.from(row.anchor_mac).toString("hex")).toBe(rec.anchorMac);
    expect((await sink.list()).map((a) => a.id)).toEqual([rec.id]);
    const file = fs.readdirSync(dir)[0]!;
    expect(fs.statSync(path.join(dir, file)).mode & 0o222).toBe(0);                // read-only
    await expect(sink.put(rec)).rejects.toThrow(/EEXIST/);                          // write-once
    expect((await q("select action from audit_log where chain_id = $1 and action = 'audit.anchor'", [SYSTEM_CHAIN])).length).toBe(1);
  });
  it("verifies clean, and reports rows past the anchor as unanchored rather than as an error", async () => {
    const u = await mkUser("a2@example.com"); const sink = new MemoryAnchorSink();
    await append(u, "a"); await anchorAudit(app.ctx, sink);
    await append(u, "b"); await append(u, "c"); await append(SYSTEM_CHAIN, "s");
    const v = await verifyAnchors(app.ctx, sink);
    expect(v.ok).toBe(true); expect(v.tampered).toEqual([]);
    expect(v.unanchored.rows).toBeGreaterThanOrEqual(3);
  });
  it("ST-142: chain verification detects a truncated tail against the anchor, even when the heads row is truncated to match", async () => {
    const u = await mkUser("a3@example.com"); const sink = new MemoryAnchorSink();
    for (const a of ["a", "b", "c", "d"]) await append(u, a);
    await anchorAudit(app.ctx, sink);
    await withoutAuditGuard(async () => {
      await q("delete from audit_log where chain_id = $1 and seq > 2", [u]);
    });
    // Log truncated, heads row left alone: the two disagree.
    let v = await verifyAnchors(app.ctx, sink);
    expect(v.ok).toBe(false);
    expect(v.tampered.map((f) => f.kind)).toEqual(expect.arrayContaining(["truncated", "head_mismatch"]));
    // A tidy attacker fixes the heads row too. The chain then verifies on its own, and only the anchor catches it.
    const tail = (await q("select mac from audit_log where chain_id = $1 and seq = 2", [u]))[0];
    await q("update audit_heads set seq = 2, head_mac = $2 where chain_id = $1", [u, tail.mac]);
    const own = await tx(app.ctx.cron, (c) => verifyChain(app.ctx, c, u));
    expect(own).toEqual({ ok: true, length: 2 });
    v = await verifyAnchors(app.ctx, sink);
    expect(v.ok).toBe(false);
    expect(v.tampered).toContainEqual(expect.objectContaining({ kind: "truncated", chainId: u, anchoredSeq: 4, presentSeq: 2 }));
    // The job alerts.
    await auditVerifyJob(app.ctx, sink);
    expect((await q("select severity from alerts where kind = 'audit.anchor_mismatch'"))[0].severity).toBe("page");
  });
  it("detects an edited row (MAC mismatch), a forged anchor file and a missing chain", async () => {
    const u = await mkUser("a4@example.com"); const u2 = await mkUser("a5@example.com"); const sink = new MemoryAnchorSink();
    await append(u, "a"); await append(u, "b"); await append(u2, "z");
    await anchorAudit(app.ctx, sink);
    await withoutAuditGuard(async () => { await q("update audit_log set action = 'edited' where chain_id = $1 and seq = 2", [u]); });
    const chains = await verifyAllChains(app.ctx);
    expect(chains.failures).toContainEqual(expect.objectContaining({ chainId: u, badSeq: 2, reason: "mac" }));
    // Forged anchor: heads changed after signing.
    const forged: AnchorRecord = JSON.parse(JSON.stringify((await sink.list())[0]));
    forged.heads[0]!.seq += 1; forged.id = "00000000-0000-4000-8000-000000000001";
    const s2 = new MemoryAnchorSink(); await s2.put(forged);
    expect((await verifyAnchors(app.ctx, s2)).tampered).toContainEqual({ kind: "anchor_mac", anchorId: forged.id });
    // Missing chain.
    await withoutAuditGuard(async () => { await q("delete from audit_log where chain_id = $1", [u2]); });
    await q("delete from audit_heads where chain_id = $1", [u2]);
    expect((await verifyAnchors(app.ctx, sink)).tampered).toContainEqual(expect.objectContaining({ kind: "chain_missing", chainId: u2 }));
  });
  it("a restore event on the system chain turns anchors newer than the restore point into the expected gap, not tampering; older ones still count", async () => {
    const u = await mkUser("a6@example.com"); const sink = new MemoryAnchorSink();
    await append(u, "a"); app.clock.advance(HOUR);
    const older = await anchorAudit(app.ctx, sink);
    await append(u, "b"); app.clock.advance(HOUR);
    const restoredTo = app.clock.now();                                              // "restore to T"
    await append(u, "c"); app.clock.advance(HOUR);
    const newer = await anchorAudit(app.ctx, sink);
    await withoutAuditGuard(async () => { await q("delete from audit_log where chain_id = $1 and seq > 2", [u]); });
    await q("update audit_heads set seq = 2, head_mac = (select mac from audit_log where chain_id = $1 and seq = 2) where chain_id = $1", [u]);
    expect((await verifyAnchors(app.ctx, sink)).ok).toBe(false);                     // unexplained
    await append(SYSTEM_CHAIN, "restore", { restored_to: restoredTo.toISOString() });
    const v = await verifyAnchors(app.ctx, sink);
    expect(v.tampered.filter((f) => f.kind !== "head_mismatch")).toEqual([]);
    expect(v.expectedGap.map((f) => (f as any).anchorId)).toContain(newer.id);
    expect(v.expectedGap.map((f) => (f as any).anchorId)).not.toContain(older.id);
  });
  it("audit.verify alerts when the newest anchor is older than 25 hours or missing", async () => {
    const sink = new MemoryAnchorSink();
    await auditVerifyJob(app.ctx, sink);
    expect((await q("select severity from alerts where kind = 'audit.anchor_stale'"))).toHaveLength(1);
    await q("delete from alerts");
    await anchorAudit(app.ctx, sink);
    app.clock.advance(24 * HOUR); await auditVerifyJob(app.ctx, sink);
    expect(await q("select 1 from alerts where kind = 'audit.anchor_stale'")).toHaveLength(0);
    app.clock.advance(2 * HOUR); await auditVerifyJob(app.ctx, sink);
    expect(await q("select 1 from alerts where kind = 'audit.anchor_stale'")).toHaveLength(1);
  });
  it("the S3 Object Lock sink builds write-once requests (fake client; the real bucket is unproven)", async () => {
    const puts: any[] = []; const store = new Map<string, string>();
    const sink = new S3ObjectLockAnchorSink({
      putObject: async (p) => { puts.push(p); store.set(p.Key, p.Body); }, listKeys: async () => [...store.keys()], getObject: async (p) => store.get(p.Key)!,
    }, "log-archive", 365, () => new Date("2026-10-01T00:00:00Z"));
    const rec = { v: 1 as const, id: "id1", anchoredAt: "2026-10-01T00:00:00.000Z", heads: [], anchorMac: "00" };
    await sink.put(rec);
    expect(puts[0]).toMatchObject({ Bucket: "log-archive", IfNoneMatch: "*", ObjectLockMode: "COMPLIANCE" });
    expect(puts[0].ObjectLockRetainUntilDate.toISOString()).toBe("2027-10-01T00:00:00.000Z");
    expect(await sink.list()).toEqual([rec]);
  });
  it("the tick schedules the daily audit jobs once and they run with the injected services", async () => {
    registerOpsJobs();
    const sink = new MemoryAnchorSink(); const ct = new FakeCloudTrail();
    app.ctx.services = { anchorSink: sink, cloudTrail: ct, erasureLedger: new MemoryErasureLedger(), dnsResolver: new FakeDns() };
    try {
      const r1 = await runTick(app.ctx, { budgetMs: 10_000 });
      expect(r1.scheduled).toBe(8); expect(r1.done).toBe(8);
      expect(sink.items).toHaveLength(1);
      const r2 = await runTick(app.ctx, { budgetMs: 10_000 });
      expect(r2.scheduled).toBe(0); expect(sink.items).toHaveLength(1);
      app.clock.advance(24 * HOUR);
      await runTick(app.ctx, { budgetMs: 10_000 });
      expect(sink.items).toHaveLength(2);
      expect((await q("select count(*)::int as n from jobs where state = 'dead'"))[0].n).toBe(0);
    } finally { app.ctx.services = {}; }
  });
  it("a job without its service fails, retries and finally pages rather than passing silently", async () => {
    registerOpsJobs();
    await runTick(app.ctx, { budgetMs: 5_000 });                                       // no services wired
    expect((await q("select count(*)::int as n from jobs where state = 'queued' and attempts = 1"))[0].n).toBe(5);
    expect((await q("select distinct last_error from jobs where last_error is not null"))[0].last_error).toBe("MissingServiceError");
  });
});

describe("erasure ledger and purge", () => {
  it("erases identifying rows, keeps the audit chain valid, is idempotent, and leaves other users alone", async () => {
    const a = await mkUser("er1@example.com"); const b = await mkUser("er2@example.com");
    for (const u of [a, b]) {
      await q("insert into notification_addresses (user_id, address, kind, verified_at) values ($1,'x@example.com','login',now())", [u]);
      await q("insert into contacts (user_id, fields_enc) values ($1,'{}')", [u]);
      await q("insert into passkeys (user_id, credential_id, public_key, alg, backup_eligible, backup_state) values ($1,$2,'\\x00',-7,false,false)", [u, "cred-" + u]);
      await append(u, "thing");
    }
    expect((await eraseUser(app.ctx, a)).erased).toBe(true);
    expect((await eraseUser(app.ctx, a)).erased).toBe(false);
    const u = (await q("select email::text as email, status from users where id = $1", [a]))[0];
    expect(u.status).toBe("purged"); expect(u.email).toMatch(/@erased\.invalid$/); expect(u.email).not.toContain("er1");
    for (const t of ["notification_addresses", "contacts", "passkeys"]) expect((await q(`select count(*)::int as n from ${t} where user_id = $1`, [a]))[0].n).toBe(0);
    expect((await q("select status from users where id = $1", [b]))[0].status).toBe("active");
    expect((await q("select count(*)::int as n from contacts where user_id = $1", [b]))[0].n).toBe(1);
    expect(await tx(app.ctx.cron, (c) => verifyChain(app.ctx, c, a))).toMatchObject({ ok: true, length: 2 });
    expect((await q("select action, detail from audit_log where chain_id = $1 order by seq desc limit 1", [a]))[0]).toEqual({ action: "account.erased", detail: { via: "purge" } });
  });
  it("the ledger holds hashes, not ids, and purgeFromLedger re-applies erasures to a database that lost them", async () => {
    const a = await mkUser("er3@example.com"); const ledger = new MemoryErasureLedger();
    await recordErasure(ledger, a, app.clock.now());
    expect(JSON.stringify(ledger.items)).not.toContain(a);
    expect(ledger.items[0]!.userHash).toBe(erasureHash(a));
    expect(await purgeFromLedger(app.ctx, ledger)).toEqual({ ledgerEntries: 1, erased: 1 });
    expect(await purgeFromLedger(app.ctx, ledger)).toEqual({ ledgerEntries: 1, erased: 0 });
  });
  it("the file ledger appends and survives reopening", async () => {
    const f = path.join(tmp, "ledger", "l.jsonl");
    const l1 = new FileErasureLedger(f); await recordErasure(l1, "11111111-1111-4111-8111-111111111111", new Date(0));
    const l2 = new FileErasureLedger(f); await recordErasure(l2, "22222222-2222-4222-8222-222222222222", new Date(0));
    expect((await new FileErasureLedger(f).list()).length).toBe(2);
  });
});

