# Read-only retail economics audit — 2026-10-09

Source: `origin/main` at `e311dae06f75d41131f92d4421355a3934b9bcda` (the production source identified by the lead). No pricing, production database, account configuration, purchases, real grants, or provider calls changed. The selected development base has older $4 low-tier pricing and lacks migration 1220; calculations below deliberately use production source.

## Finding

Configured retail exceeds the configured registrar member charge for all six supported extensions. That is not a guarantee of positive contribution after payment processing, funding, membership, refunds/disputes and support. The $3 low tier leaves `.studio` especially thin and can produce a negative contribution for a successful transaction under a plausible higher-fee scenario. No target net contribution is enforced by the pricing code.

## Configured amounts and reproducible scenario

USD, before sales tax. Register, renew and transfer have equal per-year wholesale rows in migration 1220. `.ai` uses the minimum two-year order; other rows are one year. Stripe scenario is standard US domestic cards at 2.9% + $0.30. The 3% registrar funding rate is the repository's scenario (BUILD-PLAN-2026-10-08 section 5), not an independently verified account charge. Formula: `retail - registrar_cost - (0.029 * retail + 0.30) - (funding_rate * registrar_cost)`; displayed amounts round at the end.

| TLD | Term | Configured provider cost | Retail | After Stripe only | Also assuming 3% funding |
|---|---:|---:|---:|---:|---:|
| .com | 1 year | $10.46 | $13.46 | $2.31 | $2.00 |
| .dev | 1 year | $12.20 | $15.20 | $2.26 | $1.89 |
| .app | 1 year | $14.20 | $17.20 | $2.20 | $1.78 |
| .studio | 1 year | $31.20 | $34.20 | $1.71 | $0.77 |
| .io | 1 year | $50.00 | $59.00 | $6.99 | $5.49 |
| .ai | 2 years | $160.00 | $178.00 | $12.54 | $7.74 |

The last column is contribution before membership, infrastructure, support, tax-service charges and adverse outcomes, not net profit. A `.studio` transaction at Stripe's international + currency-conversion scenario (5.4% + $0.30), plus assumed 3% funding, contributes **-$0.08** before those costs. If the account settles USD without conversion, that extra 1% does not apply. Stripe processing applies to the customer charge including collected tax; tax collections are liabilities, not extra margin. Stripe Tax Basic also has its own charge where registered.

The existing model `docs/research/unit-economics.py` still uses OpenSRS/Dynadot wholesale and assumes no funding fee by default. Reusing its explicitly hypothetical behavior assumptions with production member costs and assumed 3% funding gives expected contribution per domain-year of `.com` $1.56 first/$1.49 renewal; `.dev` $1.44/$1.36; `.app` $1.31/$1.22; `.studio` $0.17/-$0.03; `.io` $3.11/$4.34; `.ai` $0.54/$2.44. These are sensitivity estimates, not observed customer results or a forecast. They still exclude membership and normal overhead. The model assumes 3% first-order refunds, 0.5% renewal refunds, 0.5%/1% disputes, 70% dispute loss, 15% international cards, varying wholesale recovery and labeled support allowances. Those assumptions need owner-approved recalibration for Openprovider and actual outcomes.

## Existing protections and gaps

- `packages/api/src/pricing/fee.ts`: $3 under $50 annual standard wholesale, $9 from $50 to under $100, $10 at $100+. `computeAmounts` in `pricing/quote.ts` charges max(operation cost, renewal cost) plus that fee. It does not calculate processor/funding/overhead contributions.
- `packages/db/migrations/1220_openprovider_member_prices.sql`: member cost rows effective 2026-10-07. Migration comments explicitly say live prices remain unverified; account-specific quotes, settled balance debits and invoice taxes were not read in this audit. The post-2026-11-01 `.com` member cost is a documented pending update. Promotions are excluded deliberately.
- `pricing/quote.ts`, `orders/wiring.ts`, `orders/machine.ts`: live registration quote must match the table, premium names are refused, and fulfilment rechecks price. `transfers/start.ts` and `transfers/driver.ts` separately check transfer quote at start and fulfilment. `domains/renewals.ts:liveRenewalCheck` holds renewals if live wholesale exceeds the table or becomes premium. These guards limit stale-cost selling; they do not establish a sufficient profit margin.
- `registrar/openprovider/adapter.ts:quote`: refuses non-USD quote currencies. The balance debit check detects discrepancies after successful writes and alerts; it cannot retroactively guarantee the cost of an already completed operation.
- Registrar balance/funding gates protect availability of cash for orders and renewals, not unit profitability. Membership is a fixed cost that must be allocated against actual volume. Its live invoice and applicability/limits were not inspected.
- Refunds retain original Stripe processing costs. Failed registration authorization cancellation is better economically than capture/refund; renewals and asynchronous transfers have different loss paths. Transfer failure rates are explicitly an unmodelled gap in the old model.
- `docs/CONVERSION-RELEASE.md` warns the conversion report's contribution estimate excludes processing, chargebacks, overhead and refunded-order economics. It should not be used as net profit evidence.
- Production fees disclosure and D-062 match the configured $3/member-price policy. This was an owner pricing decision; this audit does not change it.

## Supported sales scope and `.ai`

Production source includes `.ai` in `packages/api/src/search/labels.ts:7` and the Openprovider adapter's `LAUNCH_TLDS`, publishes its price in `apps/web/public/fees.html`, and configures member register/renew/transfer rows. The two-year minimum is enforced. This proves implemented support, not that live operational gates currently permit a sale. No production flags or active membership invoice were read.

The source does **not** implement a decision to leave `.ai` for later through these supported-TLD lists. If that is the owner's intended rollout, it needs a separately authorized, server-enforced sales restriction covering direct registration, renewal/transfer policy, CLI/MCP/REST entry points, and public copy. Hiding a search chip alone would not enforce it. This audit neither enables nor disables `.ai` and does not infer an authorization to sell it from the existing code.

The isolated reviewer passed 270 tests across 30 production-source files, including pricing and sale paths; see `retail-verification-2026-10-09.json`. This document’s calculations use source inspection and deterministic Decimal arithmetic. It makes no claim of successful live `.ai` sales, verified live price coverage, or registration completion.

## Proposed minimum-contribution policy (design only)

The confirmed issue is the absence of a fee-aware minimum contribution check, with `.studio` the weakest current tier. Keep the owner-selected public fee policy separate from a configurable sell/hold decision. Do not silently increase a quoted price to clear the floor.

A proposed policy stores versioned, owner-approved values in integer minor units: minimum contribution per order and per domain-year; supported payment/settlement currencies; processor percentage and fixed charges for supported card categories; actual funding charges; membership/overhead allocation; and an explicitly labeled loss reserve. Quotes record the policy version, operation, term, provider quote timestamp, renewal cost and assumptions used. The initial calculation is:

```text
estimated contribution = retail excluding collected tax
                       - quoted provider debit for this operation and term
                       - funding costs and unrecoverable upstream taxes/FX
                       - processing fees on the full captured amount (including tax)
                       - applicable tax-service charges
                       - allocated membership/overhead and approved loss reserve
required floor = max(minimum per order, years × minimum per domain-year)
```

Only show checkout as available when estimated contribution meets the configured floor and every required cost input is known and fresh. The precise freshness limits and contribution targets require an owner decision; this audit invents neither. Recheck before any irreversible registrar write. For payment categories whose fee is not known until checkout, use an approved conservative estimate or hold before fulfilment; do not rely on a domestic-card assumption for every customer. This design needs isolated tests for each TLD/operation/term, fee boundary, tax and currency combination, membership lapse, changed provider cost and expired quote before any implementation is released.

Three distinct currency facts must remain explicit: the provider invoice currency, the customer's charge currency and the Stripe settlement currency. The current adapter rejects provider quotes outside USD and orders check the charge currency. Neither establishes the account's settlement currency or its actual FX/payment fee schedule; those remain unverified. The current fee formula does not reserve for those costs.

Registration cost and annual renewal cost are also distinct inputs. The existing renewal floor already prevents a cheap introductory registration quote from hiding a higher **currently known** renewal cost. Publish registration and renewal amounts separately when they differ, and disclose that later upstream price changes can require notice and renewed consent. Today's floor does not guarantee future annual renewal prices. Transfer, renewal and restore have different provider debit/refund rules and need their own contribution checks; do not borrow a registration teaser cost for them.

Current fail-closed coverage versus the proposed floor:

- Unsupported TLDs and terms are refused by the search/parser/provider allowlists; unknown cost rows produce `no_price`. `.ai` is currently in the supported list and therefore is not covered by an unsupported-TLD refusal.
- Premium/nonstandard registration and transfer quotes are refused; higher/premium renewal quotes cause a hold. Renewal quote failures also hold. The 30-minute customer quote expiry and fulfilment price recheck limit stale quotes. A configured cost row has no independent maximum-age rule; live comparison is the important current safeguard. Payment and funding assumptions have no corresponding freshness gate.
- Registrar funding gates require enough available balance for the operation and reserves. They do not check sufficient contribution. Membership lapse can be caught when live provider pricing diverges, but membership amortization and payment fees are absent from the current calculation.

No floor, fee, allowlist, sale gate or live price was changed by this proposal. The review should first resolve `.studio`'s small/negative contribution scenarios and the actual account fee/settlement inputs before expanding supported sales.

## Sources

Production source: [fee tiers](https://github.com/nsheinbe/MossHatch/blob/e311dae06f75d41131f92d4421355a3934b9bcda/packages/api/src/pricing/fee.ts), [member costs](https://github.com/nsheinbe/MossHatch/blob/e311dae06f75d41131f92d4421355a3934b9bcda/packages/db/migrations/1220_openprovider_member_prices.sql), [pricing arithmetic and guard](https://github.com/nsheinbe/MossHatch/blob/e311dae06f75d41131f92d4421355a3934b9bcda/packages/api/src/pricing/quote.ts), [D-062 owner decision](https://github.com/nsheinbe/MossHatch/blob/e311dae06f75d41131f92d4421355a3934b9bcda/docs/DECISIONS.md#d-062-openprovider-membership-member-price-rows-and-a-300-fee).

Official pages rechecked in this audit: [Stripe US pricing](https://stripe.com/us/pricing) confirms 2.9% + $0.30 domestic, +1.5% international, +1% when conversion is needed, Stripe Tax Basic Checkout 0.5% where registered, and retained original processing costs on refunds. [Openprovider payment methods](https://support.openprovider.eu/hc/en-us/articles/216644258-Supported-payment-methods) confirms payment-specific charges shown at top-up; it does not establish a universal 3% fee. It also limits bank transfer availability to EU-address/EUR accounts, so the old OpenSRS zero-cost ACH/wire assumption is not validated for this USD Openprovider account.

A concrete next pricing decision should set an owner-selected expected contribution target and use actual Stripe/funding invoices, membership amortization and measured adverse outcomes. That review is necessary before calling each sale profitable enough; no price changes are authorized by this audit.
