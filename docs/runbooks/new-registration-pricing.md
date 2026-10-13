# New .com registration pricing

The new-registration target is $14.99 per year before tax. A higher price is returned when wholesale/renewal costs, payment fees or configured cost reserves require it. Search and checkout use the same integer-only calculation. Actual upstream quotes still must match the pinned wholesale price before payment; premium, availability, invite, funding, global and per-account spend gates remain in place.

## Activate only after the published fee notice

The fee page publishes advance notice of the target new-registration offer on 13 October 2026, with an earliest date of 12 December 2026. The new tariff is **off by default** and requires both:
- `MH_NEW_COM_PRICING_NOTICE_AT` containing the actual verified public notice timestamp, at least 60 complete 24-hour periods in the past.
- `MH_NEW_COM_PRICING_ENABLED=1`, set separately only after the cost and readiness review below. Missing, `0` and every other value leave the tariff off.

Recording the notice timestamp alone never activates the tariff, now or later. The gate rejects dates before the public notice date. Never backdate the timestamp to the start of the publication day. These settings do not open public sales; preserve the separate invite, payment, fulfillment and launch gates.

### Publication record

The first production notice was verified at `https://mosshatch.com/fees.html` on **2026-10-13T17:47:23.759Z**, with production commit `5db66fe0d9c023b5fccbda2bf62794d09a495b04`. Record this exact time in `MH_NEW_COM_PRICING_NOTICE_AT`. Its timing-only earliest eligibility is **2026-12-12T17:47:23.759Z**. This is not an activation appointment or a promise that the target price will be available then. Activation remains off until a separate explicit decision after cost validation.

### Activation prerequisites

Before setting `MH_NEW_COM_PRICING_ENABLED=1`, validate current supplier registration and renewal quotes against the pinned price rows, reconcile the actual processor fees and operating/loss reserves below, and verify search and checkout show the same registration price with a separate renewal estimate. The fee table and public preview are explicitly labeled **8 October 2026 reference examples**, not today's prices; preserve that date/wording unless publishing a newly verified dated tariff. Review the public notice and reference labels with the proposed live quote so no sample is presented as a current offer. Complete payment, registration, renewal and refund readiness verification before public launch. Do not change existing accepted quotes, renewal mandates or launch gates as part of activation.

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
