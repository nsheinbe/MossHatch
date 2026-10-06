import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRegistrarPort } from "@mosshatch/registrar/mock-port";
import { RegistrarError } from "@mosshatch/registrar/port";
import { tx } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { Router } from "../http/router.ts";
import { clearJobRegistry, enqueue, registerJob } from "../jobs/registry.ts";
import { clearRecurringJobs, registerRecurringJob, runTick } from "../jobs/engine.ts";
import { transferPoll, transferPollJob } from "../domain-mgmt/transfer.ts";
import { anchorAudit, auditVerifyJob, MemoryAnchorSink } from "./anchor.ts";
import { autoSafeMode, raiseAlert } from "./alerts.ts";

// These use the real migrated PostgreSQL and cron role, not a SQL mock.
let app: TestApp;
let registrar: MockRegistrarPort;
const q = (sql: string, params: unknown[] = []) => app.db.owner.query(sql, params).then((r) => r.rows);
const staleAlert = () => raiseAlert(app.ctx, app.ctx.cron, { severity: "page", kind: "audit.anchor_stale", subject: "anchors" });
const openStale = () => q("select id from alerts where kind='audit.anchor_stale' and state='open'");

beforeAll(async () => { app = await createTestApp(new Router()); }, 60_000);
afterAll(async () => { await app?.drop(); });
beforeEach(async () => {
  vi.restoreAllMocks(); clearJobRegistry(); clearRecurringJobs();
  await q("delete from alerts; delete from jobs; delete from audit_anchors");
  await q("update flags set value='false'::jsonb where name='registrar_writes_paused'");
  await q("update flags set value='null'::jsonb where name='heartbeat.tick'");
  app.clock.set(new Date(Date.now() + 60_000));
  registrar = new MockRegistrarPort({ clock: app.clock });
  app.ctx.services = { domainMgmt: { registrar } };
});

describe("audit anchor freshness recovery", () => {
  it("an older startup verify snapshot cannot reopen stale after the external put and anchor commit", async () => {
    const sink = new MemoryAnchorSink();
    let read!: () => void, resume!: () => void;
    const readDone = new Promise<void>((resolve) => { read = resolve; });
    const proceed = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(sink, "list").mockImplementationOnce(async () => {
      const olderSnapshot = [...sink.items];
      read(); await proceed;
      return olderSnapshot;
    });
    const verifying = auditVerifyJob(app.ctx, sink);
    await readDone;
    try { await anchorAudit(app.ctx, sink); } finally { resume(); }
    const result = await verifying;
    expect(result.anchors.latestAnchorAt).toBeNull(); // Prove the stale external read finished last.
    expect(await q("select id from audit_anchors")).toHaveLength(1);
    expect(sink.items).toHaveLength(1);
    expect(await openStale()).toHaveLength(0);
    app.clock.advance(31 * 60_000);
    expect(await autoSafeMode(app.ctx)).toEqual({ engaged: false });
    expect((await q("select value from flags where name='registrar_writes_paused'"))[0]!.value).toBe(false);
  });

  it("a successful committed anchor closes only freshness, preserving the operator pause and integrity alerts", async () => {
    await staleAlert();
    await q("update flags set value='true'::jsonb where name='registrar_writes_paused'");
    for (const kind of ["audit.chain_broken", "audit.anchor_mismatch"]) {
      await raiseAlert(app.ctx, app.ctx.cron, { severity: "page", kind, subject: "anchors" });
    }
    await anchorAudit(app.ctx, new MemoryAnchorSink());
    expect(await openStale()).toHaveLength(0);
    expect(await q("select id from alerts where kind in ('audit.chain_broken','audit.anchor_mismatch') and state='open'")).toHaveLength(2);
    expect((await q("select value from flags where name='registrar_writes_paused'"))[0]!.value).toBe(true);
  });

  it("a failed external put never closes freshness", async () => {
    await staleAlert();
    const sink = new MemoryAnchorSink();
    vi.spyOn(sink, "put").mockRejectedValue(new Error("external_put_failed"));
    await expect(anchorAudit(app.ctx, sink)).rejects.toThrow("external_put_failed");
    expect(await openStale()).toHaveLength(1);
    expect(await q("select id from audit_anchors")).toHaveLength(0);
  });

  it("an external put whose anchor transaction rolls back never closes freshness", async () => {
    await staleAlert();
    const sink = new MemoryAnchorSink();
    const put = sink.put.bind(sink);
    vi.spyOn(sink, "put").mockImplementation(async (record) => {
      const stored = await put(record);
      vi.spyOn(app.ctx.kms, "hmac").mockRejectedValueOnce(new Error("anchor_commit_failed"));
      return stored;
    });
    await expect(anchorAudit(app.ctx, sink)).rejects.toThrow("anchor_commit_failed");
    expect(sink.items).toHaveLength(1);
    expect(await openStale()).toHaveLength(1);
    expect(await q("select id from audit_anchors")).toHaveLength(0);
  });

  it("a fresh valid external verification clears stale without changing pause or other alert states", async () => {
    const sink = new MemoryAnchorSink();
    await anchorAudit(app.ctx, sink); await staleAlert();
    await q("update flags set value='true'::jsonb where name='registrar_writes_paused'");
    await raiseAlert(app.ctx, app.ctx.cron, { severity: "page", kind: "audit.anchor_mismatch", subject: "anchors" });
    const verified = await auditVerifyJob(app.ctx, sink);
    expect(verified.anchors.ok).toBe(true);
    expect(verified.chains.failures).toEqual([]);
    expect(await openStale()).toHaveLength(0);
    expect(await q("select id from alerts where kind='audit.anchor_mismatch' and state='open'")).toHaveLength(1);
    expect((await q("select value from flags where name='registrar_writes_paused'"))[0]!.value).toBe(true);
  });

  it("a fresh but invalid external anchor cannot claim successful verification recovery", async () => {
    const sink = new MemoryAnchorSink();
    await anchorAudit(app.ctx, sink); await staleAlert();
    sink.items[0]!.anchorMac = "00";
    expect((await auditVerifyJob(app.ctx, sink)).anchors.ok).toBe(false);
    expect(await openStale()).toHaveLength(1);
    expect(await q("select id from alerts where kind='audit.anchor_mismatch' and state='open'")).toHaveLength(1);
  });

  it("a preexisting fresh database anchor cannot hide an empty different external sink", async () => {
    await anchorAudit(app.ctx, new MemoryAnchorSink());
    await staleAlert();
    const emptySink = new MemoryAnchorSink();
    const result = await auditVerifyJob(app.ctx, emptySink);
    expect(result.anchors.latestAnchorAt).toBeNull();
    expect(await openStale()).toHaveLength(1);
    await q("delete from alerts where kind='audit.anchor_stale'");
    await auditVerifyJob(app.ctx, emptySink);
    expect(await openStale()).toHaveLength(1);
  });
});

describe("definitely unsupported outbound transfer poll", () => {
  const unsupported = () => new RegistrarError("rejected", "not supported", { code: "transfers_away_unsupported", retryable: false, outcomeUnknown: false });

  it("completes recurring jobs once per attempt and keeps one warning rather than repeated retries or dead jobs", async () => {
    vi.spyOn(registrar, "getTransfersAway").mockRejectedValue(unsupported());
    registerJob({ kind: "transfer.poll", priority: 1, maxRuntimeSec: 45, handler: transferPollJob });
    registerRecurringJob({ kind: "transfer.poll", everySec: 300 });
    for (let i = 0; i < 12; i++) {
      const result = await runTick(app.ctx, { heartbeat: false, budgetMs: 5_000 });
      expect(result.done).toBe(1); expect(result.retried).toBe(0); expect(result.dead).toBe(0);
      app.clock.advance(5 * 60_000);
    }
    const jobs = await q("select state, attempts, last_error from jobs where kind='transfer.poll'");
    expect(jobs).toHaveLength(12);
    expect(jobs.every((j) => j.state === "done" && j.attempts === 1 && j.last_error === null)).toBe(true);
    expect(await q("select id from alerts where kind='transfer.poll_unsupported' and state='open' and severity='warn'")).toHaveLength(1);
    expect(await q("select id from alerts where kind='job.dead'")).toHaveLength(0);
  });

  it("does not mistake unsupported polling for an observed end of an existing transfer", async () => {
    const user = (await q("insert into users(email,status) values('unsupported-poll@example.test','active') returning id"))[0]!.id;
    const domain = (await q("insert into domains(user_id,fqdn_ascii,tld,registrar,livemode,state) values($1,'unsupported-poll.com','com','openprovider',false,'needs_attention') returning id", [user]))[0]!.id;
    const transfer = (await q("insert into domain_transfers_away(user_id,domain_id,upstream_status,requested_at,prev_domain_state) values($1,$2,'pending_registry',$3,'registered') returning id", [user, domain, app.clock.now()]))[0]!.id;
    await raiseAlert(app.ctx, app.ctx.cron, { severity: "page", kind: "transfer.unrequested", subject: domain });
    vi.spyOn(registrar, "getTransfersAway").mockRejectedValue(unsupported());
    const getDomain = vi.spyOn(registrar, "getDomain");
    expect(await transferPoll(app.ctx)).toEqual({ seen: 0, unrequested: 0, closed: 0 });
    expect(getDomain).not.toHaveBeenCalled();
    expect((await q("select state from domain_transfers_away where id=$1", [transfer]))[0]!.state).toBe("open");
    expect((await q("select state from domains where id=$1", [domain]))[0]!.state).toBe("needs_attention");
    expect(await q("select id from alerts where kind='transfer.unrequested' and subject=$1 and state='open'", [domain])).toHaveLength(1);
  });

  for (const [kind, retryable, outcomeUnknown, code] of [
    ["unavailable", true, false, "timeout"],
    ["rejected", false, false, "unauthorized"],
    ["rejected", true, false, "transfers_away_unsupported"],
    ["rejected", false, true, "transfers_away_unsupported"],
    ["unknown", false, false, "transfers_away_unsupported"],
  ] as const) {
    it(`preserves ${kind}/${code}/retry=${retryable}/unknown=${outcomeUnknown} as a genuine failure`, async () => {
      const error = new RegistrarError(kind, "provider failure", { retryable, outcomeUnknown, code });
      vi.spyOn(registrar, "getTransfersAway").mockRejectedValue(error);
      await expect(transferPoll(app.ctx)).rejects.toBe(error);
      registerJob({ kind: "transfer.poll", priority: 1, maxRuntimeSec: 45, handler: transferPollJob });
      await tx(app.ctx.cron, (c) => enqueue(c, { kind: "transfer.poll", payload: {}, runAt: app.clock.now() }));
      const result = await runTick(app.ctx, { heartbeat: false, budgetMs: 5_000 });
      expect(result.retried).toBe(1); expect(result.done).toBe(0);
      expect((await q("select state, attempts from jobs where kind='transfer.poll'"))[0]).toMatchObject({ state: "queued", attempts: 1 });
      expect(await q("select id from alerts where kind='transfer.poll_unsupported'")).toHaveLength(0);
    });
  }
});
