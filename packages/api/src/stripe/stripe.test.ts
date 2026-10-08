import { describe, expect, it } from "vitest";
import { FakeClock } from "../testing/app.ts";
import { FakeStripe } from "./fake.ts";
import { StripeError, type CreateSessionInput } from "./port.ts";
import { StripeReal, STRIPE_API_VERSION, mapError } from "./real.ts";
import { toStripeSessionParams } from "./params.ts";
import { signHeader } from "./signature.ts";
import { ModeError } from "../config/modeguard.ts";

const input = (over: Partial<CreateSessionInput> = {}): CreateSessionInput => ({
  customer: "cus_1", clientReferenceId: "ord_1", successUrl: "https://x.test/ok?s={CHECKOUT_SESSION_ID}", cancelUrl: "https://x.test/no", expiresAt: 0,
  metadata: { order_id: "ord_1", attempt: "1" }, lineItem: { name: "moonfern.com for 1 year", unitAmount: 1925, currency: "usd" }, captureMethod: "manual", requestThreeDSecure: "any", ...over,
});
const setup = () => { const clock = new FakeClock(new Date("2026-11-07T12:00:00Z")); const s = new FakeStripe(clock, { taxBps: 800 }); return { clock, s, now: () => Math.floor(clock.now().getTime() / 1000) }; };

describe("FakeStripe models the parts of Stripe the order machine relies on", () => {
  it("idempotency: the same key replays the first result, another body under the key is an error, keys live 24 hours", async () => {
    const { s, now, clock } = setup();
    const exp = now() + 31 * 60;
    const a = await s.createCheckoutSession(input({ expiresAt: exp }), "cs:o:1");
    const b = await s.createCheckoutSession(input({ expiresAt: exp }), "cs:o:1");
    expect(b.id).toBe(a.id);
    expect(s.created.sessions).toBe(1);
    await expect(s.createCheckoutSession(input({ expiresAt: exp, lineItem: { name: "x", unitAmount: 1, currency: "usd" } }), "cs:o:1")).rejects.toMatchObject({ kind: "idempotency_error" });
    clock.advance(25 * 3600_000);
    const c = await s.createCheckoutSession(input({ expiresAt: now() + 31 * 60 }), "cs:o:1");
    expect(c.id).not.toBe(a.id);
  });

  it("a 500 is cached under its key and replays as a 500 until a new key is used; a lost answer replays the applied result", async () => {
    const { s, now } = setup();
    const sess = await s.createCheckoutSession(input({ expiresAt: now() + 31 * 60 }), "k0");
    s.payCheckout(sess.id);
    const pi = [...s.paymentIntents.values()][0]!;
    s.fail("capturePaymentIntent", { kind: "server" });
    await expect(s.capturePaymentIntent(pi.id, "cap:1")).rejects.toMatchObject({ status: 500, kind: "api_error" });
    await expect(s.capturePaymentIntent(pi.id, "cap:1")).rejects.toMatchObject({ status: 500 });
    expect(s.paymentIntents.get(pi.id)!.status).toBe("requires_capture");
    expect((await s.capturePaymentIntent(pi.id, "cap:1:2")).status).toBe("succeeded");
    // applied but the answer is lost: the same key gives the real answer
    const s2 = await s.createCheckoutSession(input({ expiresAt: now() + 31 * 60, clientReferenceId: "ord_2" }), "k2");
    s.payCheckout(s2.id);
    const pi2 = [...s.paymentIntents.values()].at(-1)!;
    s.fail("capturePaymentIntent", { kind: "timeout" });
    await expect(s.capturePaymentIntent(pi2.id, "cap:2")).rejects.toMatchObject({ kind: "timeout" });
    expect((await s.capturePaymentIntent(pi2.id, "cap:2")).status).toBe("succeeded");
    expect(s.created.captures).toBe(2);
  });

  it("a second request while the first is in flight is a 409 (idempotency_key_in_use), as Stripe answers a concurrent twin", async () => {
    const { s, now } = setup();
    const p = [1, 2, 3].map(() => s.createCheckoutSession(input({ expiresAt: now() + 31 * 60 }), "twin").then((x) => x.id, (e: StripeError) => e.kind));
    const out = await Promise.all(p);
    expect(out.filter((x) => x === "idempotency_in_progress")).toHaveLength(2);
    expect(s.created.sessions).toBe(1);
  });

  it("Checkout adds tax on top of the subtotal; the PaymentIntent is requires_capture with capture_before, and captures exactly the authorized amount", async () => {
    const { s, now } = setup();
    const sess = await s.createCheckoutSession(input({ expiresAt: now() + 31 * 60 }), "k");
    const evs = s.payCheckout(sess.id);
    expect(evs.map((e) => e.type)).toEqual(["checkout.session.completed", "payment_intent.amount_capturable_updated"]);
    const pi = await s.retrievePaymentIntent(evs[1]!.data.object.id);
    expect([pi.status, pi.amount, pi.amount_capturable, pi.currency, pi.capture_method]).toEqual(["requires_capture", 1925 + 154, 1925 + 154, "usd", "manual"]);
    expect(pi.capture_before).toBe(now() + 7 * 24 * 3600 - 60);
    expect(pi.metadata.order_id).toBe("ord_1");
    const done = await s.capturePaymentIntent(pi.id, "c");
    expect([done.status, done.amount_received, done.amount_capturable]).toEqual(["succeeded", 2079, 0]);
    await expect(s.cancelPaymentIntent(pi.id, "x")).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(s.capturePaymentIntent(pi.id, "c2")).rejects.toMatchObject({ kind: "invalid_request" });
  });

  it("an uncaptured authorization cancels itself when capture_before passes", async () => {
    const { s, now, clock } = setup();
    const sess = await s.createCheckoutSession(input({ expiresAt: now() + 31 * 60 }), "k");
    s.payCheckout(sess.id);
    const id = [...s.paymentIntents.keys()][0]!;
    clock.advance(7 * 24 * 3600_000);
    expect((await s.retrievePaymentIntent(id)).status).toBe("canceled");
    await expect(s.capturePaymentIntent(id, "late")).rejects.toMatchObject({ kind: "invalid_request" });
    expect(s.outbox.at(-1)!.type).toBe("payment_intent.canceled");
  });

  it("Sessions: expiry needs 30 minutes to 24 hours, an unpaid one expires on the clock, a completed one cannot be expired", async () => {
    const { s, now, clock } = setup();
    await expect(s.createCheckoutSession(input({ expiresAt: now() + 10 * 60 }), "short")).rejects.toMatchObject({ kind: "invalid_request" });
    const a = await s.createCheckoutSession(input({ expiresAt: now() + 31 * 60 }), "a");
    const b = await s.createCheckoutSession(input({ expiresAt: now() + 31 * 60, clientReferenceId: "o2" }), "b");
    s.payCheckout(a.id);
    await expect(s.expireSession(a.id, "e1")).rejects.toMatchObject({ kind: "invalid_request" });
    expect((await s.expireSession(b.id, "e2")).status).toBe("expired");
    expect(() => s.payCheckout(b.id)).toThrow();
    const c = await s.createCheckoutSession(input({ expiresAt: now() + 31 * 60, clientReferenceId: "o3" }), "c");
    clock.advance(32 * 60_000);
    expect((await s.retrieveSession(c.id)).status).toBe("expired");
  });

  it("events carry livemode and verify with the t=,v1= scheme; refunds need a captured charge", async () => {
    const { s, now, clock } = setup();
    const live = new FakeStripe(clock, { livemode: true });
    const sess = await live.createCheckoutSession(input({ expiresAt: now() + 31 * 60 }), "k");
    const [ev] = live.payCheckout(sess.id);
    expect(ev!.livemode).toBe(true);
    const w = live.deliver(ev!, ["s_new", "s_old"]);
    expect(live.constructEvent(w.body, w.headers["stripe-signature"]!, ["s_old"], clock.now()).id).toBe(ev!.id);
    expect(() => live.constructEvent(w.body, w.headers["stripe-signature"]!, ["nope"], clock.now())).toThrow(StripeError);
    expect(w.headers["stripe-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    const sess2 = await s.createCheckoutSession(input({ expiresAt: now() + 31 * 60 }), "k");
    s.payCheckout(sess2.id);
    const pi = [...s.paymentIntents.values()][0]!;
    await expect(s.createRefund({ paymentIntent: pi.id }, "r0")).rejects.toMatchObject({ kind: "invalid_request" });
    await s.capturePaymentIntent(pi.id, "c");
    expect((await s.createRefund({ paymentIntent: pi.id, amount: 79 }, "r1")).amount).toBe(79);
    await expect(s.createRefund({ paymentIntent: pi.id, amount: 5000 }, "r2")).rejects.toMatchObject({ kind: "invalid_request" });
  });
});

describe("StripeReal (never exercised against the network here)", () => {
  it("pins the API version and builds the Checkout parameters the plan requires", () => {
    expect(STRIPE_API_VERSION).toBe("2026-08-26.dahlia");
    const p = toStripeSessionParams(input({ expiresAt: 1234 }));
    expect(p.mode).toBe("payment");
    expect(p.payment_method_types).toEqual(["card"]);
    expect(p.payment_intent_data.capture_method).toBe("manual");
    expect(p.payment_method_options.card.request_three_d_secure).toBe("any");
    expect(p.automatic_tax).toEqual({ enabled: true });
    // 2026-10-08: Stripe's Managed Payments, on by default for a new account, refused the first live Checkout (`custom_text` is not allowed in that mode).
    expect(p.managed_payments).toEqual({ enabled: false });
    expect(p.custom_text.submit.message).toBeTruthy();
    expect(p.line_items[0]!.price_data.unit_amount).toBe(1925);
    expect(JSON.stringify(p)).not.toMatch(/"price":/);
    expect(toStripeSessionParams(input({ captureMethod: "automatic", requestThreeDSecure: "automatic" })).payment_intent_data.capture_method).toBe("automatic");
  });

  it("the constructor runs the mode guard: a live key outside production or with a mock registrar is refused", () => {
    const ok = () => new StripeReal({ apiKey: "sk_test_abc", mode: "local", registrarMode: "mock", client: {} as never });
    expect(ok().livemode).toBe(false);
    expect(() => new StripeReal({ apiKey: "sk_live_abc", mode: "local", registrarMode: "mock", client: {} as never })).toThrow(ModeError);
    expect(() => new StripeReal({ apiKey: "sk_live_abc", mode: "production", registrarMode: "mock", client: {} as never })).toThrow(ModeError);
    expect(() => new StripeReal({ apiKey: "sk_test_abc", mode: "production", registrarMode: "live", client: {} as never })).toThrow(ModeError);
    expect(new StripeReal({ apiKey: "sk_live_abc", mode: "production", registrarMode: "live", vercelEnv: "production", client: {} as never }).livemode).toBe(true);
    expect(() => new StripeReal({ apiKey: "pk_test_abc", mode: "local", registrarMode: "mock", client: {} as never })).toThrow();
  });

  it("calls the SDK with idempotency keys and maps its errors and objects", async () => {
    const calls: { fn: string; args: unknown[] }[] = [];
    const rec = (fn: string, ret: unknown) => async (...args: unknown[]) => { calls.push({ fn, args }); return ret; };
    const pi = { id: "pi_1", status: "requires_capture", amount: 2079, amount_capturable: 2079, amount_received: 0, currency: "usd", metadata: { order_id: "o" }, livemode: false, latest_charge: { payment_method_details: { card: { capture_before: 1700000000 } } }, review: null, payment_method: "pm_1", customer: "cus_1", capture_method: "manual", created: 1 };
    const client = {
      customers: { create: rec("customers.create", { id: "cus_1", livemode: false }) },
      checkout: { sessions: { create: rec("sessions.create", { id: "cs_1", url: "https://c", status: "open", payment_status: "unpaid", payment_intent: null, customer: "cus_1", metadata: {}, expires_at: 1, livemode: false }), retrieve: rec("sessions.retrieve", { id: "cs_1", status: "complete", payment_status: "unpaid", payment_intent: { id: "pi_1" }, livemode: false, total_details: { amount_tax: 154 }, amount_subtotal: 1925, amount_total: 2079 }), expire: rec("sessions.expire", { id: "cs_1", status: "expired", livemode: false }) } },
      paymentIntents: { retrieve: rec("pi.retrieve", pi), capture: rec("pi.capture", { ...pi, status: "succeeded", amount_received: 2079, amount_capturable: 0 }), cancel: rec("pi.cancel", { ...pi, status: "canceled" }), create: rec("pi.create", { ...pi, status: "succeeded" }) },
      refunds: { create: rec("refunds.create", { id: "re_1", status: "succeeded", amount: 79, payment_intent: "pi_1", currency: "usd" }) },
    };
    const r = new StripeReal({ apiKey: "sk_test_abc", mode: "local", registrarMode: "mock", client: client as never });
    await r.createCustomer({ userId: "u1" }, "cust:u1");
    await r.createCheckoutSession(input({ expiresAt: 1 }), "cs:o:1");
    const s = await r.retrieveSession("cs_1");
    expect([s.payment_intent, s.amount_tax]).toEqual(["pi_1", 154]);
    const got = await r.retrievePaymentIntent("pi_1");
    expect([got.capture_before, got.review_open]).toEqual([1700000000, false]);
    await r.capturePaymentIntent("pi_1", "cap:o");
    await r.cancelPaymentIntent("pi_1", "cancel:o");
    await r.expireSession("cs_1", "expire:o:1");
    await r.createOffSessionPaymentIntent({ customer: "cus_1", paymentMethod: "pm_1", amount: 100, currency: "usd", metadata: { order_id: "o" } }, "offsession:o");
    await r.createRefund({ paymentIntent: "pi_1", amount: 79, reason: "customer" }, "refund:o:1");
    const keys = calls.map((c) => (c.args.at(-1) as { idempotencyKey?: string } | undefined)?.idempotencyKey);
    expect(keys.filter(Boolean)).toEqual(["cust:u1", "cs:o:1", "cap:o", "cancel:o", "expire:o:1", "offsession:o", "refund:o:1"]);
    expect((calls.find((c) => c.fn === "pi.create")!.args[0] as Record<string, unknown>).off_session).toBe(true);
    expect((calls.find((c) => c.fn === "sessions.create")!.args[0] as { payment_method_types: string[] }).payment_method_types).toEqual(["card"]);
    expect((calls.find((c) => c.fn === "pi.retrieve")!.args[1] as { expand: string[] }).expand).toContain("latest_charge");
    // error mapping
    expect(mapError({ type: "StripeConnectionError" })).toMatchObject({ kind: "timeout" });
    expect(mapError({ type: "StripeAPIError", statusCode: 500 }).isServerError).toBe(true);
    expect(mapError({ type: "StripeCardError", statusCode: 402, code: "card_declined" })).toMatchObject({ kind: "card_error" });
    expect(mapError({ type: "StripeIdempotencyError", statusCode: 409 })).toMatchObject({ kind: "idempotency_in_progress" });
    expect(mapError({ type: "StripeRateLimitError", statusCode: 429 }).retryable).toBe(true);
    // constructEvent uses the same scheme as the fake
    const body = JSON.stringify({ id: "evt_1", type: "x", livemode: false, created: 1, data: { object: {} } });
    const now = new Date(1_800_000_000_000);
    expect(r.constructEvent(body, signHeader(body, "old", 1_800_000_000), ["new", "old"], now).id).toBe("evt_1");
    expect(() => r.constructEvent(body, signHeader(body, "old", 1_800_000_000), ["new"], now)).toThrow(StripeError);
  });
});
