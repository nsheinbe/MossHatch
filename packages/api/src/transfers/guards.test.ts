import { afterEach, describe, expect, it, vi } from "vitest";
import { TRANSFER_REVIEW_MS } from "@mosshatch/registrar/mock-port";
import { harnessPerTest, mailOf } from "../domains/testkit.ts";
import { orderRow } from "../orders/testkit.ts";
import { installTransfers } from "./eligibility.ts";
import { CODE, cancel, confirm, confirmCodeOf, makeOwner, ownerWithContact, pass, rescueAndPay, startRescue, transferRow, type TH } from "./testkit.ts";

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });
const DAY = 86_400_000;
const make = async () => per.make() as Promise<TH>;
const counts = async (h: TH) => (await h.app.db.owner.query("select (select count(*)::int from transfers_in) t, (select count(*)::int from orders where kind = 'transfer_in') o")).rows[0];

describe("ST-126: Rescue applies screening and velocity limits, runs the pre-transfer check, asks the registrant email to confirm, never stores a card, and refuses when a DS record needs removal", () => {
  it("the pre-transfer check refuses with a plain reason (and the date for the 60-day rules), and nothing is written or sent", async () => {
    const h = await make();
    const a = await makeOwner(h, "st126-check@example.org");
    const b = await makeOwner(h, "st126-other@example.org");
    const now = h.app.clock.now();
    const seed = (f: string, o: Parameters<TH["registrar"]["transferIn"]["seedForeign"]>[1]) => h.registrar.transferIn.seedForeign(f, o);
    seed("locked-there.com", { authCode: CODE, locked: true });
    seed("registry-locked.com", { authCode: CODE, registryLock: true });
    seed("too-young.com", { authCode: CODE, createdAt: new Date(now.getTime() - 10 * DAY) });
    seed("just-moved.com", { authCode: CODE, createdAt: new Date(now.getTime() - 800 * DAY), lastTransferAt: new Date(now.getTime() - 30 * DAY) });
    seed("in-redemption.com", { authCode: CODE, status: "redemption" });
    seed("in-dispute.com", { authCode: CODE, status: "udrp" });
    seed("signed-zone.com", { authCode: CODE, dsPresent: true });
    seed("near-cap.com", { authCode: CODE, expiresAt: new Date(now.getTime() + 9.5 * 365 * DAY) });
    for (const [fqdn, owner] of [["mine-already.com", a], ["theirs-already.com", b]] as const) {
      await h.app.db.owner.query("insert into domains (user_id, fqdn_ascii, tld, registrar, state, locked, livemode) values ($1,$2,'com','opensrs','active',true,false)", [owner.userId, fqdn]);
    }
    const cases: [string, string, RegExp][] = [
      ["free-nobody-has.com", "not_registered", /not registered\. You can register it instead/],
      ["mine-already.com", "already_yours", /already in your account/],
      ["theirs-already.com", "already_here", /already managed here/],
      ["locked-there.com", "locked_at_losing", /Unlock it there/],
      ["registry-locked.com", "registry_lock", /registry lock/],
      ["too-young.com", "too_new", /60 days after it was registered\. You can transfer it from \d{4}-\d\d-\d\d/],
      ["just-moved.com", "recently_transferred", /60 days after its last transfer/],
      ["in-redemption.com", "redemption", /Restore it at your current registrar first/],
      ["in-dispute.com", "dispute", /dispute/],
      ["signed-zone.com", "dnssec", /DNSSEC records that would make it unreachable\. Remove them first\./],
      ["near-cap.com", "ten_year_cap", /ten-year limit/],
    ];
    for (const [fqdn, reason, text] of cases) {
      const r = await startRescue(h, a, fqdn);
      expect(r.status, `${fqdn}: ${r.text}`).toBe(409);
      expect(r.json.error.code).toBe("not_transferable");
      expect(r.json.error.reason, fqdn).toBe(reason);
      expect(r.json.error.message, fqdn).toMatch(text);
    }
    const young = await startRescue(h, a, "too-young.com", { key: "again" });
    expect(young.json.error.transferable_from).toBe(new Date(now.getTime() + 50 * DAY).toISOString());
    expect(await counts(h)).toEqual({ t: 0, o: 0 });
    expect(mailOf(h, "transfer_confirm_code")).toHaveLength(0);
    expect(h.stripe.created.sessions).toBe(0);
    expect(h.registrar.calls.startTransferIn).toBe(0);
  });

  it("DNSSEC is read from RDAP when the adapter cannot tell: signed is refused; unknown is allowed and recorded as unchecked", async () => {
    const h = await make();
    const a = await makeOwner(h, "st126-rdap@example.org");
    const orig = h.registrar.checkTransferIn.bind(h.registrar);
    h.registrar.checkTransferIn = async (f: string) => { const r = await orig(f); delete r.dsPresent; return r; };   // like OpenSRS CHECK_TRANSFER
    h.registrar.transferIn.seedForeign("rdap-signed.com", { authCode: CODE });
    h.registrar.transferIn.seedForeign("rdap-unknown.com", { authCode: CODE });
    installTransfers(h.app.ctx, { dnssec: { delegationSigned: async (f) => (f === "rdap-signed.com" ? true : null) } });
    expect((await startRescue(h, a, "rdap-signed.com")).json.error).toMatchObject({ code: "not_transferable", reason: "dnssec" });
    const ok = await startRescue(h, a, "rdap-unknown.com");
    expect(ok.status, ok.text).toBe(201);
    expect((await transferRow(h, ok.json.transfer_id)).dnssec_checked).toBe(false);
  });

  it("screening and velocity: a sanctioned registrant is held, a new account's daily transfer cap and the global cap refuse, and nothing is written", async () => {
    const h = await make();
    h.registrar.transferIn.seedForeign("screened.com", { authCode: CODE });
    const bad = await ownerWithContact(h, "st126-sanction@example.org", { name: "Test Sanctioned Person" });
    const r1 = await startRescue(h, bad, "screened.com");
    expect([r1.status, r1.json.error.code]).toEqual([403, "screening_hold"]);
    expect(await counts(h)).toEqual({ t: 0, o: 0 });

    const fresh = await makeOwner(h, "st126-new@example.org");
    await h.app.db.owner.query("update users set created_at = now() where id = $1", [fresh.userId]);
    await h.app.db.owner.query("insert into flags (name, value) values ('limits.new_account_daily_transfers', '1') on conflict (name) do update set value = excluded.value");
    h.registrar.transferIn.seedForeign("first-one.com", { authCode: CODE });
    h.registrar.transferIn.seedForeign("second-one.com", { authCode: CODE });
    expect((await startRescue(h, fresh, "first-one.com")).status).toBe(201);
    const r2 = await startRescue(h, fresh, "second-one.com");
    expect([r2.status, r2.json.error.code]).toEqual([429, "new_account_daily_transfers"]);

    const old = await makeOwner(h, "st126-global@example.org");
    await h.app.db.owner.query("update flags set value = '0' where name = 'limits.daily_registrations'");
    const r3 = await startRescue(h, old, "second-one.com", { key: "g" });
    expect([r3.status, r3.json.error.code]).toEqual([503, "global_daily_cap"]);
    expect((await counts(h)).t).toBe(1);
  });

  it("the registrant email confirms before any payment: the code goes only there, wrong codes cost tries and end it, and the right code opens Checkout", async () => {
    const h = await make();
    const o = await ownerWithContact(h, "st126-login@example.org", { email: "st126-registrant@example.org" });
    h.registrar.transferIn.seedForeign("confirm-me.com", { authCode: CODE });
    h.registrar.transferIn.seedForeign("never-confirmed.com", { authCode: CODE });
    const s = await startRescue(h, o, "confirm-me.com");
    expect(s.status, s.text).toBe(201);
    expect(s.json.state).toBe("awaiting_confirmation");
    const mail = mailOf(h, "transfer_confirm_code");
    expect(mail.map((m) => m.to)).toEqual([["st126-registrant@example.org"]]);
    expect(mail[0]!.text).not.toContain(CODE);
    expect((await orderRow(h, s.json.order_id)).state).toBe("draft");
    expect(h.stripe.created.sessions).toBe(0);
    const wrong = await confirm(h, o, s.json.transfer_id, "AAAAAAAA");
    expect([wrong.status, wrong.json.error.code, wrong.json.error.attempts_left]).toEqual([422, "invalid_code", 4]);
    const right = await confirm(h, o, s.json.transfer_id, confirmCodeOf(h, "confirm-me.com"));
    expect(right.status, right.text).toBe(200);
    expect(right.json.checkout_url).toMatch(/^https:\/\//);
    const t = await transferRow(h, s.json.transfer_id);
    expect(t.confirmed_at).not.toBeNull();
    expect(t.confirm_email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.confirm_code_hash).toBeNull();

    const n = await startRescue(h, o, "never-confirmed.com");
    for (let i = 0; i < 4; i++) expect((await confirm(h, o, n.json.transfer_id, "BBBBBBBB")).status).toBe(422);
    const last = await confirm(h, o, n.json.transfer_id, "BBBBBBBB");
    expect([last.status, last.json.error.code]).toEqual([409, "code_expired"]);
    expect(await transferRow(h, n.json.transfer_id)).toMatchObject({ state: "expired", auth_code_enc: null });
    expect((await orderRow(h, n.json.order_id)).state).toBe("voided");
    expect((await confirm(h, o, n.json.transfer_id, confirmCodeOf(h, "never-confirmed.com"))).status).toBe(409);
  });

  it("an unconfirmed transfer expires on its own and its code is wiped", async () => {
    const h = await make();
    const o = await makeOwner(h, "st126-expire@example.org");
    h.registrar.transferIn.seedForeign("walked-away.com", { authCode: CODE });
    const s = await startRescue(h, o, "walked-away.com");
    await pass(h, 31 * 60_000);
    expect(await transferRow(h, s.json.transfer_id)).toMatchObject({ state: "expired", failure: "unconfirmed", auth_code_enc: null });
    expect((await orderRow(h, s.json.order_id)).state).toBe("voided");
  });

  it("never stores a card: Checkout does not save the payment method, and the hold is the only thing on it", async () => {
    const h = await make();
    const o = await makeOwner(h, "st126-card@example.org");
    h.registrar.transferIn.seedForeign("no-card-kept.com", { authCode: CODE });
    const { orderId } = await rescueAndPay(h, o, "no-card-kept.com");
    const row = await orderRow(h, orderId);
    const session = h.stripe.sessions.get(row.stripe_checkout_session_id) as { _params?: { input: { setupFutureUsage?: string; captureMethod: string } } };
    expect(session._params!.input.setupFutureUsage).toBeUndefined();
    expect(session._params!.input.captureMethod).toBe("manual");
    expect([...h.stripe.paymentMethods.values()].every((pm) => pm.customer === null)).toBe(true);
    expect((await h.app.db.owner.query("select count(*)::int n from renewal_mandates where user_id = $1", [o.userId])).rows[0].n).toBe(0);
  });

  it("input: the term is the extension's transfer term, the code shape is checked without echoing it, and an agent token cannot start one", async () => {
    const h = await make();
    const o = await makeOwner(h, "st126-input@example.org");
    h.registrar.transferIn.seedForeign("two-years.ai", { authCode: CODE });
    const t1 = await startRescue(h, o, "two-years.ai", { years: 1 });
    expect([t1.status, t1.json.error.code, t1.json.error.years]).toEqual([422, "invalid_term", 2]);
    const bad = CODE + " \u0001";
    const t2 = await startRescue(h, o, "two-years.ai", { code: bad });
    expect([t2.status, t2.json.error.code]).toEqual([422, "invalid_auth_code_format"]);
    expect(t2.text).not.toContain(CODE);
    const agent = await h.app.call("POST", "/api/v1/transfers", { authorization: "Bearer mh_live_notarealtoken", body: {}, browser: false });
    expect([401, 403]).toContain(agent.status);
  });
});

describe("ST-22 (transfer-in): a transfer authorization code canary appears in no job payload, audit row, log, email, error or database column", () => {
  it("through success, a timeout after sending, a refusal and a failed transfer, the code is only ever on the registrar wire", async () => {
    const h = await make();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const o = await makeOwner(h, "st22-transfer@example.org");
    const wire: string[] = [];
    const start = h.registrar.startTransferIn.bind(h.registrar);
    h.registrar.startTransferIn = async (r) => { wire.push(r.authCode); return start(r); };
    h.registrar.transferIn.seedForeign("canary-ok.com", { authCode: CODE });
    h.registrar.transferIn.seedForeign("canary-timeout.com", { authCode: CODE });
    h.registrar.transferIn.seedForeign("canary-locked.com", { authCode: CODE, locked: true });
    h.registrar.transferIn.seedForeign("canary-wrong.com", { authCode: "SomethingElse1" });
    const bodies: string[] = [];
    const ok = await rescueAndPay(h, o, "canary-ok.com");
    h.registrar.faults.set("timeoutAfterAccept", { times: 1, fqdn: "canary-timeout.com" });
    const to = await rescueAndPay(h, o, "canary-timeout.com");
    bodies.push((await startRescue(h, o, "canary-locked.com")).text);
    bodies.push((await startRescue(h, o, "canary-ok.com", { key: "dup", code: CODE })).text);
    const wrong = await rescueAndPay(h, o, "canary-wrong.com");
    // Before submit the stored envelope never holds the plaintext.
    await pass(h, TRANSFER_REVIEW_MS);
    h.registrar.transferIn.losingAck("canary-ok.com"); h.registrar.transferIn.losingAck("canary-timeout.com");
    await pass(h);
    for (const id of [ok.id, to.id, wrong.id]) bodies.push((await h.app.call("GET", `/api/v1/transfers/${id}`, { cookie: o.cookie })).text);
    bodies.push((await cancel(h, o, ok.id)).text);
    expect((await transferRow(h, ok.id)).state).toBe("completed");
    expect((await transferRow(h, wrong.id)).failure).toBe("invalid_auth_code");
    expect(wire.length).toBe(3);
    expect(wire.every((w) => w === CODE)).toBe(true);

    const tables = (await h.app.db.owner.query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'")).rows.map((r) => r.relname as string);
    const hay: string[] = [];
    for (const t of tables) hay.push(JSON.stringify((await h.app.db.owner.query(`select * from ${t}`)).rows));
    hay.push(JSON.stringify(h.app.email.sent), bodies.join("\n"), spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n"));
    spies.forEach((s) => s.mockRestore());
    const all = hay.join("\n");
    expect(all.includes(CODE), "canary found in a table, a mail, a response or a log").toBe(false);
    expect((await h.app.db.owner.query("select count(*)::int n from transfers_in where auth_code_enc is not null")).rows[0].n).toBe(0);
    expect(tables.length).toBeGreaterThan(40);
  });
});
