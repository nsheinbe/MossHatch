# Domain sales conversion release

## What changed

The public preview and invited shop share a stable search interface. The preview shows published test prices, explicitly labelled as subject to change. Live purchase buttons require a confirmed available name, current unexpired quote, complete registrant contact and current legal acceptance.

Customers can generate ideas locally and check alternative .com names. No raw idea or search text is sent to conversion measurement. The result cards show registration term and renewal pricing. The .ai sheet explicitly discloses public registrant details. The purchase interface works without WebGL.

Checkout retries reuse the same idempotency key for an unchanged request during that sheet session. Late responses cannot price another selected domain or carry another account's acceptance forward. The return page retries transient errors and never describes a network failure as a failed registration. Confirmed buyers can open domain setup.

## Measurement

Apply migration 1200 before deploying the API. It adds aggregate conversion counts and a forced-RLS table for first-write order attribution. Roll back application code if needed; the additive tables can remain.

Run:
```sh
DATABASE_URL_CRON='<secure connection>' node scripts/conversion-report.mjs 30
```

Visit, search, available, selected and checkout are at most once per mode per page load, not unique visitors. Preview/live and mobile/desktop remain separate. Bot traffic, blocked requests, reloads and privacy preferences affect counts. Do not claim a person-level conversion rate from them.

Only server-confirmed live registration orders and captured payments count as purchases. Renewals, transfers and test orders are excluded. Attribution is optional and first-write wins. Coarse campaign labels remain in memory and are not persisted in a visitor cookie. DNT and GPC suppress measurement.

The contribution field is an estimate for nonrefunded registered orders, using the quoted wholesale amount. It excludes payment processing fees, chargebacks, overhead and refunded-order economics. It is not net profit.

## Public launch remains a separate operational gate

At the October 6 review, production was invite-only and `registrar_writes_paused` was true following auto-safe. The deployment does not clear it, expand purchase limits, or bypass invite controls.

Before opening public purchases:
1. Run the existing read-only live preflight in the authorized production environment and resolve current registrar, funding and payment failures.
2. Review the open auto-safe page and the current alert causes. Use the existing operator runbook to resume only after the underlying incident is resolved.
3. Complete the existing controlled live purchase rehearsal and reconcile registrar ownership, payment capture and receipt delivery.
4. Complete the existing public-launch legal and operating prerequisites, including final approved public terms and registrar egress controls.
5. Change the launch configuration deliberately after readiness evidence exists.

The preview deployment is not proof of live registrar readiness. No real purchase or financial transaction is part of this implementation's automated tests.
