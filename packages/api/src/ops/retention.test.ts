import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { Router } from "../http/router.ts";
import { SYSTEM_CHAIN } from "../audit.ts";
import { clearJobRegistry, getJobDef } from "../jobs/registry.ts";
import { clearRecurringJobs, listRecurringJobs } from "../jobs/engine.ts";
import { registerOpsJobs } from "./jobs.ts";
import { purgeExpired, purgeWebhookPayloads } from "./retention.ts";

let app: TestApp;
const DAY = 86_400_000;
const q = <T = any>(sql: string, p: unknown[] = []) => app.db.owner.query(sql, p).then((r) => r.rows as T[]);
const mkUser = async (email: string) => (await q("insert into users (email, status, email_verified_at) values ($1,'active',now()) returning id", [email]))[0].id as string;
const ago = (days: number) => new Date(app.clock.now().getTime() - days * DAY);
const ahead = (days: number) => new Date(app.clock.now().getTime() + days * DAY);

beforeAll(async () => { app = await createTestApp(new Router()); }, 60_000);
afterAll(async () => { await app?.drop(); });
beforeEach(async () => {
  clearJobRegistry(); clearRecurringJobs();
  await q("delete from alerts; delete from webhook_events; delete from consents; delete from notices; delete from transfer_log; delete from renewal_mandates;");
  app.clock.set(new Date("2026-10-01T12:00:00Z"));
});

describe("C-19: retention purge by retain_until, never under legal_hold", () => {
  it("C-19: deletes expired rows without a hold in consents, notices, transfer_log and revoked mandates; keeps held, unexpired, live-mandate evidence and live mandates", async () => {
    const u = await mkUser("ret1@example.com");
    const d = (await q("insert into domains (user_id, fqdn_ascii, tld, registrar, livemode) values ($1,'ret-one.com','com','mock',false) returning id", [u]))[0].id;
    const consent = async (retain: Date, hold = false) => (await q("insert into consents (user_id, kind, document_hash, version, retain_until, legal_hold) values ($1,'terms','h','v',$2,$3) returning id", [u, retain, hold]))[0].id as string;
    const cGone = await consent(ago(1)); const cHeld = await consent(ago(1), true); const cLive = await consent(ahead(30)); const cEvidence = await consent(ago(1));
    const mandate = async (retain: Date, revoked: boolean, consentId: string | null, hold = false) =>
      (await q("insert into renewal_mandates (domain_id, user_id, price_ceiling_minor, text_hash, retain_until, revoked_at, consent_id, legal_hold) values ($1,$2,1000,'t',$3,$4,$5,$6) returning id",
        [d, u, retain, revoked ? ago(2) : null, consentId, hold]))[0].id as string;
    const mActive = await mandate(ago(1), false, cEvidence); const mRevoked = await mandate(ago(1), true, null); const mHeld = await mandate(ago(1), true, null, true);
    const notice = async (retain: Date, hold = false) => (await q("insert into notices (kind, user_id, template_version, retain_until, legal_hold) values ('renewal',$1,'v1',$2,$3) returning id", [u, retain, hold]))[0].id as string;
    const nGone = await notice(ago(1)); const nHeld = await notice(ago(400), true);
    const tl = async (retain: Date) => (await q("insert into transfer_log (user_id, direction, event, actor_kind, at, retain_until) values ($1,'out','requested','user',$2,$3) returning id", [u, ago(500), retain]))[0].id as string;
    const tGone = await tl(ago(1)); const tLive = await tl(ahead(1));

    const r = await purgeExpired(app.ctx);
    expect(r.deleted).toEqual({ consents: 1, notices: 1, transfer_log: 1, renewal_mandates: 1 });
    expect(r.held).toBe(3);
    const ids = async (t: string) => (await q(`select id from ${t}`)).map((x) => x.id).sort();
    expect(await ids("consents")).toEqual([cHeld, cLive, cEvidence].sort());
    expect(await ids("renewal_mandates")).toEqual([mActive, mHeld].sort());
    expect(await ids("notices")).toEqual([nHeld]);
    expect(await ids("transfer_log")).toEqual([tLive]);
    expect([cGone, mRevoked, nGone, tGone]).toHaveLength(4);

    // One system audit row with counts only (no ids), and a second run finds nothing more.
    const audit = await q("select action, detail from audit_log where chain_id = $1 and action = 'retention.expired' order by seq desc limit 1", [SYSTEM_CHAIN]);
    expect(audit[0].detail).toEqual({ consents: 1, notices: 1, transfer_log: 1, renewal_mandates: 1, held: 3 });
    expect((await purgeExpired(app.ctx)).deleted).toEqual({ consents: 0, notices: 0, transfer_log: 0, renewal_mandates: 0 });

    // Lifting the hold lets the next run delete the row; revoking the mandate releases its consent evidence.
    await q("update consents set legal_hold = false where id = $1", [cHeld]);
    await q("update renewal_mandates set revoked_at = $2 where id = $1", [mActive, ago(1)]);
    const r2 = await purgeExpired(app.ctx);
    expect(r2.deleted).toMatchObject({ consents: 2, renewal_mandates: 1 });
  });

  it("C-19: the consent behind a revoked mandate that is still kept (under legal hold, or before its own retain_until) is kept with it", async () => {
    const u = await mkUser("ret2@example.com");
    const d = (await q("insert into domains (user_id, fqdn_ascii, tld, registrar, livemode) values ($1,'ret-two.com','com','mock',false) returning id", [u]))[0].id;
    const consent = async () => (await q("insert into consents (user_id, kind, document_hash, version, retain_until) values ($1,'auto_renew_mandate','h','v',$2) returning id", [u, ago(1)]))[0].id as string;
    const cHeldMandate = await consent(); const cKeptMandate = await consent(); const cGoneMandate = await consent();
    const mandate = async (retain: Date, consentId: string, hold: boolean) =>
      (await q("insert into renewal_mandates (domain_id, user_id, price_ceiling_minor, text_hash, retain_until, revoked_at, consent_id, legal_hold) values ($1,$2,1000,'t',$3,$4,$5,$6) returning id",
        [d, u, retain, ago(2), consentId, hold]))[0].id as string;
    const mHeld = await mandate(ago(1), cHeldMandate, true); const mKept = await mandate(ahead(30), cKeptMandate, false); await mandate(ago(1), cGoneMandate, false);
    const r = await purgeExpired(app.ctx);
    expect(r.deleted).toMatchObject({ consents: 1, renewal_mandates: 1 });
    expect((await q("select id from consents")).map((x) => x.id).sort()).toEqual([cHeldMandate, cKeptMandate].sort());
    expect((await q("select id from renewal_mandates")).map((x) => x.id).sort()).toEqual([mHeld, mKept].sort());
  });

  it("C-19: a transfer_log row under legal hold survives its retain_until, and is purged once the hold is lifted", async () => {
    const u = await mkUser("ret-tl@example.com");
    const tl = async (retain: Date, hold: boolean) => (await q("insert into transfer_log (user_id, direction, event, actor_kind, at, retain_until, legal_hold) values ($1,'in','completed','system',$2,$3,$4) returning id", [u, ago(500), retain, hold]))[0].id as string;
    const held = await tl(ago(30), true); const gone = await tl(ago(30), false);
    expect((await q("select legal_hold from transfer_log where id = $1", [held]))[0].legal_hold).toBe(true);
    expect((await q("select legal_hold from transfer_log where id = $1", [gone]))[0].legal_hold).toBe(false);
    const r = await purgeExpired(app.ctx);
    expect(r.deleted.transfer_log).toBe(1);
    expect(r.held).toBe(1);
    expect((await q("select id from transfer_log")).map((x) => x.id)).toEqual([held]);
    // New rows default to no hold; lifting the hold lets the next run delete the row.
    await q("update transfer_log set legal_hold = false where id = $1", [held]);
    expect((await purgeExpired(app.ctx)).deleted.transfer_log).toBe(1);
    expect(await q("select id from transfer_log")).toEqual([]);
  });

  it("C-19: the retention jobs are registered on a daily schedule next to retention.purge", () => {
    registerOpsJobs();
    for (const k of ["retention.purge", "retention.expire", "retention.webhook_payloads"]) expect(getJobDef(k), k).toBeTruthy();
    expect(listRecurringJobs()).toEqual(expect.arrayContaining([{ kind: "retention.expire", everySec: 86_400 }, { kind: "retention.webhook_payloads", everySec: 86_400 }]));
  });
});

describe("C-19: webhook_events payload retention", () => {
  it("C-19: nulls processed payloads after 30 days and unprocessed ones after 90 (with a warning), and deletes rows after 180 days", async () => {
    const ev = async (id: string, receivedDaysAgo: number, processed: boolean) =>
      q("insert into webhook_events (provider, event_id, livemode, type, payload, received_at, processed_at) values ('stripe',$1,false,'payment_intent.succeeded',$2,$3,$4)",
        [id, { id, data: { object: { customer_details: { email: "buyer@example.com" } } } }, ago(receivedDaysAgo), processed ? ago(receivedDaysAgo) : null]);
    await ev("fresh", 10, true); await ev("old-done", 31, true); await ev("old-open", 31, false); await ev("stale-open", 91, false); await ev("ancient", 181, true);
    const r = await purgeWebhookPayloads(app.ctx);
    expect(r).toEqual({ payloadsCleared: 1, unprocessedCleared: 1, rowsDeleted: 1 });
    const rows = Object.fromEntries((await q("select event_id, payload is not null as has from webhook_events")).map((x) => [x.event_id, x.has]));
    expect(rows).toEqual({ fresh: true, "old-done": false, "old-open": true, "stale-open": false });
    expect((await q("select severity, detail from alerts where kind = 'webhook.unprocessed_expired'"))[0]).toEqual({ severity: "warn", detail: { count: 1 } });
    // The dedupe record survives the payload: a replay of a cleared event is still recognised.
    expect((await q("select count(*)::int n from webhook_events where event_id = 'old-done'"))[0].n).toBe(1);
    expect(await purgeWebhookPayloads(app.ctx)).toEqual({ payloadsCleared: 0, unprocessedCleared: 0, rowsDeleted: 0 });
  });
});
