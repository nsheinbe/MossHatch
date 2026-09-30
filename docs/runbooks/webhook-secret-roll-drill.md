# Runbook and drill: roll the Stripe webhook secret with the 24-hour overlap

Template: PLAN section 5. Phase 2 exit requires this drill done in staging ("webhook-secret drill done"). Rotation is also a 90-day routine. Written before the drill; the result and times go in the table at the end. Not yet performed: there is no Stripe staging account in the build container.

## Trigger

Scheduled every 90 days; on suspected exposure use the incident runbook (roll with immediate expiry instead).

## Severity

S2 when scheduled; S1 if run because of exposure.

## First 15 minutes (the drill, in staging)

Precondition: staging endpoint `POST /api/v1/webhooks/stripe` receives test-mode events; `STRIPE_WEBHOOK_SECRET` is set in the staging `web` project. During the overlap Stripe signs each event with both the old and the new secret (two `v1` signatures in `Stripe-Signature`), so a verifier holding either one accepts it; the app needs no dual-secret mode. Confirm that with the first test event in step 3 rather than assuming it, and check the Stripe module verifies every `v1` signature in the header.

1. T0: in the Stripe Dashboard (test mode) open the endpoint, choose "Roll secret" and keep the old secret valid for 24 hours. Copy the new `whsec_` value directly into the Vercel Sensitive variable; do not paste it anywhere else.
2. Before changing the variable, send a test event (Dashboard "Send test webhook" or `stripe trigger payment_intent.amount_capturable_updated`). Expect HTTP 200 with the old secret still deployed (this proves the overlap works) and one `webhook_events` row with `processed_at` set.
3. Update `STRIPE_WEBHOOK_SECRET` to the new value and redeploy. Send another test event: 200 and a new row.
4. Verify a forged event (wrong secret) and a stale timestamp (older than the tolerance) still fail with `bad_signature` and leave no `webhook_events` row.
5. At T0 + 24 h (overlap ended), send a test event again: 200. Post one event whose signature is computed with only the old secret (built by hand in staging before the old value is discarded): rejected with `bad_signature`.

## Decision owner

Founder.

## Customer-notice template

None for a scheduled roll. If an incident: see the exposure runbook.

## Upstream and regulator clocks

Stripe's overlap is at most 24 hours for webhook secrets (restricted keys up to 7 days). Events sent during the overlap carry signatures for both secrets. No regulator clock for a scheduled roll.

## Evidence to preserve

Timestamps of each step, the Dashboard "secret rolled" event, the deploy ids, the `webhook_events` rows for the tests, and the test output for the forged and stale cases. No secret value is recorded anywhere.

## Exit test

- Test event before the roll, during the overlap and after it: 200 and a `webhook_events` row each time.
- Forged, wrong-secret and stale-timestamp events: 400 `bad_signature`, no `webhook_events` row for the forged ones.
- After the overlap the old secret verifies nothing.
- The next rotation date is recorded.

## Drill record

| Date | Environment | Rolled at | New secret live | Old secret dead | Total | Failures found | Actions |
|---|---|---|---|---|---|---|---|
| (not yet run) | staging | | | | | | |
