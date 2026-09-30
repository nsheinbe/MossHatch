import { afterEach, describe, expect, it } from "vitest";
import { advance, machine, toCanceling } from "../orders/machine.ts";
import { loadOrder } from "../orders/support.ts";
import { buyAndPay, deliverAll, drain, postOrder } from "../orders/testkit.ts";
import { runRenewalScheduler } from "./renewals.ts";
import { alertRows, at, autoRenewOn, buyDomain, days, domainRow, harnessPerTest, hygiene, makeOwner, relogin, renewOrders, settle, termRow } from "./testkit.ts";

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });

describe("ST-108: forced_pending is never registered, and a void cancels the upstream order", () => {
  it("an order the registrar accepts but holds for funds stays registering, never registered, and creates no domain", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "st108a@example.com");
    h.registrar.faults.set("insufficientFunds", { times: 1 });
    const paid = await buyAndPay(h, o, "free-st108a.dev");
    await deliverAll(h); await drain(h);
    const events = () => h.app.db.owner.query("select to_state from order_events where order_id = $1 order by at, id", [paid.id]).then((r) => r.rows.map((x) => x.to_state as string));
    expect((await loadOrder(h.app.ctx.cron, paid.id))!.state).toBe("registering");
    const upstream = h.registrar.orders.filter((u) => u.fqdn === "free-st108a.dev");
    expect(upstream.map((u) => [u.type, u.status, u.pendingReason])).toEqual([["new", "pending", "forced_pending"]]);
    // Time and repeated polling change nothing: the upstream order is pending, so the name is not ours.
    for (let i = 0; i < 4; i++) { at(h, new Date(h.app.clock.now().getTime() + 10 * 60_000)); await hygiene(h); await drain(h); }
    expect((await loadOrder(h.app.ctx.cron, paid.id))!.state).toBe("registering");
    expect(await events()).not.toContain("registered");
    expect(await events()).not.toContain("captured");
    expect((await h.app.db.owner.query("select count(*)::int n from domains where fqdn_ascii = 'free-st108a.dev'")).rows[0].n).toBe(0);
    expect(h.registrar.domainRecord("free-st108a.dev")).toBeUndefined();
    expect(h.stripe.created.captures).toBe(0);                    // the customer has not been charged
  });

  it("a void (the customer cancels, or the authorization window closes) cancels the pending upstream order first, and a later top-up cannot resurrect it", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "st108b@example.com");
    h.registrar.faults.set("insufficientFunds", { times: 1 });
    const paid = await buyAndPay(h, o, "free-st108b.dev");
    await deliverAll(h); await drain(h);
    const order = (await loadOrder(h.app.ctx.cron, paid.id))!;
    expect(order.state).toBe("registering");
    const m = machine(h.app.ctx);
    await toCanceling(m, order, ["registering"], "customer_cancel");
    await advance(m, paid.id);
    const after = (await loadOrder(h.app.ctx.cron, paid.id))!;
    expect([after.state, after.voidReason]).toEqual(["voided", "customer_cancel"]);
    expect(h.registrar.orders.filter((u) => u.fqdn === "free-st108b.dev").map((u) => u.status)).toEqual(["cancelled"]);
    expect(h.registrar.orders.filter((u) => u.status === "pending" || u.status === "waiting")).toHaveLength(0);
    expect([...h.stripe.paymentIntents.values()].filter((p) => p.metadata.order_id === paid.id).every((p) => p.status === "canceled")).toBe(true);
    h.registrar.topUp(5_000_000n);
    at(h, new Date(h.app.clock.now().getTime() + 3600_000)); await settle(h);
    expect(h.registrar.domainRecord("free-st108b.dev")).toBeUndefined();
    expect((await loadOrder(h.app.ctx.cron, paid.id))!.state).toBe("voided");
    expect((await h.app.db.owner.query("select count(*)::int n from domains where fqdn_ascii = 'free-st108b.dev'")).rows[0].n).toBe(0);
  });
});

describe("ST-109: the sell gate refuses below the threshold, renewals rank ahead of registrations, and a void leaves nothing pending upstream", () => {
  it("POST /orders is refused with nothing charged when available funds less the wholesale fall below USD 250, and accepted above", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "st109a@example.com");
    h.registrar.setBalance(26_000n);                              // 26,000 - 1,700 wholesale = 24,300 < 25,000
    const refused = await postOrder(h, o, { fqdn: "free-st109a.dev", years: 1 }, "gate-1");
    expect(refused.status).toBe(503); expect(refused.json.error.code).toBe("sell_gate");
    expect(refused.json.error.message).toBe("Registration is paused for a short while. Nothing was charged.");
    expect((await h.app.db.owner.query("select count(*)::int n from orders where user_id = $1", [o.userId])).rows[0].n).toBe(0);
    expect(h.stripe.created.sessions).toBe(0);
    h.registrar.setBalance(30_000n);
    expect((await postOrder(h, o, { fqdn: "free-st109a.dev", years: 1 }, "gate-2")).status).toBe(201);
  });

  it("the renewal scheduler refuses below the threshold (nothing charged, a page), and charges once funds return", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "st109b@example.com");
    const dom = await buyDomain(h, o, "free-st109b.dev");
    await autoRenewOn(h, o, dom.id);
    const c = new Date(new Date((await termRow(h, dom.id)).charge_at).getTime() + 60_000);
    at(h, c);
    h.registrar.setBalance(26_000n);
    await settle(h);
    expect(h.stripe.calls.createOffSessionPaymentIntent ?? 0).toBe(0);
    expect(await renewOrders(h, dom.id)).toHaveLength(0);
    const t = await termRow(h, dom.id);
    expect([t.state, t.held_reason]).toEqual(["held", "funds_gate"]);
    expect((await alertRows(h, "renewal_sell_gate")).length).toBe(1);
    h.registrar.topUp(100_000n);
    at(h, new Date(c.getTime() + 10 * 60_000)); await settle(h);
    expect((await renewOrders(h, dom.id)).map((r) => r.state)).toEqual(["renewed"]);
  });

  it("renewals rank ahead of registrations: at the same balance a new registration is refused and the renewal due goes through", async () => {
    const h = await per.make();
    const ada = await makeOwner(h, "st109c@example.com");
    const dom = await buyDomain(h, ada, "free-st109c.dev");
    await autoRenewOn(h, ada, dom.id);
    const E = new Date((await domainRow(h, dom.id)).expires_at);
    // Twelve days before expiry the renewal is due within the 14-day look-ahead, so its wholesale (1,700) is reserved.
    at(h, new Date(E.getTime() - days(12)));
    const bob = await makeOwner(h, "st109d@example.com");
    // 28,399 - 1,700 (renewal reserve) - 1,700 (new registration) = 24,999, one cent short of the floor.
    h.registrar.setBalance(28_399n);
    const refused = await postOrder(h, bob, { fqdn: "free-st109d.dev", years: 1 }, "rank-1");
    expect(refused.status).toBe(503); expect(refused.json.error.code).toBe("sell_gate");
    h.registrar.setBalance(28_400n);
    const ok = await postOrder(h, bob, { fqdn: "free-st109d.dev", years: 1 }, "rank-2");
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    // The renewal itself: at the charge day the same short balance still funds it (28,399 - 1,700 = 26,699 >= 25,000).
    h.registrar.setBalance(28_399n);
    at(h, new Date(E.getTime() - days(10) + 60_000));
    await settle(h);
    expect((await renewOrders(h, dom.id)).map((r) => r.state)).toEqual(["renewed"]);
    void relogin;
  });

  it("the balance job records the position and closes the gate on the same arithmetic", async () => {
    const h = await per.make();
    const { runBalanceCheck } = await import("./balance.ts");
    h.registrar.setBalance(200_000n);
    expect((await runBalanceCheck(h.app.ctx))!.gateOpen).toBe(true);
    expect(await alertRows(h, "sell_gate_closed")).toHaveLength(0);
    h.registrar.setBalance(40_000n);                              // above the floor but inside twice the floor: a warning
    const warn = (await runBalanceCheck(h.app.ctx))!;
    expect(warn.gateOpen).toBe(true);
    expect((await alertRows(h, "registrar_balance_low")).map((a) => a.severity)).toEqual(["warn"]);
    h.registrar.setBalance(20_000n);
    const shut = (await runBalanceCheck(h.app.ctx))!;
    expect(shut.gateOpen).toBe(false);
    expect((await alertRows(h, "sell_gate_closed")).map((a) => a.severity)).toEqual(["page"]);
    h.registrar.setBalance(-500n);                                // a negative balance is a material breach of the reseller agreement
    await runBalanceCheck(h.app.ctx);
    expect((await alertRows(h, "registrar_balance_negative")).map((a) => a.severity)).toEqual(["page"]);
    h.registrar.setBalance(500_000n);
    await runBalanceCheck(h.app.ctx);
    for (const k of ["sell_gate_closed", "registrar_balance_low", "registrar_balance_negative"]) expect(await alertRows(h, k), k).toHaveLength(0);
    const snaps = (await h.app.db.owner.query("select gate_open, available_minor from registrar_balance_snapshots order by at, id")).rows;
    expect(snaps.map((s) => s.gate_open)).toEqual([true, true, false, false, true]);
  });

  it("a voided order leaves no pending upstream order (the registration that was held for funds, then voided)", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "st109e@example.com");
    h.registrar.faults.set("insufficientFunds", { times: 1 });
    const paid = await buyAndPay(h, o, "free-st109e.dev");
    await deliverAll(h); await drain(h);
    const m = machine(h.app.ctx);
    await toCanceling(m, (await loadOrder(h.app.ctx.cron, paid.id))!, ["registering"], "registrar_unavailable");
    await advance(m, paid.id);
    expect((await loadOrder(h.app.ctx.cron, paid.id))!.state).toBe("voided");
    expect(h.registrar.orders.filter((u) => u.status === "pending" || u.status === "waiting")).toHaveLength(0);
    void runRenewalScheduler;
  });
});
