import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_SWEEP_GRACE_MS, APPROVAL_TTL_MS, expireDue, reconcileReservations } from "./requests.ts";
import { bearer, bindingRow, clearCounters, createAgentToken, makeAgentKit, makeOwner, requestRow, stepUp, web, type AgentKit, type Owner } from "./testkit.ts";

/**
 * ST-74 review: Pay now makes the order for an approved request at the moment the sweeper expires that approval. Both take the
 * request row lock and re-check under it, so the outcome never depends on the sweeper's margin: an expired approval never yields an
 * order, and an approval with an order never has its reservation released. Interleaved by hand with gates (no timing): the clock is
 * moved while Pay now is held, so the sweeper finds the approval past its time.
 */

let k: AgentKit; let ada: Owner;
beforeAll(async () => { k = await makeAgentKit(); ada = await makeOwner(k, "ordrace-ada"); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => {
  await clearCounters(k);
  await k.app.db.owner.query("update flags set value = '1000' where name = 'pricing.tax_ceiling_bps'");
  await k.app.db.owner.query("update flags set value = 'false' where name in ('orders_paused', 'agent_purchases_paused')");
});

const MIN = 60_000;
const flag = (name: string, value: string) => k.app.db.owner.query("update flags set value = $2::jsonb where name = $1", [name, value]);
const ordersFor = async (id: string) => (await k.app.db.owner.query("select id, state from orders where agent_request_id = $1", [id])).rows;
let n = 0;

/** An approved request with no order yet (the order path failed after the approval), approved `ageMs` ago. */
async function approvedWithoutOrder(ageMs: number) {
  const t = await createAgentToken(k, ada, ["register.propose:*"], { cap: 1_000_000, name: `Order bot ${++n}` });
  const fqdn = `free-ordrace${n}x${Date.now().toString(36)}.com`;
  const r = await bearer(k, t.token, "POST", "/api/v1/agent/proposals", { kind: "register", domain: fqdn });
  expect(r.status, r.text).toBe(202);
  const id = r.json.approval_id as string;
  const s = await stepUp(k, ada, "agent.purchase.approve", id, { typed_domain: fqdn });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  await flag("agent_purchases_paused", "true");
  const decide = await web(k, ada, "POST", `/api/v1/approvals/${id}/decide`, {}, { "x-mh-action-id": s.actionId });
  expect(decide.status, decide.text).toBe(503);
  await flag("agent_purchases_paused", "false");
  await k.app.db.owner.query("update agent_requests set decided_at = $2 where id = $1", [id, new Date(k.app.clock.now().getTime() - ageMs)]);
  const row = await requestRow(k, id);
  expect(row).toMatchObject({ state: "approved", order_id: null, reservation: "held" });
  return { id, fqdn, binding: t.id, quoted: BigInt(row.quoted_minor) };
}

/** Hold the first matching call until released (the call runs after the release). Restoring releases it too. */
function gate<O extends object, K extends keyof O>(obj: O, key: K, when: (...args: any[]) => boolean) {
  const orig = (obj[key] as any).bind(obj);
  let reached!: () => void, release!: () => void, armed = true;
  const atGate = new Promise<void>((r) => { reached = r; });
  const open = new Promise<void>((r) => { release = r; });
  (obj as any)[key] = async (...args: any[]) => {
    if (armed && when(...args)) { armed = false; reached(); await open; }
    return orig(...args);
  };
  return { atGate, release, restore: () => { release(); (obj as any)[key] = orig; } };
}

/** True once `p` waits on a lock in this database; false when it settled without waiting. */
async function blockedOnLock(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  for (;;) {
    const w = (await k.app.db.owner.query("select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")).rows[0].n as number;
    if (w > 0) return true;
    if (settled) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Move the clock so an approval made `age` ago is past the sweeper's cut-off. */
const pastSweep = (age: number) => k.app.clock.advance(APPROVAL_TTL_MS + APPROVAL_SWEEP_GRACE_MS - age + MIN);

describe("ST-74 review: order creation and the approval sweeper serialise on the request row", () => {
  it("the sweeper, run while Pay now is making the order, waits for the row and leaves the approval (and its reservation) alone", async () => {
    const age = APPROVAL_TTL_MS - MIN;
    const x = await approvedWithoutOrder(age);
    // Pay now has checked the approval and is inside the order path (the registrar's availability check, before the order row).
    const g = gate(k.h.registrar, "checkAvailability", (fqdn: string, o?: { noCache?: boolean }) => fqdn === x.fqdn && !!o?.noCache);
    let pay, swept;
    try {
      const p = web(k, ada, "POST", `/api/v1/approvals/${x.id}/checkout`);
      await g.atGate;
      pastSweep(age);
      const sweep = expireDue(k.app.ctx);
      expect(await blockedOnLock(sweep)).toBe(true);
      g.release();
      pay = await p;
      swept = await sweep;
    } finally { g.restore(); }
    expect(pay.status, pay.text).toBe(200);
    expect(pay.json.checkout_url).toBeTruthy();
    expect(swept).toBe(0);
    const orders = await ordersFor(x.id);
    expect(orders).toHaveLength(1);
    expect(await requestRow(k, x.id)).toMatchObject({ state: "approved", order_id: orders[0].id, reservation: "held" });
    expect(BigInt((await bindingRow(k, x.binding)).reserved_minor)).toBe(x.quoted);
    // Later sweeps leave it too: the order settles or releases the reservation.
    expect(await expireDue(k.app.ctx)).toBe(0);
    expect((await requestRow(k, x.id)).state).toBe("approved");
    expect((await reconcileReservations(k.app.ctx)).corrected).toBe(0);
  });

  it("an approval the sweeper expired while Pay now was checking the signed quote yields no order: 409 request_expired", async () => {
    const age = APPROVAL_TTL_MS - MIN;
    const x = await approvedWithoutOrder(age);
    // Pay now has read the approval as fresh and is checking the quote it signed; it has not taken the row yet.
    const pricing = (k.app.ctx.services as { orders: { pricing: object } }).orders.pricing;
    const g = gate(pricing as { quote: (...a: unknown[]) => unknown }, "quote", () => true);
    let pay;
    try {
      const p = web(k, ada, "POST", `/api/v1/approvals/${x.id}/checkout`);
      await g.atGate;
      pastSweep(age);
      expect(await expireDue(k.app.ctx)).toBeGreaterThanOrEqual(1);
      expect(await requestRow(k, x.id)).toMatchObject({ state: "expired", decision_reason: "approval_expired", reservation: "released" });
      g.release();
      pay = await p;
    } finally { g.restore(); }
    expect(pay.status, pay.text).toBe(409);
    expect(pay.json.error.code).toBe("request_expired");
    expect(await ordersFor(x.id)).toHaveLength(0);
    expect(await requestRow(k, x.id)).toMatchObject({ state: "expired", order_id: null, reservation: "released" });
    expect(BigInt((await bindingRow(k, x.binding)).reserved_minor)).toBe(0n);
    expect((await reconcileReservations(k.app.ctx)).corrected).toBe(0);
  });
});
