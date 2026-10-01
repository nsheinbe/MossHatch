# Runbook: Stripe key or webhook-secret exposure

Template: PLAN section 5. Skeleton written in Phase 2 (first phase with a Stripe key and webhook endpoint); to be exercised in the staging drill and completed with real console steps once the Stripe account exists. Nothing here has been run against a live Stripe account.

## Trigger

Any of: a Stripe secret or restricted key (`sk_`, `rk_`) or a webhook signing secret (`whsec_`) seen outside the Vercel Sensitive variable (repository, log, chat, screenshot, CI output, a departed person's machine); GitHub or Stripe secret scanning alert; forged or unsigned webhook attempts that pass signature checks; unexplained charges, refunds, payouts or customer changes in the Stripe Dashboard; a person with access leaves.

## Severity

S1 (money and keys). Page immediately; the founder is sole on-call, the second trusted person has read-only alert access.

## First 15 minutes

1. Set `registrar_writes_paused` and `orders_paused` in `flags` (`update flags set value = 'true', updated_by = 'incident' where name in ('registrar_writes_paused','orders_paused')`). Renewals and reads continue.
2. Decide which secret: key exposure and webhook-secret exposure differ (below). If unsure, do both.
3. Restricted key exposed: in the Stripe Dashboard create a new restricted key with the same least-privilege permissions, put it in the `web` Sensitive variable (Production), redeploy or promote, smoke a read (`GET /v1/balance` via the app health check), then roll (expire) the old key immediately. Do not use the overlap window when exposure is suspected; the overlap of up to 7 days is for scheduled rotation only.
4. Webhook secret exposed: roll the endpoint secret, choosing immediate expiry of the old secret (the 24-hour overlap is for the scheduled drill). Update `STRIPE_WEBHOOK_SECRET`, redeploy, send a test event, confirm `webhook_events` records it.
5. Pull the Stripe Dashboard event log and the app's `webhook_events` for the exposure window: look for payments, refunds, payouts, customer or payment-method changes that Mosshatch did not make. Open the alert list for `webhook` signature failures.
6. Rotate `CRON_SECRET` too if the same place leaked it (90-day rotation applies anyway).

## Decision owner

Founder. Second person may execute steps 1 to 4 on instruction.

## Customer-notice template

Send only if customer data or money was affected. Plain text, sentence case, active voice, no apology: "On <date> we found that a payment credential for Mosshatch was exposed. We replaced it at <time>. We found <no / the following> unauthorised activity on your account: <list of order ids>. We refunded <amount>. You do not need to do anything. Write to security@mosshatch.com with questions." Do not name the credential type or the place it leaked.

## Upstream and regulator clocks

- Stripe: report a compromise to Stripe through Dashboard support at once; no contractual notification period was found in the sources read for this plan. Confirm in the Stripe Services Agreement before the first live payment.
- GDPR: 72 hours to the supervisory authority from awareness if personal data was affected and the risk is not unlikely (counsel to confirm applicability).
- Card data: Mosshatch never sees card numbers (hosted Checkout, SAQ A). A key leak alone is not a card-data breach; confirm with Stripe.
- Not applicable here: Tucows/OpenSRS 4-hour clock (registrar credentials, see the Phase 3 runbook).

## Evidence to preserve

Do not delete the leaked artefact until captured: the commit or log line (hash, URL, first-seen time), the Stripe Dashboard event log export for the window, `webhook_events` rows for the window, `alerts` and `audit_log` rows from the incident, screenshots of the key list before and after. Record who saw the secret. Write the incident to `audit_log` (`actor_kind = 'system'` or `'cli'` with a `restore`-style incident action, ids only).

## Exit test

- Old key and old webhook secret rejected by Stripe (a request with the old key returns 401; an event signed with the old secret is rejected by the endpoint with `bad_signature`).
- New key and secret work: test event processed, `webhook_events` row present.
- `orders_paused` and `registrar_writes_paused` cleared by the documented SQL statement, and one test-mode order completes.
- Reconciliation: `stripe.reconcile` run for the exposure window shows no unexplained charge or refund.
- Post-incident: scanner rule added if the leak shape was not caught; rotation date recorded.
