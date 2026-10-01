import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mintToken } from "../util/token.ts";
import { signIn } from "../auth/testkit.ts";
import { call, everythingStored, makeDomain, makeKit, makePerson, poll, refreshSession, resetFuse, stepUp, tick, type Kit, type Person } from "./testkit.ts";

let k: Kit; let alice: Person;
beforeAll(async () => { k = await makeKit(); alice = await makePerson(k, "alice"); }, 120_000);
afterAll(async () => { await k?.app.drop(); });
beforeEach(async () => { await resetFuse(k); k.app.email.clear(); });

const linkOf = (text: string) => /email-actions\/([A-Za-z0-9_-]{43})/.exec(text)?.[1];
const row = async (sql: string, args: unknown[]) => (await k.app.db.owner.query(sql, args)).rows;

describe("ST-125: an unrequested pending transfer-away", () => {
  it("raises the alert within 10 minutes, turns the domain to needs attention, emails every address; Stop re-locks, re-randomises the code and opens the ticket", async () => {
    const d = await makeDomain(k, alice, "st125-hostile.com");
    // The attacker knows a code (leaked from an earlier issue, or set through the registrar's own end-user interface).
    const code = "LeakedCode2026xyz";
    k.registrar.setAuthInfo(d.fqdn, code);
    k.registrar.oob.setLock(d.fqdn, false);
    k.app.email.clear();

    // The attacker's transfer starts out of band, three days after our own code was issued (so no committed action matches it).
    k.app.clock.advance(3 * 86_400_000);
    await refreshSession(k, alice);
    const started = k.app.clock.now();
    k.registrar.oob.startTransferAway(d.fqdn, { gainingRegistrar: "Evil Registrar LLC" });
    k.app.clock.advance(4 * 60_000);
    await tick(k);

    const t = (await row("select * from domain_transfers_away where domain_id = $1", [d.id]))[0]!;
    expect(t.explained).toBe(false);
    expect(new Date(t.detected_at).getTime() - started.getTime(), "detected within 10 minutes of the request").toBeLessThanOrEqual(10 * 60_000);
    expect(new Date(t.notified_at).getTime() - started.getTime()).toBeLessThanOrEqual(10 * 60_000);
    expect((await row("select severity, state from alerts where kind = 'transfer.unrequested' and subject = $1", [d.id]))).toEqual([{ severity: "page", state: "open" }]);
    expect((await row("select state from domains where id = $1", [d.id]))[0].state).toBe("needs_attention");
    for (const to of [alice.login, alice.second, alice.registrantAddr]) {
      const m = k.app.email.to(to).find((x) => x.kind === "domain.transfer_unrequested");
      expect(m, to).toBeTruthy();
      expect(m!.text).toContain("You did not ask for it"); expect(m!.text).toContain("Evil Registrar LLC"); expect(linkOf(m!.text)).toBeTruthy();
    }
    // A second poll does not raise a second alert or send a second mail.
    k.app.email.clear();
    k.app.clock.advance(5 * 60_000); await tick(k);
    expect(k.app.email.sent.filter((m) => m.kind === "domain.transfer_unrequested")).toHaveLength(0);
    expect((await row("select id from alerts where kind = 'transfer.unrequested'", []))).toHaveLength(1);

    // What the domain page reads.
    await refreshSession(k, alice);
    const view = await call(k, alice, "GET", `/api/v1/domains/${d.fqdn}/transfer`);
    expect(view.json.state).toBe("unrequested"); expect(view.json.stop_available).toBe(true); expect(view.json.can_cancel_upstream).toBe(false);
    expect(view.json.message).toContain("press Stop this transfer");
    const sec = await call(k, alice, "GET", `/api/v1/domains/${d.fqdn}/security`);
    expect(sec.json.state).toBe("needs_attention"); expect(sec.json.attention.kind).toBe("unrequested_transfer");

    // Stop: re-lock, new code, ticket. The panel says plainly that only the owner or Tucows can end the transfer.
    expect(k.registrar.authCodeMatches(d.fqdn, code)).toBe(true);
    const stop = await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/transfer/stop`, {});
    expect(stop.status).toBe(200);
    expect(stop.json.relocked).toBe(true); expect(stop.json.code_replaced).toBe(true); expect(stop.json.pending_transfer_remains).toBe(true);
    expect(stop.json.message).toContain("decline link"); expect(stop.json.message).toContain("Tucows");
    expect(k.registrar.domainRecord(d.fqdn)!.locked).toBe(true);
    expect(k.registrar.authCodeMatches(d.fqdn, code)).toBe(false);
    const ticket = await row("select kind, state from domain_tickets where domain_id = $1", [d.id]);
    expect(ticket).toEqual([{ kind: "stop_transfer", state: "open" }]);
    expect((await row("select state from domain_transfers_away where domain_id = $1", [d.id]))[0].state).toBe("stopped");
    expect((await row("select 1 from alerts where kind = 'transfer.stop_requested' and state = 'open'", []))).toHaveLength(1);
    // Pressing it twice opens no second ticket.
    expect((await call(k, alice, "POST", `/api/v1/domains/${d.fqdn}/transfer/stop`, {})).status).toBe(200);
    expect((await row("select 1 from domain_tickets where domain_id = $1", [d.id]))).toHaveLength(1);
    expect((await row("select released_at from domains where id = $1", [d.id]))[0].released_at).toBeNull();
    expect(await everythingStored(k)).not.toContain(code);
  });

  it("a transfer that matches a committed transfer-out action is expected: no alert, no needs attention", async () => {
    const p = await makePerson(k, "dave");
    const d = await makeDomain(k, p, "st125-expected.com");
    await stepUp(k, p, "domain.unlock", d.fqdn).then((id) => call(k, p, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, id));
    const id = await stepUp(k, p, "domain.transfer_out", d.fqdn);
    await call(k, p, "POST", `/api/v1/domains/${d.fqdn}/transfer-out`, {}, id);
    k.registrar.oob.startTransferAway(d.fqdn, { gainingRegistrar: "My New Registrar" });
    await poll(k);
    const t = (await row("select explained, state from domain_transfers_away where domain_id = $1", [d.id]))[0];
    expect(t).toEqual({ explained: true, state: "open" });
    expect((await row("select 1 from alerts where kind = 'transfer.unrequested' and subject = $1", [d.id]))).toHaveLength(0);
    expect((await row("select state from domains where id = $1", [d.id]))[0].state).toBe("registered");
    const view = await call(k, p, "GET", `/api/v1/domains/${d.fqdn}/transfer`);
    expect(view.json.state).toBe("requested");
  });

  it("a declined transfer restores the state and closes the alert; a completed one is recorded and the domain is NOT released here", async () => {
    const p = await makePerson(k, "erin");
    const a = await makeDomain(k, p, "st125-declined.com");
    const b = await makeDomain(k, p, "st125-completed.com");
    k.registrar.oob.startTransferAway(a.fqdn); k.registrar.oob.startTransferAway(b.fqdn);
    await poll(k);
    expect((await row("select state from domains where id = any($1) order by fqdn_ascii", [[a.id, b.id]])).map((r) => r.state)).toEqual(["needs_attention", "needs_attention"]);
    k.registrar.oob.setTransferAwayStatus(a.fqdn, "cancelled");
    k.registrar.oob.setTransferAwayStatus(b.fqdn, "completed");
    await poll(k);
    expect((await row("select state from domain_transfers_away where domain_id = $1", [a.id]))[0].state).toBe("ended");
    expect((await row("select state from domains where id = $1", [a.id]))[0].state).toBe("registered");
    expect((await row("select state from alerts where kind = 'transfer.unrequested' and subject = $1", [a.id]))[0].state).toBe("closed");
    expect((await row("select state from domain_transfers_away where domain_id = $1", [b.id]))[0].state).toBe("completed");
    expect((await row("select released_at from domains where id = $1", [b.id]))[0].released_at).toBeNull();
  });

  it("a transfer for a name that is not ours is ignored, and another person cannot press Stop", async () => {
    const p = await makePerson(k, "frank");
    const d = await makeDomain(k, p, "st125-mine.com");
    const other = await makePerson(k, "gina");
    k.registrar.oob.startTransferAway(d.fqdn);
    await poll(k);
    const stop = await call(k, other, "POST", `/api/v1/domains/${d.fqdn}/transfer/stop`, {});
    expect(stop.status).toBe(404);
    expect((await row("select 1 from domain_tickets where domain_id = $1", [d.id]))).toHaveLength(0);
  });
});

describe("ST-148: freeze", () => {
  it("locks the domain, revokes sessions, pauses bindings, keeps passkeys; does not unlock or change nameservers; unfreezing needs a passkey sign-in; renewal still succeeds", async () => {
    const p = await makePerson(k, "hank");
    const d = await makeDomain(k, p, "st148-frozen.com");
    const other = await makeDomain(k, p, "st148-second.com");
    // State the freeze must leave alone: an unlocked domain, changed nameservers, a live renewal mandate.
    const un = await stepUp(k, p, "domain.unlock", d.fqdn).then((id) => call(k, p, "POST", `/api/v1/domains/${d.fqdn}/unlock`, {}, id));
    expect(un.status, un.text).toBe(200);
    const nsId = await stepUp(k, p, "domain.nameservers.change", other.fqdn, { kind: "nameservers", nameservers: ["ns1.example.net", "ns2.example.net"] });
    await call(k, p, "POST", `/api/v1/domains/${other.fqdn}/nameservers`, {}, nsId);
    const codeId = await stepUp(k, p, "domain.transfer_out", d.fqdn);
    const code = (await call(k, p, "POST", `/api/v1/domains/${d.fqdn}/transfer-out`, {}, codeId)).json.code as string;
    const m = mintToken("live");
    await k.app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, expires_at) values ($1,'agent','b',$2,$3, now() + interval '30 days')", [p.user.userId, m.prefix, m.hash]);
    await k.app.db.owner.query("insert into renewal_mandates (domain_id, user_id, stripe_payment_method_ref, price_ceiling_minor, text_hash, retain_until) values ($1,$2,'pm_test',5000,'h', now() + interval '3 years')", [d.id, p.user.userId]);
    await k.app.db.owner.query("update domains set auto_renew = true where id = $1", [d.id]);
    const otherNs = [...k.registrar.domainRecord(other.fqdn)!.nameservers];
    const passkeysBefore = (await row("select count(*)::int n from passkeys where user_id = $1 and revoked_at is null", [p.user.userId]))[0].n;
    const email = k.app.email.to(p.login).find((x) => x.kind === "domain.code_issued")!;
    const token = linkOf(email.text)!;

    // GET shows what the link does and changes nothing; the POST freezes.
    expect((await k.app.call("GET", `/api/v1/email-actions/${token}`)).status).toBe(200);
    expect((await row("select frozen_at from users where id = $1", [p.user.userId]))[0].frozen_at).toBeNull();
    expect((await k.app.call("POST", `/api/v1/email-actions/${token}`, { body: { confirm: true } })).status).toBe(200);
    await tick(k);

    const u = (await row("select frozen_at from users where id = $1", [p.user.userId]))[0];
    expect(u.frozen_at).not.toBeNull();
    // Locked, with the code replaced. Not unlocked, not re-pointed.
    expect(k.registrar.domainRecord(d.fqdn)!.locked).toBe(true);
    expect((await row("select locked from domains where id = $1", [d.id]))[0].locked).toBe(true);
    expect(k.registrar.authCodeMatches(d.fqdn, code)).toBe(false);
    expect(k.registrar.domainRecord(other.fqdn)!.locked).toBe(true);
    expect(k.registrar.domainRecord(other.fqdn)!.nameservers).toEqual(otherNs);
    expect((await row("select nameservers from domains where id = $1", [other.id]))[0].nameservers).toEqual(["ns1.example.net", "ns2.example.net"]);
    // Sessions revoked, bindings paused (not revoked), passkeys kept.
    expect((await row("select count(*)::int n from sessions where user_id = $1 and revoked_at is null", [p.user.userId]))[0].n).toBe(0);
    const bind = (await row("select paused_at, revoked_at from bindings where user_id = $1", [p.user.userId]))[0];
    expect(bind.paused_at).not.toBeNull(); expect(bind.revoked_at).toBeNull();
    expect((await row("select count(*)::int n from passkeys where user_id = $1 and revoked_at is null", [p.user.userId]))[0].n).toBe(passkeysBefore);
    expect((await call(k, p, "GET", `/api/v1/domains/${d.fqdn}/security`)).status).toBe(401);
    expect((await row("select action from audit_log where chain_id = $1 and action = 'domain.frozen'", [p.user.userId])).length).toBe(2);

    // Renewal keeps working: the mandate is untouched, auto-renew is still on, and the registrar renews.
    const mandate = (await row("select revoked_at from renewal_mandates where domain_id = $1", [d.id]))[0];
    expect(mandate.revoked_at).toBeNull();
    expect((await row("select auto_renew from domains where id = $1", [d.id]))[0].auto_renew).toBe(true);
    const year = k.registrar.domainRecord(d.fqdn)!.expiresAt.getUTCFullYear();
    const renewed = await k.registrar.renew(d.fqdn, 1, year);
    expect(renewed.status).toBe("renewed");

    // Unfreezing needs a passkey sign-in: a session cannot exist without one, and the flag stays until then.
    expect((await row("select frozen_at from users where id = $1", [p.user.userId]))[0].frozen_at).not.toBeNull();
    const si = await signIn(k.app, p.key.auth);
    expect(si.res.status, si.res.text).toBe(200);
    expect((await row("select frozen_at from users where id = $1", [p.user.userId]))[0].frozen_at).toBeNull();
    expect((await row("select paused_at from bindings where user_id = $1", [p.user.userId]))[0].paused_at).not.toBeNull();
  });

  it("a freeze while a transfer is pending opens the Stop ticket", async () => {
    const p = await makePerson(k, "ivy");
    const d = await makeDomain(k, p, "st148-pending.com");
    k.registrar.oob.startTransferAway(d.fqdn);
    await poll(k);
    await k.app.db.owner.query("update users set frozen_at = now() where id = $1", [p.user.userId]);
    await tick(k);
    expect((await row("select kind, state from domain_tickets where domain_id = $1", [d.id]))).toEqual([{ kind: "stop_transfer", state: "open" }]);
  });
});
