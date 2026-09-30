import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, everythingStored, makeDomain, makeKit, makePerson, poll, refreshSession, resetFuse, stepUp, type Kit, type Person } from "./testkit.ts";
import { setDisputeLock, clearDisputeLock } from "./dispute.ts";
import { COR_LOCK_MS } from "./common.ts";

let k: Kit; let alice: Person;
beforeAll(async () => { k = await makeKit(); alice = await makePerson(k, "alice"); }, 120_000);
afterAll(async () => { await k?.app.drop(); });
beforeEach(async () => { await resetFuse(k); k.app.email.clear(); await refreshSession(k, alice); });

const DAY = 86_400_000;
const NEW = { name: "Ada Moss", email: "new-owner@example.org", phone: "+1.5555550100", street: "77 Secret Street", city: "Portland", region: "OR", postalCode: "97201", country: "US" };
const row = async (sql: string, args: unknown[]) => (await k.app.db.owner.query(sql, args)).rows;
const linkOf = (text: string) => /email-actions\/([A-Za-z0-9_-]{43})/.exec(text)?.[1];

async function draft(p: Person, fqdn: string, fields: Partial<typeof NEW> = {}) {
  const r = await call(k, p, "POST", `/api/v1/domains/${fqdn}/contact-drafts`, { ...NEW, ...fields });
  expect(r.status, r.text).toBe(201);
  return r.json as { id: string; registrant_change: boolean; warnings: { code: string }[]; email_matches_login: boolean };
}

describe("ST-121: the registrant email differs from the login email by default; a match warns; a contact change is gated and notifies every address", () => {
  it("the form starts from the registrant address, not the login address, and a matching registrant address shows a warning", async () => {
    const good = await makeDomain(k, alice, "st121-good.com");
    const view = await call(k, alice, "GET", `/api/v1/domains/${good.fqdn}/contact`);
    expect(view.json.suggested_email).toBe(alice.registrantAddr);
    expect(view.json.suggested_email).not.toBe(alice.login);
    expect(view.json.current.email).toBe(alice.registrantAddr);
    expect(view.json.login_email_matches).toBe(false); expect(view.json.warning).toBeNull();

    const mal = await makePerson(k, "mallory", { contactEmail: "mallory-login@example.org" });
    const bad = await makeDomain(k, mal, "st121-same.com", { registrantEmail: mal.login });
    const warned = await call(k, mal, "GET", `/api/v1/domains/${bad.fqdn}/contact`);
    expect(warned.json.login_email_matches).toBe(true);
    expect(warned.json.warning.code).toBe("registrant_matches_login");

    const d = await draft(alice, good.fqdn, { email: alice.login });
    expect(d.email_matches_login).toBe(true);
    expect(d.warnings.map((w) => w.code)).toContain("registrant_matches_login");
    const fine = await draft(alice, good.fqdn, { email: "someone-else@example.org" });
    expect(fine.email_matches_login).toBe(false);
    expect(fine.warnings.map((w) => w.code)).not.toContain("registrant_matches_login");
  });

  it("submitting needs domain.contact.change: no action, or an action for another draft, is refused", async () => {
    const d = await makeDomain(k, alice, "st121-gate.com");
    const a = await draft(alice, d.fqdn), b = await draft(alice, d.fqdn, { city: "Salem" });
    const none = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/contact`, {});
    expect(none.status).toBe(403); expect(none.json.error.code).toBe("step_up_required");
    // The first draft was replaced by the second, so it cannot be prepared any more.
    const stale = await call(k, alice, "POST", "/api/v1/actions/prepare", { type: "domain.contact.change", target_id: a.id, user_input: {} });
    expect(stale.status).toBe(404);
    expect(b.id).not.toBe(a.id);
  });

  it("a change of registrant: warns first, needs both parties, stores no plain values, blocks unlock while pending, then locks transfers for 60 days and starts email verification", async () => {
    const d = await makeDomain(k, alice, "st121-cor.com");
    const dr = await draft(alice, d.fqdn);
    expect(dr.registrant_change).toBe(true);
    expect(dr.warnings.map((w) => w.code)).toContain("change_of_registrant");
    const id = await stepUp(k, alice, "domain.contact.change", dr.id);
    const res = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/contact`, {}, id);
    expect(res.status, res.text).toBe(202);
    expect(res.json.status).toBe("awaiting_approval"); expect(res.json.transfer_lock_days).toBe(60);
    // Every address is told, with a freeze link; the new registrant is told what to approve, without a freeze link.
    for (const to of [alice.login, alice.second, alice.registrantAddr]) {
      const m = k.app.email.to(to).filter((x) => x.kind === "domain.contact_change");
      expect(m, to).toHaveLength(1); expect(linkOf(m[0]!.text)).toBeTruthy(); expect(m[0]!.text).toContain("60 days");
    }
    const newMail = k.app.email.to(NEW.email).filter((x) => x.kind === "domain.cor_new_registrant");
    expect(newMail).toHaveLength(1); expect(linkOf(newMail[0]!.text)).toBeUndefined();
    // The values live encrypted; the id and the hash are all that other tables hold.
    const stored = await everythingStored(k, { mail: false });
    expect(stored).not.toContain(NEW.street); expect(stored).not.toContain(NEW.email);
    expect((await row("select fields_enc from contact_changes where id = $1", [dr.id]))[0].fields_enc.email.ct).toBeTruthy();
    // The action is single use.
    expect((await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/contact`, {}, id)).status).toBeGreaterThanOrEqual(400);

    // While the change waits, the domain cannot be unlocked.
    const blocked = await call(k, alice, "POST", "/api/v1/actions/prepare", { type: "domain.unlock", target_id: d.fqdn, user_input: {} });
    expect(blocked.status).toBe(423); expect(blocked.json.error.code).toBe("contact_change_pending");
    const sec1 = await call(k, alice, "GET", `/api/v1/domains/${d.fqdn}/security`);
    expect(sec1.json.contact_change.state).toBe("awaiting_approval");

    // Nothing happens until the upstream reports the new owner; then the lock and the verification clock start.
    await poll(k);
    expect((await row("select state from contact_changes where id = $1", [dr.id]))[0].state).toBe("awaiting_approval");
    k.registrar.approveContactChange(d.fqdn);
    k.app.email.clear();
    await poll(k);
    const done = (await row("select state, applied_at from contact_changes where id = $1", [dr.id]))[0];
    expect(done.state).toBe("applied");
    const sec = (await row("select transfer_lock_until from domain_security where domain_id = $1", [d.id]))[0];
    expect(new Date(sec.transfer_lock_until).getTime() - new Date(done.applied_at).getTime()).toBe(COR_LOCK_MS);
    const ver = (await row("select state, reason, deadline_at, started_at from registrant_verifications where domain_id = $1", [d.id]))[0];
    expect(ver.state).toBe("pending"); expect(ver.reason).toBe("change_of_registrant");
    expect(new Date(ver.deadline_at).getTime() - new Date(ver.started_at).getTime()).toBe(15 * DAY);
    for (const to of [alice.login, alice.second, alice.registrantAddr]) expect(k.app.email.to(to).some((x) => x.kind === "domain.contact_change_applied"), to).toBe(true);

    const locked = await call(k, alice, "POST", "/api/v1/actions/prepare", { type: "domain.unlock", target_id: d.fqdn, user_input: {} });
    expect(locked.status).toBe(423); expect(locked.json.error.code).toBe("transfer_locked"); expect(locked.json.error.until).toBeTruthy();
    const sec2 = await call(k, alice, "GET", `/api/v1/domains/${d.fqdn}/security`);
    expect(sec2.json.transfer_lock_until).toBeTruthy();
    // The lock lifts after 60 days.
    k.app.clock.advance(60 * DAY + 60_000);
    await refreshSession(k, alice);
    expect((await call(k, alice, "POST", "/api/v1/actions/prepare", { type: "domain.unlock", target_id: d.fqdn, user_input: {} })).status).toBe(200);
  });

  it("an unanswered change of registrant lapses after 5 days and changes nothing", async () => {
    const d = await makeDomain(k, alice, "st121-lapse.com");
    const dr = await draft(alice, d.fqdn);
    await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/contact`, {}, await stepUp(k, alice, "domain.contact.change", dr.id));
    k.app.clock.advance(5 * DAY + 60_000);
    await poll(k);
    expect((await row("select state from contact_changes where id = $1", [dr.id]))[0].state).toBe("expired");
    expect((await row("select 1 from domain_security where domain_id = $1 and transfer_lock_until is not null", [d.id]))).toHaveLength(0);
    await refreshSession(k, alice);
  });

  it("a change that is not a change of registrant applies at once with no lock", async () => {
    const d = await makeDomain(k, alice, "st121-phone.com");
    const dr = await draft(alice, d.fqdn, { email: alice.registrantAddr, name: "Ada Moss", phone: "+1.5555550199" });
    expect(dr.registrant_change).toBe(false);
    const res = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/contact`, {}, await stepUp(k, alice, "domain.contact.change", dr.id));
    expect(res.status, res.text).toBe(200); expect(res.json.status).toBe("applied"); expect(res.json.transfer_lock_days).toBe(0);
    expect((await row("select 1 from domain_security where domain_id = $1 and transfer_lock_until is not null", [d.id]))).toHaveLength(0);
    expect((await row("select 1 from registrant_verifications where domain_id = $1", [d.id]))).toHaveLength(0);
  });
});

describe("C-16: registrant email verification", () => {
  it("a code to the registrant address verifies it; wrong codes are counted; reminder at day 10; the hold path at day 15 opens a ticket and verifying lifts it", async () => {
    const d = await makeDomain(k, alice, "c16-verify.com");
    await k.app.db.owner.query("insert into registrant_verifications (user_id, domain_id, reason, started_at, deadline_at) values ($1,$2,'registration',$3,$4)", [alice.user.userId, d.id, k.app.clock.now(), new Date(k.app.clock.now().getTime() + 15 * DAY)]);
    // Wrong code first: refused, and it costs an attempt.
    const send = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/registrant-verification/send`, {});
    expect(send.json.sent).toBe(true);
    const mail = k.app.email.to(alice.registrantAddr).find((m) => m.kind === "domain.registrant_verify")!;
    const code = /\b(\d{8})\b/.exec(mail.text)![1]!;
    const wrong = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/registrant-verification/verify`, { code: code === "00000000" ? "11111111" : "00000000" });
    expect(wrong.status).toBe(400);
    expect((await row("select code_attempts from registrant_verifications where domain_id = $1", [d.id]))[0].code_attempts).toBe(1);
    expect(await everythingStored(k, { mail: false })).not.toContain(code);

    // Day 10: one reminder to every address. Day 15: the domain is put on hold (ticket, alert, needs attention).
    k.app.clock.advance(10 * DAY + 60_000); await refreshSession(k, alice); k.app.email.clear();
    await poll(k);
    for (const to of [alice.login, alice.second, alice.registrantAddr]) expect(k.app.email.to(to).filter((m) => m.kind === "domain.registrant_reminder"), to).toHaveLength(1);
    await poll(k);
    expect(k.app.email.to(alice.login).filter((m) => m.kind === "domain.registrant_reminder")).toHaveLength(1);
    k.app.clock.advance(5 * DAY); await refreshSession(k, alice);
    await poll(k);
    expect((await row("select state from registrant_verifications where domain_id = $1", [d.id]))[0].state).toBe("suspended");
    expect((await row("select kind, state from domain_tickets where domain_id = $1", [d.id]))).toEqual([{ kind: "client_hold_request", state: "open" }]);
    const sec = await call(k, alice, "GET", `/api/v1/domains/${d.fqdn}/security`);
    expect(sec.json.attention.kind).toBe("registrant_suspended");

    const send2 = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/registrant-verification/send`, {});
    expect(send2.json.sent).toBe(true);
    const code2 = /\b(\d{8})\b/.exec([...k.app.email.to(alice.registrantAddr)].reverse().find((m) => m.kind === "domain.registrant_verify")!.text)![1]!;
    const ok = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/registrant-verification/verify`, { code: code2 });
    expect(ok.status, ok.text).toBe(200); expect(ok.json.hold_lift_requested).toBe(true);
    expect((await row("select state from registrant_verifications where domain_id = $1", [d.id]))[0].state).toBe("verified");
    expect((await row("select state from domain_tickets where domain_id = $1", [d.id]))[0].state).toBe("closed");
  });

  it("the annual registration-data reminder goes out once, before the anniversary, with a notices row as proof", async () => {
    const d = await makeDomain(k, alice, "c16-annual.com");
    const anniv = new Date(k.app.clock.now().getTime() + 20 * DAY);
    const created = new Date(Date.UTC(anniv.getUTCFullYear() - 2, anniv.getUTCMonth(), anniv.getUTCDate()));
    await k.app.db.owner.query("update domains set registry_created_at = $2 where id = $1", [d.id, created]);
    k.app.email.clear();
    await poll(k);
    k.app.clock.advance(3600_000 + 1000); await poll(k);
    expect(k.app.email.to(alice.login).filter((m) => m.kind === "domain.rdrp_annual")).toHaveLength(1);
    expect((await row("select kind, template_version from notices where domain_id = $1", [d.id]))).toEqual([{ kind: "rdrp_annual", template_version: "rdrp-v1" }]);
  });
});

describe("C-23: dispute lock", () => {
  it("freezes contact edits, unlock and transfer-out, keeps the domain locked, alerts, opens a 2-business-day ticket, and shows in the security view; clearing restores", async () => {
    const d = await makeDomain(k, alice, "c23-dispute.com");
    const dr = await draft(alice, d.fqdn);
    const staged = await stepUp(k, alice, "domain.contact.change", dr.id);
    const { dueAt, ticketId } = await setDisputeLock(k.app.ctx, { domainId: d.id, state: "udrp_locked", staffId: "staff_ops1" });
    expect(ticketId).toBeTruthy();
    expect(dueAt.getUTCDay()).not.toBe(0); expect(dueAt.getUTCDay()).not.toBe(6);
    expect(dueAt.getTime() - k.app.clock.now().getTime()).toBeGreaterThanOrEqual(2 * DAY); expect(dueAt.getTime() - k.app.clock.now().getTime()).toBeLessThanOrEqual(4 * DAY);
    expect(k.registrar.domainRecord(d.fqdn)!.locked).toBe(true);
    expect((await row("select severity from alerts where kind = 'domain.dispute_lock' and state = 'open'", []))[0].severity).toBe("page");
    // An action committed before the lock cannot use it either.
    const late = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/contact`, {}, staged);
    expect(late.status).toBe(423); expect(late.json.error.code).toBe("dispute_lock");
    expect((await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/contact-drafts`, NEW)).status).toBe(423);
    for (const [type, input] of [["domain.unlock", {}], ["domain.transfer_out", {}]] as const) {
      const r = await call(k, alice, "POST", "/api/v1/actions/prepare", { type, target_id: d.fqdn, user_input: input });
      expect(r.status, type).toBe(423); expect(r.json.error.code).toBe("dispute_lock");
    }
    const sec = await call(k, alice, "GET", `/api/v1/domains/${d.fqdn}/security`);
    expect(sec.json.dispute_lock.state).toBe("udrp_locked"); expect(sec.json.attention.kind).toBe("dispute_lock");
    // The audit row names the staff member and holds no free text.
    expect((await row("select actor_kind, actor_id, detail from audit_log where action = 'domain.dispute_lock_set'", []))[0]).toMatchObject({ actor_kind: "support", actor_id: "staff_ops1" });

    await clearDisputeLock(k.app.ctx, { domainId: d.id, staffId: "staff_ops1" });
    expect((await call(k, alice, "POST", "/api/v1/actions/prepare", { type: "domain.unlock", target_id: d.fqdn, user_input: {} })).status).toBe(200);
    expect((await row("select state from domain_tickets where domain_id = $1 and kind = 'dispute_lock'", [d.id]))[0].state).toBe("closed");
  });
});

describe("C-20: DS records", () => {
  it("lists records with a plain note, relays add and remove behind the step-up, and says .io is unsupported", async () => {
    const d = await makeDomain(k, alice, "c20-ds.com");
    const before = await call(k, alice, "GET", `/api/v1/domains/${d.fqdn}/ds`);
    expect(before.json.supported).toBe(true); expect(before.json.records).toEqual([]);
    expect(before.json.glue_supported).toBe(false); expect(before.json.note).toContain("IPv6");
    const ds = { keyTag: 4242, algorithm: 13, digestType: 2, digest: "ef".repeat(32) };
    const add = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/ds`, {}, await stepUp(k, alice, "domain.nameservers.change", d.fqdn, { kind: "ds_add", ds }));
    expect(add.status, add.text).toBe(200); expect(add.json.ds_present).toBe(true);
    expect((await call(k, alice, "GET", `/api/v1/domains/${d.fqdn}/ds`)).json.records).toHaveLength(1);
    // A nameserver action cannot be spent on a DS route, and the other way round.
    const nsAction = await stepUp(k, alice, "domain.nameservers.change", d.fqdn, { kind: "ds_remove", ds });
    const wrongRoute = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/nameservers`, {}, nsAction);
    expect(wrongRoute.status).toBe(403);
    const rm = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/ds`, {}, nsAction);
    expect(rm.status, rm.text).toBe(200); expect(rm.json.ds_present).toBe(false);

    const io = await makeDomain(k, alice, "c20-ds.io");
    const info = await call(k, alice, "GET", `/api/v1/domains/${io.fqdn}/ds`);
    expect(info.json.supported).toBe(false); expect(info.json.note).toContain("not available for .io");
    const res = await call(k, alice, "POST", `/api/v1/domains/${io.fqdn}/ds`, {}, await stepUp(k, alice, "domain.nameservers.change", io.fqdn, { kind: "ds_add", ds }));
    expect(res.status).toBe(409); expect(res.json.error.code).toBe("dnssec_unsupported");
  });

  it("ST-58, ST-122: the step-up summary and the signed params name the DS record, so two different removals never read the same", async () => {
    const d = await makeDomain(k, alice, "c20-ds-summary.com");
    const one = { keyTag: 11111, algorithm: 13, digestType: 2, digest: "A1B2C3D4E5F60718".repeat(4) };
    const two = { keyTag: 22222, algorithm: 8, digestType: 1, digest: "0f".repeat(20) };
    const prep = async (kind: string, ds: typeof one) => {
      const r = await call(k, alice, "POST", "/api/v1/actions/prepare", { type: "domain.nameservers.change", target_id: d.fqdn, user_input: { kind, ds } });
      expect(r.status, r.text).toBe(200);
      const params = (await row("select params from actions where id = $1", [r.json.action_id]))[0].params;
      return { summary: r.json.summary as string, params };
    };
    const a = await prep("ds_remove", one), b = await prep("ds_remove", two);
    expect(a.summary).not.toBe(b.summary);
    // Key tag, algorithm, digest type and a short prefix of the digest (lower case, as relayed), never the whole digest.
    expect(a.summary).toBe(`Remove the DNSSEC record with key tag 11111, algorithm 13, digest type 2, digest a1b2c3d4e5f60718… from ${d.fqdn}.`);
    expect(b.summary).toBe(`Remove the DNSSEC record with key tag 22222, algorithm 8, digest type 1, digest 0f0f0f0f0f0f0f0f… from ${d.fqdn}.`);
    expect(a.summary).not.toContain(one.digest.toLowerCase());
    const add = await prep("ds_add", one);
    expect(add.summary).toBe(`Add the DNSSEC record with key tag 11111, algorithm 13, digest type 2, digest a1b2c3d4e5f60718… to ${d.fqdn}.`);
    // The identity is in the params the passkey signs (hashed into the challenge), and the summary is rendered from those params.
    for (const [x, ds] of [[a, one], [b, two]] as const) {
      expect(x.params.ds).toEqual({ ...ds, digest: ds.digest.toLowerCase() });
      expect(x.params.ds_label).toBe(`key tag ${ds.keyTag}, algorithm ${ds.algorithm}, digest type ${ds.digestType}, digest ${ds.digest.toLowerCase().slice(0, 16)}…`);
    }
    // Changing only the digest after the first 16 characters still changes what is signed.
    const tail = await prep("ds_remove", { ...one, digest: one.digest.slice(0, 60) + "ffff" });
    expect(tail.params.ds.digest).not.toBe(a.params.ds.digest);
  });
});
