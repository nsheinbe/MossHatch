# Runbook: payment mismatch

Template: PLAN section 5. Skeleton written in Phase 2 with the order machine. Covers: `paid_before_registration`, `capture_failed`, a Stripe-versus-`orders` disagreement found by `order.reconcile` or `stripe.reconcile`, an amount charged that differs from the amount shown, and a PaymentIntent within 36 hours of `capture_before` that is neither captured nor cancelled. Not run against live Stripe.

## Trigger

An S1 alert of kind `order.stuck`, `money.mismatch`, `capture_failed` or `job.dead` with a money kind; a customer report of a wrong charge; the daily `stripe.reconcile` finding.

## Severity

S1 (money). The customer-visible promise: never charged more than the total shown; a failed registration never keeps money.

## First 15 minutes

1. Identify the order: `select id, state, stripe_payment_intent_id, capture_before, total_minor, updated_at from orders where id = $1`, then `order_events` and `order_operations` for the cause chain. Ids only in notes and tickets.
2. Fetch the PaymentIntent from Stripe (never trust the cached copy): status, amount, amount_capturable, `capture_before`.
3. Match to a case:
   - **`paid_before_registration`** (captured while `authorized` or `registering`): the order registers or refunds. If registration is still possible and the name is ours or free, let the machine register; otherwise refund in full. Re-fetch the PaymentIntent before any cancel call.
   - **`capture_failed`** (registered, unpaid): retry the same idempotency key for 6 hours on 5xx or timeout; after a 500, `GET` the PaymentIntent and if still `requires_capture` capture with a new key. If cancelled or expired, charge a saved payment method off-session if one exists; otherwise send the pay link valid 7 days (human flows only, never agent flows) and keep the domain. At the deadline delete inside the add-grace period and book the loss.
   - **Amount differs from the quote** (the guard should have voided): stop, `orders_paused`, refund the difference, and open a defect: the price shown must equal the amount charged in every test.
   - **Stripe says paid, orders says not** (or the reverse): trust Stripe for money, the registrar for the domain. Run `order.reconcile` for the order, then decide refund or fulfil.
   - **Within 36 hours of `capture_before`, unresolved**: decide capture or cancel now; the authorization lapses at seven days (cards) and cannot be extended.
4. If more than one order is affected or the cause is unknown, set `orders_paused` and `registrar_writes_paused` until the cause is found.
5. Keep the customer informed within the hour when they were charged; use the templates in the app (receipt, void notice); they contain no payment or approval link.

## Decision owner

Founder. Refunds over USD 100 or more than three in 30 days for one account need a second look (own target).

## Customer-notice template

Charged and not registered: "We could not register <domain>, so we refunded USD <amount> to your card. It reaches your account in 5 to 10 business days, depending on your bank." Registered and payment pending: "We registered <domain> for you. Your payment did not complete. Pay within 7 days to keep it: <see the order in your account>." (No Stripe URL in email templates; the pay page is reached by signing in.) Wrong amount: "We charged USD <x> where you agreed to USD <y>. We refunded the difference today."

## Upstream and regulator clocks

- Stripe: authorization hold lasts 7 days for cards (Visa merchant-initiated 4 days 18 hours); refunds do not return the processing fee; dispute evidence is due by the date on the dispute (typically about 7 to 21 days; read the dispute).
- OpenSRS: a registration completed upstream but not paid is a loss unless deleted inside the add-grace period; check the grace window per extension in `tld_policy`.
- Consumer law: refund within the time the Terms promise (5-day window for the standard refund; counsel to confirm the statutory floor by jurisdiction).

## Evidence to preserve

`orders` row, all `order_events` and `order_operations`, `payments` and `refunds` rows, the Stripe PaymentIntent, Charge and event JSON (export from Dashboard), the `webhook_events` payloads, the `audit_log` rows for the order and any support actions, and the customer's message. Do not edit or delete rows; corrections go through a new event.

## Exit test

- `order.reconcile` for the order reports state equal to Stripe's and the registrar's.
- Ledger check: `sum(payments) - sum(refunds)` for the order equals the amount the customer should have paid.
- The customer has been told; no open alert of the kind remains.
- If a defect caused it: a failing test reproducing it now passes, and the price-equals-charge property test is green.
