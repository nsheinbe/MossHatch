/**
 * The Stripe port. Only what the order machine needs; amounts are the integer minor units Stripe uses (JS numbers,
 * converted to bigint at the edge of our own code). Nothing here holds card data.
 */
export type StripeErrorKind = "api_error" | "timeout" | "rate_limit" | "invalid_request" | "card_error" | "idempotency_error" | "idempotency_in_progress" | "authentication" | "signature";

export class StripeError extends Error {
  constructor(public kind: StripeErrorKind, public status: number | null, public code?: string, message?: string) {
    super(message ?? `${kind}${code ? ":" + code : ""}`);
    this.name = "StripeError";
  }
  /** A 5xx from Stripe. Stripe caches it under the idempotency key, so a retry needs a NEW key after a GET. */
  get isServerError() { return this.kind === "api_error" && (this.status ?? 500) >= 500; }
  /** No answer at all (connection lost). The request may have been applied; the SAME key replays the real result. */
  get isTimeout() { return this.kind === "timeout"; }
  get retryable() { return this.kind === "api_error" || this.kind === "timeout" || this.kind === "rate_limit" || this.kind === "idempotency_in_progress"; }
}

export type CheckoutStatus = "open" | "complete" | "expired";
export interface CheckoutSession {
  id: string;
  url: string | null;
  status: CheckoutStatus;
  payment_status: "unpaid" | "paid" | "no_payment_required";
  payment_intent: string | null;
  customer: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string>;
  expires_at: number;
  livemode: boolean;
  amount_subtotal: number;
  amount_total: number;
  amount_tax: number;
  currency: string;
}

export type PaymentIntentStatus = "requires_payment_method" | "requires_confirmation" | "requires_action" | "processing" | "requires_capture" | "succeeded" | "canceled";
export interface PaymentIntent {
  id: string;
  status: PaymentIntentStatus;
  amount: number;
  amount_capturable: number;
  amount_received: number;
  currency: string;
  metadata: Record<string, string>;
  /** Unix seconds; null for cards without a documented window and for Link. */
  capture_before: number | null;
  livemode: boolean;
  /** True while a Radar review is open on the PaymentIntent. */
  review_open: boolean;
  payment_method: string | null;
  customer: string | null;
  capture_method: "manual" | "automatic";
  cancellation_reason: string | null;
  created: number;
}

export interface CreateSessionInput {
  customer: string;
  clientReferenceId: string;
  successUrl: string;
  cancelUrl: string;
  /** Unix seconds; Stripe requires 30 minutes to 24 hours from now. */
  expiresAt: number;
  metadata: Record<string, string>;
  lineItem: { name: string; unitAmount: number; currency: "usd" };
  captureMethod: "manual" | "automatic";
  requestThreeDSecure: "any" | "automatic";
  /**
   * `off_session` only when the person ticked the auto-renew box at checkout (C-31): Stripe then attaches the card to the customer so a
   * later renewal can be charged without them. Absent means the card is used once and never charged off-session.
   */
  setupFutureUsage?: "off_session";
}

/** The parts of a PaymentMethod Mosshatch reads: never a number, only the brand for the new-agreement rule (C-38). */
export interface PaymentMethodInfo { id: string; customer: string | null; brand: string | null }

export interface Refund { id: string; status: "succeeded" | "pending" | "failed" | "canceled"; amount: number; payment_intent: string; currency: string }

export interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  created: number;
  api_version?: string;
  /** `previous_attributes` is present on `*.updated` events such as `payment_method.automatically_updated`. */
  data: { object: Record<string, any>; previous_attributes?: Record<string, any> };
}

export interface CreateOffSessionInput { customer: string; paymentMethod: string; amount: number; currency: "usd"; metadata: Record<string, string> }

export interface StripePort {
  readonly livemode: boolean;
  createCustomer(input: { userId: string; metadata?: Record<string, string> }, idem: string): Promise<{ id: string; livemode: boolean }>;
  createCheckoutSession(input: CreateSessionInput, idem: string): Promise<CheckoutSession>;
  retrieveSession(id: string): Promise<CheckoutSession>;
  expireSession(id: string, idem: string): Promise<CheckoutSession>;
  retrievePaymentIntent(id: string): Promise<PaymentIntent>;
  /** Detach a saved card from its customer (C-31: the order ended without a name, or the person asked). Idempotent on our side. */
  detachPaymentMethod(id: string, idem: string): Promise<PaymentMethodInfo>;
  retrievePaymentMethod(id: string): Promise<PaymentMethodInfo>;
  /** Captures the full amount_capturable (never a partial amount). */
  capturePaymentIntent(id: string, idem: string): Promise<PaymentIntent>;
  cancelPaymentIntent(id: string, idem: string): Promise<PaymentIntent>;
  /** Off-session charge of a saved payment method, captured at once. */
  createOffSessionPaymentIntent(input: CreateOffSessionInput, idem: string): Promise<PaymentIntent>;
  createRefund(input: { paymentIntent: string; amount?: number; reason?: string; metadata?: Record<string, string> }, idem: string): Promise<Refund>;
  /**
   * Verify the signature over the raw body against every secret in `secrets` (two during a roll) and the timestamp
   * tolerance, then parse. Throws StripeError("signature") on any failure.
   */
  constructEvent(rawBody: string, signatureHeader: string | null, secrets: string[], now: Date, toleranceSec?: number): StripeEvent;
}
