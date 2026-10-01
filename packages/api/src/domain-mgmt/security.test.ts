import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrarError } from "@mosshatch/registrar/port";
import { call, everythingStored, makeDomain, makeKit, makePerson, refreshSession, resetFuse, resetPrepareLimit, stepUp, tick, type Kit, type Person } from "./testkit.ts";

let k: Kit; let alice: Person; let bob: Person;
beforeAll(async () => { k = await makeKit(); alice = await makePerson(k, "alice"); bob = await makePerson(k, "bob"); }, 120_000);
afterAll(async () => { await k?.app.drop(); });
beforeEach(async () => { await resetFuse(k); k.app.email.clear(); });

const linkOf = (text: string) => /email-actions\/([A-Za-z0-9_-]{43})/.exec(text)?.[1];
/** Every one of the person's three addresses received exactly this kind of notice, and each has a freeze link. */
function expectNotice(p: Person, kind: string) {
  for (const to of [p.login, p.second, p.registrantAddr]) {
    const m = k.app.email.to(to).filter((x) => x.kind === kind);
    expect(m.length, `${kind} to ${to}`).toBe(1);
    expect(linkOf(m[0]!.text), `freeze link in ${kind} to ${to}`).toBeTruthy();
  }
}

describe("ST-122: gated routes refuse without a committed action", () => {
  it("unlock, nameserver change, DS change, contact change and code issue return 403 step_up_required with no action, a wrong-type action and an action for another domain", async () => {
    const d = await makeDomain(k, alice, "st122-a.com");
    const other = await makeDomain(k, alice, "st122-b.com");
    const routes: [string, string, unknown][] = [
      ["POST", `/api/v1/domains/${d.fqdn}/unlock`, {}], ["POST", `/api/v1/domains/${d.fqdn}/nameservers`, { nameservers: ["ns1.example.net", "ns2.example.net"] }],
      ["POST", `/api/v1/domains/${d.fqdn}/ds`, {}], ["POST", `/api/v1/domains/${d.fqdn}/contact`, {}], ["POST", `/api/v1/domains/${d.fqdn}/transfer-out`, {}],
    ];
    for (const [m, path, body] of routes) {
      const none = await call(k, alice, m, path, body);
      expect(none.status, path).toBe(403); expect(none.json.error.code, path).toBe("step_up_required");
    }
    // A committed unlock for st122-b does not open the unlock of st122-a, and an unlock action is not a nameserver action.
    const unlockB = await stepUp(k, alice, "domain.unlock", other.fqdn);
    const wrongDomain = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, unlockB);
    expect(wrongDomain.status).toBe(403); expect(wrongDomain.json.error.code).toBe("step_up_required");
    const wrongType = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/nameservers`, {}, unlockB);
    expect(wrongType.status).toBe(403); expect(wrongType.json.error.code).toBe("step_up_required");
    expect((await k.app.db.owner.query("select locked from domains where id = $1", [d.id])).rows[0].locked).toBe(true);
    expect(k.registrar.domainRecord(d.fqdn)!.locked).toBe(true);
  });

  it("an action is single use, and a bearer or anonymous caller never reaches the handler", async () => {
    const d = await makeDomain(k, alice, "st122-once.com");
    const id = await stepUp(k, alice, "domain.unlock", d.fqdn);
    expect((await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, id)).status).toBe(200);
    const again = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, id);
    expect(again.status).toBeGreaterThanOrEqual(400);
    const anon = await k.app.call("POST", `/api/v1/domains/${d.fqdn}/unlock`, { body: {} });
    expect([401, 403]).toContain(anon.status);
  });

  it("a DS record blocks a nameserver change to unsigned DNS: at prepare, and at the route when only the registrar knows the DS", async () => {
    const d = await makeDomain(k, alice, "st122-ds.com");
    await k.registrar.addDs(d.fqdn, { keyTag: 12345, algorithm: 13, digestType: 2, digest: "ab".repeat(32) });
    // Our copy is stale (ds_present false): the route asks the registrar, which refuses.
    const id = await stepUp(k, alice, "domain.nameservers.change", d.fqdn, { kind: "nameservers", nameservers: ["ns1.example.net", "ns2.example.net"] });
    const res = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/nameservers`, {}, id);
    expect(res.status).toBe(409); expect(res.json.error.code).toBe("dnssec_would_break");
    expect(k.registrar.domainRecord(d.fqdn)!.nameservers.every((n) => n.endsWith("systemdns.com"))).toBe(true);
    // The refusal rolled back the use of the action: it is still committed, not executed.
    expect((await k.app.db.owner.query("select state from actions where id = $1", [id])).rows[0].state).toBe("committed");
    // Once our copy knows, the change is refused at prepare, before any passkey touch.
    await k.app.db.owner.query("update domains set ds_present = true where id = $1", [d.id]);
    const prep = await call(k, alice, "POST", "/api/v1/actions/prepare", { type: "domain.nameservers.change", target_id: d.fqdn, user_input: { kind: "nameservers", nameservers: ["ns1.example.net", "ns2.example.net"] } });
    expect(prep.status).toBe(409); expect(prep.json.error.code).toBe("dnssec_would_break");
  });

  it("nameserver change works with a committed action, is bound to the params, and glue is refused plainly", async () => {
    const d = await makeDomain(k, alice, "st122-ns.com");
    const glue = await call(k, alice, "POST", "/api/v1/actions/prepare", { type: "domain.nameservers.change", target_id: d.fqdn, user_input: { kind: "nameservers", nameservers: [`ns1.${d.fqdn}`, `ns2.${d.fqdn}`] } });
    expect(glue.status).toBe(422); expect(glue.json.error.code).toBe("glue_unsupported");
    const id = await stepUp(k, alice, "domain.nameservers.change", d.fqdn, { kind: "nameservers", nameservers: ["ns1.example.net", "ns2.example.net"] });
    const ok = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/nameservers`, { nameservers: ["evil.example.org", "evil2.example.org"] }, id);
    expect(ok.status).toBe(200);
    expect(ok.json.nameservers).toEqual(["ns1.example.net", "ns2.example.net"]);          // the body is ignored; the committed params rule
    expect(k.registrar.domainRecord(d.fqdn)!.nameservers).toEqual(["ns1.example.net", "ns2.example.net"]);
    const row = (await k.app.db.owner.query("select nameservers, dns_hosted_here from domains where id = $1", [d.id])).rows[0];
    expect(row.nameservers).toEqual(["ns1.example.net", "ns2.example.net"]); expect(row.dns_hosted_here).toBe(false);
  });

  it("a recovery hold refuses the four specs at prepare", async () => {
    const p = await makePerson(k, "held");
    const d = await makeDomain(k, p, "st122-held.com");
    await k.app.db.owner.query("insert into action_holds (user_id, scope, until) values ($1,'all_held', now() + interval '1 day')", [p.user.userId]);
    for (const [type, target, input] of [["domain.unlock", d.fqdn, {}], ["domain.nameservers.change", d.fqdn, { kind: "nameservers", nameservers: ["a.example.net", "b.example.net"] }]] as const) {
      const r = await call(k, p, "POST", "/api/v1/actions/prepare", { type, target_id: target, user_input: input });
      expect(r.status, type).toBe(423);
    }
  });

  it("registrar_writes_paused fails closed for gated writes and does not stop locking", async () => {
    const d = await makeDomain(k, alice, "st122-paused.com");
    const id = await stepUp(k, alice, "domain.unlock", d.fqdn);
    await k.app.db.owner.query("update flags set value = 'true' where name = 'registrar_writes_paused'");
    try {
      const res = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, id);
      expect(res.status).toBe(503); expect(res.json.error.code).toBe("registrar_writes_paused");
      expect((await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/lock`, {})).status).toBe(200);
    } finally { await k.app.db.owner.query("update flags set value = 'false' where name = 'registrar_writes_paused'"); }
  });
});

describe("ST-123: every unlock, code issue, nameserver change and contact change emails every address with a freeze link", () => {
  it("unlock", async () => {
    const d = await makeDomain(k, alice, "st123-unlock.com");
    const id = await stepUp(k, alice, "domain.unlock", d.fqdn);
    expect((await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, id)).status).toBe(200);
    expectNotice(alice, "domain.unlocked");
  });

  it("code issue, nameserver change and DS change", async () => {
    const d = await makeDomain(k, alice, "st123-code.com");
    await k.app.db.owner.query("update domains set locked = false where id = $1", [d.id]); await k.registrar.setLock(d.fqdn, false);
    const code = await stepUp(k, alice, "domain.transfer_out", d.fqdn);
    expect((await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/transfer-out`, {}, code)).status).toBe(200);
    expectNotice(alice, "domain.code_issued");
    const ns = await stepUp(k, alice, "domain.nameservers.change", d.fqdn, { kind: "nameservers", nameservers: ["ns1.example.net", "ns2.example.net"] });
    expect((await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/nameservers`, {}, ns)).status).toBe(200);
    expectNotice(alice, "domain.nameservers_changed");
    const ds = await stepUp(k, alice, "domain.nameservers.change", d.fqdn, { kind: "ds_add", ds: { keyTag: 1, algorithm: 13, digestType: 2, digest: "cd".repeat(32) } });
    expect((await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/ds`, {}, ds)).status).toBe(200);
    expectNotice(alice, "domain.ds_changed");
    expect((await k.app.db.owner.query("select ds_present from domains where id = $1", [d.id])).rows[0].ds_present).toBe(true);
  });

  it("contact change, and the freeze link in the notice really freezes the account without unlocking or changing anything", async () => {
    const p = await makePerson(k, "carol");
    const d = await makeDomain(k, p, "st123-contact.com");
    const draft = await call(k, p, "POST", `/api/v1/domains/${d.fqdn}/contact-drafts`, { name: "Ada Moss", email: "new-owner@example.org", phone: "+1.5555550100", street: "1 Fern Lane", city: "Portland", region: "OR", postalCode: "97201", country: "US" });
    expect(draft.status).toBe(201);
    const id = await stepUp(k, p, "domain.contact.change", draft.json.id);
    const res = await call(k, p, "POST", `/api/v1/domains/${d.fqdn}/contact`, {}, id);
    expect(res.status).toBe(202);
    expectNotice(p, "domain.contact_change");
    const token = linkOf(k.app.email.to(p.second).find((m) => m.kind === "domain.contact_change")!.text)!;
    const before = k.registrar.domainRecord(d.fqdn)!;
    const nsBefore = [...before.nameservers], lockedBefore = before.locked;
    const go = await k.app.call("POST", `/api/v1/email-actions/${token}`, { body: { confirm: true } });
    expect(go.status).toBe(200);
    expect((await k.app.db.owner.query("select frozen_at from users where id = $1", [p.user.userId])).rows[0].frozen_at).not.toBeNull();
    expect(k.registrar.domainRecord(d.fqdn)!.nameservers).toEqual(nsBefore);
    expect(k.registrar.domainRecord(d.fqdn)!.locked).toBe(lockedBefore);
  });
});

describe("ST-120 and ST-22: the transfer code is shown once and stored nowhere", () => {
  it("the code is in the response only; only the issue time is stored; it is replaced after 24 hours and at re-lock; a stored code is never read back", async () => {
    const d = await makeDomain(k, alice, "st120-code.com");
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((s) => vi.spyOn(console, s).mockImplementation(() => undefined));
    let code: string;
    try {
      const unlock = await stepUp(k, alice, "domain.unlock", d.fqdn);
      await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, unlock);
      const id = await stepUp(k, alice, "domain.transfer_out", d.fqdn);
      const res = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/transfer-out`, {}, id);
      expect(res.status).toBe(200);
      code = res.json.code as string;
      expect(code).toMatch(/^[A-Za-z0-9]{20}$/);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(k.registrar.authCodeMatches(d.fqdn, code)).toBe(true);

      // Canary: the code appears in no job payload, audit row, log, column, alert, email or later read.
      const stored = await everythingStored(k);
      const security = await call(k, alice, "GET", `/api/v1/domains/${d.fqdn}/security`);
      const transfer = await call(k, alice, "GET", `/api/v1/domains/${d.fqdn}/transfer`);
      const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
      for (const hay of [stored, security.text, transfer.text, logged]) expect(hay.includes(code)).toBe(false);
      const sec = (await k.app.db.owner.query("select * from domain_security where domain_id = $1", [d.id])).rows[0];
      expect(sec.code_issued_at).not.toBeNull();
      expect(Object.keys(sec).filter((c) => /code|auth/.test(c)).sort()).toEqual(["code_issued_at", "code_rerandomize_at", "code_rerandomized_at"]);
      const job = (await k.app.db.owner.query("select payload, run_at from jobs where kind = 'domain.code_rerandomize' and payload->>'domain_id' = $1", [d.id])).rows[0];
      expect(Object.keys(job.payload)).toEqual(["domain_id"]);
      expect(security.json.transfer_code.issued_at).toBeTruthy();
    } finally { spies.forEach((s) => s.mockRestore()); }

    // The port has no way to read a code back (the plan's allow-list has no such command).
    expect("getAuthCode" in k.registrar).toBe(false);

    // 23 hours later nothing has changed; after 24 hours the tick replaces the code with one nobody saw.
    k.app.clock.advance(23 * 3600_000);
    await tick(k);
    expect(k.registrar.authCodeMatches(d.fqdn, code!)).toBe(true);
    k.app.clock.advance(61 * 60_000);
    await tick(k);
    expect(k.registrar.authCodeMatches(d.fqdn, code!)).toBe(false);
    const after = (await k.app.db.owner.query("select code_rerandomized_at, code_rerandomize_at from domain_security where domain_id = $1", [d.id])).rows[0];
    expect(after.code_rerandomized_at).not.toBeNull(); expect(after.code_rerandomize_at).toBeNull();
    await refreshSession(k, alice);
    expect((await k.app.db.owner.query("select 1 from audit_log where action = 'domain.code_rerandomized' and resource_id = $1", [d.id])).rowCount).toBe(1);
  });

  it("re-locking replaces an outstanding code", async () => {
    const d = await makeDomain(k, alice, "st120-relock.com");
    await stepUp(k, alice, "domain.unlock", d.fqdn).then((id) => call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, id));
    const id = await stepUp(k, alice, "domain.transfer_out", d.fqdn);
    const code = (await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/transfer-out`, {}, id)).json.code as string;
    expect(k.registrar.authCodeMatches(d.fqdn, code)).toBe(true);
    const relock = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/lock`, {});
    expect(relock.status).toBe(200); expect(relock.json.code_replaced).toBe(true);
    expect(k.registrar.authCodeMatches(d.fqdn, code)).toBe(false);
    expect(k.registrar.domainRecord(d.fqdn)!.locked).toBe(true);
  });

  it("code issue needs an unlocked domain, and .io codes become a human request instead of a code", async () => {
    const d = await makeDomain(k, alice, "st120-locked.com");
    const prep = await call(k, alice, "POST", "/api/v1/actions/prepare", { type: "domain.transfer_out", target_id: d.fqdn, user_input: {} });
    expect(prep.status).toBe(409); expect(prep.json.error.code).toBe("domain_locked");
    const io = await makeDomain(k, alice, "st120-request.io");
    await stepUp(k, alice, "domain.unlock", io.fqdn).then((id) => call(k, alice, "POST", `/api/v1/domains/${io.fqdn}/unlock`, {}, id));
    const id = await stepUp(k, alice, "domain.transfer_out", io.fqdn);
    const res = await call(k, alice, "POST", `/api/v1/domains/${io.fqdn}/transfer-out`, {}, id);
    expect(res.status).toBe(202); expect(res.json.code).toBeUndefined(); expect(res.json.status).toBe("requested");
    expect((await k.app.db.owner.query("select kind, state from domain_tickets where domain_id = $1", [io.id])).rows).toEqual([{ kind: "code_request", state: "open" }]);
  });
});

describe("ST-115 (route level): the velocity fuse", () => {
  it("the sixth code issue in an hour is refused and alerts; the action is not consumed", async () => {
    const p = await makePerson(k, "fuse");
    const d = await makeDomain(k, p, "st115-fuse.com");
    await stepUp(k, p, "domain.unlock", d.fqdn).then((id) => call(k, p, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, id));
    for (let i = 1; i <= 5; i++) {
      const id = await stepUp(k, p, "domain.transfer_out", d.fqdn);
      const r = await call(k, p, "POST", `/api/v1/domains/${d.fqdn}/transfer-out`, {}, id);
      expect(r.status, `issue ${i}`).toBe(200);
    }
    const sixth = await stepUp(k, p, "domain.transfer_out", d.fqdn);
    const before = k.registrar.calls.issueAuthCode;
    const r = await call(k, p, "POST", `/api/v1/domains/${d.fqdn}/transfer-out`, {}, sixth);
    expect(r.status).toBe(429); expect(r.json.error.code).toBe("fuse_tripped");
    expect(k.registrar.calls.issueAuthCode).toBe(before);
    expect((await k.app.db.owner.query("select state from actions where id = $1", [sixth])).rows[0].state).toBe("committed");
    const alert = (await k.app.db.owner.query("select severity, subject from alerts where kind = 'registrar.fuse_tripped' and state = 'open'")).rows;
    expect(alert).toEqual([{ severity: "page", subject: "code_issue" }]);
    // The refusal cost nothing: once the window has moved on (counters cleared), the same committed action still works.
    await resetFuse(k);
    expect((await call(k, p, "POST", `/api/v1/domains/${d.fqdn}/transfer-out`, {}, sixth)).status).toBe(200);
  });

  it("a fuse tripped inside the adapter comes back as 429 and leaves the action usable", async () => {
    const p = await makePerson(k, "fuse2");
    const d = await makeDomain(k, p, "st115-adapter.com");
    const id = await stepUp(k, p, "domain.unlock", d.fqdn);
    const orig = k.registrar.setLock.bind(k.registrar);
    k.registrar.setLock = async () => { throw new RegistrarError("rate_limited", "velocity fuse tripped", { retryable: false, outcomeUnknown: false, code: "fuse_unlock" }); };
    try {
      const r = await call(k, p, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, id);
      expect(r.status).toBe(429); expect(r.json.error.code).toBe("fuse_tripped");
    } finally { k.registrar.setLock = orig; }
    expect((await k.app.db.owner.query("select state from actions where id = $1", [id])).rows[0].state).toBe("committed");
    expect((await call(k, p, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, id)).status).toBe(200);
  });

  it("the eleventh unlock in an hour is refused", async () => {
    const p = await makePerson(k, "fuse3");
    for (let i = 1; i <= 11; i++) {
      const d = await makeDomain(k, p, `st115-unlock-${i}.com`);
      await resetPrepareLimit(k);
      const id = await stepUp(k, p, "domain.unlock", d.fqdn);
      const r = await call(k, p, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, id);
      expect(r.status, `unlock ${i}`).toBe(i <= 10 ? 200 : 429);
    }
  });
});
