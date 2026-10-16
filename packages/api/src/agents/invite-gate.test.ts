import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { bearer, bindingRow, clearCounters, createAgentToken, makeAgentKit, makeDomain, makeOwner, requestRow, stepUp, web, type AgentKit, type Owner } from "./testkit.ts";

let k: AgentKit;
beforeAll(async () => { k = await makeAgentKit(); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await clearCounters(k); });
afterEach(() => { (k.app.ctx.services as { liveGate?: boolean }).liveGate = false; });

const gate = () => { (k.app.ctx.services as { liveGate?: boolean }).liveGate = true; };
const orders = async (id: string) => (await k.app.db.owner.query("select count(*)::int n from orders where agent_request_id = $1", [id])).rows[0].n;
const action = async (id: string) => (await k.app.db.owner.query("select * from actions where id = $1", [id])).rows[0];

/** Model a successfully redeemed invitation; the actual signup ceremony is covered in waitlist/gate.test.ts. */
async function invite(p: Owner) {
  const w = (await k.app.db.owner.query(
    "insert into waitlist (email, consent_hash, consented_at, source, created_at, confirmed_at, invited_at) values ($1, $2, now(), 'page', now(), now(), now()) returning id",
    [p.login, crypto.randomBytes(32)])).rows[0].id;
  await k.app.db.owner.query(
    "insert into waitlist_invites (waitlist_id, token_hash, created_at, expires_at, used_at, used_by) values ($1, $2, now(), now() + interval '14 days', now(), $3)",
    [w, crypto.randomBytes(32), p.user.userId]);
}

describe("invite-only agent purchase approvals", () => {
  it.each(["register", "renew"] as const)("blocks an uninvited %s approval before effects and preserves it for an invited retry", async (kind) => {
    const p = await makeOwner(k, `invite-${kind}`);
    const fqdn = `free-invite-${kind}.com`;
    if (kind === "renew") await makeDomain(k, p, fqdn);
    const scopes = kind === "renew" ? [`renew.propose:${fqdn}`] : ["register.propose:*"];
    const t = await createAgentToken(k, p, scopes, { cap: 1_000_000 });
    const proposal = await bearer(k, t.token, "POST", "/api/v1/agent/proposals", { kind, domain: fqdn });
    expect(proposal.status, proposal.text).toBe(202);
    const id = proposal.json.approval_id as string;
    const signed = await stepUp(k, p, "agent.purchase.approve", id, { typed_domain: fqdn });
    expect(signed.status, JSON.stringify(signed.json)).toBe(200);
    const before = {
      request: await requestRow(k, id), action: await action(signed.actionId), binding: await bindingRow(k, t.id),
      stripeCalls: { ...k.h.stripe.calls }, stripeCreated: { ...k.h.stripe.created }, emails: k.app.email.sent.length,
    };
    expect(before.action.state).toBe("committed");
    gate();
    const decide = () => web(k, p, "POST", `/api/v1/approvals/${id}/decide`, {}, { [ACTION_HEADER]: signed.actionId });
    const blocked = await decide();
    expect([blocked.status, blocked.json.error?.code]).toEqual([403, "invite_required"]);
    expect(await requestRow(k, id)).toEqual(before.request);
    expect(await action(signed.actionId)).toEqual(before.action);
    expect((await bindingRow(k, t.id)).reserved_minor).toBe(before.binding.reserved_minor);
    expect(await orders(id)).toBe(0);
    expect(k.h.stripe.calls).toEqual(before.stripeCalls);
    expect(k.h.stripe.created).toEqual(before.stripeCreated);
    expect(k.app.email.sent).toHaveLength(before.emails);
    expect((await k.app.db.owner.query("select count(*)::int n from audit_log where action = 'agent.request.approved' and resource_id = $1", [id])).rows[0].n).toBe(0);

    await invite(p);
    const allowed = await decide();
    expect(allowed.status, allowed.text).toBe(200);
    expect(allowed.json.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect((await action(signed.actionId)).state).toBe("executed");
    expect((await requestRow(k, id)).state).toBe("approved");
    expect(await orders(id)).toBe(1);
    expect(k.h.stripe.created.sessions).toBe(before.stripeCreated.sessions + 1);
  });

  it("lets an uninvited owner decline and release a pending reservation while the gate is on", async () => {
    const p = await makeOwner(k, "invite-decline");
    const t = await createAgentToken(k, p, ["register.propose:*"], { cap: 1_000_000 });
    const proposal = await bearer(k, t.token, "POST", "/api/v1/agent/proposals", { kind: "register", domain: "free-invite-decline.com" });
    expect(proposal.status, proposal.text).toBe(202);
    const id = proposal.json.approval_id as string;
    expect(BigInt((await bindingRow(k, t.id)).reserved_minor)).toBeGreaterThan(0n);
    gate();
    const declined = await web(k, p, "POST", `/api/v1/approvals/${id}/decline`);
    expect(declined.status, declined.text).toBe(200);
    expect(await requestRow(k, id)).toMatchObject({ state: "declined", reservation: "released" });
    expect(BigInt((await bindingRow(k, t.id)).reserved_minor)).toBe(0n);
    expect(await orders(id)).toBe(0);
  });
});
