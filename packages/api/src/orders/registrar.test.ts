import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RegistrarError } from "@mosshatch/registrar/port";
import { DeathSignal } from "@mosshatch/registrar/mock-port";
import { advance, machine, scanLateWatches, sweepUnknown } from "./machine.ts";
import { alerts, buyAndPay, makeBuyer, makeHarness, orderRow, states, type Buyer, type OrdersHarness } from "./testkit.ts";

let h: OrdersHarness; let ada: Buyer; let bo: Buyer; let T0: Date;
beforeAll(async () => { h = await makeHarness(); ada = await makeBuyer(h, "ada@example.com"); bo = await makeBuyer(h, "bo@example.com"); T0 = h.app.clock.now(); }, 90_000);
afterAll(async () => { await h?.app.drop(); });
beforeEach(async () => {
  // Every test starts at the same instant: time travel in one test must not expire the sessions of the next.
  h.app.clock.set(T0);
  await h.app.db.owner.query("delete from rate_counters"); h.registrar.faults.clear();
  await h.app.db.owner.query("update sessions set expires_at = expires_at + interval '400 days', idle_expires_at = idle_expires_at + interval '400 days'");
});

const m = () => machine(h.app.ctx);
const work = (id: string, maxSteps?: number) => advance(m(), id, { maxSteps });
let n = 0;
const fq = (p = "reg") => `free-${p}${++n}.com`;
const ops = async (id: string, kind = "register") => (await h.app.db.owner.query("select * from order_operations where order_id = $1 and kind = $2 order by seq", [id, kind])).rows;
/** An authorized order: paid at Stripe, guard passed, not yet registering. */
async function authorized(buyer = ada, name = fq()) {
  const { id } = await buyAndPay(h, buyer, name, { key: `k-${name}` });
  await work(id, 1);
  expect((await orderRow(h, id)).state).toBe("authorized");
  return { id, name };
}

describe("ST-103: two workers on one order produce exactly one register call", () => {
  it("N workers racing on an authorized order send one register, real concurrent transactions, repeated", async () => {
    for (let round = 0; round < 8; round++) {
      const { id } = await authorized(ada, fq("race"));
      const before = h.registrar.calls.register, applied = h.registrar.upstream.registerApplied;
      const workers = 2 + (round % 3);
      const results = await Promise.allSettled(Array.from({ length: workers }, () => work(id)));
      expect(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.filter((r) => r.status === "rejected"))).toBe(true);
      expect(h.registrar.calls.register - before, `round ${round}`).toBe(1);
      expect(h.registrar.upstream.registerApplied - applied).toBe(1);
      await work(id);                                         // settle whatever the losers left
      const o = await orderRow(h, id);
      expect(o.state).toBe("captured");
      const reg = await ops(id);
      expect(reg).toHaveLength(1);
      expect(reg[0].state).toBe("resolved");
      expect(h.stripe.paymentIntents.get(o.stripe_payment_intent_id)!.amount_received).toBeGreaterThan(0);
      expect((await h.app.db.owner.query("select count(*)::int as n from domains where fqdn_ascii = $1", [o.fqdn_ascii])).rows[0].n).toBe(1);
    }
    // One capture per order despite the race: same key replays, and the losers never resolve twice.
    const caps = (await h.app.db.owner.query("select order_id, count(*)::int as n from order_operations where kind = 'capture' group by order_id")).rows;
    expect(caps.every((r) => r.n === 1)).toBe(true);
  });

  it("the send claim is a single conditional update: a second claim on the same intent finds nothing", async () => {
    const { id } = await authorized();
    await work(id, 1);                                          // authorized -> registering (intent written)
    const [op] = await ops(id);
    expect(op.state).toBe("intent");
    const claim = () => h.app.ctx.cron.query("update order_operations set state = 'sent', sent_at = now() where id = $1 and state = 'intent' returning id", [op.id]);
    const rs = await Promise.all([claim(), claim(), claim(), claim()]);
    expect(rs.map((r) => r.rowCount).sort()).toEqual([0, 0, 0, 1]);
  });

  it("a sent operation is never re-sent, even by a worker that starts later", async () => {
    const { id } = await authorized();
    h.registrar.faults.set("timeoutAfterAccept", { times: 1 });
    await work(id);
    expect((await orderRow(h, id)).state).toBe("outcome_unknown");
    const before = h.registrar.calls.register;
    for (let i = 0; i < 3; i++) await work(id);
    expect(h.registrar.calls.register).toBe(before);
  });
});

describe("ST-104: timeout after accept and worker death resolve through reconciliation without a resend", () => {
  it("timeoutAfterAccept: outcome_unknown, then the claim rule finds the domain ours and the order finishes; one register", async () => {
    const { id, name } = await authorized();
    h.registrar.faults.set("timeoutAfterAccept", { times: 1 });
    const before = h.registrar.calls.register;
    await work(id, 3);
    let o = await orderRow(h, id);
    expect(o.state).toBe("outcome_unknown");
    expect((await alerts(h, "outcome_unknown")).some((a) => a.subject === id)).toBe(true);
    // The first poll waits for its backoff (60 s), then reconciles by getDomain and the order lookup.
    await work(id);
    expect((await orderRow(h, id)).state).toBe("outcome_unknown");
    h.app.clock.advance(61_000);
    await work(id);
    o = await orderRow(h, id);
    expect(o.state).toBe("captured");
    expect(h.registrar.calls.register - before).toBe(1);
    expect(h.registrar.upstream.registerApplied).toBeGreaterThan(0);
    expect((await ops(id))[0].state).toBe("resolved");
    expect((await h.app.db.owner.query("select fqdn_ascii from domains where id = $1", [o.domain_id])).rows[0].fqdn_ascii).toBe(name);
  });

  it("workerDeath: the sweeper moves a register sent for over 90 seconds to outcome_unknown, and it resolves without a resend", async () => {
    const { id } = await authorized();
    h.registrar.faults.set("workerDeath", { times: 1 });
    const before = h.registrar.calls.register;
    await expect(work(id)).rejects.toBeInstanceOf(DeathSignal);
    expect((await orderRow(h, id)).state).toBe("registering");
    expect((await ops(id))[0].state).toBe("sent");
    // Too early: the sweeper leaves it alone; a fulfil pass does not resend either.
    await sweepUnknown(m());
    expect((await orderRow(h, id)).state).toBe("registering");
    await work(id);
    expect(h.registrar.calls.register - before).toBe(1);
    h.app.clock.advance(91_000);
    expect((await sweepUnknown(m())).moved).toBeGreaterThanOrEqual(1);
    expect((await orderRow(h, id)).state).toBe("outcome_unknown");
    h.app.clock.advance(61_000);
    await work(id);
    expect((await orderRow(h, id)).state).toBe("captured");
    expect(h.registrar.calls.register - before).toBe(1);
    expect(h.registrar.upstream.registerApplied).toBeGreaterThanOrEqual(1);
  });

  it("a fulfil pass alone notices a register stuck in sent (same move as the sweeper)", async () => {
    const { id } = await authorized();
    h.registrar.faults.set("workerDeath", { times: 1 });
    await expect(work(id)).rejects.toBeInstanceOf(DeathSignal);
    h.app.clock.advance(95_000);
    await work(id);
    expect(["captured", "outcome_unknown"]).toContain((await orderRow(h, id)).state);
  });

  it("nothing found upstream: the order polls on a backoff until capture_before minus 24 hours, then cancels the hold, tells the customer and watches the name for 14 days", async () => {
    const { id } = await authorized();
    // The request never reaches the registrar: the answer is lost and nothing was applied.
    const realRegister = h.registrar.register.bind(h.registrar);
    h.registrar.register = async () => { h.registrar.calls.register++; throw new RegistrarError("unknown", "timeout", { retryable: false, outcomeUnknown: true, code: "timeout" }); };
    await work(id);
    h.registrar.register = realRegister;
    expect((await orderRow(h, id)).state).toBe("outcome_unknown");
    const cb = new Date((await orderRow(h, id)).capture_before);
    for (let i = 0; i < 6; i++) { h.app.clock.advance(31 * 60_000); await work(id); }
    expect((await orderRow(h, id)).state).toBe("outcome_unknown");
    h.app.clock.set(new Date(cb.getTime() - 24 * 3600_000 + 1000));
    await work(id);
    const o = await orderRow(h, id);
    expect([o.state, o.void_reason, o.late_watch_state]).toEqual(["voided", "unknown_deadline", "watching"]);
    expect(h.stripe.paymentIntents.get((await orderRow(h, id)).stripe_payment_intent_id)!.status).toBe("canceled");
    expect(h.app.email.sent.some((x) => x.kind === "order.voided" && x.text.includes("Nothing was charged"))).toBe(true);
  });

  it("late arrival by the same profile and registrant: capture_failed, the domain row exists and a page fires", async () => {
    const { id, name } = await authorized();
    const realRegister = h.registrar.register.bind(h.registrar);
    h.registrar.register = async () => { throw new RegistrarError("unknown", "timeout", { retryable: false, outcomeUnknown: true, code: "timeout" }); };
    await work(id);
    h.registrar.register = realRegister;
    const cb = new Date((await orderRow(h, id)).capture_before);
    h.app.clock.set(new Date(cb.getTime() - 24 * 3600_000 + 1000));
    await work(id);
    expect((await orderRow(h, id)).state).toBe("voided");
    // The delayed request is applied by the registrar with the same profile username and the same registrant.
    const { REGISTRANT } = await import("./testkit.ts");
    const o = await orderRow(h, id);
    h.app.clock.advance(3600_000);
    await realRegister({ fqdn: name, years: 1, regUsername: o.reg_username, regPassword: "pw-late-arrival-2", registrant: { ...REGISTRANT, email: ada.email } });
    expect(await scanLateWatches(m())).toBe(1);
    const after = await orderRow(h, id);
    expect([after.state, after.late_watch_state]).toEqual(["capture_failed", "claimed"]);
    expect((await h.app.db.owner.query("select count(*)::int as n from domains where fqdn_ascii = $1", [name])).rows[0].n).toBe(1);
    expect((await alerts(h, "late_registration")).some((a) => a.subject === id)).toBe(true);
    expect(after.capture_deadline).not.toBeNull();
  });

  it("the claim rule refuses a domain registered under another profile: taken_by_other, never registered", async () => {
    const { id, name } = await authorized();
    const realRegister = h.registrar.register.bind(h.registrar);
    h.registrar.register = async () => { throw new RegistrarError("unknown", "timeout", { retryable: false, outcomeUnknown: true, code: "timeout" }); };
    await work(id);
    h.registrar.register = realRegister;
    h.registrar.registerAsOther(name);                       // a rival got the name upstream
    h.app.clock.advance(61_000);
    await work(id);
    const o = await orderRow(h, id);
    expect([o.state, o.void_reason, o.failure_code]).toEqual(["voided", "taken_by_other", "taken_by_other"]);
    expect(h.stripe.paymentIntents.get(o.stripe_payment_intent_id)!.status).toBe("canceled");
    expect((await h.app.db.owner.query("select count(*)::int as n from domains where fqdn_ascii = $1 and user_id = $2", [name, ada.userId])).rows[0].n).toBe(0);
  });

  it("sameNameTwoUsers upstream: the register is rejected, the order is voided, and the rival's upstream order is left alone", async () => {
    const { id, name } = await authorized();
    h.registrar.faults.set("sameNameTwoUsers", { times: 1 });
    await work(id);
    const o = await orderRow(h, id);
    expect([o.state, o.void_reason]).toEqual(["voided", "taken_by_other"]);
    expect(h.registrar.calls.cancelPendingOrder).toBe(0);            // nothing of ours was pending; the rival's order is not ours to cancel
    expect(h.registrar.orders.find((x) => x.fqdn === name)?.status).toBe("completed");
    expect(h.stripe.paymentIntents.get(o.stripe_payment_intent_id ?? "")?.status ?? "canceled").toBe("canceled");
  });

  it("two customers buying one name: the loser is voided at authorized by the partial unique index, with a plain message", async () => {
    const name = fq("dup");
    const a = await buyAndPay(h, ada, name, { key: "dup-a" });
    const b = await buyAndPay(h, bo, name, { key: "dup-b" });
    await work(a.id, 1);
    expect((await orderRow(h, a.id)).state).toBe("authorized");
    await work(b.id);                                          // b pays second: the index refuses its `authorized`
    const ob = await orderRow(h, b.id);
    expect([ob.state, ob.void_reason]).toEqual(["voided", "name_taken"]);
    expect(await states(h, b.id)).toEqual(["->checkout_open", "checkout_open>canceling", "canceling>voided"]);
    const mail = h.app.email.sent.find((x) => x.kind === "order.voided" && x.to.includes(bo.email));
    expect(mail!.text).toContain("Someone else just bought this name. Nothing was charged.");
    expect([...h.stripe.paymentIntents.values()].filter((p) => p.metadata.order_id === b.id).every((p) => p.status === "canceled")).toBe(true);
    // The winner is unaffected and finishes; the loser's cancel never touched the winner's upstream order.
    await work(a.id);
    expect((await orderRow(h, a.id)).state).toBe("captured");
    expect((await h.app.db.owner.query("select user_id from domains where fqdn_ascii = $1", [name])).rows.map((r) => r.user_id)).toEqual([ada.userId]);
    expect(h.registrar.orders.filter((x) => x.fqdn === name && x.status === "completed")).toHaveLength(1);
  });
});

describe("registrar behaviour around the write", () => {
  it("forced_pending (insufficient funds) waits for a top-up and is never treated as registered", async () => {
    const { id, name } = await authorized();
    h.registrar.faults.set("insufficientFunds", { times: 1 });
    await work(id);
    expect((await orderRow(h, id)).state).toBe("registering");
    expect((await ops(id))[0].detail.accepted_pending).toBe(true);
    await sweepUnknown(m());
    h.app.clock.advance(95_000);
    await sweepUnknown(m());                                   // known-accepted, not unknown
    expect((await orderRow(h, id)).state).toBe("registering");
    await work(id);
    expect((await orderRow(h, id)).state).toBe("registering");
    expect(h.registrar.domainRecord(name)).toBeUndefined();
    h.registrar.topUp(1_000_000n);
    h.app.clock.advance(61_000);
    await work(id);
    expect((await orderRow(h, id)).state).toBe("captured");
    expect(h.registrar.calls.register).toBeGreaterThan(0);
  });

  it("the price guard: a name that turns premium after payment is refused, and a rising quote voids", async () => {
    const a = await authorized(ada, fq("prem"));
    h.registrar.setKind(a.name, "premium");
    await work(a.id);
    let o = await orderRow(h, a.id);
    expect([o.state, o.void_reason]).toEqual(["voided", "price_guard"]);

    const b = await authorized(ada, fq("rise"));
    const real = h.svc.pricing;
    h.svc.pricing = { quote: async (...args) => { const q = await real.quote(...args); return { ...q, subtotalMinor: q.subtotalMinor + 1n }; } };
    const registers = h.registrar.calls.register;
    await work(b.id);
    h.svc.pricing = real;
    o = await orderRow(h, b.id);
    expect([o.state, o.void_reason]).toEqual(["voided", "quote_increased"]);
    expect(h.registrar.calls.register).toBe(registers);
    // A lower quote does not void: the customer is charged the authorized amount, never more than shown.
    const c = await authorized(ada, fq("fall"));
    h.svc.pricing = { quote: async (...args) => { const q = await real.quote(...args); return { ...q, subtotalMinor: q.subtotalMinor - 1n }; } };
    await work(c.id);
    h.svc.pricing = real;
    expect((await orderRow(h, c.id)).state).toBe("captured");
  });

  it("a rejected register voids the order, cancels pending upstream orders first and only then the PaymentIntent", async () => {
    const { id, name } = await authorized();
    const order: string[] = [];
    const cancelPi = h.stripe.cancelPaymentIntent.bind(h.stripe);
    const cancelUp = h.registrar.cancelPendingOrder.bind(h.registrar);
    h.stripe.cancelPaymentIntent = async (...a) => { order.push("stripe.cancel"); return cancelPi(...a); };
    h.registrar.cancelPendingOrder = async (...a) => { order.push("upstream.cancel"); return cancelUp(...a); };
    // A draft order of ours is left pending upstream when the registration fails.
    const realRegister = h.registrar.register.bind(h.registrar);
    h.registrar.register = async (req) => {
      h.registrar.calls.register++;
      h.registrar.faults.set("insufficientFunds", { times: 1 });
      await realRegister(req);                                   // creates a forced-pending upstream order
      throw new RegistrarError("rejected", "registry said no", { retryable: false, outcomeUnknown: false, code: "2306" });
    };
    await work(id);
    h.registrar.register = realRegister; h.stripe.cancelPaymentIntent = cancelPi; h.registrar.cancelPendingOrder = cancelUp;
    const o = await orderRow(h, id);
    expect([o.state, o.failure_code]).toEqual(["voided", "2306"]);
    expect(order).toEqual(["upstream.cancel", "stripe.cancel"]);
    expect(h.registrar.orders.find((x) => x.fqdn === name)?.status).toBe("cancelled");
    expect(await states(h, id)).toEqual(["->checkout_open", "checkout_open>authorized", "authorized>registering", "registering>registration_failed", "registration_failed>canceling", "canceling>voided"]);
  });
});
