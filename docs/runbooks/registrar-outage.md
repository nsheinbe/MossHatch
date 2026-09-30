# Runbook: registrar outage

Template: PLAN section 5. Skeleton written in Phase 3. Not exercised against OpenSRS: the behaviour below is proven only with `MockRegistrarPort` faults (`registryMaintenance`, `rateLimited`, `timeoutAfterAccept`, `unknownAvailability`) and the fake Horizon transport.

## Trigger

`health()` answers `degraded` or `maintenance`; registrar calls fail with `unavailable`, `maintenance` or `rate_limited` for more than 10 minutes (alert `registrar_unavailable`); orders pile up in `registrar_unavailable` or `outcome_unknown`; the renewal sell gate pages (`renewal_sell_gate`); OpenSRS announces maintenance (the `maintenance_windows` table).

## Severity

S2 while nothing is charged without a name and renewals have time before E-1; S1 when a charged renewal could reach E-1 unrenewed or an `outcome_unknown` order is older than its authorization window allows.

## First 15 minutes

1. Confirm it is upstream: the OpenSRS status page, a manual `GET_BALANCE` through the registrar project, and the error codes in `order_operations` (codes only).
2. Do nothing that re-sends a registration: the order machine never resends a `sent` operation; it reconciles by polling (ST-60). Check `order.sweep_unknown` is running (health route `/api/health/ticks`).
3. New orders: the process refuses them with "Registrations are paused while our registrar is in maintenance. Nothing was charged." If the outage will outlast the Checkout authorization window, set `orders_paused` so nobody pays into a hold that may expire.
4. Renewals: charged renewals retry every 15 minutes for 24 hours, then hourly until E-1, then refund (ST-110). If an outage threatens E-1 for any name, list them: `select d.fqdn_ascii, t.term_end from renewal_terms t join domains d on d.id = t.domain_id where t.state = 'renewing' order by t.term_end`.
5. Post a status notice (status page, not on Vercel or AWS).

## Decision owner

Founder.

## Customer-notice template

"Our registrar partner is not answering right now. Registrations and changes are paused. Nothing was charged for anything that did not happen. Renewals already paid will complete when it is back, and we refund any that cannot finish before the name expires."

## Upstream and regulator clocks

None contractual for an outage on our side. OpenSRS support ticket opened at once with the error codes and times.

## Evidence to preserve

`order_operations`, `order_events`, `alerts` and `jobs` rows for the window; the OpenSRS status page capture; the time the outage started and ended.

## Exit test

- `health()` answers `ok` and one availability check and one quote succeed.
- Every order in `registrar_unavailable` and `outcome_unknown` reaches a final state through reconciliation, with no duplicate registration (`getOrdersByDomain` shows one order per name).
- Every charged renewal is renewed or refunded; the sell gate is closed; flags are back to their pre-incident values.
