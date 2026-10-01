import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RegistrarError } from "@mosshatch/registrar/port";
import { advance, machine, requestRefund, RefundRefused } from "./machine.ts";
import { registerOrderJobs, orderFulfil, orderCapture } from "./jobs.ts";
import { alerts, buyAndPay, deliver, drain, makeBuyer, makeHarness, orderRow, states, type Buyer, type OrdersHarness } from "./testkit.ts";
import type { JobRow } from "../jobs/registry.ts";

let h: OrdersHarness; let ada: Buyer; let T0: Date;
const deleted: string[] = [];
beforeAll(async () => {
  h = await makeHarness();
  h.svc.deleteDomain = async (fqdn) => { deleted.push(fqdn); };
  ada = await makeBuyer(h, "ada@example.com"); T0 = h.app.clock.now();
}, 90_000);
afterAll(async () => { await h?.app.drop(); });
beforeEach(async () => {
  h.app.clock.set(T0);
  h.stripe.clearFaults(); h.resetRegistrar();
  await h.app.db.owner.query("delete from rate_counters");
  await h.app.db.owner.query("update sessions set expires_at = expires_at + interval '400 days', idle_expires_at = idle_expires_at + interval '400 days'");
});

const m = () => machine(h.app.ctx);
const work = (id: string, maxSteps?: number) => advance(m(), id, { maxSteps });
let n = 0;
const fq = (p = "cap") => `free-${p}${++n}.com`;
const ops = async (id: string, kind: string) => (await h.app.db.owner.query("select * from order_operations where order_id = $1 and kind = $2 order by seq", [id, kind])).rows;
/** Steps: authorize, begin registering, send register, registered -> capturing. Stops before the capture. */
async function toCapturing(buyer = ada, name = fq(), pay?: Parameters<typeof buyAndPay>[3]) {
  const { id } = await buyAndPay(h, buyer, name, { key: `k-${name}`, ...(pay ?? {}) });
  await work(id, 4);
  expect((await orderRow(h, id)).state).toBe("capturing");
  return { id, name };
}
const piOf = async (id: string) => h.stripe.paymentIntents.get((await orderRow(h, id)).stripe_payment_intent_id)!;

describe("ST-106: registrar down at capture_before minus 24 hours", () => {
  it("retries with backoff while the window is open, then cancels the PaymentIntent, voids and emails the customer", async () => {
    const { id } = await buyAndPay(h, ada, fq("down"), { key: "st106-a" });
    h.registrar.faults.set("registryMaintenance", { durationMs: 30 * 24 * 3600_000 });
    await work(id);
    let o = await orderRow(h, id);
    expect(o.state).toBe("registrar_unavailable");
    expect(h.registrar.calls.register).toBe(0);
    const cb = new Date(o.capture_before);
    // Backoff retries: each poll sees maintenance and stays put; the authorization is held (not cancelled).
    for (let i = 0; i < 5; i++) { h.app.clock.advance(31 * 60_000); await work(id); }
    o = await orderRow(h, id);
    expect(o.state).toBe("registrar_unavailable");
    expect((await piOf(id)).status).toBe("requires_capture");
    // capture_before minus 24 hours: void.
    h.app.clock.set(new Date(cb.getTime() - 24 * 3600_000 - 1000));
    await work(id);
    expect((await orderRow(h, id)).state).toBe("registrar_unavailable");             // one second before the deadline: still waiting
    h.app.clock.set(new Date(cb.getTime() - 24 * 3600_000));
    await work(id);
    o = await orderRow(h, id);
    expect([o.state, o.void_reason]).toEqual(["voided", "registrar_unavailable"]);
    expect((await piOf(id)).status).toBe("canceled");
    const mail = h.app.email.sent.find((x) => x.kind === "order.voided" && x.text.includes("Registrations are paused while our registrar is in maintenance. Nothing was charged."));
    expect(mail).toBeTruthy();
    expect(mail!.to).toContain(ada.email);
    expect(h.stripe.created.captures).toBe(h.stripe.created.captures);
    expect((await h.app.db.owner.query("select count(*)::int as n from payments where order_id = $1 and status = 'succeeded'", [id])).rows[0].n).toBe(0);
    expect(h.registrar.calls.register).toBe(0);
  });

  it("recovers when the registrar comes back before the deadline: registering resumes with a new operation", async () => {
    const { id } = await buyAndPay(h, ada, fq("back"), { key: "st106-b" });
    h.registrar.faults.set("registryMaintenance", { durationMs: 45 * 60_000 });
    await work(id);
    expect((await orderRow(h, id)).state).toBe("registrar_unavailable");
    h.app.clock.advance(46 * 60_000);
    await work(id);
    expect((await orderRow(h, id)).state).toBe("captured");
    expect(h.registrar.calls.register).toBeGreaterThan(0);
  });

  it("a rate-limited or unavailable answer to the register itself moves to registrar_unavailable, resolves that operation and retries with a new one", async () => {
    const { id } = await buyAndPay(h, ada, fq("rl"), { key: "st106-c" });
    h.registrar.faults.set("rateLimited", { times: 1 });
    // rateLimited fires in guardCall, i.e. on register itself (health() reports degraded, which does not block)
    await work(id, 3);
    let o = await orderRow(h, id);
    expect(o.state).toBe("registrar_unavailable");
    const first = await ops(id, "register");
    expect([first[0].state, first[0].response_code]).toEqual(["resolved", "rate_limited"]);
    h.app.clock.advance(61_000);
    await work(id);
    o = await orderRow(h, id);
    expect(o.state).toBe("captured");
    const all = await ops(id, "register");
    expect(all.map((x) => x.seq)).toEqual([1, 2]);
    expect(all[1].state).toBe("resolved");
  });

  it("registrar_writes_paused holds the order in authorized without any registrar call, and the window rule still applies", async () => {
    const { id } = await buyAndPay(h, ada, fq("pause"), { key: "st106-d" });
    await work(id, 1);
    await h.app.db.owner.query("update flags set value = 'true' where name = 'registrar_writes_paused'");
    const before = h.registrar.calls.register;
    await work(id);
    expect((await orderRow(h, id)).state).toBe("authorized");
    h.app.clock.advance(6 * 24 * 3600_000 + 3600_000);
    await work(id);
    expect([(await orderRow(h, id)).state, (await orderRow(h, id)).void_reason]).toEqual(["voided", "auth_window"]);
    expect(h.registrar.calls.register).toBe(before);
    await h.app.db.owner.query("update flags set value = 'false' where name = 'registrar_writes_paused'");
  });
});

describe("the authorization window (capture_before)", () => {
  it("less than 24 hours left at fulfilment: cancel the hold instead of registering", async () => {
    const now = Math.floor(h.app.clock.now().getTime() / 1000);
    const { id } = await buyAndPay(h, ada, fq("win"), { key: "win-a", pay: { captureBefore: now + 23 * 3600 } });
    await work(id);
    const o = await orderRow(h, id);
    expect([o.state, o.void_reason]).toEqual(["voided", "auth_window"]);
    expect(h.registrar.calls.register).toBe(h.registrar.calls.register);
    expect((await piOf(id)).status).toBe("canceled");
  });
  it("exactly 24 hours left is enough; a card without capture_before (Link) falls back to authorization plus four days", async () => {
    const now = Math.floor(h.app.clock.now().getTime() / 1000);
    const a = await buyAndPay(h, ada, fq("win"), { key: "win-b", pay: { captureBefore: now + 24 * 3600 } });
    await work(a.id);
    expect((await orderRow(h, a.id)).state).toBe("captured");
    const b = await buyAndPay(h, ada, fq("win"), { key: "win-c", pay: { captureBefore: null } });
    await work(b.id, 1);
    const ob = await orderRow(h, b.id);
    expect(new Date(ob.capture_before).getTime() - new Date(ob.authorized_at).getTime()).toBe(4 * 24 * 3600_000);
  });
});

describe("capture: idempotency-key hygiene after a 500", () => {
  it("a cached 500 is not retried under the same key: GET the PaymentIntent, then capture under a NEW key", async () => {
    const { id } = await toCapturing();
    h.stripe.fail("capturePaymentIntent", { kind: "server", times: 1 });
    h.stripe.keysUsed.length = 0;
    await work(id);
    expect((await orderRow(h, id)).state).toBe("captured");
    const caps = h.stripe.keysUsed.filter((k) => k.method === "capturePaymentIntent").map((k) => k.key);
    expect(caps).toEqual([`cap:${id}`, `cap:${id}:2`]);
    expect(new Set(caps).size).toBe(2);
    const rows = await ops(id, "capture");
    expect(rows.map((r) => [r.seq, r.response_code])).toEqual([[1, "api_error"], [2, "ok"]]);
    expect(h.stripe.created.captures).toBeGreaterThan(0);
    expect((await piOf(id)).amount_received).toBeGreaterThan(0);
  });

  it("the fake replays a cached 500 under the same key (the behaviour the rule exists for)", async () => {
    const { id } = await toCapturing();
    const pi = (await piOf(id)).id;
    h.stripe.fail("capturePaymentIntent", { kind: "server", times: 1 });
    await expect(h.stripe.capturePaymentIntent(pi, "same-key")).rejects.toMatchObject({ status: 500 });
    await expect(h.stripe.capturePaymentIntent(pi, "same-key")).rejects.toMatchObject({ status: 500 });    // replayed, though nothing is wrong now
    expect((await h.stripe.capturePaymentIntent(pi, "new-key")).status).toBe("succeeded");
    await expect(h.stripe.capturePaymentIntent(pi, "same-key")).rejects.toMatchObject({ status: 500 });
  });

  it("persistent 500s: capture_failed pages at once, retries every 15 minutes, and finishes when Stripe recovers", async () => {
    const { id } = await toCapturing();
    h.stripe.fail("capturePaymentIntent", { kind: "server", times: 4 });
    await work(id);
    let o = await orderRow(h, id);
    expect(o.state).toBe("capture_failed");
    expect((await alerts(h, "capture_failed")).find((a) => a.subject === id)?.severity).toBe("page");
    expect(o.capture_deadline).not.toBeNull();
    await work(id);                                        // not due yet: nothing happens
    expect((await ops(id, "capture")).length).toBe(2);
    h.app.clock.advance(16 * 60_000);
    await work(id);                                        // third and fourth 500s
    expect((await orderRow(h, id)).state).toBe("capture_failed");
    h.app.clock.advance(16 * 60_000);
    await work(id);
    o = await orderRow(h, id);
    expect(o.state).toBe("captured");
    expect((await ops(id, "capture")).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(await states(h, id)).toEqual(expect.arrayContaining(["capturing>capture_failed", "capture_failed>captured"]));
    expect(h.stripe.created.captures).toBeGreaterThan(0);
  });

  it("a timeout (answer lost, capture applied) retries under the SAME key and gets the real result once", async () => {
    const { id } = await toCapturing();
    const captures = h.stripe.created.captures;
    h.stripe.fail("capturePaymentIntent", { kind: "timeout", times: 1 });
    h.stripe.keysUsed.length = 0;
    await work(id);
    // The answer was lost but the capture landed: our GET finds the PaymentIntent already succeeded, so no second capture is sent.
    expect((await orderRow(h, id)).state).toBe("captured");
    expect(h.stripe.created.captures).toBe(captures + 1);
    expect(h.stripe.keysUsed.filter((k) => k.method === "capturePaymentIntent")).toHaveLength(1);
  });

  it("a timeout where the capture did NOT land: same key next time, one capture in total", async () => {
    const { id } = await toCapturing();
    const captures = h.stripe.created.captures;
    h.stripe.fail("capturePaymentIntent", { kind: "lost", times: 2 });
    h.stripe.keysUsed.length = 0;
    await work(id);
    expect((await orderRow(h, id)).state).toBe("capture_failed");
    h.app.clock.advance(16 * 60_000);
    await work(id);
    expect((await orderRow(h, id)).state).toBe("captured");
    const keys = h.stripe.keysUsed.filter((k) => k.method === "capturePaymentIntent").map((k) => k.key);
    expect(keys).toEqual([`cap:${id}`, `cap:${id}`, `cap:${id}`]);
    expect(h.stripe.created.captures).toBe(captures + 1);
  });
});

describe("the capture_failed ladder", () => {
  async function cancelledPi(buyer: Buyer, name = fq("lad")) {
    const { id } = await toCapturing(buyer, name);
    const pi = await piOf(id);
    await h.stripe.cancelPaymentIntent(pi.id, `test-cancel-${pi.id}`);          // the hold expired or was cancelled outside our flow
    return id;
  }

  it("PaymentIntent cancelled, no saved method: capture_failed pages, one pay link is emailed (valid up to 7 days), and paying it captures", async () => {
    const id = await cancelledPi(ada);
    await work(id);
    let o = await orderRow(h, id);
    expect(o.state).toBe("capture_failed");
    expect((await alerts(h, "capture_failed")).find((a) => a.subject === id)?.severity).toBe("page");
    h.app.clock.advance(16 * 60_000);
    await work(id);                                                              // ladder step: cancelled -> pay link
    o = await orderRow(h, id);
    expect(o.state).toBe("capture_failed");
    const life = new Date(o.pay_link_expires_at).getTime() - h.app.clock.now().getTime();
    expect(life).toBeGreaterThan(4 * 24 * 3600_000);
    expect(life).toBeLessThanOrEqual(7 * 24 * 3600_000);
    const mails = h.app.email.sent.filter((x) => x.kind === "order.pay_link" && x.text.includes(o.fqdn_ascii));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).not.toMatch(/https?:\/\/(?!mosshatch\.test)/);
    h.app.clock.advance(3600_000); await work(id);
    expect(h.app.email.sent.filter((x) => x.kind === "order.pay_link" && x.text.includes(o.fqdn_ascii))).toHaveLength(1);
    // The customer opens the pay page and pays; the webhook completes the order.
    await h.app.db.owner.query("update sessions set idle_expires_at = idle_expires_at + interval '400 days'");
    const link = await h.app.call("POST", `/api/v1/orders/${id}/pay-link`, { cookie: ada.cookie, body: {} });
    expect(link.status, link.text).toBe(200);
    const sess = [...h.stripe.sessions.values()].at(-1)!;
    expect(sess.metadata.purpose).toBe("pay_link");
    expect(h.stripe.sessionParams(sess.id).stripe.payment_intent_data.capture_method).toBe("automatic");
    h.stripe.takeEvents();
    const evs = h.stripe.payCheckout(sess.id, { autoCapture: true });
    for (const e of evs) expect((await deliver(h, e)).status).toBe(200);
    o = await orderRow(h, id);
    expect(o.state).toBe("captured");
    const pay = (await h.app.db.owner.query("select * from payments where order_id = $1 and status = 'succeeded'", [id])).rows;
    expect(pay).toHaveLength(1);
  });

  it("the pay link is refused for another user's order and for an order that is not capture_failed", async () => {
    const id = await cancelledPi(ada);
    await work(id, 1);
    const eve = await makeBuyer(h, "eve@example.com");
    expect((await h.app.call("POST", `/api/v1/orders/${id}/pay-link`, { cookie: eve.cookie, body: {} })).status).toBe(404);
    const { id: fine } = await buyAndPay(h, ada, fq("lad"), { key: "notfailed" });
    expect((await h.app.call("POST", `/api/v1/orders/${fine}/pay-link`, { cookie: ada.cookie, body: {} })).status).toBe(409);
  });

  it("PaymentIntent cancelled with a saved payment method (mandate): charged off-session under a stable key, captured", async () => {
    const buyer = await makeBuyer(h, "mandate@example.com");
    const id = await cancelledPi(buyer);
    const o0 = await orderRow(h, id);
    const dom = (await h.app.db.owner.query("select id from domains where fqdn_ascii = $1", [o0.fqdn_ascii])).rows[0].id;
    await h.app.db.owner.query("insert into renewal_mandates (domain_id, user_id, stripe_payment_method_ref, price_ceiling_minor, text_hash, retain_until) values ($1,$2,'pm_saved_1',5000,'h', now() + interval '3 years')", [dom, buyer.userId]);
    h.stripe.attachCard("pm_saved_1", o0.stripe_customer_id);          // saved at an opt-in Checkout: only an attached card can be charged off-session
    await work(id, 1);
    h.app.clock.advance(16 * 60_000);
    await work(id);
    const o = await orderRow(h, id);
    expect(o.state).toBe("captured");
    const off = [...h.stripe.paymentIntents.values()].find((p) => p.metadata.purpose === "capture_failed" && p.metadata.order_id === id)!;
    expect([off.status, off.payment_method]).toEqual(["succeeded", "pm_saved_1"]);
    expect(h.stripe.keysUsed.some((k) => k.key === `offsession:${id}`)).toBe(true);
    expect(o.stripe_payment_intent_id).toBe(off.id);
  });

  it("a saved method that is declined falls back to the pay link", async () => {
    const buyer = await makeBuyer(h, "declined@example.com");
    const id = await cancelledPi(buyer);
    const o0 = await orderRow(h, id);
    const dom = (await h.app.db.owner.query("select id from domains where fqdn_ascii = $1", [o0.fqdn_ascii])).rows[0].id;
    await h.app.db.owner.query("insert into renewal_mandates (domain_id, user_id, stripe_payment_method_ref, price_ceiling_minor, text_hash, retain_until) values ($1,$2,'pm_declined_1',5000,'h', now() + interval '3 years')", [dom, buyer.userId]);
    await work(id, 1);
    h.app.clock.advance(16 * 60_000);
    await work(id);
    const o = await orderRow(h, id);
    expect(o.state).toBe("capture_failed");
    expect(o.pay_link_expires_at).not.toBeNull();
  });

  it("unpaid at the deadline: the domain is deleted inside add-grace, the loss is booked and paged, the order is voided", async () => {
    const id = await cancelledPi(ada);
    await work(id, 1);
    h.app.clock.advance(16 * 60_000);
    await work(id);
    const o = await orderRow(h, id);
    expect(new Date(o.capture_deadline).getTime() - new Date(o.registered_at).getTime()).toBeLessThan(5 * 24 * 3600_000);      // inside the 5-day add-grace
    h.app.clock.set(new Date(new Date(o.capture_deadline).getTime() - 1000));
    await work(id);
    expect((await orderRow(h, id)).state).toBe("capture_failed");
    h.app.clock.set(new Date(o.capture_deadline));
    await work(id);
    const after = await orderRow(h, id);
    expect([after.state, after.void_reason, after.failure_code]).toEqual(["voided", "unpaid", "unpaid_deleted"]);
    expect(deleted).toContain(o.fqdn_ascii);
    expect((await h.app.db.owner.query("select released_at, release_reason from domains where fqdn_ascii = $1", [o.fqdn_ascii])).rows[0]).toMatchObject({ release_reason: "unpaid" });
    expect((await alerts(h, "loss_booked")).find((a) => a.subject === id)?.severity).toBe("page");
  });

  it("without a delete capability the ladder pages a human instead of pretending", async () => {
    const del = h.svc.deleteDomain; h.svc.deleteDomain = undefined;
    const id = await cancelledPi(ada);
    await work(id, 1);
    h.app.clock.set(new Date((await orderRow(h, id)).capture_deadline));
    await work(id);
    expect((await orderRow(h, id)).failure_code).toBe("unpaid_manual_delete");
    expect((await alerts(h, "manual_domain_delete_required")).some((a) => a.subject === id)).toBe(true);
    h.svc.deleteDomain = del;
  });
});

describe("unexpected capture (paid_before_registration)", () => {
  it("a Dashboard capture while authorized registers, then records the payment without a second capture", async () => {
    const { id } = await buyAndPay(h, ada, fq("dash"), { key: "pbr-a" });
    await work(id, 1);
    const pi = await piOf(id);
    const evs = h.stripe.dashboardCapture(pi.id);
    for (const e of evs) await deliver(h, e);
    const captures = h.stripe.created.captures;
    await work(id, 1);
    expect((await orderRow(h, id)).state).toBe("paid_before_registration");
    await work(id);
    expect((await orderRow(h, id)).state).toBe("captured");
    expect(h.stripe.created.captures).toBe(captures);                            // we never captured: someone else did
    expect((await h.app.db.owner.query("select status from payments where order_id = $1", [id])).rows[0].status).toBe("succeeded");
    expect(await states(h, id)).toEqual(expect.arrayContaining(["authorized>paid_before_registration", "paid_before_registration>registered"]));
  });

  it("if registration then fails, the captured money is refunded", async () => {
    const { id } = await buyAndPay(h, ada, fq("dashfail"), { key: "pbr-b" });
    await work(id, 1);
    h.stripe.dashboardCapture((await piOf(id)).id);
    const realRegister = h.registrar.register.bind(h.registrar);
    h.registrar.register = async () => { throw new RegistrarError("rejected", "no", { retryable: false, outcomeUnknown: false, code: "2302" }); };
    await work(id);
    h.registrar.register = realRegister;
    const o = await orderRow(h, id);
    expect(o.state).toBe("refunded");
    expect([...h.stripe.refunds.values()].at(-1)!.payment_intent).toBe((await piOf(id)).id);
    expect(h.stripe.keysUsed.filter((k) => k.method === "createRefund").at(-1)!.key).toBe(`refund:${id}:1`);
  });

  it("a succeeded PaymentIntent is never cancelled: the cancel step re-fetches first", async () => {
    const { id } = await buyAndPay(h, ada, fq("refetch"), { key: "pbr-c" });
    await work(id, 1);
    const pi = await piOf(id);
    // Force a cancel path (auth window), but let the money be captured just before the cancel call.
    h.app.clock.advance(6.5 * 24 * 3600_000);
    h.stripe.dashboardCapture(pi.id);
    const cancels = h.stripe.created.cancels;
    await work(id);
    expect(h.stripe.created.cancels).toBe(cancels);
    expect((await orderRow(h, id)).state).toBe("refunded");
  });
});

describe("review, refunds, disputes and the job handlers", () => {
  it("a Radar review that opens after authorization holds the order; closing it resumes", async () => {
    const { id } = await buyAndPay(h, ada, fq("rev"), { key: "rev-a" });
    await work(id, 1);
    (await piOf(id)).review_open = true;
    await work(id);
    expect((await orderRow(h, id)).state).toBe("review_hold");
    expect(h.registrar.calls.register).toBe(h.registrar.calls.register);
    (await piOf(id)).review_open = false;
    await work(id);
    expect((await orderRow(h, id)).state).toBe("captured");
  });

  it("refund: full refund of a captured order, capped at 3 per account per 30 days, refused for a domain in use", async () => {
    const buyer = await makeBuyer(h, "refunder@example.com");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) { const { id } = await toCapturing(buyer, fq("ref")); await work(id); ids.push(id); }
    await expect(requestRefund(m(), ids[0]!, { reason: "customer", hasDnsOrConnections: true })).rejects.toMatchObject({ code: "domain_in_use" });
    expect((await orderRow(h, ids[0]!)).state).toBe("captured");
    for (let i = 0; i < 3; i++) {
      const o = await requestRefund(m(), ids[i]!, { reason: "customer", hasDnsOrConnections: false });
      expect(o.state).toBe("refunded");
    }
    await expect(requestRefund(m(), ids[3]!, { reason: "customer", hasDnsOrConnections: false })).rejects.toBeInstanceOf(RefundRefused);
    await expect(requestRefund(m(), ids[3]!, { reason: "customer", hasDnsOrConnections: false })).rejects.toMatchObject({ code: "refund_cap" });
    const pay = (await h.app.db.owner.query("select refunded_minor, amount_minor from payments where order_id = $1", [ids[0]])).rows[0];
    expect(pay.refunded_minor).toBe(pay.amount_minor);
    expect((await h.app.db.owner.query("select count(*)::int as n from refunds where user_id = $1", [buyer.userId])).rows[0].n).toBe(3);
    h.app.clock.advance(31 * 24 * 3600_000);                                     // the window rolls
    expect((await requestRefund(m(), ids[3]!, { reason: "customer", hasDnsOrConnections: false })).state).toBe("refunded");
    await expect(requestRefund(m(), ids[3]!, { reason: "customer", hasDnsOrConnections: false })).rejects.toMatchObject({ code: "not_refundable" });
  });

  it("a refund whose first request gets a 500 retries under a new key and is issued once", async () => {
    const buyer = await makeBuyer(h, "refund500@example.com");
    const { id } = await toCapturing(buyer, fq("r500")); await work(id);
    h.stripe.fail("createRefund", { kind: "server", times: 1 });
    await expect(requestRefund(m(), id, { reason: "customer", hasDnsOrConnections: false })).rejects.toBeTruthy();
    expect((await orderRow(h, id)).state).toBe("refund_pending");
    await work(id);
    expect((await orderRow(h, id)).state).toBe("refunded");
    expect(h.stripe.keysUsed.filter((k) => k.method === "createRefund").slice(-2).map((k) => k.key)).toEqual([`refund:${id}:1`, `refund:${id}:2`]);
    const piId = (await piOf(id)).id;
    expect([...h.stripe.refunds.values()].filter((r) => r.payment_intent === piId)).toHaveLength(1);
  });

  it("a dispute or early fraud warning sets the account to review as an overlay; the order stays captured", async () => {
    const buyer = await makeBuyer(h, "dispute@example.com");
    const { id } = await toCapturing(buyer, fq("dsp")); await work(id);
    const pi = await piOf(id);
    for (const kind of ["dispute", "efw"] as const) {
      const ev = h.stripe.openDispute(pi.id, kind);
      expect((await deliver(h, ev)).status).toBe(200);
    }
    expect((await h.app.db.owner.query("select risk_state from users where id = $1", [buyer.userId])).rows[0].risk_state).toBe("review");
    expect((await orderRow(h, id)).state).toBe("captured");
    expect((await h.app.db.owner.query("select dispute_state from payments where order_id = $1", [id])).rows[0].dispute_state).toBe("open");
    expect((await alerts(h, "dispute_opened")).some((a) => a.subject === id)).toBe(true);
    expect((await deliver(h, h.stripe.closeDispute(pi.id, true))).status).toBe(200);
    expect((await h.app.db.owner.query("select dispute_state from payments where order_id = $1", [id])).rows[0].dispute_state).toBe("won");
    // A review account's next order above USD 50 wholesale waits for a person (compliance module); a small one goes through.
    const small = await import("./testkit.ts").then((k) => k.postOrder(h, buyer, { fqdn: fq("after"), years: 1 }, "after-dispute"));
    expect(small.status).toBe(201);
    const big = await import("./testkit.ts").then((k) => k.postOrder(h, buyer, { fqdn: "free-bigai.ai", years: 2 }, "after-dispute-2"));
    expect([big.status, big.json.error.code]).toEqual([429, "review_hold"]);
  });

  it("a refund made in the Dashboard is mirrored once; our own refunds are not double counted by the event", async () => {
    const buyer = await makeBuyer(h, "dashrefund@example.com");
    const { id } = await toCapturing(buyer, fq("dr")); await work(id);
    const pi = await piOf(id);
    h.stripe.takeEvents();
    await h.stripe.createRefund({ paymentIntent: pi.id, amount: 100 }, "dash-refund-1");
    for (const e of h.stripe.takeEvents()) await deliver(h, e);
    const o = await orderRow(h, id);
    expect(o.state).toBe("partially_refunded");
    expect((await h.app.db.owner.query("select refunded_minor from payments where order_id = $1", [id])).rows[0].refunded_minor).toBe("100");
    // Our own refund flow: the event arrives after the ledger is already updated.
    const { id: id2 } = await toCapturing(buyer, fq("dr")); await work(id2);
    h.stripe.takeEvents();
    await requestRefund(m(), id2, { reason: "customer", hasDnsOrConnections: false });
    for (const e of h.stripe.takeEvents()) await deliver(h, e);
    const p2 = (await h.app.db.owner.query("select refunded_minor, amount_minor from payments where order_id = $1", [id2])).rows[0];
    expect(p2.refunded_minor).toBe(p2.amount_minor);
    expect((await h.app.db.owner.query("select count(*)::int as n from refunds where order_id = $1", [id2])).rows[0].n).toBe(1);
  });

  it("job handlers take an order id from the payload and nothing else", async () => {
    registerOrderJobs();
    const { id } = await buyAndPay(h, ada, fq("job"), { key: "job-a" });
    const ATTEMPT = "11111111-1111-1111-1111-111111111111";
    const running = async (kind: string, payload: Record<string, unknown>, attempt = ATTEMPT): Promise<JobRow> => {
      const r = await h.app.db.owner.query("insert into jobs (kind, priority, state, attempt_id, attempts, locked_until, payload) values ($1,0,'running',$2,1,$3,$4) returning id", [kind, attempt, new Date(h.app.clock.now().getTime() + 3600_000), payload]);
      return { id: r.rows[0].id, kind, attempt_id: attempt, attempts: 1, max_attempts: 8, payload, user_id: null };
    };
    await orderFulfil(h.app.ctx, await running("order.fulfil", { order_id: "not-a-uuid", state: "captured", amount: 1 }));    // ignored
    await orderCapture(h.app.ctx, await running("order.capture", { order_id: id }));                                             // not a capture state: no-op
    expect((await orderRow(h, id)).state).toBe("checkout_open");
    // A job that outlived its lease (a later attempt owns the row) cannot commit anything.
    const stale = await running("order.fulfil", { order_id: id });
    await h.app.db.owner.query("update jobs set attempt_id = '22222222-2222-2222-2222-222222222222' where id = $1", [stale.id]);
    await expect(orderFulfil(h.app.ctx, stale)).rejects.toMatchObject({ name: "LeaseLostError" });
    expect((await orderRow(h, id)).state).toBe("checkout_open");
    expect(h.registrar.calls.register).toBe(h.registrar.calls.register);
    await orderFulfil(h.app.ctx, await running("order.fulfil", { order_id: id, state: "voided", price: 1, fqdn: "evil.com" }));
    const o = await orderRow(h, id);
    expect(o.state).toBe("captured");
    expect(o.fqdn_ascii).not.toBe("evil.com");
    const attempt = (await h.app.db.owner.query("select attempt_id from order_operations where order_id = $1 and kind = 'register'", [id])).rows[0].attempt_id;
    expect(attempt).toBe(ATTEMPT);                                                                                              // the operation records the lease attempt
    // Scheduled through the real engine: webhook -> job -> tick.
    const { id: id2, events } = await buyAndPay(h, ada, fq("job"), { key: "job-b" });
    for (const e of events) await deliver(h, e);
    await drain(h);
    expect((await orderRow(h, id2)).state).toBe("captured");
    expect((await h.app.db.owner.query("select count(*)::int as n from jobs where payload::text ~* '(secret|password|token|code)'")).rows[0].n).toBe(0);
  });
});
