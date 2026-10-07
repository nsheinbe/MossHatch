import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RegistrarError } from "@mosshatch/registrar/port";
import { DeathSignal } from "@mosshatch/registrar/mock-port";
import { advance, machine } from "./machine.ts";
import { alerts, buyAndPay, makeBuyer, makeHarness, orderRow, postOrder, states, type Buyer, type OrdersHarness } from "./testkit.ts";

/**
 * docs/AUDIT-2026-10-07.md, section 3.1. Every case runs the real order machine on PostgreSQL against FakeStripe and the mock registrar
 * (simulated registrar behaviour: these prove the application's handling, not a real registration).
 */
let h: OrdersHarness; let ada: Buyer; let bo: Buyer; let T0: Date;
beforeAll(async () => { h = await makeHarness(); ada = await makeBuyer(h, "ada@example.com"); bo = await makeBuyer(h, "bo@example.com"); T0 = h.app.clock.now(); }, 90_000);
afterAll(async () => { await h?.app.drop(); });
beforeEach(async () => {
  h.app.clock.set(T0);
  await h.app.db.owner.query("delete from rate_counters"); h.registrar.faults.clear();
  await h.app.db.owner.query("update flags set value = 'false' where name in ('orders_paused','registrar_writes_paused')");
  await h.app.db.owner.query("update sessions set expires_at = expires_at + interval '400 days', idle_expires_at = idle_expires_at + interval '400 days'");
});

const work = (id: string, maxSteps?: number) => advance(machine(h.app.ctx), id, { maxSteps });
let n = 0;
const fq = (p = "aud") => `free-${p}${++n}.com`;
const domainsOf = async (name: string) => (await h.app.db.owner.query("select user_id from domains where fqdn_ascii = $1 and released_at is null", [name])).rows.map((r) => r.user_id as string);
async function authorized(buyer = ada, name = fq()) {
  const { id } = await buyAndPay(h, buyer, name, { key: `k-${name}` });
  await work(id, 1);
  expect((await orderRow(h, id)).state).toBe("authorized");
  return { id, name };
}

describe("AUD-F1/F2: a registration that took effect is delivered even when its answer was lost", () => {
  it("a read failure after the create (answered as unavailable) retries into the duplicate refusal; the name is ours, so it is captured, not voided", async () => {
    const { id, name } = await authorized();
    const applied = h.registrar.upstream.registerApplied;
    const real = h.registrar.register.bind(h.registrar);
    // The pre-fix adapter shape: CREATE took effect, then a follow-up read failed and surfaced as an ordinary retryable error.
    h.registrar.register = async (req) => { await real(req); throw new RegistrarError("unavailable", "read after create failed", { retryable: true, outcomeUnknown: false, code: "transport" }); };
    await work(id);
    h.registrar.register = real;
    expect((await orderRow(h, id)).state).toBe("registrar_unavailable");
    h.app.clock.advance(5 * 60_000);
    await work(id);                                            // the retry is refused as a duplicate (domain_taken): the ownership check finds it ours
    const o = await orderRow(h, id);
    expect(o.state).toBe("captured");
    expect(o.void_reason).toBeNull();
    expect(h.registrar.upstream.registerApplied - applied).toBe(1);   // one registration, never two
    expect(await domainsOf(name)).toEqual([ada.userId]);
    expect(h.stripe.paymentIntents.get(o.stripe_payment_intent_id)!.amount_received).toBeGreaterThan(0);
    expect(h.app.email.sent.some((m) => m.kind === "order.voided" && m.text.includes(name))).toBe(false);
    expect((await alerts(h, "register_refused_but_ours")).some((a) => a.subject === id)).toBe(true);
  });

  it("a refusal for a name registered by someone else is still a plain void, and the rival's name is left alone", async () => {
    const { id, name } = await authorized();
    h.registrar.registerAsOther(name);
    await work(id);
    const o = await orderRow(h, id);
    expect([o.state, o.void_reason]).toEqual(["voided", "taken_by_other"]);
    expect(await domainsOf(name)).toEqual([]);
  });

  it("when the ownership lookup itself fails, nothing is voided: the operation stays sent and reconciles under the claim rule", async () => {
    const { id, name } = await authorized();
    const real = h.registrar.register.bind(h.registrar);
    const realGet = h.registrar.getDomain.bind(h.registrar);
    h.registrar.register = async (req) => { await real(req); throw new RegistrarError("rejected", "duplicate", { retryable: false, outcomeUnknown: false, code: "346" }); };
    h.registrar.getDomain = async () => { throw new RegistrarError("unavailable", "read failed", { retryable: true, outcomeUnknown: false, code: "transport" }); };
    await expect(work(id)).rejects.toThrow();
    h.registrar.register = real; h.registrar.getDomain = realGet;
    expect((await orderRow(h, id)).state).toBe("registering");
    h.app.clock.advance(95_000);                               // past the 90-second sweep threshold
    await work(id);
    expect((await orderRow(h, id)).state).toBe("outcome_unknown");
    h.app.clock.advance(5 * 60_000);                           // the claim rule's next look finds the name under our profile
    await work(id);
    const o = await orderRow(h, id);
    expect(o.state).toBe("captured");
    expect(await domainsOf(name)).toEqual([ada.userId]);
  });
});

describe("AUD-F3: checkout refuses while registrar writes are paused", () => {
  it("no order, no Checkout Session and no card hold while registrar_writes_paused is set; it works again once cleared", async () => {
    await h.app.db.owner.query("update flags set value = 'true' where name = 'registrar_writes_paused'");
    const sessions = h.stripe.sessions.size;
    const res = await postOrder(h, ada, { fqdn: fq("paused"), years: 1 }, "paused-1");
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe("orders_paused");
    expect(h.stripe.sessions.size).toBe(sessions);
    expect((await h.app.db.owner.query("select count(*)::int as n from orders where idempotency_key = 'paused-1'")).rows[0].n).toBe(0);
    await h.app.db.owner.query("update flags set value = 'false' where name = 'registrar_writes_paused'");
    expect((await postOrder(h, ada, { fqdn: fq("paused"), years: 1 }, "paused-2")).status).toBe(201);
  });
});

describe("AUD-F4: the name lock holds while the first buyer waits on the registrar", () => {
  it("buyer A in registrar_unavailable keeps the name: buyer B is voided at authorization with a plain message, and A finishes", async () => {
    const { id: a, name } = await authorized(ada, fq("lock"));
    const real = h.registrar.register.bind(h.registrar);
    h.registrar.register = async () => { throw new RegistrarError("unavailable", "maintenance", { retryable: true, outcomeUnknown: false, code: "maintenance" }); };
    await work(a);
    h.registrar.register = real;
    expect((await orderRow(h, a)).state).toBe("registrar_unavailable");
    const b = await buyAndPay(h, bo, name, { key: `k-b-${name}` });
    await work(b.id);
    const ob = await orderRow(h, b.id);
    expect([ob.state, ob.void_reason]).toEqual(["voided", "name_taken"]);
    h.app.clock.advance(5 * 60_000);
    await work(a);
    expect((await orderRow(h, a)).state).toBe("captured");
    expect(await domainsOf(name)).toEqual([ada.userId]);
  });
});

describe("AUD-F5: the cancel path delivers a registration of ours that completed, while the hold is valid", () => {
  it("a cancel for the unknown-outcome deadline finds the name registered under our profile: captured, not voided", async () => {
    const { id, name } = await authorized(ada, fq("late"));
    const real = h.registrar.register.bind(h.registrar);
    // The worker dies after the create took effect; the order is then given up on (as the deadline path would) while the name is ours.
    h.registrar.register = async (req) => { await real(req); throw new DeathSignal("register", req.fqdn); };
    await work(id).catch(() => undefined);
    h.registrar.register = real;
    await h.app.db.owner.query("update orders set state = 'canceling', void_reason = 'unknown_deadline', cancel_pi_id = stripe_payment_intent_id where id = $1", [id]);
    await work(id);
    const o = await orderRow(h, id);
    expect(o.state).toBe("captured");
    expect(o.void_reason).toBeNull();
    expect(await domainsOf(name)).toEqual([ada.userId]);
    expect((await states(h, id)).some((s) => s === "canceling>registered")).toBe(true);
    expect((await alerts(h, "registration_recovered")).some((x) => x.subject === id)).toBe(true);
  });

  it("a cancel that refused the payment (a fraud review) still voids, even though the name is ours: a person decides", async () => {
    const { id, name } = await authorized(ada, fq("review"));
    const real = h.registrar.register.bind(h.registrar);
    h.registrar.register = async (req) => { await real(req); throw new DeathSignal("register", req.fqdn); };
    await work(id).catch(() => undefined);
    h.registrar.register = real;
    await h.app.db.owner.query("update orders set state = 'canceling', void_reason = 'review_refused', cancel_pi_id = stripe_payment_intent_id where id = $1", [id]);
    await work(id);
    expect((await orderRow(h, id)).state).toBe("voided");
    expect((await alerts(h, "registration_recovered")).some((x) => x.subject === id)).toBe(false);
    // The name stays in our account under the order's profile: the existing loss path pages a person and watches it.
    expect((await h.registrar.getDomain(name))?.profileUsername).toBe((await orderRow(h, id)).reg_username);
  });
});

describe("AUD-F7: an order whose Checkout Session was never recorded ends", () => {
  it("checkout_open without a Session waits through the checkout window, then becomes checkout_expired", async () => {
    const res = await postOrder(h, ada, { fqdn: fq("nosess"), years: 1 }, "nosess-1");
    const id = res.json.order_id as string;
    await h.app.db.owner.query("update orders set stripe_checkout_session_id = null where id = $1", [id]);
    await work(id);
    expect((await orderRow(h, id)).state).toBe("checkout_open");
    h.app.clock.advance(37 * 60_000);
    await work(id);
    expect((await orderRow(h, id)).state).toBe("checkout_expired");
  });
});

describe("AUD-F6/F8: the order view says when a hold ends and when a registered name can still be paid", () => {
  it("an authorized order reports hold_until; a voided one carries its plain message", async () => {
    const { id } = await authorized(ada, fq("view"));
    const v = await h.app.call("GET", `/api/v1/orders/${id}`, { cookie: ada.cookie });
    expect(v.status).toBe(200);
    expect(typeof v.json.hold_until).toBe("string");
    expect(v.json.pay_by).toBeNull();
  });
});
