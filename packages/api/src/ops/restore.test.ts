import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { tx } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { appendAudit, SYSTEM_CHAIN } from "../audit.ts";
import { anchorAudit, FileAnchorSink } from "./anchor.ts";
import { eraseUser, FileErasureLedger, MemoryErasureLedger, recordErasure } from "./erasure.ts";
import { restoreDrill, DEFAULT_PG_BIN } from "./restore.ts";

const exec = promisify(execFile);
const HOUR = 3_600_000;
let app: TestApp; let tmp: string;
const q = <T = any>(sql: string, p: unknown[] = []) => app.db.owner.query(sql, p).then((r) => r.rows as T[]);
const append = (chain: string, action: string, detail: Record<string, unknown> = {}) =>
  tx(app.ctx.cron, (c) => appendAudit(app.ctx, c, { chainId: chain, actorKind: "system", action, detail }));
const mkUser = async (email: string) => (await q("insert into users (email, status, email_verified_at) values ($1,'active',now()) returning id", [email]))[0].id as string;
async function withoutAuditGuard<T>(fn: () => Promise<T>): Promise<T> {
  for (const t of ["audit_no_update", "audit_no_delete"]) await q(`alter table audit_log disable trigger ${t}`);
  try { return await fn(); } finally { for (const t of ["audit_no_update", "audit_no_delete"]) await q(`alter table audit_log enable always trigger ${t}`); }
}

// Each drill test gets its own database: a drill must fail on a damaged chain, so no test may leave one behind for the next.
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-drill-")); });
afterAll(async () => { await app?.drop(); fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(async () => { if (app) await app.drop(); app = await createTestApp(); app.clock.set(new Date("2026-10-01T12:00:00Z")); }, 60_000);

describe("restore drill (real pg_dump and pg_restore against the local cluster)", () => {
  async function scenario() {
    const u1 = await mkUser(`d1-${Math.random()}@example.com`); const u2 = await mkUser(`d2-${Math.random()}@example.com`);
    for (const u of [u1, u2]) {
      await q("insert into notification_addresses (user_id, address, kind, verified_at) values ($1,'d@example.com','login',now())", [u]);
      await q("insert into contacts (user_id, fields_enc) values ($1,'{}')", [u]);
    }
    for (const a of ["one", "two", "three"]) { await append(u1, a); await append(u2, a); }
    await append(SYSTEM_CHAIN, "boot");
    app.clock.advance(HOUR);
    const sink = new FileAnchorSink(path.join(tmp, "drill-sink-" + Math.random().toString(36).slice(2)));
    const anchorA = await anchorAudit(app.ctx, sink);
    await append(u1, "after-anchor-A"); await append(u2, "after-anchor-A");
    return { u1, u2, sink, anchorA };
  }
  const dumpNow = async (file: string) => { await exec(path.join(DEFAULT_PG_BIN, "pg_dump"), ["--format=custom", "--no-owner", "--file", file, app.db.urlFor("owner")]); };

  it("ST-143 and ST-152: restores a backup into a scratch database, sees the expected gap against the newer anchor, re-runs the purge from the external ledger, and records the time", async () => {
    const { u1, u2, sink, anchorA } = await scenario();
    app.clock.advance(HOUR);
    const backupTakenAt = app.clock.now();
    const dump = path.join(tmp, "backup.dump"); await dumpNow(dump);               // "last night's off-Neon backup"
    // Life goes on after the backup: more audit rows, a newer anchor, and u2 is erased (ledger outside the database).
    await append(u1, "after-backup"); app.clock.advance(HOUR);
    const anchorB = await anchorAudit(app.ctx, sink);
    const ledger = new FileErasureLedger(path.join(tmp, "ledger-" + Math.random() + ".jsonl"));
    await recordErasure(ledger, u2, app.clock.now()); await eraseUser(app.ctx, u2);

    const logPath = path.join(tmp, "restore-drill-log.md");
    const r = await restoreDrill({ sourceUrl: app.db.urlFor("owner"), ledger, sink, kms: app.ctx.kms, clock: app.clock, workDir: tmp, logPath, label: "test", dumpFile: dump, backupTakenAt, keepScratch: true });
    try {
      expect(r.ok, JSON.stringify({ c: r.chains, a: r.anchors, r: r.resurrected })).toBe(true);
      expect(r.chains.failures).toEqual([]);
      expect(r.anchors.tampered).toEqual([]);
      // The restored database lacks what anchor B recorded for u1: reported as the expected gap.
      expect(r.anchors.expectedGap.length).toBeGreaterThan(0);
      expect(r.anchors.expectedGap.map((f: any) => f.anchorId)).toEqual(expect.arrayContaining([anchorB.id]));
      expect(r.anchors.expectedGap.map((f: any) => f.anchorId)).not.toContain(anchorA.id);
      expect(r.anchors.unanchored.rows).toBeGreaterThan(0);                          // rows after anchor A that made it into the backup
      // The erasure was replayed against the restored copy, which still had u2 alive.
      expect(r.purge).toEqual({ ledgerEntries: 1, erased: 1 });
      expect(r.resurrected).toBe(0);
      const scratch = new pg.Client({ connectionString: new URL(app.db.urlFor("owner")).toString().replace(/\/[^/]*$/, "/" + r.scratchDb) });
      await scratch.connect();
      try {
        expect((await scratch.query("select status from users where id = $1", [u2])).rows[0].status).toBe("purged");
        expect((await scratch.query("select count(*)::int as n from notification_addresses where user_id = $1", [u2])).rows[0].n).toBe(0);
        expect((await scratch.query("select status from users where id = $1", [u1])).rows[0].status).toBe("active");
      } finally { await scratch.end(); }
      expect(r.steps.map((s) => s.name)).toEqual(["create_scratch", "restore", "restore_event", "purge_from_ledger", "verify_chains", "verify_anchors"]);
      expect(r.totalMs).toBeGreaterThan(0); expect(r.withinTargets).toEqual({ reads: true, writes: true });
      const log = fs.readFileSync(logPath, "utf8");
      expect(log).toContain("| Date | Label |"); expect(log.trim().split("\n").at(-1)).toMatch(/\| test \| \d+\.\d s \|.*\| pass \|$/);
    } finally {
      const a = new pg.Client({ connectionString: app.db.urlFor("owner") }); await a.connect();
      await a.query(`drop database if exists "${r.scratchDb}" with (force)`); await a.end();
    }
  }, 120_000);

  it("ST-152: runs pg_dump itself, and a missing row before the anchor is reported as tampering (drill fails)", async () => {
    const { u1, sink } = await scenario();
    // Someone removes u1's newest row that anchor A covered, then a backup is taken of the tampered database.
    await withoutAuditGuard(async () => { await q("delete from audit_log where chain_id = $1 and seq = 3", [u1]); });
    await q("update audit_heads set seq = 2, head_mac = (select mac from audit_log where chain_id = $1 and seq = 2) where chain_id = $1", [u1]);
    await q("delete from audit_log where chain_id = $1 and seq > 3", [u1]).catch(() => undefined);
    const r = await restoreDrill({ sourceUrl: app.db.urlFor("owner"), ledger: new MemoryErasureLedger(), sink, kms: app.ctx.kms, clock: app.clock, workDir: tmp, label: "tamper" });
    expect(r.steps[0]!.name).toBe("dump");
    expect(r.ok).toBe(false);
    expect(r.anchors.tampered.map((f) => f.kind)).toContain("truncated");
    expect(r.logLine).toContain("FAIL");
  }, 120_000);

  it("the CLI script runs the drill end to end (Node type transform) and writes the log line", async () => {
    const { sink: _s } = await scenario();
    const ledgerFile = path.join(tmp, "cli-ledger.jsonl"); const log = path.join(tmp, "cli-log.md"); const anchors = path.join(tmp, "cli-anchors");
    const cliSink = new FileAnchorSink(anchors); await anchorAudit(app.ctx, cliSink);
    const script = path.resolve(import.meta.dirname, "../../../../scripts/ops-restore-drill.mjs");
    const { stdout } = await exec(process.execPath, [script, "--label", "cli"], { env: { ...process.env, MH_DRILL_SOURCE_URL: app.db.urlFor("owner"), MH_ANCHOR_DIR: anchors, MH_ERASURE_LEDGER: ledgerFile, MH_DRILL_LOG: log } });
    const out = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(out).toMatchObject({ ok: true, resurrected: 0, tampered: 0 });
    expect(fs.readFileSync(log, "utf8")).toContain("| cli |");
  }, 120_000);
});
