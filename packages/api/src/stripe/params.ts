import type { CreateSessionInput } from "./port.ts";

/**
 * The exact Checkout Session parameters sent to Stripe (plan 4.3b, guards 6 and 7 and D-002):
 * - `payment_method_types` is pinned to card so a Dashboard change cannot add auto-capture methods (ACH, Link off);
 * - `capture_method=manual` so the money is held while we register;
 * - `request_three_d_secure` per rule; `automatic_tax` so tax is added at Checkout from the address entered there;
 * - the price is a server-computed `price_data` line, never a client price id;
 * - `payment_intent_data.setup_future_usage=off_session` only when the person opted into auto-renew at checkout (C-31, C-38).
 */
export function toStripeSessionParams(i: CreateSessionInput) {
  return {
    mode: "payment" as const,
    customer: i.customer,
    client_reference_id: i.clientReferenceId,
    success_url: i.successUrl,
    cancel_url: i.cancelUrl,
    expires_at: i.expiresAt,
    metadata: i.metadata,
    payment_method_types: ["card"] as ["card"],
    billing_address_collection: "required" as const,
    customer_update: { address: "auto" as const, name: "auto" as const },
    automatic_tax: { enabled: true },
    line_items: [{ quantity: 1, price_data: { currency: i.lineItem.currency, unit_amount: i.lineItem.unitAmount, tax_behavior: "exclusive" as const, product_data: { name: i.lineItem.name } } }],
    // `setup_future_usage` is sent only for the opt-in, so an order without it can never be charged off-session later (C-31).
    payment_intent_data: { capture_method: i.captureMethod, metadata: i.metadata, ...(i.setupFutureUsage ? { setup_future_usage: i.setupFutureUsage } : {}) },
    payment_method_options: { card: { request_three_d_secure: i.requestThreeDSecure } },
  };
}
