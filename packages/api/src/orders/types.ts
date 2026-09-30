import type { PoolClient } from "@mosshatch/db";
import type { RegisterRequest, RegistrarPort } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import type { StripePort } from "../stripe/port.ts";
import type { PricedQuote, QuoteJson } from "../pricing/index.ts";
import type { SanctionsPort } from "../compliance/index.ts";

export const ORDER_STATES = [
  "draft", "checkout_open", "checkout_expired", "payment_failed", "review_hold", "authorized", "registering", "registered", "capturing", "captured",
  "capture_failed", "registrar_unavailable", "outcome_unknown", "registration_failed", "canceling", "voided", "refund_pending", "refunded",
  "partially_refunded", "refund_failed", "dispute_open", "dispute_won", "dispute_lost", "paid_before_registration", "renewing_upstream", "renewed",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

/** Why an order was voided. Enumerated codes only; each maps to a plain customer message. */
export type VoidReason =
  | "name_taken" | "taken_by_other" | "auth_window" | "auth_lost" | "quote_increased" | "price_guard" | "registrar_unavailable" | "unknown_deadline" | "registration_rejected"
  | "no_contact" | "review_refused" | "unpaid" | "customer_cancel" | "guard_low" | "guard_high" | "guard_currency" | "guard_wrong_order" | "guard_open_review" | "guard_livemode";

/** The quote frozen into `orders.quote`: the pricing module's JSON form (bigints as decimal strings). */
export type FrozenQuote = QuoteJson;

export interface OrderRow {
  id: string;
  userId: string;
  kind: "register" | "renew" | "transfer_in" | "restore";
  fqdn: string;
  domainId: string | null;
  years: number;
  state: OrderState;
  idempotencyKey: string;
  quote: FrozenQuote;
  subtotalMinor: bigint;
  taxCeilingMinor: bigint;
  totalMinor: bigint;
  sessionId: string | null;
  paymentIntentId: string | null;
  attempt: number;
  captureBefore: Date | null;
  regUsername: string | null;
  livemode: boolean;
  failureCode: string | null;
  voidReason: VoidReason | null;
  authorizedAt: Date | null;
  amountCapturableMinor: bigint | null;
  registeredAt: Date | null;
  nextCheckAt: Date | null;
  checkCount: number;
  cancelPiId: string | null;
  captureFailedAt: Date | null;
  captureDeadline: Date | null;
  payLinkExpiresAt: Date | null;
  stripeCustomerId: string | null;
  paymentMethodRef: string | null;
  lateWatchUntil: Date | null;
  lateWatchState: "watching" | "claimed" | "expired" | null;
  createdAt: Date;
}

export type Registrant = RegisterRequest["registrant"];

/** Frozen-quote source. The real one wraps `buildQuote` (pricing module); tests may pass a stub. */
export interface OrderPricing {
  quote(ctx: AppContext, c: PoolClient, input: { fqdn: string; years: number }, now: Date): Promise<PricedQuote>;
}

export type ComplianceVerdict = { ok: true } | { ok: false; status: number; code: string };
export interface OrderCompliance {
  /** New-account limits, velocity and sanctions screening for one new order. Runs inside the request transaction. */
  check(ctx: AppContext, c: PoolClient, input: { userId: string; fqdn: string; wholesaleMinor: bigint; subtotalMinor: bigint }): Promise<ComplianceVerdict>;
}

/** Everything the orders module needs from outside, carried in `ctx.services.orders`. */
export interface OrdersServices {
  stripe: StripePort;
  registrar: RegistrarPort;
  /** Adapter id stored on `domains.registrar`. */
  registrarId: string;
  pricing: OrderPricing;
  compliance: OrderCompliance;
  /** Loads the registrant contact for the upstream request (decrypts `contacts`). */
  registrant(ctx: AppContext, userId: string): Promise<Registrant | null>;
  /** Sanctions list used by the default compliance check. */
  sanctions?: SanctionsPort;
  /** Signing secrets currently accepted (two during a 24-hour roll). */
  webhookSecrets(): string[];
  /** Keeps the function alive after the response (Vercel `waitUntil`); tests collect the promises. */
  waitUntil(p: Promise<unknown>): void;
  /** Runs a short tick after a webhook enqueued work. Default: the engine's opportunistic tick. */
  tick?(ctx: AppContext): void;
  /** Delete a domain inside its add-grace period (capture_failed ladder). Absent on adapters that cannot; the ladder then pages a human. */
  deleteDomain?(fqdn: string): Promise<void>;
  /** Refunds are allowed only for a domain with no DNS records and no connections; the DNS tables arrive in Phase 3, so the caller supplies the fact. */
  domainInUse?(ctx: AppContext, c: PoolClient, domainId: string): Promise<boolean>;
}

export const MIN_AUTH_WINDOW_MS = 24 * 3600_000;
export const FALLBACK_AUTH_WINDOW_MS = 4 * 24 * 3600_000;
export const SWEEP_UNKNOWN_AFTER_MS = 90_000;
export const LATE_WATCH_MS = 14 * 24 * 3600_000;
export const CAPTURE_RETRY_WINDOW_MS = 6 * 3600_000;
export const PAY_LINK_MS = 7 * 24 * 3600_000;
/** Deletion must happen inside the add-grace period (5 days); leave half a day of margin. */
export const ADD_GRACE_DEADLINE_MS = 5 * 24 * 3600_000 - 12 * 3600_000;
export const SESSION_TTL_MS = 31 * 60_000;
export const SELL_GATE_MIN_FUNDS_MINOR = 25_000n;
export const REFUND_CAP_PER_30_DAYS = 3;
