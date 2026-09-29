# Skeptic verification: stripe-order-flow (Mosshatch Phase 0)

Verifier lens: skeptic. Date: 2026-09-29. Method: I re-fetched every source below myself (curl -sSL with browser UA through the agent proxy; headless Chromium for JS-rendered support.stripe.com pages; npm registry + a local install of stripe@22.6.2 for SDK checks). Raw captures: `working-directory/research/vsk-flow/` (`*.md` = docs.stripe.com markdown renderings, `pricing.txt`, `refund-fees.txt`, `mc-recurring.txt`, `npm/sig.cjs` = my signature test).
Limits: WebSearch was unusable (session budget 200/200 already spent); I made two calls to the Stripe documentation-search MCP tool (read-only) but its results did not settle U1 or the cancel-event question, so nothing below relies on it. No sandbox/API keys exist here, so nothing was tested against Stripe's live behaviour; anything that needs a sandbox is marked unverifiable.

## Verdict summary

- The Stripe facts in the dossier are accurate. Every quote I re-checked matched a primary source (docs.stripe.com, stripe.com/pricing, support.stripe.com, Vercel docs, npm).
- Corrected (6): (1) TL;DR "never from the redirect" is stricter than Stripe, which recommends webhooks (required) AND a landing-page trigger through the same idempotent function; (2) Vercel `request.body` is a lazy getter, not always pre-parsed (recommendation still safe); (3) webhook resend horizon: Stripe's own pages disagree (15 vs 30 days); (4) extended auth is "IC+ feature, blended users can request via support", not strictly IC+ only; (5) the dossier's "checkout.session payment_status on manual capture is undocumented" is slightly understated: the enum definition ("paid = funds are available in your account") implies `unpaid` while only authorized; (6) Stripe's Session-object doc says you cannot cancel a Checkout PaymentIntent (expire instead) while the PI cancel doc allows it in requires_capture; the dossier cites only the second.
- The recommended order state machine has real holes (section C): retrying capture with the same idempotency key after a 5xx contradicts Stripe's own 500-caching rule; `capture_before` does not exist for Link-type payments and is nullable for cards; the "authorized amount == approved total" guard collides with Checkout computing tax from an address typed after passkey approval; nothing stops two payable Sessions/PIs for one order; no landing-page step; `(object id, type)` used as a drop rule would discard legitimate repeat events; idempotency-key/parameter drift on `expires_at`.
- Unverifiable at a primary source: manual-capture `payment_status`, whether cancel emits `charge.refunded`, hold visibility after release, Tax fee/records on cancel and partial capture, retry intervals, endpoint timeout seconds, network fees on many cancelled authorizations.

## A. Re-fetched sources (all 2026-09-29)

| Short name | URL | HTTP | Note |
|---|---|---|---|
| place-hold | https://docs.stripe.com/payments/place-a-hold-on-a-payment-method.md | 200 | auth windows, limitations, capture, cancel |
| fulfil | https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted | 200 | webhooks required + landing page recommended |
| webhooks | https://docs.stripe.com/webhooks.md | 200 | retries, ordering, duplicates, tolerance |
| undelivered / evdest / sigtrouble | https://docs.stripe.com/webhooks/process-undelivered-events.md ; /event-destinations.md ; /webhooks/signature.md | 200 | no retry schedule anywhere; event retention 15/30 days |
| refunds | https://docs.stripe.com/refunds.md | 200 | fees, pending balance, reversal glossary, cost optimization |
| pi-cancel / pi-capture | https://docs.stripe.com/api/payment_intents/cancel.md ; /capture.md | 200 | |
| cs-object / cs-create / cs-expire | https://docs.stripe.com/api/checkout/sessions/object.md ; /create.md ; /expire.md | 200 | payment_status enum, allowed_payment_method_types, expire only when open |
| pm-support | https://docs.stripe.com/payments/payment-methods/payment-method-support.md | 200 | manual-capture column |
| clover-cap | https://docs.stripe.com/changelog/clover/2025-09-30/checkout-capture-method-per-payment-method.md | 200 | |
| deferred-pi | https://docs.stripe.com/changelog/2022-08-01/deferred-paymentintent-checkout-session.md | 200 | PI created at Session confirmation |
| ext-auth | https://docs.stripe.com/payments/extended-authorization.md?platform=web&ui=stripe-hosted | 200 | |
| radar-auth | https://docs.stripe.com/radar/reviews/auth-and-capture.md | 200 | |
| cits-mits, sca, save-reuse, declines, pi-create | https://docs.stripe.com/payments/cits-and-mits.md ; /strong-customer-authentication.md ; /payments/save-and-reuse.md?payment-ui=elements ; /declines/codes.md ; /api/payment_intents/create.md | 200 | |
| idem, err-lowlevel | https://docs.stripe.com/api/idempotent_requests.md ; /error-low-level.md | 200 | 500s cached, indeterminate |
| charge-pmd | https://docs.stripe.com/api/charges/object.md?query=payment_method_details | 200 | capture_before nullable; link hash fields |
| monitoring | https://docs.stripe.com/disputes/monitoring-programs.md | 200 | auth vs capture fraud reporting |
| pi-lifecycle, verifying, pi-obj | https://docs.stripe.com/payments/paymentintents/lifecycle.md ; /payments/payment-intents/verifying-status.md ; /api/payment_intents/object.md | 200 | setup_future_usage attach timing |
| smart-retries, testing, versioning, tax-checkout | https://docs.stripe.com/billing/revenue-recovery/smart-retries.md ; /testing.md ; /api/versioning.md ; /tax/checkout/page.md | 200 | |
| pricing | https://stripe.com/pricing | 200 (974 KB) | US visitor |
| refund-fees | https://support.stripe.com/questions/understanding-fees-for-refunded-payments | rendered (Chromium) | |
| mc-recurring | https://support.stripe.com/questions/guidance-for-mastercard-recurring-billing-compliance-updates | rendered (Chromium) | |
| vercel-node / vercel-lim | https://vercel.com/docs/functions/runtimes/node-js.md ; /functions/limitations.md | 200 | |
| npm | https://registry.npmjs.org/stripe (latest 22.6.2, published 2026-09-09) ; local install of stripe@22.6.2 | | |

## B. Claim-by-claim verdicts

### Manual capture on Checkout and payment-method limits
- F5 (manual capture via `payment_intent_data.capture_method=manual`; per-PM `capture_method` since 2025-09-30.clover): CONFIRMED. place-hold: "specify capture_method as manual when creating the Checkout Session". Clover changelog lists Card, Link, etc. and says it removes "previous limitations where enabling manual capture would either remove unsupported payment methods from the UI or cause errors". SDK types in stripe-node 22.6.2 (`esm/resources/Checkout/Sessions.d.ts` line 3404): `'automatic' | 'automatic_async' | 'manual' | OtherString`. Also accept-a-payment (hosted) has an "Optional: Separate authorization and capture" section that names "verifying stock availability before fulfilling an order" as the use case, which is exactly Mosshatch's pattern. Caveat: the place-hold Checkout example uses `ui_mode=elements`; the docs I fetched do not say what Dahlia does with unsupported methods under `payment_intent_data.capture_method=manual` (the changelog only describes the old behaviour). See C12.
- F9 (Cards, Apple Pay, Google Pay, Link support manual capture; ACH and iDEAL do not): CONFIRMED. pm-support "API support" tables: Cards, Link, Apple Pay, Google Pay = Supported; ACH Direct Debit = Unsupported. place-hold: "Some payment methods that don't support this include ACH and iDEAL."
- F10 (uncaptured PIs cancelled 7 days after creation; one capture; partial capture releases the rest): CONFIRMED (pi-capture; place-hold). Added fact: since API 2022-08-01 the PaymentIntent is created when the Session is confirmed, not when it is created (deferred-pi changelog), so the 7-day clock starts at payment, not at Session creation (Sessions may live 24 h).
- F11 (cancel releases hold; Checkout PI directly cancellable only in requires_capture): CONFIRMED against pi-cancel, but CORRECTED for a tension the dossier did not record: the Session object doc says of `payment_intent`: "You can't confirm or cancel the PaymentIntent for a Checkout Session. To cancel, expire the Checkout Session instead." Expire works only on `open` Sessions (cs-expire), and a paid Session is `complete`. The CANCELING step therefore depends on the pi-cancel exception; add a sandbox check to the spike.
- F12 (Radar review + manual capture): CONFIRMED. radar-auth: "Approving the review doesn't automatically capture the charge"; and "canceling an uncaptured payment releases the authorization without creating a Refund object" (primary support for the dossier's "not a Refund object").
- F8 (extended auth): CORRECTED (minor). ext-auth: "We offer extended authorizations to users on IC+ pricing. If you're on blended Stripe pricing and want access ... contact ... support" (so not strictly IC+-only); Visa other categories "additional 0.08% fee", CIT only; not for `link` type; "for many networks extended validity windows are only for cases where you don't know the final amount". Recommendation (do not use) stands.

### Authorization windows
- F7: CONFIRMED. place-hold table: Visa MIT 5 days ("exact ... 4 days and 18 hours"), CIT 7; Mastercard/Amex/Discover 7/7; "might still be classified as a CIT if a CVC is present". Two additions that matter for the machine: (a) `payment_method_details.card.capture_before` is typed "timestamp, nullable" (charge-pmd line 342); (b) `payment_method_details.link` contains only `country` and `funding_source_group`, i.e. NO `capture_before` for Link-type payments, and the windows table lists card brands only. See C4.

### Webhook retry schedule, ordering, duplicates
- F22: CONFIRMED verbatim ("up to three days with an exponential back off in live mode"; sandbox "three times over the course of a few hours"). I searched webhooks, process-undelivered-events, event-destinations and signature pages for interval numbers: none published. U4 stays unverifiable.
- F23: CONFIRMED (ordering not guaranteed; "Don't use created"; dedupe on event IDs; "In some cases, two separate Event objects are generated ... use the ID of the object in data.object along with the event.type"). The object-id+type rule is for *identifying duplicate Event objects*, not a licence to drop repeats (C7).
- F24: CONFIRMED (fulfil page: "Checkout waits up to 10 seconds ... not supported for organization webhook endpoints"). Endpoint timeout seconds not published (webhooks table only says "(Timed out) ERR ... defer complex logic").
- F25: CORRECTED. webhooks.md: Dashboard resend 15 days, CLI `stripe events resend` 30 days. event-destinations.md "Event retention": events 16-30 days old "you can't resend them or view delivery attempts". Stripe's two pages disagree; plan reconciliation on 15 days for resends and 30 days for List Events (undelivered page: "Stripe only returns events created in the last 30 days").
- F26: CONFIRMED (16 endpoints, HTTPS required in live, TLS 1.2+, IP allowlist page exists).
- F18/F19/F20: CONFIRMED and re-tested myself with stripe-node 22.6.2 (`vsk-flow/npm/sig.cjs`): raw payload verifies; `JSON.stringify(JSON.parse(p))` fails with StripeSignatureVerificationError; Buffer of raw bytes verifies; 10-minute-old header fails "Timestamp outside the tolerance zone". Observation: passing tolerance `0` to stripe-node 22.6.2 still enforced the 300 s default (the docs' "0 disables the recency check" describes other libraries); do not pass 0 anyway.
- F21: CORRECTED (nuance). Vercel doc: "We populate the request.body property with a parsed version ... when possible", but also "The request.body helper is set using a JavaScript getter ... it is only computed when it is accessed." So Node-style handlers are only a hazard if you touch `request.body` for JSON; the Web-standard `await request.text()` recommendation remains the safest and is what Stripe's App Router example does.
- F27: CONFIRMED (Hobby 300 s/300 s; Pro/Enterprise 300 s default, 800 s max, 1800 s beta; 4.5 MB payload).

### Off-session SCA
- F29/F30/F31/F32: CONFIRMED verbatim in save-and-reuse ("If the conditions for exemption aren't met, the PaymentIntent might throw an error"; 402 and `requires_payment_method`; "You must notify your customer to return to your application"; use "the declined PaymentIntent's client secret with confirmPayment" for `authentication_required`), sca ("Exemptions aren't guaranteed, and off-session payments might still require authentication by the bank"; MIT requires an agreement/mandate) and declines ("you might need to ask the customer to retry"). New detail the dossier omits: PI create has `error_on_requires_action` ("fail the payment attempt if the PaymentIntent transitions into requires_action"), useful for renewals so no dangling `requires_action` PI is left.
- F33: CONFIRMED (Smart Retries = "failed subscription and invoice payments"; `authentication_required` is in the hard-decline list; "retries ... only executes if you obtain a new payment method").
- F34: CONFIRMED as Stripe's summary (rendered support page: "Starting September 22, 2022 ... An email or electronic payment reminder for any subscription that processes 6 or more months apart"); Mastercard's own rule text still not accessible (medium).
- F36: CONFIRMED (cits-mits: brand change => "you can't charge it for any MITs until you get a new cardholder agreement"; listen for `payment_method.automatically_updated`).
- U2 (when the PM is attached): PARTLY ANSWERABLE. PI object doc for `setup_future_usage`: attach to the Customer "after the PaymentIntent is confirmed and the customer completes any required actions". With manual capture that point is the authorization (`requires_capture`), so the card is probably saved before capture and stays saved if the order is then cancelled. Not stated for cancel; sandbox-confirm.

### Fees on cancelled authorizations and refunds
- F13/F16/F50: CONFIRMED (refunds.md: "You can cancel a payment before it's completed at no cost."; "Stripe's processing fees from the original transaction aren't returned."; requires_capture "can't be refunded directly. You must cancel the PaymentIntent"; "Cost optimization ... Stripe recommends using manual authorization and capture to reduce your refund costs ... by canceling payments before they're captured, or by reducing your captured amount").
- F14: CONFIRMED (pricing FAQ text: "For all other payment methods, there are no fees for issuing refunds. The payment processing, Connect and currency conversion fees from the original transaction are not returned." and "2.9% + 30c per successful transaction for domestic cards"). Note the fee is per *successful* transaction, which is consistent with a never-captured authorization costing nothing, but no page states "cancelled authorization = $0" in those words beyond "at no cost".
- F68: CONFIRMED (rendered support article: "For all refunds, payment processing, Connect, and currency conversion fees from the original charge are not returned."). Also states "For businesses on IC+ pricing ... there may be some fees for issuing refunds" and, for standard pricing, bank transfers may add refund fees.
- F67: CONFIRMED as recorded: refunds.md glossary "Stripe doesn't withhold any fees for payment reversals" remains ambiguous; the dossier's plan (assume fee loss) is the right conservative reading.
- F15/F51: CONFIRMED (available balance, pending for cards, "approximately 5-10 business days", failed refund returns "up to 30 days").
- F69: CONFIRMED (monitoring-programs: "Issuers are required to report possible fraud for a captured payment, even if it gets refunded, but aren't required to report it for a payment authorization. If you identify and reverse a fraudulent or suspicious payment authorization before it's captured, it isn't reported.").
- F17/F41/F43: CONFIRMED on the US page (dispute received $15, countered $15 returned if won; Tax Basic 0.5% / $0.50 API where registered; Tax Complete from $90/month).
- Not verifiable: whether Stripe Tax's per-transaction fee or any Radar fee is charged on an authorization that is later cancelled (U6). Whether card networks charge acquirers for high authorization-reversal ratios: no Stripe page addresses it.

### Events and object semantics
- F6/F52: CONFIRMED (events-types: `payment_intent.amount_capturable_updated` "Occurs when a PaymentIntent has funds to be captured"; `charge.captured`; `charge.expired` "Occurs whenever an uncaptured charge expires"; `payment_intent.canceled`; `charge.refunded` "including partial refunds").
- F4: CONFIRMED (verifying-status event table: `amount_capturable_updated` "The customer's payment is authorized and ready for capture").
- F1/F2/F3: CONFIRMED verbatim, with corrections in D1/D2 below.

### Idempotency
- F48: CONFIRMED (idem: results saved "regardless of whether it succeeds or fails ... including 500 errors"; keys pruned "at least 24 hours old"; parameter comparison; not saved for validation failures or concurrent conflicts). error-low-level adds: "the idempotency layer caches the result of POST mutations that result in server errors (specifically 500s) ... retrying them with the same idempotency key usually produces the same result"; "Treat requests that return 500 errors as indeterminate"; identifiers in `metadata` let you match objects produced by Stripe's later reconciliation. This conflicts with dossier 11.2 (C1).

### Versions
- F44/F45: CONFIRMED (versioning.md: "The current version is 2026-08-26.dahlia"; monthly non-breaking + two majors a year; npm `latest` = 22.6.2 published 2026-09-09; `cjs/apiVersion.js` exports `ApiVersion = '2026-08-26.dahlia'`).
- F65: CONFIRMED (README says maxNetworkRetries 1; `PlatformFunctions.getDefaultMaxNetworkRetries()` returns 2 in 22.6.2).

### Renewal/other claims spot-checked
- F61: CONFIRMED (cs-create: `expires_at` "anywhere from 30 minutes to 24 hours after Checkout Session creation").
- F58: CONFIRMED test-card semantics (testing.md rows for 4000002500003155, 4000002760003184, 4000000000009995, 4000000000000341, 4000000000000259, 4000000000002685). Also confirmed: no documented test card or setting that simulates authorization expiry.
- F37/F42 (tax location + Google Pay needs shipping address): CONFIRMED (tax-checkout: Checkout "assesses" tax from the address the customer provides in the Session; "To make sure Google Pay is offered ... while using Stripe Tax in Checkout, you must either collect a shipping address or provide an existing customer with a saved shipping address").

## C. Challenge to the recommended state machine (dossier section 11)

Ranked by how likely they are to cause money/registration loss.

C1 (High) Capture retry policy contradicts Stripe's 500 handling. Dossier 11.2 CAPTURE_FAILED: "transient (5xx, timeout, 429, lock_timeout): retry same key with backoff for up to 6 h". Stripe (error-low-level, idem): a `500` is cached and replayed for that key for ~24 h, so looping on `cap:{order}` after a 500 returns the same 500 and never re-executes; and a 500 is "indeterminate" (the capture may or may not have happened). Correct procedure: same key only for no-response network errors and for 409/429; after any 500 (or ambiguous result) GET the PaymentIntent; `succeeded` => PAID; `requires_capture` => capture again with a NEW key (safe: a second capture on a captured PI errors rather than double-charging); `canceled` => the CAPTURE_FAILED recovery paths. Also section 3.1 of the dossier states the 500 rule correctly, so 11.2 is internally inconsistent.

C2 (High) Two payable Sessions/PIs for one order. Dossier: on price change the worker "calls POST /v1/checkout/sessions/{id}/expire ... attempt+1". Races: customer completes payment on attempt N just as the worker expires it (expire only works on `open` Sessions; the call errors and the customer's authorization stands), or has two tabs open. The AUTHORIZED guard checks `metadata.order_id` (identical across attempts) and `UNIQUE(stripe_payment_intent_id)` only protects the column, it does not stop a second PI arriving. Fix: put `attempt` and session id in PI metadata; AUTHORIZED requires PI id/session id == the order's current attempt; expire the old Session and confirm `status=expired` before minting the next; any authorized PI that is not the order's current one (or arrives after the order left CHECKOUT_OPEN) goes to cancel. On an `expire` error, re-fetch the Session before deciding.

C3 (High) "Authorized amount must equal approved amount" vs Checkout-computed tax. tax-checkout: Checkout calculates tax from the address the customer provides inside the Session (billing/shipping), which happens after the passkey approval. So `amount_capturable == total_minor` can fail for legitimate payments (customer enters an address whose tax differs from the estimate, or edits the shipping address) and the machine then cancels (`CANCELING reason=mismatch` + "possible tampering" alert), or, if the guard is loosened, the passkey no longer binds the final amount. Options: collect and validate the address before approval and pass it on the Customer; bind the passkey to subtotal + a maximum tax ceiling; treat tax difference within the ceiling as valid, otherwise send the user back to APPROVED with a new quote_hash; compare against the Session's own `amount_total`/`total_details` rather than an estimate.

C4 (Medium) `capture_before` may not exist. AUTHORIZED stores `latest_charge.payment_method_details.card.capture_before` and REGISTERING refuses if under 24 h remain. Docs: that field is nullable, and for Link-type payments (`payment_method_details.link`) no `capture_before` is exposed and no Link window is documented. Define a fallback (e.g. authorization time + 4 days, the shortest documented window) or leave Link off for Phase 0 (Link is otherwise a manual-capture-capable method per pm-support).

C5 (Medium) No transition for an unexpected capture. If a PI reaches `succeeded` while the order is AUTHORIZED/REGISTERING (Dashboard capture by a human, a Checkout misconfigured without manual capture, an ACH-type method that slipped in, or Stripe's private-preview `automatic_delayed` capture from the place-hold page if ever enabled), `payment_intent.succeeded` only maps from CAPTURING and is silently ignored; later a registrar failure runs CANCELING against a succeeded PI (cancel errors) and the order sticks with money taken and no refund path. Add `PAID_BEFORE_REGISTRATION` (register-or-refund) and make the cancel step re-fetch first.

C6 (Medium) Redirect/landing page is absent. Stripe's fulfil guide says webhooks are required and, separately, "Trigger fulfillment on your landing page [Recommended] ... webhooks can sometimes be delayed"; the dossier only says never use the redirect. Because Checkout holds the redirect up to 10 s for a 2xx (not for processing), and the design acks then processes asynchronously, the customer will often arrive while the order is still CHECKOUT_OPEN. Define the landing page: verify the `session_id` belongs to the signed-in user's current order (the id alone is not a credential), call the same idempotent reconcile (re-fetch Session/PI, conditional UPDATE), then show state and poll; do not wait for the 5-minute cron.

C7 (Medium) `(object id, type)` dedupe must not be a drop rule. Stripe's text is for spotting duplicate Event objects. Legitimate repeats share object id and type: `payment_intent.payment_failed` per attempt, `refund.updated`, `charge.refunded` for each partial refund, `charge.dispute.updated`, and, in the multicapture flow only (https://docs.stripe.com/payments/multicapture.md, re-fetched; an IC+ feature, so not Mosshatch's case), `payment_intent.amount_capturable_updated` on every capture; whether a plain single capture also re-fires it is not documented. Use it only to coalesce work; the handler already re-fetches, so processing an extra nudge is cheap. Record `processed_at` only after the transition commits, otherwise an event inserted before a crash is never retried (the retry sees "already seen").

C8 (Medium) Idempotency parameter drift. Session create uses key `cs:{order}:{attempt}` but the parameters include `expires_at=now+30..60 min`; a retry after a network error computes a new timestamp and hits Stripe's "parameters differ" error (idem). Persist `checkout_expires_at`, `amount_to_capture` and any other computed parameter on the order row before the first call and reuse it.

C9 (Low-Medium) Radar review can open after AUTHORIZED. `review` is checked at the AUTHORIZED transition only; re-fetch and check `review == null` immediately before capture (radar-auth says approving a review and capturing are separate).

C10 (Low-Medium) Cancel vs "refund" semantics. radar-auth: cancelling an uncaptured payment "releases the authorization without creating a Refund object"; but pi-cancel says the remaining amount "is automatically refunded" and the Charge field doc says an uncaptured charge is "automatically refunded" at `capture_before`. Whether `charge.refunded` fires on release/expiry is not documented. Make sure the refund overlay only applies from PAID and that a `charge.refunded` for a CANCELED order is a no-op; sandbox-verify.

C11 (Low) A cancelled order can leave a saved card. `setup_future_usage` attaches "after the PaymentIntent is confirmed" (PI object), i.e. at authorization. If registration then fails and the PI is cancelled, the PaymentMethod probably stays attached to the Customer. Detach it on CANCELED unless the user separately consented, or the "consent to save" record and reality diverge.

C12 (Low) Pin the payment-method set explicitly. cs-create has `allowed_payment_method_types` (filter) and `excluded_payment_method_types` (Dashboard-managed only), plus `payment_method_types` (static list). The dossier says "ACH disabled" (Dashboard) but nothing in the Session creation enforces it, and clover's per-PM `payment_method_options[card|link].capture_method` is the documented way to make the intent explicit. A Dashboard drift that turns on ACH would create auto-capturing, delayed payments that feed C5.

C13 (Low) Renewals: use `error_on_requires_action=true` with `off_session=true, confirm=true`, and key/param drift applies to `renew:*` keys as well.

C14 (Low, registrar-side) TLDs whose registration is asynchronous/pending for longer than the hold window (`capture_before`) cannot use authorize -> register -> capture; the fallback must be a defined capture-then-refund (fee lost) path.

C15 (Unverified) Many cancelled authorizations: card networks can penalise authorizations that are neither cleared nor reversed and Stripe says networks "may also restrict 1 USD authorizations you don't intend to capture"; no Stripe page quantifies a ratio limit. Track the auth-cancel ratio.

## D. Corrections to summary framing

D1. TL;DR 1 / design_implications: "Fulfil from webhooks, never from the redirect." Stripe: webhooks are required, and triggering fulfilment from the landing page is "[Recommended]" as well, using the same function ("might be called multiple times, possibly concurrently"). Say "webhooks are the guarantee; the landing page is an accelerator that calls the same idempotent reconcile".
D2. F3 / U1: Stripe's sample fulfils when `payment_status != 'unpaid'`. The enum definitions say `paid` = "The payment funds are available in your account" and `unpaid` = "The payment funds are not yet available in your account". An authorized-but-uncaptured Session therefore most likely reads `unpaid`, so the sample code would not fulfil; the dossier's decision to gate on PI `requires_capture` is right for that reason. Still a sandbox item.
D3. F8 "IC+ pricing only": see B (blended users can ask Stripe support).
D4. F21 "Node-style req.body is pre-parsed": see B (lazy getter).
D5. F25 resend horizon: see B.

## E. Things the dossier got right that I tried and failed to break

- Cancel-before-capture costs nothing and is not reported as fraud; refund never returns the processing fee; a card refund can sit pending without available balance.
- Deferred PaymentIntent creation means events for a PI can arrive before the order row has the PI id; the dossier's `payment_intent_data.metadata.order_id` is the right join key.
- Ordering: no guarantee, dedupe by event.id, re-fetch state: all consistent with Stripe's text and with evdest's "The object definition in the event payload might be outdated by the time you process the event".
- 7-day CIT hold for hosted Checkout; Visa MIT 4d18h is a renewal-only concern.

## F. Unverifiable (need sandbox or a Stripe answer)

U1 actual `payment_status` value on manual-capture `checkout.session.completed`; whether `charge.refunded` fires on cancel/expiry; PM attach and detach behaviour on cancel; Link authorization window and whether `capture_before` appears anywhere for Link; hold visibility duration after release (U5); webhook retry intervals (U4) and endpoint timeout seconds (U3); Stripe Tax fee/records for cancelled or partially captured Sessions (U6); Dahlia behaviour when `payment_intent_data.capture_method=manual` meets an enabled unsupported method; whether the pi-cancel exception for Checkout PIs works as documented.
