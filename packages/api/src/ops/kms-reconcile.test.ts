import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tx } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { Router } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { clearJobRegistry } from "../jobs/registry.ts";
import { clearRecurringJobs, listRecurringJobs, runTick } from "../jobs/engine.ts";
import { MemoryAnchorSink } from "./anchor.ts";
import { MemoryErasureLedger } from "./erasure.ts";
import { FakeDns } from "../mail/dns.ts";
import { registerOpsJobs } from "./jobs.ts";
import {
  AUDIT_SETTLE_MS, CloudTrailLookupEvents, FakeCloudTrail, KMS_RECONCILE_EVERY_SEC, kmsReconcile, parseCloudTrailDecrypt, UNAUDITED_ALERT_TARGET_MS, type KmsDecryptEvent,
} from "./kms-reconcile.ts";

let app: TestApp;
const MIN = 60_000;
const q = <T = any>(sql: string, p: unknown[] = []) => app.db.owner.query(sql, p).then((r) => r.rows as T[]);
const mkUser = async (email: string) => (await q("insert into users (email, status, email_verified_at) values ($1,'active',now()) returning id", [email]))[0].id as string;
/** What the vault writes before it calls Decrypt: the row id that is in the original encryption context. */
// Written through the owner pool: in production only the vault role may insert `secret.read` rows (0800 trigger, ST-12).
const auditRead = (chain: string, rowId: string, action = "secret.read") =>
  tx(app.db.owner, (c) => appendAudit(app.ctx, c, { chainId: chain, actorKind: "agent", action, resourceKind: "secret", resourceId: rowId, detail: { decrypt_nonce: rowId } }));
/** A CloudTrail Decrypt record as the vault's calls produce it: the context is exactly the one used at GenerateDataKey. */
const decrypt = (id: string, rowId: string | null, at: Date, extra: Partial<KmsDecryptEvent> = {}): KmsDecryptEvent => ({
  eventId: id, at, keyId: "arn:aws:kms:us-east-1:111122223333:key/vault-prod", principal: "arn:aws:sts::111122223333:assumed-role/vault-prod/web",
  encryptionContext: rowId ? { app: "mosshatch-nest", env: "prod", owner_id: "owner-1", secret_id: rowId } : { app: "mosshatch-nest" }, ...extra,
});

beforeAll(async () => { app = await createTestApp(new Router()); }, 60_000);
afterAll(async () => { await app?.drop(); });
beforeEach(async () => {
  clearJobRegistry(); clearRecurringJobs();
  await q("delete from alerts; delete from jobs; delete from kms_reconcile_events; delete from flags where name like 'audit.%';");
  app.clock.set(new Date("2026-10-01T12:00:00Z"));
});

describe("ST-10: KMS reconcile under real KMS semantics (token from the original encryption context, one audit row per Decrypt)", () => {
  it("ST-10: one legitimate read covers exactly one Decrypt: a replay of the same row, an unknown row and a context without the token page; failed calls are ignored", async () => {
    const u = await mkUser("kms1@example.com");
    const t0 = app.clock.now();
    await auditRead(u, "row-a");
    const ct = new FakeCloudTrail();
    ct.events = [
      decrypt("e1", "row-a", new Date(t0.getTime() + 1_000)),                        // the audited read
      decrypt("e2", "row-a", new Date(t0.getTime() + 2_000)),                        // same row, same minute, no second audit row
      decrypt("e3", "row-b", new Date(t0.getTime() + 3_000)),                        // a row nobody read through the vault
      decrypt("e4", null, new Date(t0.getTime() + 4_000)),                           // no reconcile token in the context at all
      decrypt("e5", "row-c", new Date(t0.getTime() + 5_000), { errorCode: "AccessDeniedException" }),   // failed: nothing decrypted
    ];
    app.clock.advance(10 * MIN);
    const r = await kmsReconcile(app.ctx, ct);
    expect(r.events).toBe(4);
    expect(r.unaudited).toEqual(["e2", "e3", "e4"]);
    const page = (await q("select severity, detail from alerts where kind = 'kms.decrypt_unaudited'"))[0];
    expect(page.severity).toBe("page");
    expect(page.detail.count).toBe(3);
    // Event ids and counts only: no context value (owner or row id) reaches the alert.
    expect(JSON.stringify(page.detail)).not.toMatch(/row-|owner-1/);
    expect((await q("select state, audit_seq from kms_reconcile_events where event_id = 'e1'"))[0]).toMatchObject({ state: "matched" });

    // Judged once by eventID: the same trail again changes nothing.
    const again = await kmsReconcile(app.ctx, ct);
    expect(again).toEqual({ events: 0, unaudited: [], auditWithoutEvent: 0 });

    // A later audited read of the same row consumes a NEW audit row; the already-used one is never reused.
    await auditRead(u, "row-a");
    ct.events.push(decrypt("e6", "row-a", new Date(app.clock.now().getTime() + 500)), decrypt("e7", "row-a", new Date(app.clock.now().getTime() + 900)));
    app.clock.advance(5 * MIN);
    const third = await kmsReconcile(app.ctx, ct);
    expect(third.unaudited).toEqual(["e7"]);
    expect((await q("select count(*)::int n from kms_reconcile_events where state = 'matched'"))[0].n).toBe(2);
  });

  it("ST-10 and ST-12: a row with the right token under an action the app role can write does not cover a Decrypt", async () => {
    const u = await mkUser("kms4@example.com");
    const t0 = app.clock.now();
    await tx(app.ctx.cron, (c) => appendAudit(app.ctx, c, { chainId: u, actorKind: "system", action: "pii.decrypt", detail: { decrypt_nonce: "row-forged" } }));
    const ct = new FakeCloudTrail();
    ct.events = [decrypt("forged", "row-forged", new Date(t0.getTime() + 1_000))];
    app.clock.advance(10 * MIN);
    expect((await kmsReconcile(app.ctx, ct)).unaudited).toEqual(["forged"]);
  });

  it("ST-10: an audit row must precede its Decrypt by at most 5 minutes (it commits before KMS is called); an older row does not cover a later Decrypt", async () => {
    const u = await mkUser("kms2@example.com");
    const t0 = app.clock.now();
    await auditRead(u, "row-old");
    const ct = new FakeCloudTrail();
    ct.events = [decrypt("late", "row-old", new Date(t0.getTime() + 20 * MIN))];
    app.clock.advance(25 * MIN);
    expect((await kmsReconcile(app.ctx, ct)).unaudited).toEqual(["late"]);
  });

  it("ST-10: an audited read whose Decrypt never reaches CloudTrail within 30 minutes warns once (trail late, or excluding KMS events)", async () => {
    app.clock.set(new Date("2026-10-03T12:00:00Z"));                                    // clear of the other tests' (immutable) audit rows
    const u = await mkUser("kms3@example.com");
    await auditRead(u, "row-ghost");
    const ct = new FakeCloudTrail();
    app.clock.advance(10 * MIN);
    expect((await kmsReconcile(app.ctx, ct)).auditWithoutEvent).toBe(0);                // not settled yet
    app.clock.advance(AUDIT_SETTLE_MS);
    expect((await kmsReconcile(app.ctx, ct)).auditWithoutEvent).toBe(1);
    expect((await q("select severity from alerts where kind = 'kms.audit_without_event'"))[0].severity).toBe("warn");
    app.clock.advance(5 * MIN);
    expect((await kmsReconcile(app.ctx, ct)).auditWithoutEvent).toBe(0);                // each row is checked once
  });

  it("ST-10: through the scheduler, an unmatched Decrypt delivered 5 minutes late pages within the 15-minute target", async () => {
    registerOpsJobs();
    expect(listRecurringJobs()).toEqual(expect.arrayContaining([{ kind: "audit.kms_reconcile", everySec: KMS_RECONCILE_EVERY_SEC }]));
    const ct = new FakeCloudTrail({ clock: app.clock, lagMs: 5 * MIN });
    app.ctx.services = { anchorSink: new MemoryAnchorSink(), cloudTrail: ct, erasureLedger: new MemoryErasureLedger(), dnsResolver: new FakeDns() };
    try {
      await runTick(app.ctx, { budgetMs: 10_000 });               // the daily jobs run once; the reconcile starts its 5-minute rhythm
      app.clock.advance(2 * MIN + 17_000);                        // an arbitrary phase against the schedule
      const at = app.clock.now();
      ct.events.push(decrypt("rogue", "row-x", at));
      let pagedAfter: number | null = null;
      for (let i = 0; i < 30 && pagedAfter === null; i++) {
        app.clock.advance(MIN);
        await runTick(app.ctx, { budgetMs: 10_000 });
        if ((await q("select 1 from alerts where kind = 'kms.decrypt_unaudited' and state = 'open'")).length) pagedAfter = app.clock.now().getTime() - at.getTime();
      }
      expect(pagedAfter).not.toBeNull();
      expect(pagedAfter!).toBeLessThanOrEqual(UNAUDITED_ALERT_TARGET_MS);
      expect(pagedAfter!).toBeGreaterThanOrEqual(5 * MIN);          // not before CloudTrail delivered it
    } finally { app.ctx.services = {}; }
  });

  it("the CloudTrail LookupEvents adapter signs, filters on Decrypt, paginates and parses (fake fetch: the real API is unproven)", async () => {
    const record = (id: string, src = "kms.amazonaws.com", name = "Decrypt") => JSON.stringify({
      eventID: id, eventTime: "2026-10-01T11:58:00Z", eventSource: src, eventName: name, userIdentity: { arn: "arn:aws:sts::1:assumed-role/vault-prod/web" },
      requestParameters: { encryptionContext: { app: "mosshatch-nest", env: "prod", owner_id: "o", secret_id: "row-1" }, encryptionAlgorithm: "SYMMETRIC_DEFAULT" },
      resources: [{ type: "AWS::KMS::Key", ARN: "arn:aws:kms:us-east-1:1:key/k" }],
    });
    const calls: { headers: Record<string, string>; body: any }[] = [];
    const pages = [{ Events: [{ CloudTrailEvent: record("a") }, { CloudTrailEvent: record("x", "sts.amazonaws.com", "AssumeRole") }], NextToken: "p2" }, { Events: [{ CloudTrailEvent: record("b") }] }];
    const ct = new CloudTrailLookupEvents({
      region: "us-east-1", clock: app.clock, credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" }),
      fetch: async (_url, init) => { calls.push({ headers: init.headers, body: JSON.parse(init.body) }); return { status: 200, text: async () => JSON.stringify(pages[calls.length - 1]) }; },
    });
    const evs = await ct.listDecryptEvents(new Date("2026-10-01T11:00:00Z"), new Date("2026-10-01T12:00:00Z"));
    expect(evs.map((e) => e.eventId)).toEqual(["a", "b"]);
    expect(evs[0]).toMatchObject({ keyId: "arn:aws:kms:us-east-1:1:key/k", encryptionContext: { secret_id: "row-1" }, errorCode: null });
    expect(calls[0]!.headers["x-amz-target"]).toBe("com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.LookupEvents");
    expect(calls[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/cloudtrail\/aws4_request/);
    expect(calls[0]!.body.LookupAttributes).toEqual([{ AttributeKey: "EventName", AttributeValue: "Decrypt" }]);
    expect(calls[1]!.body.NextToken).toBe("p2");
    expect(parseCloudTrailDecrypt("not json")).toBeNull();
    expect(() => new CloudTrailLookupEvents({ region: "", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), fetch: async () => ({ status: 200, text: async () => "{}" }) })).toThrow();
  });
});
