import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expireDue, reconcileReservations } from "./requests.ts";
import { approvePurchase, bearer, bindingRow, clearCounters, createAgentToken, makeAgentKit, makeOwner, requestRow, stepUp, web, type AgentKit } from "./testkit.ts";

/**
 * ST-74 / ST-75 review: an approval that never got its order (the order path failed after the approval committed, or nobody pressed
 * Pay now) must not hold its spend-cap reservation forever. PLAN 4.5 gives a proposal 72 hours and names no separate expiry for an
 * approved request, so the approval expires 72 hours after it was given (REQUEST_TTL_MS, the approval TTL in code): Pay now is refused
 * from then on, and the sweeper expires it and releases the reservation.
 */

let k: AgentKit;
beforeAll(async () => { k = await makeAgentKit(); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => {
  await clearCounters(k);
  await k.app.db.owner.query("update flags set value = '1000' where name = 'pricing.tax_ceiling_bps'");
  await k.app.db.owner.query("update flags set value = 'false' where name in ('orders_paused', 'agent_purchases_paused')");
});

const HOUR = 3_600_000;
const propose = (token: string, domain: string) => bearer(k, token, "POST", "/api/v1/agent/proposals", { kind: "register", domain });
const quoteCom = () => k.h.subtotal("com") + (k.h.subtotal("com") * 1000n + 9999n) / 10000n;
let n = 0;
const fresh = () => `free-apx${++n}x${Date.now().toString(36)}.com`;
const ordersFor = async (id: string) => (await k.app.db.owner.query("select id from orders where agent_request_id = $1", [id])).rows;
const flag = (name: string, value: string) => k.app.db.owner.query("update flags set value = $2::jsonb where name = $1", [name, value]);
/** Put the approval `ms` in the past without moving the clock (sessions live 8 hours). */
const approvedAgo = (id: string, ms: number) => k.app.db.owner.query("update agent_requests set decided_at = $2 where id = $1", [id, new Date(k.app.clock.now().getTime() - ms)]);

describe("ST-74 review: an approved request with no order releases its reservation when the approval expires", () => {
  it("is kept while the approval is fresh, refused at Pay now once 72 hours old, and expired by the sweeper, which releases the reservation", async () => {
    const p = await makeOwner(k, "apx");
    const t = await createAgentToken(k, p, ["register.propose:*"], { cap: 1_000_000 });
    const reserved = async () => BigInt((await bindingRow(k, t.id)).reserved_minor);
    const r = await propose(t.token, fresh());
    expect(r.status, r.text).toBe(202);
    const id = r.json.approval_id as string;
    const s = await stepUp(k, p, "agent.purchase.approve", id, { typed_domain: (await requestRow(k, id)).fqdn_ascii });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    // The approval commits, then the order path fails with a server-side refusal: the request stays approved with no order.
    await flag("agent_purchases_paused", "true");
    const decide = await web(k, p, "POST", `/api/v1/approvals/${id}/decide`, {}, { "x-mh-action-id": s.actionId });
    expect(decide.status, decide.text).toBe(503);
    await flag("agent_purchases_paused", "false");
    expect(await requestRow(k, id)).toMatchObject({ state: "approved", order_id: null, reservation: "held" });
    expect(await reserved()).toBe(quoteCom());

    // Not yet 72 hours: the sweeper leaves it alone.
    await approvedAgo(id, 71 * HOUR);
    await expireDue(k.app.ctx);
    expect((await requestRow(k, id)).state).toBe("approved");
    expect(await reserved()).toBe(quoteCom());

    // Past 72 hours: Pay now no longer makes the order.
    await approvedAgo(id, 72 * HOUR + 60_000);
    const late = await web(k, p, "POST", `/api/v1/approvals/${id}/checkout`);
    expect(late.status, late.text).toBe(409);
    expect(late.json.error.code).toBe("request_expired");
    expect(await ordersFor(id)).toHaveLength(0);

    // The sweeper expires it and the reservation goes back to the cap.
    await approvedAgo(id, 73 * HOUR);
    expect(await expireDue(k.app.ctx)).toBeGreaterThanOrEqual(1);
    expect(await requestRow(k, id)).toMatchObject({ state: "expired", reservation: "released", decision_reason: "approval_expired" });
    expect(await reserved()).toBe(0n);
    expect((await bearer(k, t.token, "GET", `/api/v1/approvals/${id}`)).json.status).toBe("expired");
    expect((await web(k, p, "POST", `/api/v1/approvals/${id}/checkout`)).status).toBe(409);
    expect(await ordersFor(id)).toHaveLength(0);

    // An approval whose order exists is never expired this way: the order settles or releases it.
    const r2 = await propose(t.token, fresh());
    const ok = await approvePurchase(k, p, r2.json.approval_id, (await requestRow(k, r2.json.approval_id)).fqdn_ascii);
    expect(ok.status, ok.text).toBe(200);
    await approvedAgo(r2.json.approval_id, 200 * HOUR);
    await expireDue(k.app.ctx);
    expect(await requestRow(k, r2.json.approval_id)).toMatchObject({ state: "approved", reservation: "held" });
    expect(await reserved()).toBe(quoteCom());
    expect((await reconcileReservations(k.app.ctx)).corrected).toBe(0);
  });
});
