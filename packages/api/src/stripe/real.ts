import Stripe from "stripe";
import { assertModeConsistency, type ModeInputs } from "../config/modeguard.ts";
import { verifySignature, DEFAULT_TOLERANCE_SEC } from "./signature.ts";
import { StripeError, type CheckoutSession, type CreateOffSessionInput, type CreateSessionInput, type PaymentIntent, type PaymentMethodInfo, type Refund, type StripeEvent, type StripePort } from "./port.ts";
import { toStripeSessionParams } from "./params.ts";
import { descriptorSuffix, type ProductSpec } from "./catalog.ts";

/**
 * The API version is pinned here and must equal the version set on the webhook endpoint in the Dashboard (plan 4.3b,
 * "Stripe idempotency keys"). Changing it is a reviewed change that re-runs the sandbox checks.
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia";

export interface StripeRealOptions {
  apiKey: string;
  /** The process's mode inputs. The constructor runs assertModeConsistency and throws (ModeError) unless key, registrar and environment agree. */
  mode: ModeInputs["mode"];
  registrarMode: ModeInputs["registrarMode"];
  vercelEnv?: ModeInputs["vercelEnv"];
  dbHost?: string;
  kmsAlias?: string;
  /** Injected for tests of the error mapping; production uses the SDK default. */
  client?: Stripe;
}

/**
 * The production adapter over stripe-node. UNTESTED AGAINST THE NETWORK in this repository (no Stripe access from the
 * build container): the mapping below is covered by unit tests against the FakeStripe's parameter shapes only.
 */
export class StripeReal implements StripePort {
  readonly livemode: boolean;
  private s: Stripe;

  constructor(o: StripeRealOptions) {
    const kind = /^(sk|rk)_live_/.test(o.apiKey) ? "live" : /^(sk|rk)_test_/.test(o.apiKey) ? "test" : null;
    if (!kind) throw new Error("stripe key must be a sk_/rk_ test or live key");
    assertModeConsistency({ stripeKeyKind: kind, registrarMode: o.registrarMode, mode: o.mode, vercelEnv: o.vercelEnv, dbHost: o.dbHost, kmsAlias: o.kmsAlias });
    this.livemode = kind === "live";
    this.s = o.client ?? new Stripe(o.apiKey, { apiVersion: STRIPE_API_VERSION as never, maxNetworkRetries: 0, timeout: 20_000, appInfo: { name: "mosshatch" } });
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) { throw mapError(e); }
  }

  async createCustomer(input: { userId: string; metadata?: Record<string, string> }, idem: string) {
    const c = await this.call(() => this.s.customers.create({ metadata: { user_id: input.userId, ...(input.metadata ?? {}) } }, { idempotencyKey: idem }));
    return { id: c.id, livemode: c.livemode };
  }

  async createCheckoutSession(input: CreateSessionInput, idem: string) {
    const s = await this.call(() => this.s.checkout.sessions.create(toStripeSessionParams(input) as never, { idempotencyKey: idem }));
    return mapSession(s);
  }
  async retrieveSession(id: string) { return mapSession(await this.call(() => this.s.checkout.sessions.retrieve(id))); }
  async expireSession(id: string, idem: string) { return mapSession(await this.call(() => this.s.checkout.sessions.expire(id, {}, { idempotencyKey: idem }))); }

  async retrievePaymentIntent(id: string) {
    return mapPi(await this.call(() => this.s.paymentIntents.retrieve(id, { expand: ["latest_charge", "review"] } as never)));
  }
  async capturePaymentIntent(id: string, idem: string) {
    return mapPi(await this.call(() => this.s.paymentIntents.capture(id, {}, { idempotencyKey: idem })));
  }
  async cancelPaymentIntent(id: string, idem: string) {
    return mapPi(await this.call(() => this.s.paymentIntents.cancel(id, {}, { idempotencyKey: idem })));
  }
  async createOffSessionPaymentIntent(i: CreateOffSessionInput, idem: string) {
    return mapPi(await this.call(() => this.s.paymentIntents.create({
      amount: i.amount, currency: i.currency, customer: i.customer, payment_method: i.paymentMethod, off_session: true, confirm: true, capture_method: "automatic",
      payment_method_types: ["card"], metadata: i.metadata, statement_descriptor_suffix: descriptorSuffix(i.operation ?? "renew"),
    }, { idempotencyKey: idem })));
  }
  async detachPaymentMethod(id: string, idem: string) {
    return mapPm(await this.call(() => this.s.paymentMethods.detach(id, {}, { idempotencyKey: idem })));
  }
  async retrievePaymentMethod(id: string) { return mapPm(await this.call(() => this.s.paymentMethods.retrieve(id))); }
  async createRefund(i: { paymentIntent: string; amount?: number; reason?: string; metadata?: Record<string, string> }, idem: string): Promise<Refund> {
    const r = await this.call(() => this.s.refunds.create({ payment_intent: i.paymentIntent, ...(i.amount !== undefined ? { amount: i.amount } : {}), ...(i.reason ? { metadata: { reason: i.reason, ...(i.metadata ?? {}) } } : { metadata: i.metadata ?? {} }) }, { idempotencyKey: idem }));
    return mapRefund(r);
  }
  async retrieveRefund(id: string): Promise<Refund> { return mapRefund(await this.call(() => this.s.refunds.retrieve(id))); }

  /** C-44 catalog setup: create the Product under its fixed id; an existing one (`resource_already_exists`) is read back instead. */
  async ensureProduct(spec: ProductSpec, idem: string) {
    try {
      const p = await this.s.products.create({ id: spec.id, name: spec.name, metadata: spec.metadata, ...(spec.taxCode ? { tax_code: spec.taxCode } : {}) }, { idempotencyKey: idem });
      return { id: p.id, created: true };
    } catch (e) {
      const err = mapError(e);
      if (err.kind !== "invalid_request" || err.code !== "resource_already_exists") throw err;
      const p = await this.call(() => this.s.products.retrieve(spec.id));
      if (!p.active) throw new StripeError("invalid_request", 400, "product_inactive");
      return { id: p.id, created: false };
    }
  }

  /** Same scheme and same code as the fake: t=,v1= HMAC-SHA256 over `t.body`, tolerance both ways, any of the given secrets. */
  constructEvent(rawBody: string, header: string | null, secrets: string[], now: Date, tolerance = DEFAULT_TOLERANCE_SEC): StripeEvent {
    const v = verifySignature(rawBody, header, secrets, now, tolerance);
    if (!v.ok) throw new StripeError("signature", null, v.reason);
    return JSON.parse(rawBody) as StripeEvent;
  }
}

function mapSession(s: any): CheckoutSession {
  return {
    id: s.id, url: s.url ?? null, status: s.status, payment_status: s.payment_status, payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null,
    customer: typeof s.customer === "string" ? s.customer : s.customer?.id ?? null, client_reference_id: s.client_reference_id ?? null, metadata: s.metadata ?? {}, expires_at: s.expires_at,
    livemode: s.livemode, amount_subtotal: s.amount_subtotal ?? 0, amount_total: s.amount_total ?? 0, amount_tax: s.total_details?.amount_tax ?? 0, currency: s.currency ?? "usd",
    billing_address: s.customer_details?.address ? { country: s.customer_details.address.country ?? null, state: s.customer_details.address.state ?? null } : null,
  };
}

function mapRefund(r: any): Refund {
  return { id: r.id, status: r.status as Refund["status"], amount: r.amount, payment_intent: typeof r.payment_intent === "string" ? r.payment_intent : r.payment_intent?.id, currency: r.currency };
}

function mapPm(p: any): PaymentMethodInfo {
  return { id: p.id, customer: typeof p.customer === "string" ? p.customer : p.customer?.id ?? null, brand: p.card?.brand ?? null };
}

function mapPi(p: any): PaymentIntent {
  const charge = p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
  const cb = charge?.payment_method_details?.card?.capture_before;
  const review = p.review && typeof p.review === "object" ? p.review : null;
  return {
    id: p.id, status: p.status, amount: p.amount, amount_capturable: p.amount_capturable ?? 0, amount_received: p.amount_received ?? 0, currency: p.currency, metadata: p.metadata ?? {},
    capture_before: typeof cb === "number" ? cb : null, livemode: p.livemode,
    // An unexpanded review id means we asked for it and it exists: treat as open until proven closed.
    review_open: review ? review.open === true : typeof p.review === "string",
    payment_method: typeof p.payment_method === "string" ? p.payment_method : p.payment_method?.id ?? null,
    customer: typeof p.customer === "string" ? p.customer : p.customer?.id ?? null, capture_method: p.capture_method, cancellation_reason: p.cancellation_reason ?? null, created: p.created,
    card_brand: charge?.payment_method_details?.card?.brand ?? null,
  };
}

export function mapError(e: unknown): StripeError {
  if (e instanceof StripeError) return e;
  const err = e as { type?: string; statusCode?: number; code?: string; message?: string; param?: string };
  const status = err.statusCode ?? null;
  switch (err.type) {
    case "StripeConnectionError": return new StripeError("timeout", null, "connection");
    case "StripeRateLimitError": return new StripeError("rate_limit", 429, err.code);
    case "StripeAuthenticationError": return new StripeError("authentication", 401, err.code);
    case "StripeCardError": return new StripeError("card_error", status ?? 402, err.code);
    case "StripeIdempotencyError": return new StripeError(status === 409 ? "idempotency_in_progress" : "idempotency_error", status, err.code);
    case "StripeInvalidRequestError": return new StripeError("invalid_request", status ?? 400, err.code, undefined, typeof err.param === "string" ? err.param.slice(0, 80) : undefined);
    default: return new StripeError("api_error", status ?? 500, err.code);
  }
}
