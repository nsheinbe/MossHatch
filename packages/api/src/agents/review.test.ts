import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { orderRow } from "../orders/testkit.ts";
import { approvePurchase, bearer, bindingRow, clearCounters, createAgentToken, makeAgentKit, makeDomain, makeOwner, requestRow, stepUp, web, type AgentKit } from "./testkit.ts";

/**
 * Review findings on the agent surface (independent review, 2026-09-30). Each test failed on the code as it was and names
 * the plan row it defends.
 */

let k: AgentKit;
beforeAll(async () => { k = await makeAgentKit(); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => {
  await clearCounters(k);
  await k.app.db.owner.query("update flags set value = '1000' where name = 'pricing.tax_ceiling_bps'");
  await k.app.db.owner.query("update flags set value = 'false' where name in ('orders_paused', 'agent_purchases_paused')");
});

const propose = (token: string, domain: string) => bearer(k, token, "POST", "/api/v1/agent/proposals", { kind: "register", domain });
const quoteCom = () => k.h.subtotal("com") + (k.h.subtotal("com") * 1000n + 9999n) / 10000n;
let n = 0;
const fresh = () => `free-review${++n}x${Date.now().toString(36)}.com`;
const ordersFor = async (id: string) => (await k.app.db.owner.query("select id, total_minor from orders where agent_request_id = $1", [id])).rows;
const flag = (name: string, value: string) => k.app.db.owner.query("update flags set value = $2::jsonb where name = $1", [name, value]);

describe("ST-77 review: the order an approval creates never costs more than, or accepts other terms than, what the passkey signed", () => {
  it("Pay now after the approval refuses a quote that rose since, fails the request and releases its reservation", async () => {
    const p = await makeOwner(k, "rv-price");
    const t = await createAgentToken(k, p, ["register.propose:*"], { cap: 1_000_000 });
    const r = await propose(t.token, fresh());
    expect(r.status, r.text).toBe(202);
    const id = r.json.approval_id as string;
    // Orders are paused when the person approves: the approval stands and the order waits for "Pay now".
    await flag("orders_paused", "true");
    const ok = await approvePurchase(k, p, id, (await requestRow(k, id)).fqdn_ascii);
    expect(ok.status, ok.text).toBe(503);
    expect((await requestRow(k, id)).state).toBe("approved");
    await flag("orders_paused", "false");
    // The tax ceiling rises before the person presses Pay now: the maximum total is no longer the one signed.
    await flag("pricing.tax_ceiling_bps", "1500");
    const pay = await web(k, p, "POST", `/api/v1/approvals/${id}/checkout`);
    expect(pay.status, pay.text).toBe(409);
    expect(pay.json.error.code).toBe("price_changed");
    expect(pay.json.checkout_url).toBeUndefined();
    for (const o of await ordersFor(id)) expect(BigInt(o.total_minor)).toBeLessThanOrEqual(quoteCom());
    expect((await requestRow(k, id)).state).toBe("failed");
    expect(BigInt((await bindingRow(k, t.id)).reserved_minor)).toBe(0n);
  });

  it("Pay now after the approval refuses terms that changed since, so no consent is recorded on documents the person never signed", async () => {
    const p = await makeOwner(k, "rv-terms");
    const t = await createAgentToken(k, p, ["register.propose:*"], { cap: 1_000_000 });
    const r = await propose(t.token, fresh());
    const id = r.json.approval_id as string;
    await flag("orders_paused", "true");
    const ok = await approvePurchase(k, p, id, (await requestRow(k, id)).fqdn_ascii);
    expect(ok.status, ok.text).toBe(503);
    await flag("orders_paused", "false");
    const doc = (await k.app.db.owner.query("insert into document_versions (kind, version_hash, effective_at) values ('terms', 'termshash-review-new-0001', $1) returning id", [new Date(k.app.clock.now().getTime() - 1000)])).rows[0];
    try {
      const pay = await web(k, p, "POST", `/api/v1/approvals/${id}/checkout`);
      expect(pay.status, pay.text).toBe(409);
      expect(pay.json.error.code).toBe("terms_changed");
      expect((await k.app.db.owner.query("select count(*)::int n from consents where user_id = $1 and document_hash = 'termshash-review-new-0001'", [p.user.userId])).rows[0].n).toBe(0);
      expect(await ordersFor(id)).toHaveLength(0);
      expect((await requestRow(k, id)).state).toBe("failed");
    } finally {
      await k.app.db.owner.query("delete from document_versions where id = $1", [doc.id]);
    }
  });

  it("an unchanged quote still reaches its Checkout through Pay now, and the order carries the signed amounts", async () => {
    const p = await makeOwner(k, "rv-same");
    const t = await createAgentToken(k, p, ["register.propose:*"], { cap: 1_000_000 });
    const r = await propose(t.token, fresh());
    const id = r.json.approval_id as string;
    await flag("orders_paused", "true");
    expect((await approvePurchase(k, p, id, (await requestRow(k, id)).fqdn_ascii)).status).toBe(503);
    await flag("orders_paused", "false");
    const pay = await web(k, p, "POST", `/api/v1/approvals/${id}/checkout`);
    expect(pay.status, pay.text).toBe(200);
    expect(pay.json.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const o = await orderRow(k.h, pay.json.order_id);
    expect(BigInt(o.total_minor)).toBe(quoteCom());
    expect((await requestRow(k, id)).state).toBe("approved");
  });
});

describe("ST-77 review: a renewal approval with an unchanged quote still reaches its Checkout", () => {
  it("is approved and opens the renewal's Checkout at no more than the signed amounts", async () => {
    const p = await makeOwner(k, "rv-renew");
    const d = await makeDomain(k, p, `free-renew${++n}x${Date.now().toString(36)}.com`);
    const t = await createAgentToken(k, p, [`renew.propose:${d.fqdn}`, "register.propose:*"], { cap: 1_000_000 });
    const r = await bearer(k, t.token, "POST", "/api/v1/agent/proposals", { kind: "renew", domain: d.fqdn });
    expect(r.status, r.text).toBe(202);
    const id = r.json.approval_id as string;
    const ok = await approvePurchase(k, p, id, d.fqdn);
    expect(ok.status, ok.text).toBe(200);
    const row = await requestRow(k, id);
    expect(row.state).toBe("approved");
    const o = await orderRow(k.h, ok.json.order_id);
    expect(BigInt(o.total_minor)).toBeLessThanOrEqual(BigInt(row.quoted_minor));
  });
});

describe("ST-75 review: a proposal repeated after its twin expired, before the sweeper ran", () => {
  it("is a new pending request, not a server error, and the binding holds one reservation", async () => {
    const p = await makeOwner(k, "rv-twin");
    const t = await createAgentToken(k, p, ["register.propose:*"], { cap: 1_000_000 });
    const name = fresh();
    const a = await propose(t.token, name);
    expect(a.status, a.text).toBe(202);
    await k.app.db.owner.query("update agent_requests set expires_at = $2 where id = $1", [a.json.approval_id, new Date(k.app.clock.now().getTime() - 1000)]);
    const b = await propose(t.token, name);
    expect(b.status, b.text).toBe(202);
    expect(b.json.created).toBe(true);
    expect(b.json.approval_id).not.toBe(a.json.approval_id);
    expect((await requestRow(k, a.json.approval_id)).state).toBe("expired");
    expect((await requestRow(k, a.json.approval_id)).reservation).toBe("released");
    expect(BigInt((await bindingRow(k, t.id)).reserved_minor)).toBe(quoteCom());
  });
});

describe("ST-133 review: the agent_purchases_paused kill switch (PLAN 4.3b Release, 4.4 flags) is read on the agent purchase paths", () => {
  it("refuses new proposals, the approval ceremony and the order while set, and lets them through once cleared", async () => {
    const p = await makeOwner(k, "rv-kill");
    const t = await createAgentToken(k, p, ["register.propose:*"], { cap: 1_000_000 });
    const before = await propose(t.token, fresh());
    expect(before.status, before.text).toBe(202);
    const id = before.json.approval_id as string;
    const fq = (await requestRow(k, id)).fqdn_ascii;
    await flag("agent_purchases_paused", "true");
    const paused = await propose(t.token, fresh());
    expect(paused.status, paused.text).toBe(503);
    expect(paused.json.error.code).toBe("agent_purchases_paused");
    const s = await stepUp(k, p, "agent.purchase.approve", id, { typed_domain: fq });
    expect(s.status).toBe(503);
    expect(s.json.error.code).toBe("agent_purchases_paused");
    expect(await ordersFor(id)).toHaveLength(0);
    expect((await requestRow(k, id)).state).toBe("pending");
    // An approval signed before the switch was set does not create the order while it is set; Pay now works once cleared.
    await flag("agent_purchases_paused", "false");
    const signed = await stepUp(k, p, "agent.purchase.approve", id, { typed_domain: fq });
    expect(signed.status, JSON.stringify(signed.json)).toBe(200);
    await flag("agent_purchases_paused", "true");
    const decide = await web(k, p, "POST", `/api/v1/approvals/${id}/decide`, {}, { "x-mh-action-id": signed.actionId });
    expect(decide.status, decide.text).toBe(503);
    expect(await ordersFor(id)).toHaveLength(0);
    await flag("agent_purchases_paused", "false");
    const pay = await web(k, p, "POST", `/api/v1/approvals/${id}/checkout`);
    expect(pay.status, pay.text).toBe(200);
    expect(await ordersFor(id)).toHaveLength(1);
  });
});
