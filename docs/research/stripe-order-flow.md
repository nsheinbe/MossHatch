# Stripe order flow for Mosshatch (Phase 0 research dossier)

Accessed: 2026-09-29 (all "accessed" dates below are this date). Author: research subagent. Scope: Stripe facts only; registrar, ICANN and legal topics are covered by other dossiers.
Raw fetches are cached in `research/raw/stripe/` (markdown renderings of docs.stripe.com pages, the stripe-node 22.6.2 tarball, Vercel docs).

## TL;DR

1. Fulfil from webhooks, never from the redirect. Stripe's documented Checkout trigger is `checkout.session.completed` (plus `checkout.session.async_payment_succeeded` for delayed methods); `payment_intent.succeeded` is the PaymentIntent-level equivalent. Dedupe on `event.id`, re-fetch the object, make the handler idempotent. (F1-F4)
2. Hosted Checkout supports manual capture (`payment_intent_data.capture_method=manual`). Cards, Apple Pay, Google Pay and Link support it; ACH does not. Default hold is 7 days (Visa merchant-initiated 4d18h); uncaptured PaymentIntents auto-cancel at 7 days; the event is `payment_intent.amount_capturable_updated`. (F5-F12)
3. Recommendation: authorize -> register -> capture, cards/wallets/Link only, ACH disabled. Cancelling an authorization is free; Stripe states a refund does not return the original processing fee (2.9% + 30c on the US price page; one glossary line about "reversals" is ambiguous, F67, but Stripe's support article says "For all refunds ... fees from the original charge are not returned", F68). Authorizations reversed before capture are also not reported to the card networks as fraud, captured-then-refunded payments are (F69). A card refund can also sit "pending" if the available balance is short. This moves the brief's gate from "verified `payment_intent.succeeded`" to "verified `requires_capture`"; `payment_intent.succeeded` then marks PAID. (F13-F17, F67-F69, section 2.6)
4. Vercel webhook: use the Web-standard handler and `await request.text()` + `stripe.webhooks.constructEvent` (5-minute tolerance). Re-serialised JSON fails verification (tested offline). Live retries run up to 3 days; no ordering guarantee; ack 2xx fast, work off a queue or `waitUntil`. (F18-F27)
5. Renewals: save the card only with explicit consent (`setup_future_usage=off_session`), charge from our own scheduler with off-session PaymentIntents. Smart Retries covers Subscriptions/Invoices only, not plain PaymentIntents. `authentication_required` -> email an on-session pay link. Mastercard (per Stripe) requires a reminder for subscriptions billed 6+ months apart, so annual auto-renew needs one. (F28-F36)
6. Stripe Tax: no domain-name tax code exists (0 hits for "domain" in the code list); default is `txcd_10000000`. No registration in a jurisdiction = zero tax. USD prices default to tax-exclusive, so show "+ tax". Google Pay + Stripe Tax needs a shipping address. (F37-F43)
7. Pin the API: stripe-node 22.6.2 pins `2026-08-26.dahlia`; set `api_version` on the webhook endpoint too. Live rate limit 100 req/s; idempotency keys live 24 h. (F44-F48)
8. Not verifiable from docs (test in sandbox): `payment_status` on a manual-capture Session, PaymentMethod attach timing with manual capture + saved card, webhook timeout in seconds, tax on partial capture. See section 13.

---

## 1. Which event to trust for fulfilment (hosted Checkout)

### 1.1 What Stripe recommends
- Webhooks are mandatory; the landing page alone is not enough. Quote (fulfil guide): "You can't rely on triggering fulfillment only from your checkout landing page, because it's not guaranteed customers visit that page." https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted (accessed 2026-09-29)
- Trigger event: "When someone pays you, it creates a `checkout.session.completed` event." Delayed methods: "Delayed payment methods generate a checkout.session.async_payment_succeeded event when payment succeeds later." Same page. Sample handler fulfils on `checkout.session.completed` OR `checkout.session.async_payment_succeeded`, and Stripe suggests also handling `checkout.session.async_payment_failed`.
- The fulfil function must be re-entrant: "your `fulfill_checkout` function might be called multiple times, possibly concurrently, for the same Checkout Session"; it must retrieve the Session with `line_items` expanded, check `payment_status`, fulfil, and record fulfilment. Its sample checks `payment_status != 'unpaid'`.
- Redirect coupling: with `success_url` set and a `checkout.session.completed` endpoint, "Checkout waits up to 10 seconds for your server to respond to the webhook event delivery before redirecting your customer" (not for organization-level endpoints). Same page.
- PaymentIntent-level guidance (custom integrations): "use webhooks to monitor the `payment_intent.succeeded` event" and, in the event table, `succeeded` -> "Fulfill the purchased goods or services", `amount_capturable_updated` -> "The customer's payment is authorized and ready for capture. Capture the funds that are available for payment." https://docs.stripe.com/payments/payment-intents/verifying-status.md (accessed 2026-09-29)

### 1.2 Reading for Mosshatch
| Question | Answer | Basis |
|---|---|---|
| Is `payment_intent.succeeded` a legitimate fulfilment trigger for a Checkout order? | Yes for a payment that is captured: the Checkout-created PaymentIntent reaches `succeeded` and Stripe documents that status as "The funds are in your account and you can fulfill the order." Stripe's *Checkout-specific* recommendation, however, is `checkout.session.completed` (+ `async_payment_succeeded`). | verifying-status.md; fulfillment.md. The claim that Checkout-created PIs emit PI events is an inference (PI is a normal object); the stripe-node Next.js example subscribes to both (`checkout.session.completed`, `payment_intent.succeeded`). |
| Which to use as the *money-is-safe* gate? | Auto-capture: `payment_intent.succeeded` (PI `status=succeeded`). Manual-capture: `payment_intent.amount_capturable_updated` (PI `status=requires_capture`). | verifying-status.md; place-a-hold page (F6). |
| Can I trust `checkout.session.completed` alone? | No. Session `status=complete` only means "Payment processing may still be in progress" (API object doc). With delayed methods it fires with unpaid funds. Always re-fetch and check `payment_status` / PI status. | api/checkout/sessions/object.md (status enum). |

### 1.3 Recommended handler pattern
1. Verify signature on the raw body. 2. Insert `event.id` into a unique table; if already processed, return 200. 3. Enqueue; return 2xx. 4. Worker re-fetches the PaymentIntent (and Session if needed) and derives the order transition from the *fetched* state (not the event's `created`).
5. Set `payment_intent_data.metadata.order_id` and `client_reference_id` (max 200 chars) on the Session so PI events self-identify without needing the Session.

---

## 2. Manual capture with hosted Checkout

### 2.1 Support and parameters
- Enable: "specify capture_method as `manual` when creating the Checkout Session" (`payment_intent_data[capture_method]=manual`, mode=payment). https://docs.stripe.com/payments/place-a-hold-on-a-payment-method.md (accessed 2026-09-29)
- SDK type check (stripe-node 22.6.2 `Checkout.SessionCreateParams.PaymentIntentData.CaptureMethod`) = `'automatic' | 'automatic_async' | 'manual'`.
- Since API `2025-09-30.clover`, per-payment-method capture is possible in Checkout: `payment_method_options.<pm>.capture_method` for Affirm, Afterpay Clearpay, Alma, Amazon Pay, Billie, Card, Cash App Pay, Klarna, Link, MobilePay, Revolut Pay, Satispay. Quote: "This eliminates the previous limitations where enabling manual capture would either remove unsupported payment methods from the UI or cause errors when explicitly requested." https://docs.stripe.com/changelog/clover/2025-09-30/checkout-capture-method-per-payment-method.md
- Capture: after authorization the PaymentIntent "transitions to `requires_capture`"; capture with `POST /v1/payment_intents/{id}/capture` using the Session's `payment_intent` id. "A partial capture automatically releases the remaining amount"; "you can only perform one capture on an authorized payment for most payments."
- Cancel: PaymentIntent cancel is allowed in `requires_payment_method`, `requires_capture`, `requires_confirmation`, `requires_action`. "For PaymentIntents with a `status` of `requires_capture`, the remaining `amount_capturable` is automatically refunded." For a Checkout PI: "You can directly cancel the PaymentIntent for a Checkout Session only when the PaymentIntent has a status of `requires_capture`. Otherwise, you must expire the Checkout Session." https://docs.stripe.com/api/payment_intents/cancel.md

### 2.2 Events (F6)
| Moment | Event | Notes |
|---|---|---|
| Customer completes payment, funds held | `payment_intent.amount_capturable_updated` | "Occurs when a PaymentIntent has funds to be captured. Check the `amount_capturable` property..." (event-types) and "when a customer completes the payment process on a PaymentIntent with manual capture, it triggers the `payment_intent.amount_capturable_updated` event" (place-a-hold). |
| Same | `checkout.session.completed` | Ordering vs the PI event is not guaranteed (see 4.4). Treat either as "maybe authorized; verify PI". |
| You capture | `payment_intent.succeeded`, `charge.captured` ("Occurs whenever a previously uncaptured charge is captured") | |
| You cancel | `payment_intent.canceled` | |
| Hold expires uncaptured | `charge.expired` ("Occurs whenever an uncaptured charge expires"), PI goes `canceled` | "If the authorization expires before you capture the funds, the funds are released and the payment status changes to `canceled`." |
| Radar flags it | `review.opened` / `review.closed` | With manual capture, "approving the review doesn't automatically capture the charge" and PI has a `review` attribute to check before capture (radar/reviews/auth-and-capture). |

### 2.3 Authorization validity windows (card-not-present, online) (F7)
Source: https://docs.stripe.com/payments/place-a-hold-on-a-payment-method.md (accessed 2026-09-29). Quote: "Card networks assign different characteristics ... the `payment_method_details.card.capture_before` attribute on the charge is the most reliable and accurate way to determine your charge's authorization window." (cits-and-mits.md)

| Card brand | Merchant-initiated (MIT) | Customer-initiated (CIT) | Note |
|---|---|---|---|
| Visa | 5 days (exact 4 days 18 hours) | 7 days | |
| Mastercard | 7 days | 7 days | |
| American Express | 7 days | 7 days | |
| Discover | 7 days | 7 days | |
| Stripe default for uncaptured PIs | | | "Uncaptured PaymentIntents are cancelled a set number of days (7 by default) after their creation." (api/payment_intents/capture.md) |

Caveat (quote): "a payment with `off_session: true` might still be classified as a CIT if a CVC is present". Hosted Checkout is customer-present (CIT) -> plan for 7 days, read `capture_before`, store it on the order.
Other rules: Japan-based accounts can hold JPY up to 30 days (not relevant). "Card networks may also restrict 1 USD authorizations you don't intend to capture" -> do not use $1 auths to verify cards; use SetupIntent/`mode=setup`.

### 2.4 Extended authorization (F8)
Up to 30 days (Visa 29d18h) for eligible online card payments: `payment_method_options[card][request_extended_authorization]=if_available` with manual capture (https://docs.stripe.com/payments/extended-authorization.md?platform=web&ui=stripe-hosted). Constraints: Visa/Mastercard/Amex/Discover only; not for `link`-type payments; IC+ pricing only ("We offer extended authorizations to users on IC+ pricing"); Visa outside hotel/lodging/vehicle/cruise categories costs "an additional 0.08% fee per transaction" and only for CITs; and "for many networks extended validity windows are only for cases where you don't know the final amount that you'll capture at the time of authorization." **Not recommended for Mosshatch**: the amount is known, the 7-day window is ample, and it is a network-rule compliance risk.

### 2.5 Payment-method support for manual capture (F9)
Source: https://docs.stripe.com/payments/payment-methods/payment-method-support.md ("API support" tables; Checkout column from "Product support" tables), accessed 2026-09-29.

| Method | Manual capture | Setup future usage | In hosted Checkout | Note |
|---|---|---|---|---|
| Cards | Supported | Supported | Supported | |
| Apple Pay | Supported | Supported | Supported | rides on card; no separate enum |
| Google Pay | Supported | Supported | Supported | Checkout + Stripe Tax needs a shipping address for Google Pay to be offered (F42) |
| Link | Supported | Supported | Supported | no extended auth as `link` type |
| ACH Direct Debit | **Unsupported** ("Manual capture: X" also on the ACH page) | Supported | Supported | delayed: "Up to 4 business days (T+4)"; dispute "Submission window: 60 days" |
| Other bank debits (Bacs, BECS, ACSS, NZ) | Unsupported | Supported | | |
| Cash App Pay (7 days), Klarna (by midnight of the 28th calendar day), Affirm (30 days), Afterpay/Clearpay (13 days), PayPal (10 days, auto-extended to 20), Amazon Pay (supported; window not stated) | Supported | varies | varies | not planned for launch |
| iDEAL | Unsupported | | | |

### 2.6 Compare: (A) authorize -> register -> capture vs (B) capture -> register -> refund on failure

Money facts used (US price page, accessed 2026-09-29, https://stripe.com/pricing): "2.9% + 30c per successful transaction for domestic cards"; "+ 1.5% for international cards"; "+ 1% if currency conversion is required"; refunds: "For all other payment methods [than bank transfers], there are no fees for issuing refunds. The payment processing, Connect and currency conversion fees from the original transaction are not returned." Refund doc: "You can cancel a payment before it's completed at no cost ... Stripe's processing fees from the original transaction aren't returned." (https://docs.stripe.com/refunds.md). Docs even advise: "If your business processes a large volume of refunds close to the time of transaction, Stripe recommends using manual authorization and capture to reduce your refund costs."

| Dimension | (A) authorize -> register -> capture | (B) capture -> register -> refund |
|---|---|---|
| Cost of a failed registration | $0 (cancel PI; "no cost") | Fee kept by Stripe: 2.9% + $0.30 (e.g. $0.59 on $10, $0.88 on $20, $2.04 on $60; hypothetical prices). Caveat F67: a refund issued "shortly after the original charge" can be processed as a *reversal* (glossary: "Stripe doesn't withhold any fees for payment reversals"); the support article F68 says "For all refunds, payment processing, Connect, and currency conversion fees from the original charge are not returned", so plan on losing it |
| Refund mechanics | none (release of authorization; not a Refund object) | Refund needs *available* balance: "Refunds use your available Stripe balance (not including pending amounts)"; "If your available balance doesn't cover the amount of the refund, Stripe holds the refund as pending for card transactions" -> risky on a new account. Customer sees credit "approximately 5-10 business days later"; refund can fail "up to 30 days" later |
| Dispute exposure on failed orders | none (nothing captured) | customer may dispute before the refund lands; dispute fee $15 (+ $15 countered fee, returned if won) |
| Fraud control | Radar `review` can hold capture; register only after review clears. Stripe: "Issuers are required to report possible fraud for a captured payment, even if it gets refunded, but aren't required to report it for a payment authorization" (F69) -> a fraudulent order cancelled before capture never reaches the card-network fraud counts | money already taken; must reverse; refunded-but-captured fraud still counts (F69) |
| Brief's rule ("registrar only after verified `payment_intent.succeeded`") | Deviates: gate becomes verified `requires_capture` (Stripe: "Authorizing a payment guarantees the amount by holding it") | Matches |
| Time pressure | Must capture within `capture_before` (7d CIT); alert at <24h | none |
| Amount flexibility | Can capture *less* (multi-domain cart: capture sum of successes; remainder released free). Cannot capture *more* except limited overcapture | Partial refund per failed item (fee never returned) |
| Payment methods | cards, Apple/Google Pay, Link only | any incl. ACH (but ACH settles T+4) |
| Failure mode unique to it | Registered but capture fails/expired -> domain delivered, unpaid (exposure = wholesale cost). Mitigate: capture immediately, retry same idempotency key, fallback off-session charge or registrar deletion in grace period | Refund pending/failed; customer support load; wholesale cost already committed if registrar success is unknowable |
| Statement/UX | Customer sees a pending hold; "Card statements from some issuers ... don't always distinguish between authorizations and captured (settled) payments" | Customer sees charge then credit |
| Testing/complexity | Higher (two-step, expiry, review) | Lower; standard Stripe fulfilment pattern |
| Unknowns | tax/fee on partial capture; when a saved card attaches (section 13) | |

**Recommendation for a reseller: (A) for Phase 0**, restricted to methods that support manual capture, because the dominant failure is "domain not registrable at the moment of purchase" (race after availability check, registrar error, price change) and (A) makes that failure free and dispute-proof. Use (B) only as a fallback for a method that cannot hold funds (none at launch: leave ACH and other delayed methods off). Keep the wholesale-spend safety intent of the brief: the registrar call happens only when PI is `requires_capture` with `amount_capturable == order total`, currency and `order_id` matching, and no open Radar review; `payment_intent.succeeded` then moves the order to PAID. Renewals are a separate judgement (section 5.5).

---

## 3. Idempotency keys and the order state machine built on them

### 3.1 What Stripe guarantees (F48)
Source: https://docs.stripe.com/api/idempotent_requests.md and https://docs.stripe.com/error-low-level.md (accessed 2026-09-29).
- "Stripe's idempotency works by saving the resulting status code and body of the first request made for any given idempotency key, regardless of whether it succeeds or fails. Subsequent requests with the same key return the same result, including `500` errors."
- Keys: header `Idempotency-Key`, up to 255 chars, POST only ("Don't send idempotency keys in GET and DELETE requests"). "You can remove keys from the system automatically after they're at least 24 hours old." "The idempotency layer compares incoming parameters to those of the original request and errors if they're not the same."
- Not saved when the request never started executing: validation failures, or "the request conflicts with another request that's executing concurrently" (409). Rate-limited `429` can differ on retry "because rate limiters run before the API's idempotency layer".
- Replays carry `Idempotent-Replayed: true`. Safest strategy for 4xx: "always generate a new idempotency key".
- The SDK auto-retries with its own keys: stripe-node 22.6.2 source `getDefaultMaxNetworkRetries()` returns 2 (README table says 1; README is stale, source wins) and generates `stripe-node-retry-<uuid>` keys. Those are per call, so they do not protect against *your* app re-running an operation. Always pass your own business-level key.

### 3.2 Key scheme (derive from our IDs; parameters must be byte-identical for a given key)
| Stripe write | Key | Why |
|---|---|---|
| `POST /v1/customers` | `cust:{user_id}` | one Customer per user, ever (also store `metadata.user_id`) |
| `POST /v1/checkout/sessions` | `cs:{order_id}:{attempt}` | new attempt number when cart/price changes; Sessions expire in 30 min-24 h so a key never needs to outlive 24 h |
| `POST /v1/payment_intents/{id}/capture` | `cap:{order_id}` | exactly one capture per order |
| `POST /v1/payment_intents/{id}/cancel` | `cancel:{order_id}` | |
| `POST /v1/checkout/sessions/{id}/expire` | `expire:{order_id}:{attempt}` | |
| `POST /v1/refunds` | `refund:{order_id}:{seq}` | one key per intended refund (partials need distinct `seq`) |
| Off-session renewal PI | `renew:{domain_id}:{term_start}:{try}` | `try` increments only after a *determined* failure; transient network errors reuse the key |
After 24 h keys are pruned, so the durable guard must be our own DB (unique constraints on `stripe_checkout_session_id`, `stripe_payment_intent_id`, `(order_id, operation)`), not Stripe's cache.

### 3.3 Order state machine rules that follow
1. Every transition is a single-statement conditional update: `UPDATE orders SET state=$new WHERE id=$id AND state=$expected` (works on any Postgres driver; no interactive transaction needed). Zero rows updated = someone else already moved it.
2. Side effects (Stripe capture, registrar call, email) are executed by the winner of the transition, keyed by an operation id persisted *before* the call ("outbox"): `INSERT operations(order_id, kind, idempotency_key) ON CONFLICT DO NOTHING`.
3. Webhooks only *nudge*: the worker re-fetches the PaymentIntent/Session and computes the target state from fetched data. Stale or out-of-order events become no-ops.
4. The full text machine is in section 11.

---

## 4. Webhooks on Vercel functions

### 4.1 Signature verification and raw body (F18-F21)
- Header `Stripe-Signature: t=<ts>,v1=<sig>[,v0=...]`; "Currently, the only valid live signature scheme is `v1`"; HMAC SHA-256 over `timestamp + "." + raw body`; ignore non-`v1` schemes. https://docs.stripe.com/webhooks.md (accessed 2026-09-29)
- Quote: "Stripe requires the raw body of the request to perform signature verification. If you're using a framework, make sure it doesn't manipulate the raw body. Any manipulation to the raw body of the request causes the verification to fail."
- Tolerance: "Our libraries have a default tolerance of 5 minutes ... Don't use a tolerance value of `0`. Using a tolerance value of `0` disables the recency check entirely." Each retry gets a new timestamp and signature.
- Secret per endpoint and per mode: "If you use the same endpoint for both test and live API keys, the secret is different for each one"; CLI `stripe listen` prints its own `whsec_` ("Don't verify signatures on events forwarded by the CLI using the secret from a Dashboard-managed endpoint"). Rolling a secret can keep the old one alive up to 24 h. https://docs.stripe.com/webhooks/signature.md
- **Offline test I ran** (stripe-node 22.6.2, scratchpad `sigtest.cjs`): a payload verified OK; the same JSON parsed and re-serialised (`JSON.stringify(JSON.parse(p))`) -> `StripeSignatureVerificationError: No signatures found matching the expected signature for payload. Are you passing the raw r...`; a header 10 minutes old -> `Timestamp outside the tolerance zone`; empty secret -> `No webhook secret value was provided. It should start with whsec_` (22.6.2 changelog: "Validate that webhook secrets are non-empty").
- Vercel specifics (https://vercel.com/docs/functions/runtimes/node-js.md, last_updated 2026-08-11): Node-style `/api` handlers get a parsed `request.body` ("We populate the `request.body` property with a parsed version of the content sent with the request"), which would break verification. The Web-standard handlers (`export default { fetch(request) }` or `export function POST(request: Request)`) receive a standard `Request`; use `await request.text()` (the stripe-node Next.js App Router example does exactly this: `stripe.webhooks.constructEvent(await req.text(), sig, secret)`, https://github.com/stripe/stripe-node/blob/master/examples/webhook-signing/nextjs/app/api/webhooks/route.ts). Node runtime has Node crypto so sync `constructEvent` is fine (no need for `constructEventAsync`).

### 4.2 Delivery, retries, timeouts (F22, F24, F25)
- Live retries: "Stripe attempts to deliver events to your destination for up to three days with an exponential back off in live mode." Sandbox: "We retry event deliveries created in a sandbox three times over the course of a few hours." No explicit schedule published (unverified).
- Success = any `2xx`; redirects (`3xx`) count as failure; "Stripe requires TLS version v1.2 or higher"; HTTPS required in live mode; up to 16 endpoints.
- Timeout: docs say only "Make sure you defer complex logic and return a successful response immediately"; the number of seconds is not published in the pages fetched (unverified). Only hard number: Checkout waits up to 10 s for the `checkout.session.completed` ack before redirecting (with `success_url`).
- Manual recovery: Dashboard "Resend" up to 15 days; `stripe events resend <event_id> --webhook-endpoint=<id>` up to 30 days; `GET /v1/events?delivery_success=false` returns "events created in the last 30 days" (process-undelivered-events.md). Write a reconciliation cron that lists recent PaymentIntents/Sessions and repairs orders whose webhook never arrived.
- Vercel side (https://vercel.com/docs/functions/limitations.md, accessed 2026-09-29): default max duration 300 s with fluid compute (Hobby max 300 s; Pro/Enterprise 800 s); payload limit 4.5 MB (Stripe events are far smaller). `waitUntil` (from `@vercel/functions`) "Extends the lifetime of the request handler for the lifetime of the given Promise" and shares the function's timeout. Pattern: verify -> insert event id -> `waitUntil(process())` -> return 200 immediately; heavy work (registrar) goes to a queue/cron worker.
- **Preview deployments**: Vercel Deployment Protection blocks unauthenticated callers on preview URLs; Stripe cannot send custom headers, so a preview webhook would need the query-parameter bypass `?x-vercel-protection-bypass=<secret>` (protection-bypass-automation.md), which puts a secret in the URL. Prefer: register the Stripe endpoint only for production (and one stable staging domain) and use `stripe listen --forward-to` for local/preview work.

### 4.3 Events to subscribe to (create the endpoint via API so `api_version` can be pinned)
| Event | Why | Phase 0 |
|---|---|---|
| `checkout.session.completed` | link Session -> PI, nudge order to AUTHORIZED check | required |
| `checkout.session.async_payment_succeeded` / `_failed` | only if any delayed method is ever enabled (ACH etc.) | subscribe (cheap), handle as no-op if none |
| `checkout.session.expired` | order back to CHECKOUT_EXPIRED | required |
| `payment_intent.amount_capturable_updated` | authorization succeeded -> may register | required |
| `payment_intent.succeeded` | captured -> PAID | required |
| `payment_intent.payment_failed` | show retry state (Session stays open) / off-session renewal failure | required |
| `payment_intent.canceled` | hold released (our cancel or expiry) | required |
| `payment_intent.requires_action` | off-session renewal needs 3DS (if not thrown as error) | recommended |
| `charge.captured`, `charge.expired` | audit / expiry alert | optional |
| `refund.created`, `refund.updated`, `refund.failed` (and/or `charge.refunded`) | refund lifecycle; `charge.refund.updated` is deprecated | required |
| `charge.dispute.created`, `.updated`, `.closed`, `.funds_withdrawn`, `.funds_reinstated` | dispute workflow | required |
| `review.opened`, `review.closed` | Radar review gating capture | required if Radar reviews on |
| `radar.early_fraud_warning.created` | proactive refund / registrar action | recommended |
| `payment_method.automatically_updated` | Card Account Updater; brand change requires new consent | required once cards are saved |
| `payment_method.detached`, `customer.updated`, `customer.deleted` | keep local mirror (portal edits, deletions) | recommended |
Source for event names/descriptions: https://docs.stripe.com/api/events/types.md (accessed 2026-09-29). Stripe: "Configure your webhook endpoints to receive only the types of events required by your integration."

### 4.4 Duplicates and out-of-order delivery (F23)
- "Webhook endpoints might occasionally receive the same event more than once. You can guard against duplicated event receipts by logging the event IDs you've processed." "In some cases, two separate Event objects are generated and sent. To identify these duplicates, use the ID of the object in `data.object` along with the `event.type`."
- "Stripe doesn't guarantee the delivery of events in the order that they're generated ... Don't use `created` to determine event order or whether you've already processed an event." "You can also use the API to retrieve any missing objects."
- Design: (event.id) unique + (object id, type) secondary dedupe; state guards; re-fetch. Expected orderings to tolerate: `payment_intent.amount_capturable_updated` before or after `checkout.session.completed`; `payment_intent.succeeded` before our DB records the capture call's response.

---

## 5. Saving payment methods for renewals

### 5.1 Saving the card in hosted Checkout (F28)
Source: https://docs.stripe.com/payments/checkout/save-during-payment.md?payment-ui=stripe-hosted and https://docs.stripe.com/payments/accept-a-payment.md?payment-ui=checkout&ui=stripe-hosted (accessed 2026-09-29).
- "By default, payment methods used to make a one-time payment with Checkout aren't available for future use." Pass `payment_intent_data[setup_future_usage]=off_session` with `customer_creation=always` (or an existing `customer`). SDK doc: "If Checkout does not create a Customer, the payment method is not attached to a Customer."
- "When setting this to `off_session`, Checkout will show a notice to the customer that their payment details will be saved and used for future payments" (stripe-node type docs) and "Checkout also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as SCA."
- Saved this way the card gets `allow_redisplay: limited` -> "don't appear for return purchases in Checkout" (no prefill). Prefill needs `saved_payment_method_options[payment_method_save]=enabled` (optional checkbox, `allow_redisplay: always`). Removal: `saved_payment_method_options[payment_method_remove]=enabled`.
- Privacy: "We recommend contacting your legal and privacy team prior to implementing `setup_future_usage`" (cites EDPB guidance).
- Wallet support: Apple Pay, Google Pay and Link show "Setup future usage: Supported" (payment-method-support.md); Amazon Pay/PayPal per their pages.
- To save without paying: Checkout `mode=setup` (used for the "add/replace card" page).

### 5.2 Charging off-session and SCA / 3-D Secure (F29-F32)
- Charge: PaymentIntent with `customer`, `payment_method`, `off_session=true`, `confirm=true`. Quote: "Set `off_session` to true to indicate that the customer isn't in your checkout flow to respond to any authentication requests. If ... a partner (such as a card issuer or bank) requests authentication, Stripe requests exemptions using customer information from a previous on-session transaction. If the conditions for exemption aren't met, the PaymentIntent might throw an error." https://docs.stripe.com/payments/save-and-reuse.md?payment-ui=elements
- SCA: "If you collect payments when your customer isn't actively using your application, SCA might require your customer to re-authenticate, even if they authenticated in the past." "Exemptions aren't guaranteed, and off-session payments might still require authentication by the bank." Subsequent off-session payments on a properly saved card are marked as "merchant-initiated transaction (MIT)" and "require an agreement (also known as a mandate)". https://docs.stripe.com/strong-customer-authentication.md
- Mandate text to cover minimally: customer's permission for you to initiate a payment or series of payments; "The anticipated frequency of payments (one-time or recurring)"; "How you determine the payment amount". Stripe's suggested consent: a "Save my payment method for automatic renewals" checkbox; "Keep a record of each customer's agreement to your terms." https://docs.stripe.com/payments/cits-and-mits.md
- Card brand change via Account Updater: listen for `payment_method.automatically_updated`; "When a card's brand changes, you can't charge it for any MITs until you get a new cardholder agreement." (cits-and-mits.md)

### 5.3 Failure and recovery flow (authentication_required) (F30, F32)
- "When a payment attempt fails, the request also fails with a 402 HTTP status code and the status of the PaymentIntent is `requires_payment_method`. You must notify your customer to return to your application to complete the payment (for example, by sending an email or in-app notification)." "If the payment failed due to an `authentication_required` decline code, use the declined PaymentIntent's client secret with `confirmPayment` to allow the customer to authenticate the payment." (save-and-reuse.md)
- Decline code table: `authentication_required` - "you might need to ask the customer to return" for off-session payments; `authentication_not_handled` - "For off-session payments, collect and prepare authentication on-session first, then fall back to on-session if needed." https://docs.stripe.com/declines/codes.md
- Mosshatch recovery flow: (1) catch `StripeCardError` (code / `decline_code` / `payment_intent.last_payment_error`); (2) persist renewal state `NEEDS_CUSTOMER`; (3) Resend email with a signed link `/renew/{token}` (short-lived, single use, bound to renewal id); (4) the page either confirms the *existing* PaymentIntent client secret via Stripe.js (authentication_required) or creates a fresh hosted Checkout Session (`mode=payment`, `setup_future_usage=off_session` to refresh the mandate) for declines/expired cards; (5) `payment_intent.succeeded` -> proceed to registrar renewal; (6) reminders at our own cadence until the domain's expiry/grace policy ends (ICANN timing is in another dossier).
- Test cards: `4000002500003155` ("requires authentication for off-session payments unless you set it up ... After you set it up, off-session payments no longer require authentication"), `4000002760003184` ("requires authentication on all transactions, regardless of how the card is set up" - use this to force `authentication_required`), `4000000000009995` (insufficient funds), `4000000000000341` (attach succeeds, later charges fail). https://docs.stripe.com/testing.md

### 5.4 Card-network rules on notifying customers before recurring charges (F34, F35)
- **Mastercard** (Stripe support summary, effective 2022-09-22): subscription merchants must provide "An email or electronic payment reminder for any subscription that processes 6 or more months apart (such as an annual subscription)"; full terms at signup; receipt and cancel instructions in an email; "at least seven (7) days in advance" written confirmation when a trial expires, terms change, or on cancellation confirmation (within 7 days). Trials over 7 days: notify "no less than three days, and no more than seven days" before the trial ends. https://support.stripe.com/questions/guidance-for-mastercard-recurring-billing-compliance-updates (rendered with headless Chromium; Mastercard's own rulebook not accessed). **Annual domain auto-renewal falls in the "6+ months apart" bucket if treated as a subscription** -> send a renewal reminder email; Stripe's own Billing reminder can be set "between 7 and 30 days" for long periods.
- **Visa** (Stripe FAQ, 2020): rules target free/promotional trials; "Do I have to email my customer 7 days before every new subscription charge? No, you only need to send the reminder before the date that it converts to a paid subscription." https://support.stripe.com/questions/2020-visa-trial-subscription-requirement-changes-faq
- US state/FTC negative-option rules: Stripe's page (https://support.stripe.com/questions/faq-ftc-california-subscription-law-changes-require-billing-updates) says the FTC rule was "Effective from July 14, 2025" and requires self-serve cancellation. Current legal status of that rule was **not verified** here -> legal dossier.
- Practical minimum for Mosshatch: send a renewal notice email T-30 and T-7 days before any automatic charge (also serves ICANN expiry notices), state amount and date, include one-click "turn off auto-renew" link.

### 5.5 Subscriptions vs Invoices vs one-off off-session PaymentIntents
| Criterion | Subscription | One-off Invoice (auto-collect) | Off-session PaymentIntent (own scheduler) |
|---|---|---|---|
| Smart Retries / dunning | Yes. "Stripe Billing can automatically retry failed subscription and invoice payments"; default "8 tries within 2 weeks" | Yes (invoices) | **No.** Smart Retries page covers "failed subscription and invoice payments" only |
| Retry for `authentication_required` | Scheduled but does not execute: it is a hard-decline code, "retries only execute after detecting a new payment method" | same | n/a: we email the recovery link |
| Stripe emails (failed payment, upcoming renewal, expiring card) | Built in (Billing settings) | hosted invoice page + emails | none: send via Resend |
| Extra Stripe fee (US price page) | Billing pay-as-you-go "0.7% of Billing volume" (or from $620/month) | Invoicing Starter "0.4% per paid invoice" | none beyond card fee |
| Fit with per-domain lifecycle (expiry date, registrar renewal call after payment, price changes, per-domain auto-renew toggles, grace/redemption timing) | Poor: one subscription per domain or a mixed-date item pile; Stripe's retry window is independent of registry deadlines; renewals must be gated on `invoice.paid` then registrar call | Medium: one invoice per domain-renewal, pay link built in, but retries still independent of registry clock | Best control: amount decided at charge time, key = `renew:{domain}:{term}`, charge exactly N days before expiry, retry cadence tied to expiry |
| Test time-travel | Test clocks work | Test clocks work (invoices) | **No** test clocks (Billing objects only: "up to three customers"; "you can only move it forward") -> inject our own clock |
| Customer portal | Designed around subscriptions | invoices | payment-method page only (see 9.3) |
**Recommendation: off-session PaymentIntents from our scheduler for Phase 0**, with our own reminder/dunning emails. Revisit Invoices if manual dunning becomes a burden. Sources: smart-retries.md, test-clocks-api.md, stripe.com/pricing.
Judgement: renewals may use capture-first (saved card + mandate, domain already exists so no availability race, and registrar renewal is time-critical); a failed registrar renewal after capture is then a refund, and is rare.

### 5.6 Manual capture + saved card (open question)
Whether the PaymentMethod is attached to the Customer at authorization (`requires_capture`) or only after capture, and whether cancelling the PaymentIntent leaves it saved, is not stated in the docs fetched. The order flow must not depend on the answer: after `payment_intent.succeeded`, read `payment_intent.payment_method` and check `customer` attachment; if absent, prompt the customer once ("save for renewal") via `mode=setup`.

---

## 6. Stripe Tax with Checkout

### 6.1 Mechanics (F37-F39)
- Enable: `automatic_tax[enabled]=true` on the Session; "applies automatic tax to the entire Checkout Session" for any payment method. https://docs.stripe.com/tax/checkout/page.md (accessed 2026-09-29). Location: "Checkout calculates taxes based on the billing address" for digital goods (shipping address wins if collected). Use `billing_address_collection=required` so tax is deterministic; `customer_update[address]=auto` when passing an existing `customer`. Result: `total_details.amount_tax` on the Session.
- **Registrations gate everything**: "Stripe only calculates tax in jurisdictions where you have an active tax registration. Without a registration in the customer's location, the calculation returns zero tax." (tax/tax-codes.md; tax/checkout/page.md). Zero-tax outcomes show `taxability_reason: not_collecting` (tax/zero-tax.md).
- `tax_behavior` on the Price (or `price_data`): "You must specify a `tax_behavior` on a price, or a default tax behavior in the tax settings." Stripe recommends **Automatic**: "exclusive pricing for USD and CAD and inclusive pricing for all other currencies". Exclusive: tax added on top ("$5.00 + 10% = $5.50"); inclusive: "the amount your customer pays remains constant". "You can't change `tax_behavior` after it's been set to exclusive or inclusive." https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior.md
- Customer tax IDs (B2B reverse charge): `tax_id_collection` (tax/checkout/tax-ids).

### 6.2 Product tax code for domain names (F40)
- The published code list (https://docs.stripe.com/tax/tax-codes.md, 200 KB) contains **no** entry with "domain" (0 matches). Closest candidates: `txcd_10000000` "General - Electronically Supplied Services" (default for digital; "If you stay with this category, taxes will be similar to those for a generic digital item like downloaded music"), `txcd_10701100` "Website Hosting" (A service to enable a customer's website to be accessible on the internet - not a domain registration), `txcd_20030000` "General - Services", `txcd_00000000` "Nontaxable".
- Stripe's guidance for tool/agent use: "Treat `txcd_` identifiers as opaque, exact strings ... Don't make the legal tax classification for the user." -> **decision needs an accountant** (taxability of domain registration varies by US state and country). Until decided: use the account preset `txcd_10000000`, and keep the reseller flat fee and the wholesale pass-through as one line item with one tax code.

### 6.3 Showing price + tax honestly before payment (F41-F43)
- Pricing display facts: USD defaults to tax-exclusive, so the Checkout total will exceed the list price once the address is known. On the Mosshatch pricing page and cart, show "Price $X + tax calculated from your billing address at checkout" (never a lower "from" price with the flat fee added later), and show the final tax line on our own approval screen before the passkey prompt.
- Estimate before redirect: Tax Calculation API `POST /v1/tax/calculations` (https://docs.stripe.com/api/tax/calculations/create.md). Pricing: "API integration $0.50 per transaction, where you're registered to collect taxes ... Each transaction includes 10 calculation API calls. 5c per calculation API call above 10." Alternative: create the Checkout Session first (it computes tax once an address is present) and read `total_details.amount_tax`. Tax Basic no-code (Checkout) is "0.5% per transaction, where you're registered to collect taxes".
- Google Pay gotcha: "To make sure Google Pay is offered as a payment method while using Stripe Tax in Checkout, you must either collect a shipping address or provide an existing customer with a saved shipping address." (tax/checkout/page.md). For a digital product either copy the billing address into the Customer's shipping field or accept that Google Pay disappears.
- Refunds/partial capture and tax: how Stripe Tax reverses tax for a refund or partial capture on a Checkout Session is **not verified** (docs page for tax refunds returned 404 at `/tax/refunds`); the custom Tax API page says "you must record refunds" for custom integrations only.
- Stripe Managed Payments (Stripe as merchant of record, "3.5% per successful Managed Payments transaction in addition to Payments fees") exists, but the supported categories are "Software, Video games, Digital media, Online courses and training, Electronically supplied business and web services, such as website hosting"; domain registration is not named, "Custom domains aren't supported for Managed Payments", and it is not compatible with "embeddable web components". Not evaluated further (unverified for domains; merchant-of-record status is a legal question).

---

## 7. Refunds, partial refunds, disputes

### 7.1 Refund API (F49-F52)
- Create: `POST /v1/refunds` with `payment_intent` (or `charge`) and optional `amount` (smallest currency unit), `reason`, `metadata`. "You can optionally refund only part of a charge. You can do so multiple times, until the entire charge has been refunded." https://docs.stripe.com/api/refunds/create.md
- Uncaptured payment: "the charge attached to the PaymentIntent remains uncaptured and can't be refunded directly. You must cancel the PaymentIntent." (refunds.md)
- Status/events: `refund.created`, `refund.updated`, `refund.failed`; `charge.refunded` ("including partial refunds"; "Listen to `refund.created` for information about the refund"); `charge.refund.updated` is deprecated.
- Timing: "Your customer sees the refund as a credit approximately 5-10 business days later"; failed refunds return to balance "up to 30 days" later; refunds only to "the original payment method". Card refund maximum age: not found in primary docs (a docs-search snippet says none; unverified). ACH and SEPA: 180 days.
- Some quick refunds appear as a *reversal*: "Some refunds-those issued shortly after the original charge-appear in the form of a reversal ... the original charge drops off the customer's statement, and a separate credit isn't issued." Glossary: "Stripe doesn't withhold any fees for payment reversals"; IC+ users "might see a difference in cost between reversals and refunds because reversals usually incur lower network fees." (F67). This looked in tension with "Stripe's processing fees from the original transaction aren't returned" (F13/F14); Stripe's support article settles it in favour of fee loss: "For all refunds, payment processing, Connect, and currency conversion fees from the original charge are not returned" and "Stripe doesn't return our fees when a payment is refunded" (F68, https://support.stripe.com/questions/understanding-fees-for-refunded-payments). Do not plan around a fee return.
- Cost: see 2.6 (fees not returned).

### 7.2 Disputes (F53-F55)
- Deadlines: "you have a limited window to respond (usually 7 to 21 days, depending on the card network). If you don't respond before the deadline, you automatically lose." One shot: "You've only one opportunity to submit your response ... You can't edit the response or submit additional files." https://docs.stripe.com/disputes/responding.md
- Events: `charge.dispute.created` ("Occurs whenever a customer disputes a charge with their bank"), `.updated` ("usually with evidence"), `.closed` (status `lost`, `warning_closed`, `won`), `.funds_withdrawn`, `.funds_reinstated`. Update evidence via `POST /v1/disputes/{id}` `evidence[...]` (files uploaded with purpose `dispute_evidence`). https://docs.stripe.com/disputes/api.md
- Digital-goods evidence Stripe asks for ("focus on evidence of usage, login, or download"): `customer_purchase_ip`, `customer_name`, `customer_email_address`, `access_activity_log` ("Server or activity logs showing proof that the customer accessed or downloaded the purchased digital product ... IP addresses, corresponding timestamps"), `customer_communication`, `product_description`. https://docs.stripe.com/disputes/categories.md
- Mosshatch evidence pack to auto-assemble at `charge.dispute.created` (store at order time): order + line items, ToS acceptance record, passkey approval assertion (time, credential id, IP, user agent), Checkout `customer_details`, 3DS result, registrar confirmation (registration timestamp, registrar order id, RDAP/WHOIS record showing registrant and creation date), login/session/DNS-record-change logs after purchase, Resend delivery logs of confirmation email, refund-policy text shown. Visa CE 3.0: Stripe flags eligibility itself ("Flagging disputes that are eligible for Visa CE 3.0 by searching your history for prior qualifying transactions").
- Fees (US price page): "Dispute received fee $15.00 for each dispute you receive"; "Dispute countered fee $15.00 for each dispute you respond to manually. You get this fee back for won disputes."
- Test cards: `4000000000000259` (fraudulent), `4000000000002685` (product not received), `4000000000001976` (inquiry), `4000000000005423` (early fraud warning), `4000000404000038` (Visa CE 3.0 eligible); Stripe notes the fraudulent-dispute card is "protected after 3D Secure authentication" while the product-not-received card "isn't protected" - i.e. 3DS liability shift helps against fraud claims, not against "I never got the domain" claims. https://docs.stripe.com/testing.md#disputes

---

## 8. Testing (F56-F58)
- Sandbox vs live: separate keys, separate webhook secrets, separate portal configuration ("Stripe maintains multiple distinct sets of portal configurations"). Rate limit in sandbox 25 req/s.
- **Stripe CLI** (https://docs.stripe.com/cli/listen.md): `stripe listen --forward-to localhost:PORT/api/stripe/webhook` prints a stable `whsec_` ("will not change between restarts"), needs no Dashboard endpoint; `--events a,b` filters. `stripe trigger <event>` fires fixtures including `checkout.session.completed`, `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`, `charge.dispute.created` (cli/trigger.md) with `--override`/`--add` to shape the object. `stripe events resend <evt> --webhook-endpoint=<we_...>`.
- **Test clocks** exist for Billing objects only: "Simulations use test clocks to control time"; "You can add up to three new customers to each simulation"; up to three subscriptions per customer; "you can only move it forward in time"; existing customers only if the frozen time is not in the past. Not usable for plain PaymentIntent renewals (use an injectable clock in our scheduler).
- **Cards**: `4242 4242 4242 4242` success; `4000000000000002` generic decline; `4000000000009995` insufficient funds; `4000002500003155` / `4000002760003184` 3DS (5.3); dispute cards (7.2). Extended-auth cards: Visa 4242..., Mastercard 5555555555554444, Amex 378282246310005, Discover 6011111111111117. There is no documented test card that expires an authorization: simulate expiry by calling `POST /v1/payment_intents/{id}/cancel` and by driving the `payment_intent.canceled` / `charge.expired` fixtures.
- Test wallets: https://docs.stripe.com/testing/wallets (Apple Pay/Google Pay in sandbox); hosted Checkout "supports Apple Pay and Google Pay with no integration changes".

---

## 9. Customers, Checkout customisation, saved-card management

### 9.1 Mapping users to Customers (F59-F60)
- One Stripe Customer per Mosshatch user, created lazily before the first Checkout (idempotency key `cust:{user_id}`), with `metadata[user_id]`, `email`, and `name` when known; store `stripe_customer_id` unique in Postgres. Pass `customer=cus_...` on every Session (do not use `customer_email` at the same time).
- Metadata limits: "up to 50 keys, with key names up to 40 characters long and values up to 500 characters long"; no square brackets in keys; "Don't store any sensitive information". https://docs.stripe.com/api/metadata.md. Use `client_reference_id` (max 200 chars) for `order_id`; put `order_id` also in `payment_intent_data[metadata]` so PI/charge/dispute events carry it.
- `customer_creation=always` for guest checkouts; "Sessions that don't create Customers instead are grouped by guest customers in the Dashboard"; `if_required` only creates a Customer for subscription-mode or post-purchase-invoice sessions.
- **Customers v1 vs Accounts v2**: Stripe's Checkout doc says "For most use cases, we recommend modeling your customers as customer-configured Account objects instead of using Customer objects", but "The Accounts v2 API is generally available for Connect users, and in public preview for other Stripe users" (accessed 2026-09-29). Recommendation: use Customers v1 for Phase 0 (stable, GA for everyone) and re-check Accounts v2 status before build.
- Deleting a user (privacy): `customer.deleted` event; keep order/financial records in our DB for tax/dispute retention (retention law -> lawyer).

### 9.2 Hosted Checkout customisation (F61)
- Branding: Dashboard Branding Settings or per-Session `branding_settings` (logo, icon, colours, font, border style, `display_name`); invoices still use Dashboard branding. https://docs.stripe.com/payments/checkout/customization/appearance.md?payment-ui=stripe-hosted
- `custom_text` and `consent_collection` (terms of service checkbox) for legal copy (Stripe suggests custom text to link terms for saved cards); `submit_type`, `locale`, `expires_at` ("anywhere from 30 minutes to 24 hours after Checkout Session creation", default 24 h), `statement_descriptor_suffix` for cards, `receipt_email`, `payment_method_options.card.restrictions` (funding types, added 2026-08-26).
- Custom domain for hosted Checkout/portal: paid, "$10.00 per month" (price page), one per account; not with Managed Payments.

### 9.3 Saved-card management
- Option 1 (recommended): own "Payment methods" page. Add/replace = hosted Checkout `mode=setup` (or `setup_future_usage` on next purchase); list = `GET /v1/customers/{id}/payment_methods?type=card`; remove = `POST /v1/payment_methods/{id}/detach`; choose the renewal card = our DB column `renewal_payment_method_id` per domain or per user (do not rely on Stripe defaults).
- Option 2: Stripe Customer Portal. Facts: session URLs are short-lived ("New portal sessions expire after a 5 minute period"), need the customer id and a `return_url`, "Make sure to authenticate customers on your site before creating sessions for them"; supports Cards (incl. Apple Pay/Google Pay) and Link; cannot be shown in an iframe; portal edits fire `customer.updated` and the portal writes `invoice_settings.default_payment_method` (a Billing concept). https://docs.stripe.com/customer-management.md, .../integrate-customer-portal.md. Whether the portal is useful for a customer with no subscription, and whether its default-card change can drive our own off-session PaymentIntents, is **unverified**; we would still have to read `invoice_settings.default_payment_method` ourselves.
- `saved_payment_method_options[payment_method_remove]=enabled` lets customers delete saved cards inside Checkout; Stripe: "The customer can't remove a payment method if it's tied to an active subscription and the customer doesn't have a default payment method saved for invoice and subscription payments."

---

## 10. API versioning and rate limits (F44-F47)
- "Starting with the 2024-09-30.acacia release ... we release new API versions monthly with no breaking changes. Twice a year, we issue a new major release ... The current version is 2026-08-26.dahlia." https://docs.stripe.com/api/versioning.md (accessed 2026-09-29). Dahlia's first version `2026-03-25.dahlia` was breaking; example: Checkout `ui_mode` values `hosted`, `embedded`, `custom` were removed in favour of `hosted_page`, `embedded_page`, `elements` ("Attempting to set a Checkout Session's `ui_mode` to `hosted`, `embedded`, or `custom` will fail"). https://docs.stripe.com/changelog/dahlia/2026-03-25/updates-available-checkout-session-ui-modes.md. Hosted is the default `ui_mode`, so omit it or pass `hosted_page`.
- Pin explicitly: "Make sure that you specify the API version that you're integrating against in your code instead of relying on your account's default API version" (upgrades.md). `npm view stripe`: latest 22.6.2 (published 2026-09-09, `engines.node >=18`, MIT); its source `apiVersion.js` exports `2026-08-26.dahlia`, so `new Stripe(key)` pins it, but pass `apiVersion` explicitly anyway; Stripe notes "The TypeScript types reflect the latest API version at the time of release", so overriding the version can give inaccurate types.
- Webhook payload shape is fixed by the endpoint, not the SDK: "Webhook events use the API version that's set during your webhook's endpoint creation. Otherwise, they use your Stripe account's default API version." Create the endpoint via `POST /v1/webhook_endpoints` with `api_version` equal to the SDK pin. Upgrades: create a second endpoint at the new version, deduplicate, cut over.
- Rate limits (https://docs.stripe.com/rate-limits.md): live "100 requests per second" global; sandbox 25; "Individual API endpoints (unless otherwise noted) 25 requests per second"; PaymentIntents "1000 update requests per PaymentIntent object, per hour"; Search API 20 read/s; `429` with `Stripe-Rate-Limited-Reason` header; `429 lock_timeout` when concurrent requests touch one object ("make your requests serially") - relevant to concurrent capture/cancel/webhook updates on the same PaymentIntent: serialise per order. Backoff with jitter; SDK retries lock timeouts.
- IPs and domains: webhook source IPs are published (https://docs.stripe.com/ips.md), changes announced with "seven days' notice"; rely on signature first.

---

## 11. Recommended order state machine (text)

Assumptions: hosted Checkout, `mode=payment`, `payment_intent_data.capture_method=manual`, methods limited to card (incl. Apple Pay/Google Pay) and Link, ACH and other delayed methods disabled, Customers v1, Stripe Tax on, one Postgres row per order, Stripe webhooks per section 4. "Registrar" = the wholesale API (its own dossier). Every transition is `UPDATE orders SET state=$to WHERE id=$id AND state=$from` (0 rows = already moved). Webhooks nudge; the worker re-fetches the PaymentIntent/Session and decides.

### 11.1 Columns that back the machine
`orders(id, user_id, state, attempt, total_minor, tax_minor, currency, quote_hash, approval_id, stripe_customer_id, stripe_session_id UNIQUE, stripe_payment_intent_id UNIQUE, capture_before, amount_captured_minor, last_error, created_at, updated_at)`; `order_items(order_id, fqdn, years, registrar_state, registrar_ref)`; `stripe_events(id PK, type, object_id, received_at, processed_at)`; `operations(order_id, kind, idempotency_key, status, response)` with `UNIQUE(order_id, kind, idempotency_key)`.

### 11.2 States and transitions
```
DRAFT
  -> AWAITING_APPROVAL   trigger: submit (human UI, or agent with scoped token). Agents cannot go further.
AWAITING_APPROVAL
  -> APPROVED            trigger: WebAuthn assertion whose challenge = hash(items, years, total, tax estimate, currency, expiry) [quote_hash]. Guard: user verification flag set, quote not expired.
  -> EXPIRED             trigger: TTL (e.g. 24 h) or user rejects.
APPROVED
  -> CHECKOUT_OPEN       action: create Customer if missing (key cust:{user}); create Session (key cs:{order}:{attempt}) with mode=payment,
                                 payment_intent_data{capture_method=manual, metadata.order_id, setup_future_usage=off_session only if auto-renew consent given},
                                 automatic_tax, billing_address_collection=required, client_reference_id=order_id, expires_at=now+30..60 min.
                                 Store session id, url. Redirect user to Session url.
CHECKOUT_OPEN
  -> CHECKOUT_OPEN       events: payment_intent.payment_failed (record last_error; customer may retry inside the Session).
  -> CHECKOUT_EXPIRED    events: checkout.session.expired, or worker calls POST /v1/checkout/sessions/{id}/expire (price changed -> attempt+1 -> APPROVED again). Terminal. No money moved.
  -> AUTHORIZED          events: payment_intent.amount_capturable_updated OR checkout.session.completed (first to arrive wins). Worker fetches PI (expand latest_charge):
                                 guard: status=requires_capture AND amount_capturable=total_minor AND currency matches AND metadata.order_id matches AND review is null.
                                 store capture_before = latest_charge.payment_method_details.card.capture_before.
                                 If review != null -> REVIEW_HOLD. If amount/currency/order mismatch -> CANCELING(reason=mismatch) + alert.
REVIEW_HOLD
  -> AUTHORIZED          event: review.closed (approved).   -> CANCELING(reason=review_refused) on review.closed refused/canceled.
AUTHORIZED
  -> REGISTERING         guard: capture_before - now > 24 h (else CANCELING(reason=auth_window)). action: insert operation register:{order}:{item} then call registrar with our client transaction id.
REGISTERING
  -> REGISTERED          all items succeeded.
  -> PARTIAL             some items succeeded (only if multi-item orders are allowed; see 11.4).
  -> REGISTRATION_FAILED all items definitively failed (unavailable, price mismatch, policy) -> CANCELING(reason=registration_failed).
  -> REGISTRATION_UNKNOWN timeout / 5xx / ambiguous: reconcile against registrar (domain info) with backoff until capture_before - 24 h; resolves to REGISTERED/PARTIAL/REGISTRATION_FAILED; otherwise page a human and default to CANCELING (if nothing is registered).
REGISTERED | PARTIAL
  -> CAPTURING           action: POST /v1/payment_intents/{pi}/capture, amount_to_capture = sum(registered items incl. tax share), key cap:{order}.
CAPTURING
  -> PAID                event: payment_intent.succeeded (fetch: status=succeeded, amount_received = expected). Actions: receipt email (Resend), mark domain active, "hatch" the creature, store evidence pack.
  -> CAPTURE_FAILED      Stripe error on capture that is not a same-key replay.
CAPTURE_FAILED  (domain is registered but unpaid -> highest priority alert)
  transient (5xx, timeout, 429, lock_timeout): retry same key with backoff for up to 6 h.
  PI already canceled/expired (authorization lost) or issuer refuses: (1) if a PaymentMethod is attached to the Customer, off-session PI for the same amount (key recap:{order}); (2) else email a pay link (hosted Checkout, mode=payment) valid N days and keep the domain on hold; (3) if unpaid at deadline, reverse at the registrar (delete in the add-grace period; see registrar dossier) -> CANCELED_AFTER_REGISTRATION (cost = wholesale/registry fee; record as loss).
  -> PAID                once any path succeeds.
CANCELING
  action: if PI in requires_capture -> POST /v1/payment_intents/{pi}/cancel (key cancel:{order}); if Session open -> expire. Email customer: no charge, hold released by issuer.
  -> CANCELED            event: payment_intent.canceled (or synchronous API success). Terminal. No fee, no Refund object.
PAID
  -> REFUND_PENDING      action: POST /v1/refunds (key refund:{order}:{seq}, amount optional) by admin/policy (e.g. domain deleted in grace period, duplicate order).
REFUND_PENDING
  -> REFUNDED | PARTIALLY_REFUNDED   events: refund.created/updated, charge.refunded. -> REFUND_FAILED on refund.failed (manual). Processing fee is not returned (F13).
any PAID/REFUNDED state carries an overlay dispute_status:
  charge.dispute.created  -> DISPUTE_OPEN (freeze transfer-out/lock per policy; build evidence; due_by from dispute object)
  charge.dispute.updated  -> record
  charge.dispute.closed   -> DISPUTE_WON | DISPUTE_LOST ; funds_withdrawn/funds_reinstated -> bookkeeping only
```

### 11.3 Compensation matrix
| Failure | Detected by | Compensation | Cost |
|---|---|---|---|
| Customer abandons Checkout | `checkout.session.expired` | none | none |
| Authorization webhook lost or late | reconcile cron every ~5 min (open orders older than 2 min: retrieve Session/PI) | same transition as webhook | none |
| Amount/currency/order mismatch on PI | AUTHORIZED guard | cancel PI, alert (possible tampering) | none |
| Radar review open | `review.opened` / PI.review | REVIEW_HOLD, decide within window | none |
| Registrar says unavailable/price changed | registrar response | cancel PI, email | none |
| Registrar ambiguous | timeout | reconcile, hold auth, deadline = `capture_before - 24h` | none unless deadline hit |
| Capture fails after registration | Stripe error / `payment_intent.canceled` | retry, off-session re-charge, pay link, registrar reversal | wholesale/registry fee if reversed |
| Capture succeeded, our DB write failed | `payment_intent.succeeded` webhook + reconcile | webhook repairs state | none |
| Post-payment refund | admin/policy | `POST /v1/refunds` | processing fee kept by Stripe |
| Dispute | `charge.dispute.created` | evidence pack, one submission | $15 (+$15 if countered; refunded if won) |

### 11.4 Multi-domain carts
Partial capture is documented ("A partial capture automatically releases the remaining amount") but its effect on Stripe Tax records is not (section 13). Phase 0 options: (a) one domain per order (simplest, but N orders = N fixed fees of $0.30); (b) multi-item order with all-or-nothing semantics (registrar failure of any item cancels the whole authorization; requires the ability to reverse already-registered items); (c) partial capture after a sandbox test proves tax behaviour. Decide after the sandbox test in section 13.

### 11.5 Renewal machine (off-session, capture-first)
```
RENEWAL_SCHEDULED  (auto_renew on AND passkey-approved mandate on file: max price, frequency, terms text hash)
 -> NOTICE_30 -> NOTICE_7     (Resend emails: amount, date, card last4, one-click turn-off link; satisfies Mastercard annual reminder and gives ICANN-style notice)
 -> CHARGING                  T-N days (N chosen with the registrar/ICANN dossier): PaymentIntent{customer, payment_method, off_session=true, confirm=true, metadata.renewal_id}, key renew:{domain}:{term}:{try}
      guard: renewal price <= mandate max, else -> NEEDS_CUSTOMER (ask consent)
 -> RENEWING_AT_REGISTRAR     event payment_intent.succeeded
 -> RENEWED                   registrar OK -> receipt. Registrar failure after capture -> REFUND_PENDING + page ops.
CHARGING failure (402 / requires_payment_method / requires_action):
 -> NEEDS_CUSTOMER            authentication_required -> email link to confirm the same PI client secret on-session; other declines/expired card -> link to hosted Checkout mode=payment (+setup_future_usage) or mode=setup
 -> CHARGING (try+1)          retries on our cadence (e.g. T-3, T-1) until expiry policy; card replaced via payment_method.automatically_updated handled without re-consent unless brand changed
 -> LAPSING                   hand over to registry grace/redemption handling (registrar dossier)
```

---

## 12. Complete tables

### 12.1 Findings (all claims used above)
| ID | Claim | Value | Quote | Source | Conf. |
|---|---|---|---|---|---|
| F1 | Webhooks, not the success redirect, must trigger fulfilment | Redirect page is not guaranteed to load | "You can't rely on triggering fulfillment only from your checkout landing page, because it's not guaranteed customers visit that page." | https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted | high |
| F2 | Stripe's Checkout trigger events | checkout.session.completed; delayed methods also checkout.session.async_payment_succeeded (and _failed) | "Delayed payment methods generate a checkout.session.async_payment_succeeded event when payment succeeds later." | https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted | high |
| F3 | Fulfilment function must be re-entrant and check payment_status | Retrieve Session (expand line_items), check payment_status, record fulfilment | "your fulfill_checkout function might be called multiple times, possibly concurrently, for the same Checkout Session" | https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted | high |
| F4 | PaymentIntent-level webhook guidance | payment_intent.succeeded -> fulfil; payment_intent.amount_capturable_updated -> capture | "The customer's payment is authorized and ready for capture. / Capture the funds that are available for payment." | https://docs.stripe.com/payments/payment-intents/verifying-status.md | high |
| F5 | Manual capture is enabled on a Checkout Session with payment_intent_data.capture_method=manual; per-payment-method capture_method exists since API 2025-09-30.clover | PaymentIntentData.CaptureMethod = automatic / automatic_async / manual (stripe-node 22.6.2 types) | "specify capture_method as manual when creating the Checkout Session" | https://docs.stripe.com/payments/place-a-hold-on-a-payment-method.md | high |
| F6 | Events around manual capture | payment_intent.amount_capturable_updated on authorization; charge.captured on capture; charge.expired and payment_intent.canceled on expiry/cancel | "Occurs when a PaymentIntent has funds to be captured. Check the amount_capturable property on the PaymentIntent" | https://docs.stripe.com/api/events/types.md | high |
| F7 | Card-not-present authorization validity windows | Visa MIT 5d (4d18h) / CIT 7d; Mastercard, Amex, Discover 7d/7d; read charge.payment_method_details.card.capture_before | "The exact authorization window is 4 days and 18 hours, to allow time for clearing processes." | https://docs.stripe.com/payments/place-a-hold-on-a-payment-method.md | high |
| F8 | Extended authorization (up to 30 days) constraints | IC+ pricing only; Visa/MC/Amex/Discover; not Link-type; +0.08% Visa other categories; CIT only; mainly for unknown final amounts | "for many networks extended validity windows are only for cases where you don't know the final amount that you'll capture at the time of authorization" | https://docs.stripe.com/payments/extended-authorization.md?platform=web&ui=stripe-hosted | high |
| F9 | Manual capture support by payment method | Cards, Apple Pay, Google Pay, Link: supported. ACH and other bank debits, iDEAL: not supported (per-method tables: https://docs.stripe.com/payments/payment-methods/payment-method-support.md) | "Some payment methods that don't support this include ACH and iDEAL." | https://docs.stripe.com/payments/place-a-hold-on-a-payment-method.md | high |
| F10 | Uncaptured PaymentIntents auto-cancel after 7 days by default; one capture only; partial capture releases the rest | default 7 days after creation | "Uncaptured PaymentIntents are cancelled a set number of days (7 by default) after their creation." | https://docs.stripe.com/api/payment_intents/capture.md | high |
| F11 | Cancelling a requires_capture PaymentIntent releases the hold; Checkout PIs can be cancelled directly only in requires_capture | otherwise POST /v1/checkout/sessions/{id}/expire | "You can directly cancel the PaymentIntent for a Checkout Session only when the PaymentIntent has a status of requires_capture. Otherwise, you must expire the Checkout Session." | https://docs.stripe.com/api/payment_intents/cancel.md | high |
| F12 | Radar review interacts with manual capture | Check PaymentIntent.review before capturing; approving a review does not capture | "Approving the review doesn't automatically capture the charge." | https://docs.stripe.com/radar/reviews/auth-and-capture.md | high |
| F13 | Refunds do not return Stripe's processing fees | original fees kept | "Stripe's processing fees from the original transaction aren't returned." | https://docs.stripe.com/refunds.md | high |
| F14 | US price page: card fee and refund fee treatment | 2.9% + 30c domestic cards; +1.5% international; +1% FX; no refund fee for cards; original fees not returned | "For all other payment methods, there are no fees for issuing refunds. The payment processing, Connect and currency conversion fees from the original transaction are not returned." | https://stripe.com/pricing | high |
| F15 | Refunds draw on available balance and can sit pending | new accounts with low available balance are exposed | "Refunds use your available Stripe balance (not including pending amounts)." | https://docs.stripe.com/refunds.md | high |
| F16 | Cancelling before completion is free; Stripe recommends manual capture to cut refund costs | no cost | "You can cancel a payment before it's completed at no cost." | https://docs.stripe.com/refunds.md | high |
| F17 | Dispute fees (US) | $15.00 received; $15.00 countered (returned if won) | "Dispute received fee $15.00 for each dispute you receive." | https://stripe.com/pricing | high |
| F18 | Webhook signature scheme | Stripe-Signature t=,v1= ; HMAC SHA-256 of timestamp.payload; ignore non-v1 | "Currently, the only valid live signature scheme is v1." | https://docs.stripe.com/webhooks.md | high |
| F19 | Signature timestamp tolerance | 5 minutes default; never 0 | "Our libraries have a default tolerance of 5 minutes between the timestamp and the current time." | https://docs.stripe.com/webhooks.md | high |
| F20 | Signature verification needs the raw body (empirically confirmed with stripe-node 22.6.2: re-serialised JSON fails) | StripeSignatureVerificationError on re-serialised body | "Stripe requires the raw body of the request to perform signature verification." | https://docs.stripe.com/webhooks.md | high |
| F21 | On Vercel, Node-style /api handlers get a pre-parsed request.body; use the Web-standard handler and request.text() for verification | Web handler export default { fetch(request) } or export function POST(request) | "We populate the request.body property with a parsed version of the content sent with the request when possible." | https://vercel.com/docs/functions/runtimes/node-js.md | high |
| F22 | Live-mode retry policy | Up to 3 days, exponential back off; sandbox 3 retries over a few hours; exact schedule unpublished | "Stripe attempts to deliver events to your destination for up to three days with an exponential back off in live mode." | https://docs.stripe.com/webhooks.md | high |
| F23 | No ordering guarantee; duplicates happen; track event IDs | Dedupe on event.id and on (data.object.id, type); don't use created | "Stripe doesn't guarantee the delivery of events in the order that they're generated." | https://docs.stripe.com/webhooks.md | high |
| F24 | Respond 2xx quickly; Checkout waits up to 10 s for checkout.session.completed ack before redirect; endpoint timeout in seconds not published | 10 s Checkout redirect wait | "Checkout waits up to 10 seconds for your server to respond to the webhook event delivery before redirecting your customer." | https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted | high |
| F25 | Manual event replay windows | Dashboard resend 15 days; CLI resend 30 days; List Events last 30 days | "This works for up to 15 days after the event creation." | https://docs.stripe.com/webhooks.md | high |
| F26 | Endpoint constraints | max 16 endpoints; HTTPS required in live; TLS 1.2/1.3; source IPs published | "You can register up to 16 webhook endpoints with Stripe." | https://docs.stripe.com/webhooks.md | high |
| F27 | Vercel function limits relevant to webhooks | default max duration 300 s (fluid compute); payload 4.5 MB; waitUntil shares the function timeout; preview URLs need x-vercel-protection-bypass (query param possible) | "The maximum payload size for the request body or the response body of a Vercel Function is 4.5 MB." | https://vercel.com/docs/functions/limitations.md | high |
| F28 | Saving a card during a Checkout payment | payment_intent_data[setup_future_usage]=off_session plus customer or customer_creation=always; not saved by default | "By default, payment methods used to make a one-time payment with Checkout aren't available for future use." | https://docs.stripe.com/payments/checkout/save-during-payment.md?payment-ui=stripe-hosted | high |
| F29 | Charging a saved card off-session | PaymentIntent with off_session=true, confirm=true, customer, payment_method; exemptions requested but not guaranteed | "If the conditions for exemption aren't met, the PaymentIntent might throw an error." | https://docs.stripe.com/payments/save-and-reuse.md?payment-ui=elements | high |
| F30 | Off-session failure recovery | 402; PI requires_payment_method; notify customer by email; for authentication_required confirm with the PI client secret on-session | "You must notify your customer to return to your application to complete the payment (for example, by sending an email or in-app notification)." | https://docs.stripe.com/payments/save-and-reuse.md?payment-ui=elements | high |
| F31 | SCA and mandates for off-session payments | Re-authentication may be required; saved-card off-session charges are MITs needing an agreement | "Exemptions aren't guaranteed, and off-session payments might still require authentication by the bank." | https://docs.stripe.com/strong-customer-authentication.md | high |
| F32 | authentication_required decline code | Off-session: ask the customer to retry on-session | "you might need to ask the customer to retry" | https://docs.stripe.com/declines/codes.md | high |
| F33 | Smart Retries applies to subscription and invoice payments only; authentication_required is a hard-decline code; default 8 tries in 2 weeks | Not applicable to plain PaymentIntents | "Automatically retry failed subscription and invoice payments to reduce involuntary churn." | https://docs.stripe.com/billing/revenue-recovery/smart-retries.md | high |
| F34 | Mastercard recurring rule (via Stripe support summary, effective 2022-09-22): reminder for subscriptions billed 6+ months apart | annual renewals need an email/electronic reminder | "An email or electronic payment reminder for any subscription that processes 6 or more months apart (such as an annual subscription)" | https://support.stripe.com/questions/guidance-for-mastercard-recurring-billing-compliance-updates | medium |
| F35 | Visa rule (via Stripe FAQ): reminder is for trial-to-paid conversion, not every charge | no 7-day reminder before every renewal under Visa's trial rule | "you only need to send the reminder before the date that it converts to a paid subscription." | https://support.stripe.com/questions/2020-visa-trial-subscription-requirement-changes-faq | medium |
| F36 | Saved-card consent and brand changes | Terms must cover timing, frequency, amount method, cancellation; brand change via Account Updater needs new agreement | "When a card's brand changes, you can't charge it for any MITs until you get a new cardholder agreement." | https://docs.stripe.com/payments/cits-and-mits.md | high |
| F37 | Stripe Tax in Checkout | automatic_tax[enabled]=true covers the whole Session; tax from billing (or shipping) address; total_details.amount_tax | "Setting automatic_tax.enabled to true applies automatic tax to the entire Checkout Session." | https://docs.stripe.com/tax/checkout/page.md | high |
| F38 | Stripe Tax needs an active registration per jurisdiction | no registration = zero tax | "Without a registration in the customer's location, the calculation returns zero tax." | https://docs.stripe.com/tax/tax-codes.md | high |
| F39 | tax_behavior | Recommended Automatic: USD and CAD exclusive, other currencies inclusive; immutable once set | "For the currencies USD and CAD the tax behavior is exclusive. For all other currencies the tax behavior is inclusive." | https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior.md | high |
| F40 | No product tax code for domain names in Stripe's list | 0 occurrences of 'domain'; default candidate txcd_10000000 General - Electronically Supplied Services; Stripe does not classify legally | "Treat txcd_ identifiers as opaque, exact strings." | https://docs.stripe.com/tax/tax-codes.md | high |
| F41 | Stripe Tax pricing (US page) | Tax Basic no-code 0.5% per transaction where registered; Tax Complete from $90/month | "No-code integration 0.5% per transaction, where you're registered to collect taxes" | https://stripe.com/pricing | high |
| F42 | Google Pay with Stripe Tax in Checkout needs a shipping address | collect one or store on Customer | "you must either collect a shipping address or provide an existing customer with a saved shipping address" | https://docs.stripe.com/tax/checkout/page.md | high |
| F43 | Tax preview via Tax Calculations API is priced separately | $0.50 per transaction where registered, 10 calc calls included, 5c per extra call | "API integration $0.50 per transaction, where you're registered to collect taxes" | https://stripe.com/pricing | high |
| F44 | Current API version and cadence | 2026-08-26.dahlia; monthly non-breaking; majors twice a year | "The current version is 2026-08-26.dahlia." | https://docs.stripe.com/api/versioning.md | high |
| F45 | SDK pin and webhook version | stripe-node 22.6.2 (2026-09-09) pins 2026-08-26.dahlia; webhook endpoints have their own api_version | "Webhook events use the API version that's set during your webhook's endpoint creation." | https://docs.stripe.com/api/versioning.md | high |
| F46 | Dahlia breaking change to Checkout ui_mode | hosted->hosted_page, embedded->embedded_page, custom->elements | "Attempting to set a Checkout Session's ui_mode to hosted, embedded, or custom will fail." | https://docs.stripe.com/changelog/dahlia/2026-03-25/updates-available-checkout-session-ui-modes.md | high |
| F47 | Rate limits | Live 100 req/s global; sandbox 25; 25/s per endpoint; 1000 updates per PaymentIntent per hour; 429 + lock_timeout | "100 requests per second" | https://docs.stripe.com/rate-limits.md | high |
| F48 | Idempotency semantics | Key up to 255 chars, POST only, kept ~24 h, first result (incl. 500) replayed, params compared | "Subsequent requests with the same key return the same result, including 500 errors." | https://docs.stripe.com/api/idempotent_requests.md | high |
| F49 | Partial refunds | Multiple partial refunds until the charge is fully refunded | "You can optionally refund only part of a charge. You can do so multiple times, until the entire charge has been refunded." | https://docs.stripe.com/api/refunds/create.md | high |
| F50 | Uncaptured charges cannot be refunded; cancel the PaymentIntent |  | "the charge attached to the PaymentIntent remains uncaptured and can't be refunded directly. You must cancel the PaymentIntent." | https://docs.stripe.com/refunds.md | high |
| F51 | Refund timing | Customer credit ~5-10 business days; failed refunds return to balance up to 30 days | "Your customer sees the refund as a credit approximately 5-10 business days later" | https://docs.stripe.com/refunds.md | high |
| F52 | Refund events | refund.created/updated/failed; charge.refunded incl. partials; charge.refund.updated deprecated | "Occurs whenever a charge is refunded, including partial refunds." | https://docs.stripe.com/api/events/types.md | high |
| F53 | Dispute response window and single submission | 7-21 days by network; one submission only | "usually 7 to 21 days, depending on the card network" | https://docs.stripe.com/disputes/responding.md | high |
| F54 | Dispute webhooks | charge.dispute.created/updated/closed/funds_withdrawn/funds_reinstated | "Occurs whenever a customer disputes a charge with their bank." | https://docs.stripe.com/api/events/types.md | high |
| F55 | Digital-goods dispute evidence | customer_purchase_ip, customer_email_address, customer_name, access_activity_log, customer_communication, product_description | "focus on evidence of usage, login, or download" | https://docs.stripe.com/disputes/categories.md | high |
| F56 | Stripe CLI local forwarding | stripe listen --forward-to; stable whsec_; stripe trigger fixtures incl. payment_intent.amount_capturable_updated | "You don't need to configure any webhook endpoints in your Dashboard to receive webhooks with the CLI." | https://docs.stripe.com/cli/listen.md | high |
| F57 | Test clocks apply to Billing objects only and have small limits | 3 customers, 3 subscriptions per customer, forward only | "You can add up to three new customers to each simulation." | https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage.md | high |
| F58 | Test cards for SCA, declines and disputes | 4000002760003184 always authenticates; 4000002500003155 authenticates unless set up; 4000000000009995 insufficient funds; 4000000000000259 fraud dispute; 4000000000002685 not received | "This card requires authentication on all transactions, regardless of how the card is set up." | https://docs.stripe.com/testing.md | high |
| F59 | Metadata limits | 50 keys, key 40 chars, value 500 chars, no [ ] in keys | "up to 50 keys, with key names up to 40 characters long and values up to 500 characters long" | https://docs.stripe.com/api/metadata.md | high |
| F60 | Customers v1 vs Accounts v2 | Stripe recommends customer-configured Accounts but v2 is GA only for Connect users, public preview for others | "The Accounts v2 API is generally available for Connect users, and in public preview for other Stripe users." | https://docs.stripe.com/payments/accept-a-payment.md?payment-ui=checkout&ui=stripe-hosted | high |
| F61 | Checkout Session expiry | expires_at 30 minutes to 24 hours (default 24 h); custom domain is paid ($10/month on price page) | "It can be anywhere from 30 minutes to 24 hours after Checkout Session creation." | https://docs.stripe.com/api/checkout/sessions/create.md | high |
| F62 | Customer portal facts | 5-minute portal sessions; authenticate customers first; cards incl. Apple/Google Pay and Link supported; no iframe | "New portal sessions expire after a 5 minute period." | https://docs.stripe.com/customer-management.md | high |
| F63 | Managed Payments (Stripe as merchant of record) scope and price | +3.5% per transaction; categories: software, games, digital media, courses, web services; domains not named | "3.5% per successful Managed Payments transaction in addition to Payments fees" | https://stripe.com/pricing | medium |
| F64 | ACH Direct Debit | T+4 settlement, no manual capture, 60-day dispute submission window, 180-day refund window | "Settlement timing: Up to 4 business days (T+4)" | https://docs.stripe.com/payments/ach-direct-debit.md | high |
| F65 | stripe-node retry defaults conflict between README and source | README says maxNetworkRetries 1; source getDefaultMaxNetworkRetries() returns 2; timeout 80000 ms | "return 2;" | https://registry.npmjs.org/stripe/-/stripe-22.6.2.tgz | medium |
| F66 | Billing/Invoicing fees on the US price page | Billing pay-as-you-go 0.7% of Billing volume (or from $620/month); Invoicing Starter 0.4% per paid invoice; post-payment invoices 0.4% capped at $2 | "0.7% of Billing volume" | https://stripe.com/pricing | high |
| F67 | Refund vs reversal: quick refunds may be processed as reversals and the glossary says Stripe withholds no fees on reversals; whether the original processing fee comes back in that case is not stated and sits in tension with the price-page sentence that original fees are not returned | Ambiguous glossary line; F68 (support article: 'For all refunds') resolves it in favour of fee loss; plan on fee loss (U16 residual) | "Stripe doesn't withhold any fees for payment reversals" | https://docs.stripe.com/refunds.md | medium |
| F68 | Stripe support: for all refunds the original processing fee is not returned | applies to standard pricing; bank transfers may add refund fees | "For all refunds, payment processing, Connect, and currency conversion fees from the original charge are not returned." | https://support.stripe.com/questions/understanding-fees-for-refunded-payments | high |
| F69 | Authorization-only avoids fraud reporting: issuers must report possible fraud on captured payments even if refunded, but not on authorizations reversed before capture | Stripe suggests separate auth and capture combined with review rules | "Issuers are required to report possible fraud for a captured payment, even if it gets refunded, but aren't required to report it for a payment authorization." | https://docs.stripe.com/disputes/monitoring-programs.md | high |

### 12.2 Prices (Stripe US price page https://stripe.com/pricing, accessed 2026-09-29; the page was served for a US visitor - the price for Mosshatch's actual business country is unverified)
| Item | Price | Note / quote |
|---|---|---|
| Cards, domestic | 2.9% + 30c per successful transaction | "2.9% + 30¢ per successful transaction for domestic cards" |
| Manually entered card surcharge | +0.5% | not relevant to Checkout |
| International cards | +1.5% | |
| Currency conversion | +1% | |
| Refund | no fee for cards; original fees not returned | "there are no fees for issuing refunds ... fees from the original transaction are not returned" |
| Cancel an uncaptured authorization | $0 | refunds.md: "at no cost" |
| Dispute received | $15.00 | "$15.00 for each dispute you receive" |
| Dispute countered | $15.00 | "You get this fee back for won disputes" |
| ACH Direct Debit | 0.8%, $5.00 cap | not used at launch |
| Stripe Tax Basic, no-code (Checkout) | 0.5% per transaction where registered | |
| Stripe Tax Basic, API | $0.50 per transaction where registered (10 calc calls included; 5c each above) | for pre-checkout estimates |
| Stripe Tax Complete | from $90/month, 1-year contract | includes registrations/filings |
| Billing (subscriptions) | 0.7% of Billing volume pay-as-you-go, or from $620/month | not recommended for domain renewals (5.5) |
| Invoicing Starter | 0.4% per paid invoice | |
| Post-payment invoices (Checkout) | 0.4% of transaction total, $2.00 cap per invoice | |
| Custom domain for hosted Checkout/portal | $10.00/month | |
| Extended authorization (Visa, non-lodging categories) | +0.08% per transaction, IC+ only | not recommended |
| Managed Payments (merchant of record) | +3.5% per successful transaction on top of Payments fees | eligibility for domain names unverified |
| 3-D Secure | included with standard pricing | "$0.03 per 3D Secure attempt for accounts with custom pricing" |
Worked example (hypothetical $20.00 order, US card, no tax): fee = 0.029 x 20.00 + 0.30 = $0.88. Failed registration under (A) authorize-first costs $0.00; under (B) capture-first costs $0.88 per failure plus support time, and a refund pending if the available balance is short.

### 12.3 API surface used (all verified against docs.stripe.com or the stripe-node 22.6.2 types on 2026-09-29)
| Call | Parameters that matter | Verified in |
|---|---|---|
| `POST /v1/customers` | `email`, `name`, `metadata[user_id]`; `Idempotency-Key` | api/idempotent_requests.md; metadata.md |
| `POST /v1/checkout/sessions` | `mode=payment`, `line_items` / `price_data` (with `tax_behavior`, `product_data.tax_code`), `customer`, `customer_creation`, `client_reference_id`, `success_url`, `cancel_url`, `expires_at`, `automatic_tax[enabled]`, `billing_address_collection`, `customer_update[address]`, `payment_intent_data[capture_method\|setup_future_usage\|metadata\|description\|receipt_email\|statement_descriptor_suffix]`, `payment_method_options[card][request_extended_authorization\|capture_method]`, `saved_payment_method_options[payment_method_save\|payment_method_remove]`, `custom_text`, `consent_collection`, `branding_settings`, `excluded_payment_method_types`, `ui_mode=hosted_page` (default) | api/checkout/sessions/create.md; stripe-node types |
| `GET /v1/checkout/sessions/{id}` (`expand[]=line_items`) | | checkout/fulfillment.md |
| `POST /v1/checkout/sessions/{id}/expire` | status must be `open` | api/checkout/sessions/expire.md |
| `POST /v1/payment_intents/{id}/capture` | `amount_to_capture` | api/payment_intents/capture.md; place-a-hold |
| `POST /v1/payment_intents/{id}/cancel` | | api/payment_intents/cancel.md |
| `POST /v1/payment_intents` (off-session renewal) | `amount`, `currency`, `customer`, `payment_method`, `off_session=true`, `confirm=true`, `metadata` | payments/save-and-reuse.md |
| `POST /v1/refunds` | `payment_intent` or `charge`, `amount`, `reason`, `metadata` | api/refunds/create.md |
| `POST /v1/disputes/{id}` | `evidence[...]`; files via File Upload API purpose `dispute_evidence` | disputes/api.md |
| `GET /v1/customers/{id}/payment_methods`, `POST /v1/payment_methods/{id}/detach` | detach is permanent | api/payment_methods/customer_list.md, detach.md |
| `POST /v1/billing_portal/sessions` | `customer`, `return_url` | customer-management/integrate-customer-portal.md |
| `POST /v1/tax/calculations` | `currency`, `customer_details[address]`, `line_items` | api/tax/calculations/create.md |
| `POST /v1/webhook_endpoints` | `url`, `enabled_events`, `api_version` | api/webhook_endpoints/create.md |
| `GET /v1/events` | `delivery_success=false`, `types[]`, `ending_before`; 30-day retention | webhooks/process-undelivered-events.md |
| SDK `stripe.webhooks.constructEvent(rawBody, sigHeader, secret)` | tolerance default 300 s | webhooks.md; run offline in this research |

### 12.4 Source disagreements recorded
- Refund fees: refunds.md, the price page and the support article all say original processing fees are not returned (F13, F14, F68); the refunds.md glossary says "Stripe doesn't withhold any fees for payment reversals" (F67) for quick refunds processed as reversals. The glossary line is ambiguous (no extra fee is not the same as returning the original fee); the conservative reading is used.
- stripe-node README table: `maxNetworkRetries` default 1 (and "one reattempt"), but `cjs/platform/PlatformFunctions.js` in 22.6.2 returns 2 and a runtime call printed 2. Use the source; set the value explicitly.
- Stripe's Mastercard/Visa/FTC information is in Stripe support articles (secondary summaries of network/regulator rules). They carry their own dates: Mastercard effective 2022-09-22; Visa trial rules 2020-04-18; FTC page says effective 2025-07-14 (status not verified).

---

## 13. Unverified (could not be settled from primary docs; each has a Phase 0 test or owner)
| # | Item | Why unverified | How to close |
|---|---|---|---|
| U1 | `payment_status` (and thus Stripe's sample `!= 'unpaid'` check) on a `checkout.session.completed` for a **manual-capture** Session | Docs define `paid` as "The payment funds are available in your account" and `unpaid` as "not yet available"; no page states the manual-capture case. Two web-search summaries said `unpaid` but those are not primary. | Sandbox: create a manual-capture Session, pay with 4242, inspect the event. Design already avoids depending on it (check PI `status=requires_capture`). |
| U2 | Whether `setup_future_usage=off_session` attaches the PaymentMethod to the Customer at authorization or only at capture; whether a cancelled PI leaves it saved | not in fetched docs | Sandbox test; code path in 5.6 tolerates both |
| U3 | Stripe webhook delivery timeout in seconds | docs and support article say only "promptly"/"too long" | Keep handler under ~2 s; ack then process |
| U4 | Exact live retry intervals | only "up to three days with an exponential back off" | Not needed; reconciliation cron covers gaps |
| U5 | How long a released authorization remains visible on the customer's statement | issuer-dependent, not documented | Customer copy: "your bank may take several business days to drop the hold" (wording to be agreed) |
| U6 | Fee and Stripe Tax handling on partial capture and on cancel/refund of Checkout sessions using `automatic_tax` | tax refund page 404; nothing in fetched pages | Sandbox + accountant; decides 11.4 |
| U7 | Maximum age for refunding a card payment | not in fetched primary docs; docs-search knowledge snippet: "Card payments through Stripe do not have a time restriction for refunds" (low confidence); ACH and SEPA are 180 days | Confirm with Stripe support if needed |
| U8 | Whether the Stripe customer portal is useful for customers with no subscription, and whether portal card changes can be used to drive our own off-session PaymentIntents | portal docs are Billing-centric (`invoice_settings.default_payment_method`) | Prefer own payment-methods page (9.3); test portal in sandbox if wanted |
| U9 | Managed Payments eligibility for domain registration and its compatibility with off-session renewals / registrar contracts | domains not among named categories | Ask Stripe; legal review |
| U10 | Mastercard's own rule text (Stripe summary used) and Visa's current recurring-billing rules | rulebooks are not public in the fetched material | Legal/compliance dossier |
| U11 | Current legal status of the FTC negative-option ("click to cancel") rule and state auto-renewal laws | out of Stripe scope; Stripe page dated 2025 | Legal dossier |
| U12 | Stripe price list for Mosshatch's actual country of incorporation | fetched page shows US pricing | Check after entity country is fixed |
| U13 | Latest Stripe CLI version | GitHub API returned nothing usable | `stripe --version` after install |
| U14 | Whether Apple Pay/Google Pay wallet cards saved with `setup_future_usage` survive as usable MIT credentials over a 1-year renewal | table says setup-future-usage is supported; long-term behaviour not documented | Sandbox cannot prove; monitor `payment_method.automatically_updated` and decline rates |
| U15 | Vercel-side IP allowlisting of Stripe webhook IPs | not investigated (signature verification is the required control) | Optional hardening |
| U16 | Residual: whether a quick refund processed as a *reversal* returns the original fee | glossary line (F67) is ambiguous; support article F68 says "For all refunds" fees are not returned | Optional: one small live refund and read the balance transaction `fee` |

## 14. Needs a lawyer or accountant
1. Taxability of domain registration (and of the flat reseller fee) per US state/country; which product tax code to use (Stripe: "Don't make the legal tax classification for the user"); where to register for Stripe Tax (zero tax is collected without registrations).
2. Displaying price + tax and the flat fee in a way that satisfies price-transparency ("drip pricing") rules in the target markets.
3. Auto-renewal consent wording, notice timing and cancellation flow: card-network mandate text (F31, F36), Mastercard annual reminder (F34), US state auto-renewal laws and the status of the FTC rule, EU/UK equivalents.
4. Saving cards (`setup_future_usage`) under GDPR/ePrivacy: Stripe itself says "contact your legal and privacy team" (EDPB reference).
5. Refund/cancellation policy vs registry grace periods and ICANN registrar obligations (interaction with capture/cancel timing).
6. Whether Stripe as merchant of record (Managed Payments) would be acceptable to registrant/registrar agreements.
7. Retention of order/payment/evidence records vs user deletion requests.
8. Chargeback policy and whether to contest small disputes given fees ($15 + $15).

## 15. Design implications (for the Mosshatch plan)
1. Use hosted Checkout `mode=payment` with `payment_intent_data.capture_method=manual` and enable only card (Apple/Google Pay) and Link; leave ACH off. Order gate = PI `requires_capture` verified server-side, capture after registrar success, `payment_intent.succeeded` = PAID. Document this deviation from the brief's "verified `payment_intent.succeeded`" and why (F13-F16).
2. Implement the machine in section 11 with conditional-UPDATE transitions, an outbox for side effects, `stripe_events` dedupe, and a 5-minute reconciliation cron. Serialise Stripe writes per order (lock timeouts, F47).
3. Vercel: Web-standard `POST(request: Request)` webhook using `request.text()`; production-only Stripe endpoint created via API with `api_version` pinned; `stripe listen` for local/preview; never register a preview URL that needs a bypass secret in the query string.
4. Pin `stripe@22.6.2` and `apiVersion: '2026-08-26.dahlia'` (and the same on the endpoint); plan a monthly changelog check; expect a new breaking major roughly every six months.
5. Store on each order: session id, PI id, `capture_before`, quote hash, passkey approval id, tax breakdown, customer_details snapshot (dispute evidence), registrar transaction id.
6. Approval UX: show total, tax (estimated via Tax Calculations API or, after Session creation, `total_details.amount_tax`), fixed flat fee and wholesale portion before the passkey prompt; the amount authorized must equal the amount approved.
7. Auto-renew: separate passkey-approved consent object (max price, frequency, terms hash); `setup_future_usage=off_session` only when the user opted in; renewal reminders T-30/T-7 by Resend; own dunning and on-session recovery link; renewals as off-session PaymentIntents from our scheduler (no Subscriptions, no Smart Retries); inject a clock for tests because test clocks do not cover PaymentIntents.
8. Digital-goods dispute readiness: log passkey assertion, IP, user agent, ToS acceptance, registrar confirmation, post-purchase activity; auto-build the evidence pack on `charge.dispute.created` (single submission).
9. Google Pay + Stripe Tax: copy billing address into Customer shipping address or accept losing Google Pay.
10. Resolve U1, U2, U6 in a one-day sandbox spike before writing the order code.

## 16. Compliance / integration checklist (also returned in structured form)
| # | Requirement | Applies to | Source |
|---|---|---|---|
| C1 | Verify `Stripe-Signature` on the raw body; reject old timestamps; never accept unsigned events | webhook endpoint | https://docs.stripe.com/webhooks.md |
| C2 | Dedupe events by `event.id` and (object id, type); do not depend on ordering | webhook worker | https://docs.stripe.com/webhooks.md |
| C3 | Fulfil from webhooks, idempotently, after re-fetching the object | order worker | https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted |
| C4 | Capture (or cancel) before `capture_before`; read it from the charge | manual-capture flow | https://docs.stripe.com/payments/place-a-hold-on-a-payment-method.md |
| C5 | Idempotency keys on every Stripe POST; deterministic per operation; DB uniqueness as the durable guard | all Stripe writes | https://docs.stripe.com/api/idempotent_requests.md |
| C6 | Obtain and record explicit consent (terms: timing, frequency, amount, cancellation) before saving a card for off-session use | auto-renew | https://docs.stripe.com/payments/cits-and-mits.md |
| C7 | Re-obtain cardholder agreement when Account Updater changes the card brand | saved cards | https://docs.stripe.com/payments/cits-and-mits.md |
| C8 | Send an email/electronic reminder for subscriptions billed 6+ months apart (Mastercard, per Stripe) | annual renewals | https://support.stripe.com/questions/guidance-for-mastercard-recurring-billing-compliance-updates |
| C9 | Register for tax collection where required; set `tax_behavior`; choose the tax code with an accountant | Stripe Tax | https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior.md |
| C10 | Respond to disputes within the network deadline with one complete submission | disputes | https://docs.stripe.com/disputes/responding.md |
| C11 | Pin API version in SDK and webhook endpoint | all | https://docs.stripe.com/api/versioning.md |
| C12 | Keep secret keys and `whsec_` in Vercel env vars, roll webhook secret periodically | ops | https://docs.stripe.com/webhooks.md |

## 17. Sources opened (all accessed 2026-09-29; cached under research/raw/stripe/)
Housekeeping: early in the run I wrote a helper named `fetch.sh` in this shared research directory and then renamed it to `stripe-fetch.sh`; if another agent had a `fetch.sh` there at that moment it may have been overwritten (a different `fetch.sh` exists now and is not mine). All my files are prefixed `stripe-` or live under `raw/stripe/`; `sigtest.cjs` is my offline signature test.
docs.stripe.com: checkout/fulfillment, payments/place-a-hold-on-a-payment-method, payments/extended-authorization, payments/payment-methods/payment-method-support, payments/accept-a-payment (Checkout hosted), payments/checkout/save-during-payment, payments/save-and-reuse, payments/cits-and-mits, payments/paymentintents/lifecycle, payments/payment-intents/verifying-status, payments/ach-direct-debit, payments/managed-payments (+eligibility, how-it-works), webhooks (+signature, process-undelivered-events, quickstart), api/events/types, api/idempotent_requests, error-low-level, rate-limits, api/versioning, upgrades, changelog/dahlia (+2026-03-25 ui-modes), changelog/clover/2025-09-30 capture-method-per-payment-method, refunds, api/refunds/create, api/payment_intents/{capture,cancel}, api/checkout/sessions/{create,object,expire}, api/payment_methods/{detach,customer_list}, api/webhook_endpoints/create, api/metadata, strong-customer-authentication, declines/codes, billing/revenue-recovery/smart-retries, billing/testing/test-clocks, tax/{checkout/page,tax-codes,products-prices-tax-codes-tax-behavior,zero-tax}, api/tax/calculations/create, disputes (+responding, best-practices, categories, api, monitoring-programs), testing, cli/{listen,trigger}, customer-management (+integrate, configure), radar/reviews/auth-and-capture, payments/checkout/{customization/appearance, custom-domains}, ips.
stripe.com/pricing; support.stripe.com articles (Mastercard recurring, Visa trial FAQ, FTC/California FAQ, webhook timed-out, auth-and-capture, fees for refunded payments) rendered with headless Chromium.
vercel.com/docs: functions/runtimes/node-js, functions/limitations, functions-api-reference/vercel-functions-package, deployment-protection (+protection-bypass-automation).
npm registry: `stripe` 22.6.2 tarball (source inspected; offline signature test in `research/sigtest.cjs`); raw.githubusercontent.com stripe-node Next.js webhook example.
Search snippets (WebSearch, Stripe docs search tool) were used only to find pages; nothing rests on a snippet alone except the flagged U7 item.
