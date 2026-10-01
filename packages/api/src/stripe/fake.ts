import crypto from "node:crypto";
import type { Clock } from "../ports.ts";
import { canonicalJson } from "../util/bytes.ts";
import { signHeader, verifySignature, DEFAULT_TOLERANCE_SEC } from "./signature.ts";
import {
  StripeError,
  type CheckoutSession, type CreateOffSessionInput, type CreateSessionInput, type PaymentIntent, type Refund, type StripeEvent, type StripePort,
} from "./port.ts";
import { toStripeSessionParams } from "./params.ts";
import { CATALOG, descriptorSuffix, type ProductSpec } from "./catalog.ts";

/**
 * FakeStripe: a faithful in-memory model of the parts of Stripe the order machine touches. It is NOT Stripe. What it
 * models on purpose: hosted Checkout sessions, PaymentIntents in requires_capture / succeeded / canceled, idempotency
 * keys (a key replays the first result INCLUDING a cached 500, a different body under a used key is an error, keys
 * expire after 24 hours, and a second request while the first is in flight is a 409), `capture_before`, tax added at
 * Checkout on top of the subtotal, signed webhook events with `livemode`, and manual-capture cancel and refund rules.
 * Saved cards (API version pinned in real.ts, 2026-08-26.dahlia): a Checkout Session with `payment_intent_data.setup_future_usage=off_session`
 * attaches the card to the session's customer when it is paid (and emits `payment_method.attached`); an off-session PaymentIntent with a
 * card that is not attached to that customer is refused; `detach` removes the attachment; the card updater emits
 * `payment_method.automatically_updated` with the PaymentMethod and `previous_attributes`, as documented.
 * Catalog (C-44): Products with caller-chosen ids; a Session whose `price_data.product` names a missing or inactive Product is
 * refused (`resource_missing`), so a deployment that skipped `ensureCatalog` fails closed. Descriptors (C-40): a card PaymentIntent
 * takes `statement_descriptor_suffix` (at most 22 characters, no `< > \ ' " *`); the fake records it per PaymentIntent.
 * Billing address (C-42): the address typed at Checkout lands on `customer_details.address` (mapped to `billing_address`).
 * Disputes carry `payment_method_details.card.brand`; early fraud warnings do not.
 * What it cannot prove: any behaviour of the real API, wallets, Radar, Stripe Tax, or the exact error code Stripe returns for an
 * unattached card off-session (UNVERIFIED: the fake uses invalid_request / `payment_method_not_attached`), for a missing
 * Product, or for an invalid descriptor suffix (UNVERIFIED: the fake uses `parameter_invalid_string`).
 */
export type FaultMethod = "detachPaymentMethod" | "retrievePaymentMethod" | "createCheckoutSession" | "createCustomer" | "capturePaymentIntent" | "cancelPaymentIntent" | "expireSession" | "createRefund" | "retrieveRefund" | "retrievePaymentIntent" | "retrieveSession" | "createOffSessionPaymentIntent" | "ensureProduct";
export interface Fault {
  /** server: a 500 that Stripe caches under the idempotency key. timeout: applied, but the caller never sees the answer. lost: never applied, caller sees a timeout. */
  kind: "server" | "timeout" | "lost";
  times?: number;
}

export interface PayOptions {
  taxBps?: number;
  /** Anomalies for the authorized-amount guard. */
  amountCapturable?: number;
  currency?: string;
  metadataOrderId?: string;
  reviewOpen?: boolean;
  captureBefore?: number | null;
  /** `customer_details.address` as typed at Checkout. Default: a California address (an enabled region). */
  billingAddress?: { country: string | null; state: string | null } | null;
  /** Card that fails the authorization. */
  declined?: boolean;
  paymentMethod?: string;
  /** Capture automatically (a Dashboard-created or misconfigured method): the PaymentIntent ends succeeded. */
  autoCapture?: boolean;
}

interface Idem { hash: string; state: "inflight" | "done"; at: number; result?: unknown; error?: StripeError }

export class FakeStripe implements StripePort {
  readonly livemode: boolean;
  taxBps: number;
  /** Authorization window in ms for cards that carry capture_before. */
  captureWindowMs = 7 * 24 * 3600_000 - 60_000;
  sessions = new Map<string, CheckoutSession & { _params?: unknown; _paymentMethod?: string }>();
  paymentIntents = new Map<string, PaymentIntent>();
  refunds = new Map<string, Refund>();
  /**
   * The status a new refund is created with. `pending` models a refund Stripe accepted but has not settled (the amount is reserved
   * against the charge until it settles or fails); `finishPendingRefund` settles it. Which card refunds stay pending, and for how long,
   * is UNVERIFIED.
   */
  refundStatus: "succeeded" | "pending" = "succeeded";
  /** Products by id (C-44). Seeded with the catalog unless constructed with `catalog: "empty"`. */
  products = new Map<string, { id: string; name: string; active: boolean; tax_code: string | null; metadata: Record<string, string> }>();
  /** The statement-descriptor suffix sent for each PaymentIntent (C-40). */
  descriptors = new Map<string, string | null>();
  customers = new Map<string, { id: string; userId: string }>();
  /** Every card seen, with the customer it is attached to (null: used once, never saved). */
  paymentMethods = new Map<string, { id: string; customer: string | null; brand: string; expYear: number; last4: string }>();
  outbox: StripeEvent[] = [];
  calls: Record<string, number> = {};
  /** Real creations (an idempotent replay does not count). */
  created = { sessions: 0, customers: 0, refunds: 0, captures: 0, cancels: 0 };
  /** The last captured/cancelled key per PaymentIntent, for assertions about key hygiene. */
  keysUsed: { method: string; key: string }[] = [];
  private idem = new Map<string, Idem>();
  private faults = new Map<FaultMethod, { fault: Fault; remaining: number }>();
  private seq = 0;

  constructor(private clock: Clock, opts: { livemode?: boolean; taxBps?: number; catalog?: "seeded" | "empty" } = {}) {
    this.livemode = opts.livemode ?? false;
    this.taxBps = opts.taxBps ?? 0;
    if (opts.catalog !== "empty") for (const p of Object.values(CATALOG)) this.products.set(p.id, { id: p.id, name: p.name, active: true, tax_code: p.taxCode, metadata: {} });
  }

  // ---- controls -------------------------------------------------------------------------------------------------
  fail(method: FaultMethod, fault: Fault) { this.faults.set(method, { fault, remaining: fault.times ?? 1 }); }
  clearFaults() { this.faults.clear(); }
  private id(prefix: string) { return `${prefix}_${(++this.seq).toString().padStart(4, "0")}${crypto.randomBytes(3).toString("hex")}`; }
  private nowSec() { return Math.floor(this.clock.now().getTime() / 1000); }
  private count(m: string) { this.calls[m] = (this.calls[m] ?? 0) + 1; }
  private emit(type: string, object: Record<string, any>, livemode = this.livemode): StripeEvent {
    const ev: StripeEvent = { id: this.id("evt"), type, livemode, created: this.nowSec(), api_version: "2026-08-26.dahlia", data: { object: structuredClone(object) } };
    this.outbox.push(ev);
    return ev;
  }
  takeEvents(): StripeEvent[] { const e = this.outbox; this.outbox = []; return e; }

  /** What Stripe puts on the wire: the raw body and the signature header, signed with one or more secrets. */
  deliver(ev: StripeEvent, secrets: string | string[], opts: { t?: number } = {}): { body: string; headers: Record<string, string> } {
    const body = JSON.stringify(ev);
    return { body, headers: { "stripe-signature": signHeader(body, secrets, opts.t ?? this.nowSec()), "content-type": "application/json" } };
  }

  // ---- idempotency ----------------------------------------------------------------------------------------------
  private async run<T>(method: FaultMethod, key: string | null, params: unknown, apply: () => T): Promise<T> {
    this.count(method);
    const hash = key ? crypto.createHash("sha256").update(method + canonicalJson(params ?? null)).digest("hex") : "";
    if (key) {
      const prior = this.idem.get(key);
      if (prior && this.clock.now().getTime() - prior.at > 24 * 3600_000) this.idem.delete(key);
      const hit = this.idem.get(key);
      if (hit) {
        if (hit.hash !== hash) throw new StripeError("idempotency_error", 400, "idempotency_key_in_use", "Keys for idempotent requests can only be used with the same parameters they were first used with.");
        if (hit.state === "inflight") throw new StripeError("idempotency_in_progress", 409, "lock_timeout", "A request with this idempotency key is already in progress.");
        if (hit.error) throw hit.error;   // a cached 500 replays as a 500
        return hit.result as T;
      }
      this.idem.set(key, { hash, state: "inflight", at: this.clock.now().getTime() });
    }
    await new Promise<void>((r) => setImmediate(r));   // a real network hop: lets concurrent callers interleave
    const f = this.faults.get(method);
    let fault: Fault | undefined;
    if (f && f.remaining > 0) { f.remaining--; fault = f.fault; if (f.remaining === 0) this.faults.delete(method); }
    const settle = (patch: Partial<Idem>) => { if (key) Object.assign(this.idem.get(key)!, { state: "done", ...patch }); };
    try {
      if (fault?.kind === "lost") { if (key) this.idem.delete(key); throw new StripeError("timeout", null, "timeout"); }
      if (fault?.kind === "server") { const err = new StripeError("api_error", 500, "api_error", "An error occurred with our API."); settle({ error: err }); throw err; }
      const result = apply();
      settle({ result });
      if (fault?.kind === "timeout") throw new StripeError("timeout", null, "timeout");
      return result;
    } catch (e) {
      // Only successes and 5xx are stored under the key; validation and state errors are not.
      const rec = key ? this.idem.get(key) : undefined;
      if (key && rec && rec.state === "inflight") this.idem.delete(key);
      throw e;
    }
  }
  private key(k: string, method: string) { this.keysUsed.push({ method, key: k }); return k; }

  // ---- StripePort -----------------------------------------------------------------------------------------------
  async createCustomer(input: { userId: string; metadata?: Record<string, string> }, idem: string) {
    return this.run("createCustomer", this.key(idem, "createCustomer"), input, () => {
      const c = { id: this.id("cus"), userId: input.userId };
      this.customers.set(c.id, c); this.created.customers++;
      return { id: c.id, livemode: this.livemode };
    });
  }

  async createCheckoutSession(input: CreateSessionInput, idem: string): Promise<CheckoutSession> {
    return this.run("createCheckoutSession", this.key(idem, "createCheckoutSession"), input, () => {
      const now = this.nowSec();
      if (input.expiresAt < now + 30 * 60 - 5 || input.expiresAt > now + 24 * 3600) throw new StripeError("invalid_request", 400, "parameter_invalid_integer", "expires_at must be 30 minutes to 24 hours from now");
      const sp = toStripeSessionParams(input);
      const pd = sp.line_items[0]!.price_data as { product?: string; product_data?: unknown };
      if (pd.product && pd.product_data) throw new StripeError("invalid_request", 400, "parameter_unknown", "You may only specify one of these parameters: product, product_data.");
      const prod = pd.product ? this.products.get(pd.product) : undefined;
      if (pd.product && (!prod || !prod.active)) throw new StripeError("invalid_request", 400, "resource_missing", `No such product: '${pd.product}'`);
      this.checkDescriptor(sp.payment_intent_data.statement_descriptor_suffix);
      const id = this.id("cs_test");
      const s: CheckoutSession & { _params?: unknown } = {
        id, url: `https://checkout.stripe.test/c/pay/${id}`, status: "open", payment_status: "unpaid", payment_intent: null, customer: input.customer,
        client_reference_id: input.clientReferenceId, metadata: { ...input.metadata }, expires_at: input.expiresAt, livemode: this.livemode,
        amount_subtotal: input.lineItem.unitAmount, amount_total: input.lineItem.unitAmount, amount_tax: 0, currency: input.lineItem.currency,
        _params: { input, stripe: sp },
      };
      this.sessions.set(id, s); this.created.sessions++;
      return this.pubSession(s);
    });
  }

  private pubSession(s: CheckoutSession): CheckoutSession {
    this.expireIfDue(s);
    const rest: Record<string, unknown> = { ...s };
    delete rest._params; delete rest._paymentMethod;
    return structuredClone(rest) as unknown as CheckoutSession;
  }
  private expireIfDue(s: CheckoutSession) {
    if (s.status === "open" && this.nowSec() >= s.expires_at) { s.status = "expired"; s.url = null; this.emit("checkout.session.expired", s); }
  }

  async retrieveSession(id: string) {
    return this.run("retrieveSession", null, id, () => {
      const s = this.sessions.get(id);
      if (!s) throw new StripeError("invalid_request", 404, "resource_missing", "No such checkout session");
      return this.pubSession(s);
    });
  }

  async expireSession(id: string, idem: string) {
    return this.run("expireSession", this.key(idem, "expireSession"), id, () => {
      const s = this.sessions.get(id);
      if (!s) throw new StripeError("invalid_request", 404, "resource_missing", "No such checkout session");
      this.expireIfDue(s);
      if (s.status !== "open") throw new StripeError("invalid_request", 400, "resource_invalid_state", "Only Checkout Sessions with a status of open can be expired.");
      s.status = "expired"; s.url = null;
      this.emit("checkout.session.expired", s);
      return this.pubSession(s);
    });
  }

  async retrievePaymentIntent(id: string) {
    return this.run("retrievePaymentIntent", null, id, () => {
      const p = this.paymentIntents.get(id);
      if (!p) throw new StripeError("invalid_request", 404, "resource_missing", "No such payment_intent");
      this.expirePi(p);
      return structuredClone(p);
    });
  }
  private expirePi(p: PaymentIntent) {
    // An uncaptured authorization cancels itself when its window ends.
    if (p.status === "requires_capture" && p.capture_before !== null && this.nowSec() > p.capture_before) { p.status = "canceled"; p.cancellation_reason = "automatic"; p.amount_capturable = 0; this.emit("payment_intent.canceled", p); }
    else if (p.status === "requires_capture" && p.capture_before === null && this.nowSec() > p.created + 7 * 24 * 3600) { p.status = "canceled"; p.cancellation_reason = "automatic"; p.amount_capturable = 0; this.emit("payment_intent.canceled", p); }
  }

  async capturePaymentIntent(id: string, idem: string) {
    return this.run("capturePaymentIntent", this.key(idem, "capturePaymentIntent"), id, () => {
      const p = this.paymentIntents.get(id);
      if (!p) throw new StripeError("invalid_request", 404, "resource_missing", "No such payment_intent");
      this.expirePi(p);
      if (p.status !== "requires_capture") throw new StripeError("invalid_request", 400, "payment_intent_unexpected_state", `This PaymentIntent could not be captured because it has a status of ${p.status}.`);
      p.status = "succeeded"; p.amount_received = p.amount_capturable; p.amount_capturable = 0; this.created.captures++;
      this.emit("payment_intent.succeeded", p);
      return structuredClone(p);
    });
  }

  async cancelPaymentIntent(id: string, idem: string) {
    return this.run("cancelPaymentIntent", this.key(idem, "cancelPaymentIntent"), id, () => {
      const p = this.paymentIntents.get(id);
      if (!p) throw new StripeError("invalid_request", 404, "resource_missing", "No such payment_intent");
      this.expirePi(p);
      if (p.status === "succeeded" || p.status === "canceled") throw new StripeError("invalid_request", 400, "payment_intent_unexpected_state", `You cannot cancel this PaymentIntent because it has a status of ${p.status}.`);
      p.status = "canceled"; p.cancellation_reason = "requested_by_customer"; p.amount_capturable = 0; this.created.cancels++;
      this.emit("payment_intent.canceled", p);
      return structuredClone(p);
    });
  }

  async createOffSessionPaymentIntent(input: CreateOffSessionInput, idem: string) {
    return this.run("createOffSessionPaymentIntent", this.key(idem, "createOffSessionPaymentIntent"), input, () => {
      const now = this.nowSec();
      if (input.paymentMethod.startsWith("pm_declined")) throw new StripeError("card_error", 402, "card_declined", "Your card was declined.");
      if (input.paymentMethod.startsWith("pm_auth_required")) throw new StripeError("card_error", 402, "authentication_required", "This payment requires authentication.");
      // A card used once at Checkout without setup_future_usage is not attached to the customer and cannot be charged off-session.
      const pm = this.paymentMethods.get(input.paymentMethod);
      if (!pm || pm.customer !== input.customer) throw new StripeError("invalid_request", 400, "payment_method_not_attached", "The provided PaymentMethod is not attached to this Customer.");
      const suffix = descriptorSuffix(input.operation ?? "renew");
      this.checkDescriptor(suffix);
      const p: PaymentIntent = {
        id: this.id("pi"), status: "succeeded", amount: input.amount, amount_capturable: 0, amount_received: input.amount, currency: input.currency, metadata: { ...input.metadata },
        capture_before: null, livemode: this.livemode, review_open: false, payment_method: input.paymentMethod, customer: input.customer, capture_method: "automatic", cancellation_reason: null, created: now,
        card_brand: pm.brand,
      };
      this.paymentIntents.set(p.id, p);
      this.descriptors.set(p.id, suffix);
      this.emit("payment_intent.succeeded", p);
      return structuredClone(p);
    });
  }

  async detachPaymentMethod(id: string, idem: string) {
    return this.run("detachPaymentMethod", this.key(idem, "detachPaymentMethod"), id, () => {
      const pm = this.paymentMethods.get(id);
      if (!pm) throw new StripeError("invalid_request", 404, "resource_missing", "No such PaymentMethod");
      if (!pm.customer) throw new StripeError("invalid_request", 400, "payment_method_unexpected_state", "The payment method you provided is not attached to a customer so detachment is impossible.");
      pm.customer = null;
      this.emit("payment_method.detached", { id: pm.id, object: "payment_method", customer: null, card: { brand: pm.brand, last4: pm.last4, exp_year: pm.expYear } });
      return { id: pm.id, customer: null, brand: pm.brand };
    });
  }
  async retrievePaymentMethod(id: string) {
    return this.run("retrievePaymentMethod", null, id, () => {
      const pm = this.paymentMethods.get(id);
      if (!pm) throw new StripeError("invalid_request", 404, "resource_missing", "No such PaymentMethod");
      return { id: pm.id, customer: pm.customer, brand: pm.brand };
    });
  }

  async createRefund(input: { paymentIntent: string; amount?: number; reason?: string; metadata?: Record<string, string> }, idem: string) {
    return this.run("createRefund", this.key(idem, "createRefund"), input, () => {
      const p = this.paymentIntents.get(input.paymentIntent);
      if (!p) throw new StripeError("invalid_request", 404, "resource_missing", "No such payment_intent");
      if (p.status !== "succeeded") throw new StripeError("invalid_request", 400, "charge_not_refundable", "The charge has not been captured.");
      const already = [...this.refunds.values()].filter((r) => r.payment_intent === p.id && r.status !== "failed").reduce((a, r) => a + r.amount, 0);
      const amount = input.amount ?? p.amount_received - already;
      if (amount <= 0 || amount + already > p.amount_received) throw new StripeError("invalid_request", 400, "charge_already_refunded", "Refund amount exceeds the charge.");
      const r: Refund = { id: this.id("re"), status: this.refundStatus, amount, payment_intent: p.id, currency: p.currency };
      this.refunds.set(r.id, r); this.created.refunds++;
      this.emit("charge.refunded", { id: "ch_" + p.id, object: "charge", payment_intent: p.id, amount: p.amount_received, amount_refunded: already + amount, currency: p.currency, refunded: already + amount >= p.amount_received, metadata: p.metadata });
      return structuredClone(r);
    });
  }

  async retrieveRefund(id: string) {
    return this.run("retrieveRefund", null, id, () => {
      const r = this.refunds.get(id);
      if (!r) throw new StripeError("invalid_request", 404, "resource_missing", "No such refund");
      return structuredClone(r);
    });
  }

  /** A pending refund settles or fails: `refund.updated` (and `refund.failed` on failure) with the Refund object. */
  finishPendingRefund(id: string, status: "succeeded" | "failed"): StripeEvent[] {
    const r = this.refunds.get(id);
    if (!r || r.status !== "pending") throw new Error("no such pending refund");
    const before = this.outbox.length;
    r.status = status;
    const obj = { ...r, object: "refund", metadata: this.paymentIntents.get(r.payment_intent)?.metadata ?? {} };
    this.emit("refund.updated", obj);
    if (status === "failed") this.emit("refund.failed", obj);
    return this.outbox.slice(before);
  }

  constructEvent(rawBody: string, header: string | null, secrets: string[], now: Date, tolerance = DEFAULT_TOLERANCE_SEC): StripeEvent {
    const v = verifySignature(rawBody, header, secrets, now, tolerance);
    if (!v.ok) throw new StripeError("signature", null, v.reason);
    return JSON.parse(rawBody) as StripeEvent;
  }

  /** Product create with a caller-chosen id; an existing id is `resource_already_exists` on create, so ensure reads it back instead. */
  async ensureProduct(spec: ProductSpec, idem: string) {
    return this.run("ensureProduct", this.key(idem, "ensureProduct"), spec, () => {
      const have = this.products.get(spec.id);
      if (have) {
        if (!have.active) throw new StripeError("invalid_request", 400, "product_inactive", "This product is archived.");
        return { id: have.id, created: false };
      }
      this.products.set(spec.id, { id: spec.id, name: spec.name, active: true, tax_code: spec.taxCode, metadata: { ...spec.metadata } });
      return { id: spec.id, created: true };
    });
  }

  private checkDescriptor(suffix: string | null | undefined) {
    if (suffix == null) return;
    if (suffix.length > 22 || /[<>\\'"*]/.test(suffix) || !/[A-Za-z]/.test(suffix)) throw new StripeError("invalid_request", 400, "parameter_invalid_string", "Invalid statement_descriptor_suffix.");
  }

  // ---- what the customer, Radar and the Dashboard do ------------------------------------------------------------
  /** The customer completes Checkout. Tax is added on top of the subtotal from the address entered on the page. */
  payCheckout(sessionId: string, o: PayOptions = {}): StripeEvent[] {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("no such session");
    this.expireIfDue(s);
    if (s.status !== "open") throw new StripeError("invalid_request", 400, "resource_invalid_state", "This Checkout Session is no longer payable.");
    const tax = Math.floor((s.amount_subtotal * (o.taxBps ?? this.taxBps)) / 10_000);
    const total = s.amount_subtotal + tax;
    const before = this.outbox.length;
    if (o.declined) { const e = this.emit("payment_intent.payment_failed", { id: "pi_declined", metadata: s.metadata, last_payment_error: { code: "card_declined" } }); return [e]; }
    const now = this.nowSec();
    const params = (s as { _params?: { input: CreateSessionInput } })._params?.input;
    const auto = !!o.autoCapture || params?.captureMethod === "automatic";
    const pmId = o.paymentMethod ?? `pm_card_visa_${(++this.seq).toString().padStart(4, "0")}`;
    const saved = params?.setupFutureUsage === "off_session";
    if (!this.paymentMethods.has(pmId)) this.paymentMethods.set(pmId, { id: pmId, customer: null, brand: "visa", expYear: new Date(now * 1000).getUTCFullYear() + 3, last4: "4242" });
    if (saved && s.customer) {
      const pm = this.paymentMethods.get(pmId)!;
      pm.customer = s.customer;
      this.emit("payment_method.attached", { id: pm.id, object: "payment_method", customer: s.customer, card: { brand: pm.brand, last4: pm.last4, exp_year: pm.expYear } });
    }
    const pmRow = this.paymentMethods.get(pmId)!;
    const p: PaymentIntent = {
      card_brand: pmRow.brand,
      id: this.id("pi"), status: auto ? "succeeded" : "requires_capture", amount: o.amountCapturable ?? total, amount_capturable: auto ? 0 : (o.amountCapturable ?? total),
      amount_received: auto ? (o.amountCapturable ?? total) : 0, currency: o.currency ?? "usd",
      metadata: { order_id: o.metadataOrderId ?? s.metadata.order_id ?? "", attempt: s.metadata.attempt ?? "" }, capture_before: auto ? null : o.captureBefore !== undefined ? o.captureBefore : now + Math.floor(this.captureWindowMs / 1000),
      livemode: this.livemode, review_open: !!o.reviewOpen, payment_method: pmId, customer: s.customer, capture_method: auto ? "automatic" : "manual", cancellation_reason: null, created: now,
    };
    this.paymentIntents.set(p.id, p);
    this.descriptors.set(p.id, ((s as { _params?: { stripe: ReturnType<typeof toStripeSessionParams> } })._params?.stripe.payment_intent_data.statement_descriptor_suffix) ?? null);
    s.billing_address = o.billingAddress === undefined ? { country: "US", state: "CA" } : o.billingAddress;
    s.status = "complete"; s.payment_status = auto ? "paid" : "unpaid"; s.payment_intent = p.id; s.amount_tax = tax; s.amount_total = total; s.url = null;
    this.emit("checkout.session.completed", s);
    this.emit(auto ? "payment_intent.succeeded" : "payment_intent.amount_capturable_updated", p);
    return this.outbox.slice(before);
  }

  /**
   * The card network's updater replaced the saved card's details (new number or expiry, rarely a new brand). Emits
   * `payment_method.automatically_updated` with the PaymentMethod and `previous_attributes` naming what changed.
   */
  cardUpdater(pmId: string, change: { brand?: string; expYear?: number } = {}): StripeEvent {
    const pm = this.paymentMethods.get(pmId);
    if (!pm) throw new Error("no such payment method");
    const prev: Record<string, unknown> = { exp_year: pm.expYear, last4: pm.last4 };
    if (change.brand && change.brand !== pm.brand) prev.brand = pm.brand;
    pm.expYear = change.expYear ?? pm.expYear + 4; pm.last4 = String(1000 + (this.seq++ % 9000));
    if (change.brand) pm.brand = change.brand;
    const ev: StripeEvent = { id: this.id("evt"), type: "payment_method.automatically_updated", livemode: this.livemode, created: this.nowSec(), api_version: "2026-08-26.dahlia",
      data: { object: { id: pm.id, object: "payment_method", customer: pm.customer, type: "card", card: { brand: pm.brand, last4: pm.last4, exp_year: pm.expYear } }, previous_attributes: { card: prev } } };
    this.outbox.push(ev);
    return ev;
  }

  /** Test helper: a saved card attached to a customer (as a paid opt-in Checkout would leave it). */
  attachCard(pmId: string, customer: string, brand = "visa"): void {
    this.paymentMethods.set(pmId, { id: pmId, customer, brand, expYear: 2030, last4: "4242" });
  }

  /** Someone captures in the Dashboard. */
  dashboardCapture(piId: string): StripeEvent[] {
    const p = this.paymentIntents.get(piId);
    if (!p || p.status !== "requires_capture") throw new Error("not capturable");
    const before = this.outbox.length;
    p.status = "succeeded"; p.amount_received = p.amount_capturable; p.amount_capturable = 0;
    this.emit("payment_intent.succeeded", p);
    return this.outbox.slice(before);
  }

  openDispute(piId: string, kind: "dispute" | "efw" = "dispute"): StripeEvent {
    const p = this.paymentIntents.get(piId);
    if (!p) throw new Error("no such payment intent");
    return kind === "dispute"
      ? this.emit("charge.dispute.created", { id: this.id("dp"), object: "dispute", payment_intent: p.id, charge: "ch_" + p.id, status: "needs_response", amount: p.amount_received, payment_method_details: { type: "card", card: { brand: p.card_brand ?? "visa" } } })
      : this.emit("radar.early_fraud_warning.created", { id: this.id("issfr"), object: "radar.early_fraud_warning", payment_intent: p.id, charge: "ch_" + p.id, fraud_type: "unauthorized_use_of_card" });
  }
  closeDispute(piId: string, won: boolean): StripeEvent {
    return this.emit("charge.dispute.closed", { id: this.id("dp"), object: "dispute", payment_intent: piId, status: won ? "won" : "lost" });
  }

  /** Test access to the mapped Stripe parameters recorded when the session was created. */
  sessionParams(sessionId: string): { input: CreateSessionInput; stripe: ReturnType<typeof toStripeSessionParams> } {
    return (this.sessions.get(sessionId) as any)._params;
  }
}
