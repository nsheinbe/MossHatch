# New .com registration pricing

The new-registration target is $14.99 per year before tax. A higher price is returned when wholesale/renewal costs, payment fees or configured cost reserves require it. Search and checkout use the same integer-only calculation. Actual upstream quotes still must match the pinned wholesale price before payment; premium, availability, invite, funding, global and per-account spend gates remain in place.

## Activate only after the published fee notice

The fee page publishes advance notice of the target new-registration offer on 13 October 2026, with an earliest date of 12 December 2026. The new tariff is **off by default**. After verifying the notice is actually public in production, record that verification's full UTC timestamp in `MH_NEW_COM_PRICING_NOTICE_AT` (for example `2026-10-13T17:30:00.123Z`). Use the real verification time, never this example or the start of the publication day. The tariff activates only after 60 complete 24-hour periods from that timestamp. A publication verified at 17:30 UTC cannot activate at midnight 60 days later. The gate rejects dates before the public notice date. Do not backdate the value. Keep public launch/readiness gates unchanged; this timestamp is not permission to open sales.

Before activation, update the dated fee table and preview price data to the current registration price, while keeping renewal prices separately stated. This change neither opens public purchasing nor deploys/configures production. Complete payment/registration/renewal/refund readiness verification before public launch.

Only **new .com registration quotes routed to Openprovider** use this policy. Existing stored orders, renewals, transfers, restoration prices and renewal mandates are unchanged. Current renewal is priced separately in search and checkout. Registration prices are not used to invent a renewal promise.

## Cost assumptions to verify

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `MH_NEW_COM_TARGET_MINOR` | 1499 | Minimum new-registration target, USD cents per year |
| `MH_REGISTRATION_PAYMENT_BPS` | 290 | Variable payment fee in basis points; raise to the actual applicable rate |
| `MH_REGISTRATION_PAYMENT_FIXED_MINOR` | 30 | Fixed payment fee per checkout |
| `MH_REGISTRATION_OVERHEAD_MINOR` | 100 | Reserve per domain-year for membership allocation, support, infrastructure and expected loss |
| `MH_REGISTRATION_MIN_CONTRIBUTION_MINOR` | 250 | Required contribution per domain-year after the modeled costs |

The $1 overhead reserve is a planning assumption, not measured expense. Reconcile it against actual volume, membership fees, support minutes, fraud/refund losses, taxes and processor charges before activation. No pricing formula guarantees net profitability or funds paid acquisition. Percentage card fees are reserved on the **tax-inclusive ceiling**, not only the pre-tax sale. Invalid cost settings fail closed.

At $10.46 annual upstream cost, the default target remains $14.99. With a 10% tax ceiling it reserves $0.78 for processing and $1.00 for overhead, leaving $2.75 contribution. More expensive input costs produce a higher price. Changing these assumptions does not authorize repricing existing customers.

## Validation

Run `node --test scripts/verify-registration-pricing.mjs` with Node 22.18+ or Node 24. This exercises real quote amount arithmetic, legacy renewal prices, multi-year totals, supplier price increases, fee/tax rounding, notice activation and invalid cost settings without a database. Run the existing database-backed pricing/search/checkout suites and a browser checkout review before release.
