import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { advance, machine, requestRefund } from "./machine.ts";
import { alerts, buyAndPay, deliver, makeBuyer, makeHarness, orderRow, type Buyer, type OrdersHarness } from "./testkit.ts";

/** Reproductions of the independent review's findings against the orders module (money correctness). */
let h: OrdersHarness; let T0: Date;
beforeAll(async () => { h = await makeHarness(); h.svc.deleteDomain = async () => undefined; T0 = h.app.clock.now(); }, 90_000);
afterAll(async () => { await h?.app.drop(); });
beforeEach(async () => {
  h.app.clock.set(T0);
  h.stripe.clearFaults(); h.resetRegistrar(); h.stripe.refundStatus = "succeeded";
  await h.app.db.owner.query("delete from rate_counters");
  await h.app.db.owner.query("update sessions set expires_at = expires_at + interval '400 days', idle_expires_at = idle_expires_at + interval '400 days'");
});

const m = () => machine(h.app.ctx);
const work = (id: string, maxSteps?: number) => advance(m(), id, { maxSteps });
let n = 0;
const fq = (p = "rv") => `free-${p}${++n}.com`;
const piOf = async (id: string) => h.stripe.paymentIntents.get((await orderRow(h, id)).stripe_payment_intent_id)!;
const pisOf = (id: string) => [...h.stripe.paymentIntents.values()].filter((p) => p.metadata.order_id === id);
const keptOf = (id: string) => pisOf(id).filter((p) => p.status === "succeeded" && !([...h.stripe.refunds.values()].some((r) => r.payment_intent === p.id && r.status !== "failed")));
const payLink = async (b: Buyer, id: string) => {
  await h.app.db.owner.query("update sessions set expires_at = greatest(expires_at, now() + interval '400 days'), idle_expires_at = greatest(idle_expires_at, now() + interval '400 days')");
  return h.app.call("POST", `/api/v1/orders/${id}/pay-link`, { cookie: b.cookie, body: {} });
};
const sessionOfUrl = (url: string) => [...h.stripe.sessions.values()].find((s) => url.endsWith(s.id))!;
async function deliverTaken() { for (const e of h.stripe.takeEvents()) expect((await deliver(h, e)).status).toBe(200); }

/** A registered order whose hold is gone: capture_failed, and (after one ladder step) a pay link offered. */
async function capFailed(buyer: Buyer, name = fq(), o: { ladder?: boolean; autoRenew?: boolean } = {}) {
  const { id } = await buyAndPay(h, buyer, name, { key: `k-${name}`, autoRenew: o.autoRenew });
  await work(id, 4);
  expect((await orderRow(h, id)).state).toBe("capturing");
  const pi = await piOf(id);
  await h.stripe.cancelPaymentIntent(pi.id, `test-cancel-${pi.id}`);          // the hold ended outside our flow
  await work(id, 1);
  expect((await orderRow(h, id)).state).toBe("capture_failed");
  if (o.ladder !== false) { h.app.clock.advance(16 * 60_000); await work(id); }
  h.stripe.takeEvents();
  return id;
}
async function mandateFor(buyer: Buyer, domainFqdn: string, pm: string) {
  const dom = (await h.app.db.owner.query("select id from domains where fqdn_ascii = $1 and released_at is null", [domainFqdn])).rows[0].id;
  await h.app.db.owner.query("insert into renewal_mandates (domain_id, user_id, stripe_payment_method_ref, price_ceiling_minor, text_hash, retain_until) values ($1,$2,$3,50000,'h', now() + interval '3 years')", [dom, buyer.userId, pm]);
}

describe("review: pay links (plan 4.3b capture_failed ladder)", () => {
  it("review: a second pay-link click an hour later reuses the open Checkout instead of minting another payable one", async () => {
    const b = await makeBuyer(h, "rv-link1@example.com");
    const id = await capFailed(b);
    const a = await payLink(b, id);
    expect(a.status, a.text).toBe(200);
    h.app.clock.advance(65 * 60_000);                                           // the next clock hour: the old key scheme minted a new session here
    const again = await payLink(b, id);
    expect(again.status, again.text).toBe(200);
    expect(again.json.checkout_url).toBe(a.json.checkout_url);
    expect([...h.stripe.sessions.values()].filter((s) => s.metadata.order_id === id && s.metadata.purpose === "pay_link")).toHaveLength(1);
    h.stripe.payCheckout(sessionOfUrl(a.json.checkout_url).id, { autoCapture: true });
    await deliverTaken();
    expect((await orderRow(h, id)).state).toBe("captured");
    expect(keptOf(id)).toHaveLength(1);
  });

  it("review: a second click within the same hour gets the same session back, not a 503 from a reused idempotency key", async () => {
    const b = await makeBuyer(h, "rv-link2@example.com");
    const id = await capFailed(b);
    const a = await payLink(b, id);
    expect(a.status, a.text).toBe(200);
    h.app.clock.advance(5_000);
    const again = await payLink(b, id);
    expect(again.status, again.text).toBe(200);
    expect(again.json.checkout_url).toBe(a.json.checkout_url);
  });

  it("review: an expiring pay link is expired before a new one is minted, and the new one replays byte-identically under its key", async () => {
    const b = await makeBuyer(h, "rv-link3@example.com");
    const id = await capFailed(b);
    const a = await payLink(b, id);
    const sa = sessionOfUrl(a.json.checkout_url);
    h.app.clock.set(new Date((sa.expires_at - 10 * 60) * 1000));               // ten minutes left on session A
    const b2 = await payLink(b, id);
    expect(b2.status, b2.text).toBe(200);
    expect(b2.json.checkout_url).not.toBe(a.json.checkout_url);
    expect(h.stripe.sessions.get(sa.id)!.status).toBe("expired");
    expect(() => h.stripe.payCheckout(sa.id, { autoCapture: true })).toThrow();
  });

  it("review: a pay-link payment that lands after the order was already paid is refunded, not kept with a warning", async () => {
    const b = await makeBuyer(h, "rv-link4@example.com");
    const id = await capFailed(b);
    const a = await payLink(b, id);
    h.stripe.payCheckout(sessionOfUrl(a.json.checkout_url).id, { autoCapture: true });
    await deliverTaken();
    expect((await orderRow(h, id)).state).toBe("captured");
    // A second payable pay-link Checkout of the same order (a second browser, or one minted before the reuse rule) is paid too.
    const o = await orderRow(h, id);
    const s2 = await h.stripe.createCheckoutSession({
      customer: o.stripe_customer_id, clientReferenceId: id, successUrl: "https://mosshatch.test/ok", cancelUrl: "https://mosshatch.test/no",
      expiresAt: Math.floor(h.app.clock.now().getTime() / 1000) + 3600, metadata: { order_id: id, purpose: "pay_link" },
      lineItem: { name: "x", unitAmount: Number(o.subtotal_minor), currency: "usd", operation: "register" }, captureMethod: "automatic", requestThreeDSecure: "automatic",
    }, `stray-${id}`);
    h.stripe.payCheckout(s2.id, { autoCapture: true });
    const second = h.stripe.sessions.get(s2.id)!.payment_intent!;
    await deliverTaken();
    await deliverTaken();                                                        // the refund's own charge.refunded event
    expect([...h.stripe.refunds.values()].filter((r) => r.payment_intent === second && r.status === "succeeded")).toHaveLength(1);
    expect(keptOf(id)).toHaveLength(1);
    const after = await orderRow(h, id);
    expect(after.state).toBe("captured");
    expect(after.stripe_payment_intent_id).not.toBe(second);
    expect((await h.app.db.owner.query("select count(*)::int n from refunds where order_id = $1", [id])).rows[0].n).toBe(0);
  });

  it("review: a pay link paid before its webhook arrives is found by the ladder, which never charges the saved card on top", async () => {
    const b = await makeBuyer(h, "rv-race@example.com");
    const name = fq("race");
    const { id } = await buyAndPay(h, b, name, { key: `k-${name}` });
    await work(id, 4);
    await mandateFor(b, name, "pm_declined_race");                               // this domain's own mandate; the card declines at first
    await h.stripe.cancelPaymentIntent((await piOf(id)).id, "test-cancel-race");
    await work(id, 1);
    h.app.clock.advance(16 * 60_000);
    await work(id);                                                               // off-session declined: the pay link is offered
    expect((await orderRow(h, id)).pay_link_expires_at).not.toBeNull();
    const link = await payLink(b, id);
    h.stripe.payCheckout(sessionOfUrl(link.json.checkout_url).id, { autoCapture: true });
    h.stripe.takeEvents();                                                        // the webhook is late
    // The customer fixes their saved card meanwhile.
    const o = await orderRow(h, id);
    h.stripe.attachCard("pm_fixed_race", o.stripe_customer_id);
    await h.app.db.owner.query("update renewal_mandates set stripe_payment_method_ref = 'pm_fixed_race' where user_id = $1", [b.userId]);
    h.app.clock.advance(61 * 60_000);
    await work(id);
    expect((await orderRow(h, id)).state).toBe("captured");
    expect(pisOf(id).filter((p) => p.metadata.purpose === "capture_failed")).toHaveLength(0);
    expect(keptOf(id)).toHaveLength(1);
  });
});

describe("review: the charge.refunded mirror", () => {
  it("review: a Dashboard refund of another PaymentIntent that names the order leaves the order state and its ledger alone", async () => {
    const b = await makeBuyer(h, "rv-mirror@example.com");
    const name = fq("mir");
    const { id } = await buyAndPay(h, b, name, { key: `k-${name}` });
    await work(id);
    expect((await orderRow(h, id)).state).toBe("captured");
    const o = await orderRow(h, id);
    const s2 = await h.stripe.createCheckoutSession({
      customer: o.stripe_customer_id, clientReferenceId: id, successUrl: "https://mosshatch.test/ok", cancelUrl: "https://mosshatch.test/no",
      expiresAt: Math.floor(h.app.clock.now().getTime() / 1000) + 3600, metadata: { order_id: id, purpose: "pay_link" },
      lineItem: { name: "x", unitAmount: Number(o.subtotal_minor), currency: "usd", operation: "register" }, captureMethod: "automatic", requestThreeDSecure: "automatic",
    }, `stray-mirror-${id}`);
    h.stripe.payCheckout(s2.id, { autoCapture: true });
    const stray = h.stripe.sessions.get(s2.id)!.payment_intent!;
    h.stripe.takeEvents();
    await h.stripe.createRefund({ paymentIntent: stray }, `dash-${stray}`);     // an operator refunds the stray in the Dashboard
    await deliverTaken();
    const after = await orderRow(h, id);
    expect(after.state).toBe("captured");
    const pays = (await h.app.db.owner.query("select stripe_payment_intent_id, refunded_minor from payments where order_id = $1", [id])).rows;
    expect(pays.every((p) => p.refunded_minor === "0")).toBe(true);
    expect((await h.app.db.owner.query("select count(*)::int n from refunds where order_id = $1", [id])).rows[0].n).toBe(0);
  });
});

describe("review: refunds", () => {
  it("review: a refund Stripe reports as pending is followed by id, not sent again, and finishes when it settles", async () => {
    const b = await makeBuyer(h, "rv-pending@example.com");
    const name = fq("pend");
    const { id } = await buyAndPay(h, b, name, { key: `k-${name}` });
    await work(id);
    h.stripe.refundStatus = "pending";
    const before = h.stripe.calls.createRefund ?? 0;
    const o = await requestRefund(m(), id, { reason: "customer", hasDnsOrConnections: false });
    expect(o.state).toBe("refund_pending");
    await work(id);
    h.app.clock.advance(10 * 60_000);
    await work(id);
    expect(h.stripe.calls.createRefund! - before).toBe(1);
    expect((await orderRow(h, id)).state).toBe("refund_pending");
    const re = [...h.stripe.refunds.values()].find((r) => r.payment_intent === (o.paymentIntentId ?? ""))!;
    h.stripe.takeEvents();
    for (const e of h.stripe.finishPendingRefund(re.id, "succeeded")) expect((await deliver(h, e)).status).toBe(200);
    await work(id);
    expect((await orderRow(h, id)).state).toBe("refunded");
    const pay = (await h.app.db.owner.query("select amount_minor, refunded_minor from payments where order_id = $1 and status = 'succeeded'", [id])).rows[0];
    expect(pay.refunded_minor).toBe(pay.amount_minor);
    expect((await h.app.db.owner.query("select stripe_refund_id from refunds where order_id = $1", [id])).rows.map((r) => r.stripe_refund_id)).toEqual([re.id]);
    expect((await alerts(h, "refund_failed")).some((a) => a.subject === id)).toBe(false);
  });

  it("review: parallel refund requests cannot pass the 3 per account per 30 days cap", async () => {
    const b = await makeBuyer(h, "rv-cap@example.com");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) { const name = fq("cap"); const { id } = await buyAndPay(h, b, name, { key: `k-${name}` }); await work(id); ids.push(id); }
    const res = await Promise.allSettled(ids.map((id) => requestRefund(machine(h.app.ctx), id, { reason: "customer", hasDnsOrConnections: false })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(res.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(["refund_cap", "refund_cap"]);
    expect((await h.app.db.owner.query("select count(*)::int n from refunds where user_id = $1", [b.userId])).rows[0].n).toBe(3);
  });

  it("review: a pending refund counts against the cap while it is in flight", async () => {
    const b = await makeBuyer(h, "rv-cap-pending@example.com");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) { const name = fq("capp"); const { id } = await buyAndPay(h, b, name, { key: `k-${name}` }); await work(id); ids.push(id); }
    h.stripe.refundStatus = "pending";
    for (let i = 0; i < 3; i++) expect((await requestRefund(m(), ids[i]!, { reason: "customer", hasDnsOrConnections: false })).state).toBe("refund_pending");
    await expect(requestRefund(m(), ids[3]!, { reason: "customer", hasDnsOrConnections: false })).rejects.toMatchObject({ code: "refund_cap" });
  });
});

describe("review: the capture_failed ladder's off-session charge (C-31, plan 4.3b agent purchases)", () => {
  it("review: a card saved under another domain's mandate is never charged for this order; the pay link follows", async () => {
    const b = await makeBuyer(h, "rv-mandate@example.com");
    const old = fq("old");
    const { id: oldId } = await buyAndPay(h, b, old, { key: `k-${old}` });
    await work(oldId);
    const cust = (await orderRow(h, oldId)).stripe_customer_id;
    h.stripe.attachCard("pm_old_mandate", cust);
    await mandateFor(b, old, "pm_old_mandate");
    const id = await capFailed(b, fq("new"));
    expect(pisOf(id).filter((p) => p.metadata.purpose === "capture_failed")).toHaveLength(0);
    const o = await orderRow(h, id);
    expect(o.state).toBe("capture_failed");
    expect(o.pay_link_expires_at).not.toBeNull();
  });

  it("review: an agent-approved order is never charged off-session, even under its own domain's mandate", async () => {
    const b = await makeBuyer(h, "rv-agent@example.com");
    const name = fq("agent");
    const { id } = await buyAndPay(h, b, name, { key: `k-${name}` });
    await work(id, 4);
    await h.app.db.owner.query("update orders set agent_request_id = $2 where id = $1", [id, crypto.randomUUID()]);
    const cust = (await orderRow(h, id)).stripe_customer_id;
    h.stripe.attachCard("pm_agent_own", cust);
    await mandateFor(b, name, "pm_agent_own");
    await h.stripe.cancelPaymentIntent((await piOf(id)).id, "test-cancel-agent");
    await work(id, 1);
    h.app.clock.advance(16 * 60_000);
    await work(id);
    expect(pisOf(id).filter((p) => p.metadata.purpose === "capture_failed")).toHaveLength(0);
    expect((await orderRow(h, id)).pay_link_expires_at).not.toBeNull();
  });

  it("review: the card this order itself saved at an opt-in Checkout is the one charged off-session", async () => {
    await h.app.db.owner.query("insert into document_versions (kind, version_hash, effective_at) values ('auto_renew_authorisation','authhash0123456789abcdef','2026-01-01') on conflict do nothing");
    const b = await makeBuyer(h, "rv-owncard@example.com");
    const id = await capFailed(b, fq("own"), { autoRenew: true });
    const o = await orderRow(h, id);
    expect(o.card_reusable).toBe(true);
    expect(o.state).toBe("captured");
    const off = pisOf(id).find((p) => p.metadata.purpose === "capture_failed")!;
    expect([off.status, off.payment_method]).toEqual(["succeeded", o.payment_method_ref]);
  });
});
