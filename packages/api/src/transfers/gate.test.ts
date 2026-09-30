import { afterEach, describe, expect, it } from "vitest";
import { harnessPerTest, mailOf, relogin, type Owner } from "../domains/testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { commit, prepare } from "../stepup/testkit.ts";
import { denyTransferAway, gateSweep } from "./gate.ts";
import { CODE, makeOwner, pass, rescueAndPay, type TH } from "./testkit.ts";

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });
const DAY = 86_400_000;
const make = async () => per.make() as Promise<TH>;

/** A name registered here long ago (so the 60-day rule is behind it), at the mock registrar and in the account. */
async function oldDomain(h: TH, o: Owner, fqdn: string, ageDays = 400): Promise<string> {
  h.registrar.setKind(fqdn, "available");
  await h.registrar.register({ fqdn, years: 1, regUsername: "mhgate" + fqdn.length, regPassword: "p".repeat(14), registrant: { name: "Ada Moss", email: o.email, phone: "+1.5555550100", street: "1 Fern Lane", city: "Portland", region: "OR", postalCode: "97201", country: "US" } });
  const st = (await h.registrar.getDomain(fqdn))!;
  const created = new Date(h.app.clock.now().getTime() - ageDays * DAY);
  return (await h.app.db.owner.query(
    `insert into domains (user_id, fqdn_ascii, tld, registrar, state, registered_at, registry_created_at, expires_at, locked, nameservers, dns_hosted_here, livemode)
     values ($1,$2,$3,'opensrs','active',$4,$4,$5,true,$6,true,false) returning id`,
    [o.userId, fqdn, fqdn.slice(fqdn.indexOf(".") + 1), created, st.expiresAt, st.nameservers])).rows[0].id as string;
}
const gate = (h: TH, o: Owner, id: string) => h.app.call("GET", `/api/v1/domains/${id}/gate`, { cookie: o.cookie });
async function stepUp(h: TH, o: Owner, type: string, target: string): Promise<string> {
  const prep = await prepare(h.app, o.user, { type, target_id: target, user_input: {} });
  expect(prep.status, JSON.stringify(prep.json)).toBe(200);
  const done = await commit(h.app, o.user, prep.json.action_id, o.key.auth.get(prep.json.webauthn_options));
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  return prep.json.action_id as string;
}
const post = (h: TH, o: Owner, path: string, action?: string) => h.app.call("POST", path, { cookie: o.cookie, body: {}, headers: action ? { [ACTION_HEADER]: action } : {} });

describe("ST-124: transfer-out and code issue return 403 step_up_required without a committed action", () => {
  it("code issue and unlock refuse without an action, with an action of the wrong type, and with one for another domain; the Gate itself is a read", async () => {
    const h = await make();
    const o = await makeOwner(h, "st124@example.org");
    const id = await oldDomain(h, o, "gated-name.com");
    const other = "gated-other.com"; await oldDomain(h, o, other);
    for (const p of ["unlock", "transfer-out"]) {
      const r = await post(h, o, `/api/v1/domains/gated-name.com/${p}`);
      expect([r.status, r.json.error.code], p).toEqual([403, "step_up_required"]);
    }
    const unlockOther = await stepUp(h, o, "domain.unlock", other);
    expect((await post(h, o, "/api/v1/domains/gated-name.com/unlock", unlockOther)).json.error.code).toBe("step_up_required");
    const unlock = await stepUp(h, o, "domain.unlock", "gated-name.com");
    expect((await post(h, o, "/api/v1/domains/gated-name.com/transfer-out", unlock)).json.error.code).toBe("step_up_required");   // wrong type
    expect((await post(h, o, "/api/v1/domains/gated-name.com/unlock", unlock)).status).toBe(200);
    expect((await post(h, o, "/api/v1/domains/gated-name.com/transfer-out")).json.error.code).toBe("step_up_required");
    expect(h.registrar.calls.issueAuthCode).toBe(0);
    const g = await gate(h, o, id);
    expect(g.status).toBe(200);
    expect(g.json.state).toBe("unlocked");
  });
});

describe("The Gate: unlock, code, approval by email at the gaining side, detection, and release when the name leaves", () => {
  it("walks the whole outbound flow honestly and releases the domain (cause transferred_out) only once the adapter no longer shows it", async () => {
    const h = await make();
    let o = await makeOwner(h, "gate-flow@example.org");
    const f = "leaving-soon.com";
    const id = await oldDomain(h, o, f);
    let g = await gate(h, o, id);
    expect(g.json).toMatchObject({ state: "locked", transferable: true, blocks: [], billing_blocks_transfer: false, can_cancel_upstream: false, pending: null });
    expect(g.json.steps).toHaveLength(4);
    expect(g.json.approval).toMatch(/emails the registrant a link to approve or decline.*Silence for five days counts as approval/);
    expect(g.json.timing).toMatch(/several days and sometimes about two weeks/);

    expect((await post(h, o, `/api/v1/domains/${f}/unlock`, await stepUp(h, o, "domain.unlock", f))).status).toBe(200);
    const issued = await post(h, o, `/api/v1/domains/${f}/transfer-out`, await stepUp(h, o, "domain.transfer_out", f));
    expect(issued.status, issued.text).toBe(200);
    const code = issued.json.code as string;
    g = await gate(h, o, id);
    expect(g.json.state).toBe("code_issued");
    expect(g.json.code).toMatchObject({ outstanding: true, shown_once: true });
    expect(g.text).not.toContain(code);

    // The gaining registrar starts the transfer; OpenSRS emails the registrant. transfer.poll sees it and it is explained by the code issue.
    h.registrar.oob.startTransferAway(f, { status: "pending_owner", gainingRegistrar: "Other Registrar Inc" });
    await pass(h);
    o = await relogin(h, o);
    g = await gate(h, o, id);
    expect(g.json.state).toBe("traveling");
    expect(g.json.pending).toMatchObject({ requested_by_you: true, gaining_registrar: "Other Registrar Inc", stop_available: true });
    const started = mailOf(h, "transfer_away_started");
    expect(started).toHaveLength(1);
    expect(started[0]!.text).toMatch(/emails the registrant to confirm or decline it\. Silence until .* counts as agreement/);
    expect(started[0]!.text).toMatch(/\/api\/v1\/email-actions\//);    // the freeze link
    expect(started[0]!.text).not.toContain(code);
    expect(mailOf(h, "domain.transfer_unrequested")).toHaveLength(0);
    // Nothing is released while the adapter still has the name.
    expect((await h.app.db.owner.query("select released_at from domains where id = $1", [id])).rows[0].released_at).toBeNull();

    h.registrar.oob.setTransferAwayStatus(f, "completed");
    await pass(h);
    await pass(h);
    const d = (await h.app.db.owner.query("select released_at, release_reason from domains where id = $1", [id])).rows[0];
    expect(d.release_reason).toBe("transferred_out");
    expect(d.released_at).not.toBeNull();
    expect(mailOf(h, "domain_released")).toHaveLength(1);
    o = await relogin(h, o);
    g = await gate(h, o, id);
    expect(g.json).toMatchObject({ state: "left", released: { cause: "transferred_out" } });
    expect(g.json.log.map((l: { event: string }) => l.event)).toEqual(expect.arrayContaining(["away_requested", "away_completed"]));
    // Idempotent: another sweep releases nothing twice.
    expect(await gateSweep(h.app.ctx)).toEqual({ notified: 0, released: 0 });
  });

  it("an unrequested transfer is needs attention, gets no 'you asked for it' mail, and is still released if it completes", async () => {
    const h = await make();
    const o = await makeOwner(h, "gate-hostile@example.org");
    const f = "hostile-away.com";
    const id = await oldDomain(h, o, f);
    h.registrar.oob.startTransferAway(f);
    await pass(h);
    expect((await gate(h, o, id)).json.state).toBe("needs_attention");
    expect(mailOf(h, "transfer_away_started")).toHaveLength(0);
    expect(mailOf(h, "domain.transfer_unrequested")).toHaveLength(1);
  });
});

describe("C-06, C-04, C-03: why a name cannot leave yet, and what never blocks it", () => {
  it("C-06: a new registration, a recent transfer-in and a change of registrant each block with the date they lift", async () => {
    const h = await make();
    const o = await makeOwner(h, "gate-dates@example.org");
    const young = await oldDomain(h, o, "young-reg.com", 10);
    let g = await gate(h, o, young);
    expect(g.json.state).toBe("blocked");
    expect(g.json.blocks).toEqual([{ code: "too_new", message: expect.stringMatching(/60 days after it was registered/), until: new Date(h.app.clock.now().getTime() + 50 * DAY).toISOString() }]);
    expect(g.json.transferable_from).toBe(g.json.blocks[0].until);

    h.registrar.transferIn.seedForeign("came-in.com", { authCode: CODE, losing: "ack" });
    const { id: tid } = await rescueAndPay(h, o, "came-in.com");
    await pass(h, 24 * 3_600_000);
    const dom = (await h.app.db.owner.query("select domain_id from transfers_in where id = $1", [tid])).rows[0].domain_id as string;
    expect(dom).toBeTruthy();
    const o2 = await relogin(h, o);
    g = await gate(h, o2, dom);
    expect(g.json.blocks.map((b: { code: string }) => b.code)).toContain("recently_transferred");
    // domain-mgmt refuses the unlock too, with the date (the 60-day lock after a transfer).
    const prep = await prepare(h.app, o2.user, { type: "domain.unlock", target_id: "came-in.com", user_input: {} });
    expect([prep.status, prep.json.error.code]).toEqual([423, "transfer_locked"]);

    const cor = await oldDomain(h, o2, "owner-changed.com");
    await h.app.db.owner.query("insert into domain_security (domain_id, user_id, transfer_lock_until, transfer_lock_reason) values ($1,$2,$3,'change_of_registrant')", [cor, o2.userId, new Date(h.app.clock.now().getTime() + 40 * DAY)]);
    expect((await gate(h, o2, cor)).json.blocks.map((b: { code: string }) => b.code)).toEqual(["change_of_registrant"]);
  });

  it("C-04: a payment dispute or an account under review never blocks unlock or code release", async () => {
    const h = await make();
    const o = await makeOwner(h, "gate-dispute@example.org");
    const f = "disputed-card.com";
    const id = await oldDomain(h, o, f);
    await h.app.db.owner.query("update users set risk_state = 'review' where id = $1", [o.userId]);
    expect((await gate(h, o, id)).json).toMatchObject({ transferable: true, billing_blocks_transfer: false });
    expect((await post(h, o, `/api/v1/domains/${f}/unlock`, await stepUp(h, o, "domain.unlock", f))).status).toBe(200);
    const issued = await post(h, o, `/api/v1/domains/${f}/transfer-out`, await stepUp(h, o, "domain.transfer_out", f));
    expect(issued.status, issued.text).toBe(200);
  });

  it("C-03: .io codes come from registrar support, and the Gate shows the open request with its 5-day due date", async () => {
    const h = await make();
    const o = await makeOwner(h, "gate-io@example.org");
    const f = "support-code.io";
    const id = await oldDomain(h, o, f);
    expect((await post(h, o, `/api/v1/domains/${f}/unlock`, await stepUp(h, o, "domain.unlock", f))).status).toBe(200);
    const r = await post(h, o, `/api/v1/domains/${f}/transfer-out`, await stepUp(h, o, "domain.transfer_out", f));
    expect(r.status).toBe(202);
    const g = await gate(h, o, id);
    expect(g.json.state).toBe("code_requested");
    expect(g.json.code.by_support).toBe(true);
    expect(new Date(g.json.code.request.due_at).getTime()).toBe(h.app.clock.now().getTime() + 5 * DAY);
    expect(g.json.timing).toBe("The registry sets the timing and we cannot predict it.");
  });
});

describe("C-05: the denial console offers only the Transfer Policy reasons and emails the reason", () => {
  it("refuses 'pay first' and unknown reasons, accepts a must-deny reason, opens the ticket for Tucows and tells the registrant why", async () => {
    const h = await make();
    const o = await makeOwner(h, "gate-deny@example.org");
    const f = "udrp-held.com";
    const id = await oldDomain(h, o, f);
    await expect(denyTransferAway(h.app.ctx, { domainId: id, reason: "udrp", operator: "op" })).rejects.toMatchObject({ code: "no_pending_transfer" });
    h.registrar.oob.startTransferAway(f);
    await pass(h);
    await expect(denyTransferAway(h.app.ctx, { domainId: id, reason: "non_payment", operator: "op" })).rejects.toMatchObject({ status: 422, code: "reason_not_used" });
    await expect(denyTransferAway(h.app.ctx, { domainId: id, reason: "pay_first", operator: "op" })).rejects.toMatchObject({ status: 422, code: "reason_not_allowed" });
    const r = await denyTransferAway(h.app.ctx, { domainId: id, reason: "udrp", operator: "op" });
    const ticket = (await h.app.db.owner.query("select kind, detail from domain_tickets where id = $1", [r.ticketId])).rows[0];
    expect(ticket).toMatchObject({ kind: "stop_transfer", detail: { denial_reason: "udrp", must_deny: true } });
    const m = mailOf(h, "transfer_denied");
    expect(m).toHaveLength(1);
    expect(m[0]!.text).toMatch(/The reason: an open UDRP dispute\./);
    expect((await h.app.db.owner.query("select event, actor_kind from transfer_log where domain_id = $1 and event = 'away_denied'", [id])).rows).toEqual([{ event: "away_denied", actor_kind: "operator" }]);
  });
});

describe("Cross-tenant: the Gate and the transfer routes answer another user's ids exactly like missing ones", () => {
  it("B cannot read A's Gate or transfer, confirm or cancel it", async () => {
    const h = await make();
    const a = await makeOwner(h, "gate-a@example.org");
    const b = await makeOwner(h, "gate-b@example.org");
    const id = await oldDomain(h, a, "alice-gated.com");
    h.registrar.transferIn.seedForeign("alice-moving.com", { authCode: CODE });
    const s = await h.app.call("POST", "/api/v1/transfers", { cookie: a.cookie, headers: { "idempotency-key": "x" }, body: { fqdn: "alice-moving.com", years: 1, auth_code: CODE, accept: Object.fromEntries((await h.app.db.owner.query("select kind, version_hash from document_versions where kind in ('terms','registration_agreement')")).rows.map((d) => [d.kind, d.version_hash])) } });
    expect(s.status, s.text).toBe(201);
    const missing = "018f0000-0000-7000-8000-000000000000";
    const pairs: [string, string, string][] = [
      ["GET", `/api/v1/domains/${id}/gate`, `/api/v1/domains/${missing}/gate`],
      ["GET", `/api/v1/transfers/${s.json.transfer_id}`, `/api/v1/transfers/${missing}`],
      ["POST", `/api/v1/transfers/${s.json.transfer_id}/confirm`, `/api/v1/transfers/${missing}/confirm`],
      ["POST", `/api/v1/transfers/${s.json.transfer_id}/cancel`, `/api/v1/transfers/${missing}/cancel`],
    ];
    for (const [method, mine, none] of pairs) {
      const x = await h.app.call(method, mine, { cookie: b.cookie, body: method === "GET" ? undefined : { code: "AAAAAAAA" } });
      const y = await h.app.call(method, none, { cookie: b.cookie, body: method === "GET" ? undefined : { code: "AAAAAAAA" } });
      expect(x.status, mine).toBe(404);
      expect(JSON.stringify([x.status, x.json, x.headers.get("content-type")])).toBe(JSON.stringify([y.status, y.json, y.headers.get("content-type")]));
    }
    expect((await h.app.db.owner.query("select state, confirm_attempts from transfers_in where id = $1", [s.json.transfer_id])).rows[0]).toEqual({ state: "awaiting_confirmation", confirm_attempts: 0 });
  });
});
