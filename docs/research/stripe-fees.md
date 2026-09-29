# Mosshatch payment-processing costs (Stripe Checkout, US launch)

Research date: 2026-09-29. All sources below were fetched on 2026-09-29 (the "accessed" date for every citation unless a row says otherwise). Raw page text is cached in `working-directory/research/stripe-raw/`. Citation form: `[S#]` = entry in the Source index (Section 12, full URL + accessed date); load-bearing claims also carry a short exact quote.

## TL;DR

1. Stripe US standard card price is 2.9% + 30¢; +1.5% for international cards; +1% only if currency conversion is required. Apple Pay, Google Pay and Link cards are the same rate. Checkout adds no fee. [S1, S2, S26, S27]
2. At Mosshatch order sizes the fixed 30¢ dominates: domestic effective cost is 5.90% at $10, 4.93% at $15, 4.12% at $25, 3.40% at $60, 3.10% at $150. International card plus FX: 8.40% at $10 down to 5.60% at $150.
3. Refunds are free to issue but Stripe keeps the original fee. Disputes cost $15 received (never returned, even on a win) plus $15 countered (returned only on a win). A lost, countered dispute on a $10 order costs $30.59 in Stripe fees plus the $10 reversed. [S1, S8, S40]
4. Radar Lite is included; Radar Standard is $0.05 per screened transaction. Stripe Tax Basic is 0.5% per transaction (Checkout, no-code) only where registered, but $0.50 per transaction via API, which is 5% of a $10 order. [S3, S4]
5. Visa VAMP: merchant Excessive ratio is 1.5% in the US since 2026-04-01 (was 2.2%), with a minimum of 1,500 fraud+dispute events per month; Mastercard ECM needs 100+ chargebacks and 1.5%. At launch volume the network programs are unreachable; Stripe's own risk review (industry "excessive" line 0.75%) is the practical constraint. [S9, S10, S41]
6. Domain registration and domain reselling are not on Stripe's prohibited or restricted lists (page last updated 2026-09-22), but the prohibited "no-value-added services ... resale of a service without added benefit to the buyer" line and the "undisclosed products" rule mean the reseller model must be disclosed and its value-add documented. No explicit Stripe statement on registrars exists (unverified). [S12, S13]
7. New accounts: first payout typically 7-14 days; Stripe may add an initial holding period, payout availability delays (released after 14 days) and risk-based fixed or rolling reserves. No numeric new-account reserve policy is published. [S15, S16, S17, S43]
8. Merchant-of-record options: Paddle 5% + 50¢; Lemon Squeezy 5% + 50¢ (+1.5% international); Polar 5% + 50¢ (Pro 3.8% + 40¢); Stripe Managed Payments +3.5% on top of 2.9% + 30¢. None lists domain names as allowed or prohibited; all target software and digital products (unverified for domains). [S18-S23]
9. No change to Stripe's headline US card rates was found for 2026; 2026 changes found are Radar tiering, Tax plans, Managed Payments, dispute add-ons. [S1, S3, S4, S24]

---

## 1. Stripe US standard pricing (primary: stripe.com/pricing, rendered as "United States (English)")

| Item | Value | Exact quote | Source |
|---|---|---|---|
| Standard card rate, domestic | 2.9% + $0.30 per successful transaction | "2.9% + 30¢ per successful transaction for domestic cards" | [S1] https://stripe.com/pricing |
| Manually entered cards | +0.5% (not applicable to hosted Checkout) | "+ 0.5% for manually entered cards" | [S1] |
| International card surcharge | +1.5% | "+ 1.5% for international cards" | [S1] |
| Currency conversion | +1%, only when conversion is required | "+ 1% if currency conversion is required" | [S1] |
| What "international" means | Non-domestic cards get the fee | "Any non-domestic cards processed for your business will be assessed an international card fee" | [S25] https://support.stripe.com/questions/understanding-stripe-s-fee-structure-for-international-and-refunded-payments |
| Apple Pay | Same as cards (2.9% + 30¢, +1.5% intl, +1% FX) | "Stripe will charge the same rate for processing Apple Pay transactions as we do for all other credit and debit card transactions. There is no additional fee from Apple for Apple Pay transactions." | [S26] https://support.stripe.com/questions/pricing-for-apple-pay-with-stripe ; also [S2] |
| Google Pay | Same as cards | "Stripe will charge the same rate for processing Google Pay transactions as we do for all other credit and debit card transactions." | [S27] https://support.stripe.com/questions/pricing-for-google-pay-with-stripe |
| Link (cards) | 2.9% + 30¢, +1.5% intl, +1% FX | "Cards 2.9% + 30¢ per successful transaction + 1.5% for international transactions + 1% if currency conversion is required" | [S1], [S2] https://stripe.com/pricing/local-payment-methods |
| ACH Direct Debit | 0.8%, $5.00 cap; 1.2% for two-day settlement; $1.50 per instant bank validation; $15.00 disputed payment; $4.00 failed payment | "0.8% per transaction for standard settlement timing ... $5.00 cap ... 1.2% per transaction for two-day settlement ... $15.00 for disputed payments ... $4.00 for failed payments" | [S2] |
| ACH settlement time | 4 business days | "ACH Debit \| 4 business days" | [S16] https://docs.stripe.com/payouts |
| Checkout-specific fee | None for accepting payments | "Accept payments made on Stripe Checkout. Included with Payments ... Included at no additional charge for businesses on standard payments pricing" | [S1] |
| Checkout optional extras | Custom domain $10.00/month; post-payment invoices 0.4% of transaction total, $2.00 cap per invoice | "Custom domain ... $10.00 per month"; "Post-payment invoices ... 0.4% on transaction total ... $2.00 cap per invoice" | [S1] |
| Adaptive Pricing (Checkout local currency) | Merchant pays 0%; customer pays 2-4% embedded in the rate | "You don't directly pay any additional Stripe fees for Adaptive Pricing, as all such fees are paid by your customers ... includes a conversion fee of between 2-4%" | [S28] https://support.stripe.com/questions/adaptive-pricing ; [S29] https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing |
| Minimum charge | 0.50 USD | "0.50 USD" (minimum charge list) | [S30] https://docs.stripe.com/currencies |
| Rounding | Nearest cent; 0.025 rounds up to 0.03 | "Stripe rounds the Stripe fee to the nearest unit (e.g., cents). For example, if the fee is 0.025, Stripe will round up to 0.03." | [S31] https://support.stripe.com/questions/rounding-rules-for-stripe-fees |
| Setup / monthly fees | None on standard pricing | "Stripe does not charge setup fees, monthly fees, or any other hidden fees like closure fees." | [S1] |

### 1.1 Add-ons and adjacent fees

| Item | Value | Exact quote | Source |
|---|---|---|---|
| Radar Lite | Included on standard payments pricing | "Get AI-based fraud prevention for card payments and card testing, plus fraud alerts included at no additional charge for businesses on standard payments pricing." | [S3] https://stripe.com/radar/pricing |
| Radar Standard | $0.05 per screened transaction (pay as you go), or from $10/month (includes 200 transactions, then $0.05 each) | "$0.05 per screened transaction" ; "Includes 200 transactions $0.05 per additional screened transaction" | [S3] (rendered page, "Show pricing" expanded) ; [S1] "Starting at $0.05 per screened transaction" |
| Radar Standard/Plus/Pro billing basis | Per screened transaction | "Radar Standard, Plus, and Pro plans charge a fee for each screened transaction." | [S32] https://docs.stripe.com/radar/how-radar-works |
| Radar Plus / Pro | From $14/month and $20/month; PAYG rates $0.07 and $0.09 appear only in a secondary source | "Starting at $14 per month" ; "Starting at $20 per month" | [S3]; PAYG: [S33] (secondary) |
| Stripe Tax Basic, no-code (Checkout, Billing, Invoicing, Payment Links) | 0.5% per transaction, only where registered to collect | "0.5% per transaction, where you're registered to collect taxes" | [S4] https://stripe.com/tax/pricing |
| Stripe Tax Basic, API | $0.50 per transaction where registered; 10 calc calls included, 5¢ per extra call | "50¢ per transaction, where you're registered to collect taxes ... 5¢ per calculation API call above 10" | [S4] |
| Stripe Tax Complete | From $90/month, 1-year contract; 200 transactions/month, 2 registrations/yr, 4 filings/yr; tiers $90 / $430 / $1000 / $1500 | "Starting at $90 per month with registrations, calculations, and filings included" | [S4]; tiers [S34] https://support.stripe.com/questions/understanding-stripe-tax-pricing |
| Tax Complete overage and extras | US registration included in tier, US overage registration $150, US overage filing $55; non-US registration $150 additional, overage $300 | "US \| 0 USD \| 150 USD" (registrations) ; "US \| 0 USD \| 55 USD" (filings) | [S34] |
| Tax fees are deducted from balance and charged in merchant's currency | | "Fees for Stripe Tax are automatically deducted from your Stripe Balance" | [S34] |
| Dispute prevention (Verifi / Ethoca) | Included; deflection lookups $15.00 per Visa resolution, $15.00 per Visa Compelling Evidence 3.0 block, $29.00 per Mastercard resolution | "Dispute deflection lookups $15.00 per Visa resolution ... $29.00 per Mastercard resolution" | [S1] |
| Smart Disputes | 30% of disputed amount on wins only; no counter fee | "30% of the disputed amount for each dispute you win. There's no Smart Dispute fee for lost disputes. The dispute received fee still applies." | [S1]; waiver of counter fee: [S35] https://support.stripe.com/questions/june-2025-pricing-updates-for-disputes |
| 3D Secure | Included | "Included at no additional charge for businesses on standard payments pricing" | [S1] |
| Payouts (standard) | Free | "Stripe doesn't charge you a fee to initiate normal payouts." | [S16] |
| Instant Payouts | 1.5% of Instant Payouts volume, minimum 50¢; new users not immediately eligible | "1.5% of Instant Payouts volume Minimum fee of 50¢" ; "New Stripe users aren't immediately eligible for Instant Payouts." | [S1], [S16] |
| Standard US payout timing | 2 business days after settlement for established accounts | "You can always pay out your funds using our standard schedule (2 business days) for free." | [S36] https://support.stripe.com/questions/june-2024-pricing-update-for-instant-payouts-for-businesses-in-the-united-states |
| Managed Payments (Stripe's MoR) | +3.5% per successful transaction on top of Payments fees | "3.5% per successful Managed Payments transaction in addition to Payments fees" | [S1]; [S37] https://support.stripe.com/questions/managed-payments-pricing |
| Refund issuing fee | None for cards | "For all other payment methods, there are no fees for issuing refunds. The payment processing, Connect and currency conversion fees from the original transaction are not returned." | [S1] (FAQ) ; [S38] https://support.stripe.com/questions/understanding-fees-for-refunded-payments |

## 2. Spreadsheet formulas (USD, `P` = order amount in dollars; Excel/Sheets `ROUND` is half-away-from-zero, which matches the documented rounding example)

Named inputs (put in a parameter block, do not hard-code):

| Name | Value | Meaning |
|---|---|---|
| `r_card` | 0.029 | base card rate |
| `f_fixed` | 0.30 | fixed fee per successful card charge |
| `r_intl` | 0.015 | international card surcharge |
| `r_fx` | 0.01 | currency-conversion fee (only when conversion is required) |
| `r_tax_nocode` | 0.005 | Stripe Tax Basic via Checkout (only where registered) |
| `f_tax_api` | 0.50 | Stripe Tax Basic via API (only where registered) |
| `f_radar_std` | 0.05 | Radar Standard per screened transaction (0 if Radar Lite) |
| `f_disp_recv` | 15 | dispute received fee (never returned) |
| `f_disp_ctr` | 15 | dispute countered fee (returned only on a win) |
| `r_smart` | 0.30 | Smart Disputes fee on wins |
| `r_ach` , `cap_ach` | 0.008 , 5 | ACH rate and cap |

Formulas:

```
Domestic card fee            = ROUND(P*r_card + f_fixed, 2)
International card, USD-priced (no conversion)
                             = ROUND(P*(r_card + r_intl) + f_fixed, 2)
International card + conversion (price shown in foreign currency, settled in USD)
                             = ROUND(P*(r_card + r_intl + r_fx) + f_fixed, 2)
Net to Mosshatch             = P - fee
Effective rate               = fee / P

Refunded order (card)        : Stripe cost = original fee (not returned); refund fee = 0
                               cash impact = -fee (principal P is returned to customer)

Disputed, lost, not countered: Stripe cost = fee + f_disp_recv
Disputed, lost, countered    : Stripe cost = fee + f_disp_recv + f_disp_ctr
   cash out including reversed principal = P + Stripe cost   (before any wholesale/registrar recovery)
Disputed, won, countered     : Stripe cost = fee + f_disp_recv   (counter fee returned)
Disputed, won via Smart Disputes
                             : Stripe cost = fee + f_disp_recv + ROUND(r_smart*P, 2)

Optional add-ons (per order)
  Tax Basic no-code          = ROUND(P*r_tax_nocode, 2)      (only in registered jurisdictions)
  Tax Basic API              = f_tax_api
  Radar Standard             = f_radar_std

ACH fee                      = MIN(ROUND(P*r_ach, 2), cap_ach)

Expected dispute cost per order, dispute rate d, win rate w, counter c (1 if countered, 0 if accepted)
                             = fee + d*((1-w)*(P + f_disp_recv + c*f_disp_ctr) + w*f_disp_recv)     [w applies only when c=1; use w=0 when c=0]

Gross-up (price needed so that net of domestic fee = N)
                             = (N + f_fixed) / (1 - r_card)
Margin check for a flat-fee model (wholesale W, flat fee F, P = W + F)
                             = F - fee(P)
```

Assumption flagged: Stripe documents rounding "the Stripe fee" to the nearest cent [S31]; whether it rounds the total or each component is not stated (unverified). Tax and Radar fees are separate line items, so round them separately.

## 3. Effective Stripe cost by order size (computed with the formulas above; half-up rounding)

### 3.1 (i) Domestic card and (ii) international card

| Order P | (i) Domestic fee | Effective % | Net | Intl card, USD-priced (4.4% + 30¢) | Effective % | (ii) Intl + currency conversion (5.4% + 30¢) | Effective % | Net |
|---|---|---|---|---|---|---|---|---|
| $10 | $0.59 | 5.90% | $9.41 | $0.74 | 7.40% | $0.84 | 8.40% | $9.16 |
| $15 | $0.74 | 4.93% | $14.26 | $0.96 | 6.40% | $1.11 | 7.40% | $13.89 |
| $25 | $1.03 | 4.12% | $23.97 | $1.40 | 5.60% | $1.65 | 6.60% | $23.35 |
| $60 | $2.04 | 3.40% | $57.96 | $2.94 | 4.90% | $3.54 | 5.90% | $56.46 |
| $150 | $4.65 | 3.10% | $145.35 | $6.90 | 4.60% | $8.40 | 5.60% | $141.60 |

Note: $15 and $25 domestic land on half-cent results (0.735 and 1.025); the table rounds half up.

### 3.2 (iii) Refunded order

| Order P | Domestic: Stripe keeps | Refund fee | Cash impact | Intl + FX: Stripe keeps | Cash impact |
|---|---|---|---|---|---|
| $10 | $0.59 | $0 | -$0.59 | $0.84 | -$0.84 |
| $15 | $0.74 | $0 | -$0.74 | $1.11 | -$1.11 |
| $25 | $1.03 | $0 | -$1.03 | $1.65 | -$1.65 |
| $60 | $2.04 | $0 | -$2.04 | $3.54 | -$3.54 |
| $150 | $4.65 | $0 | -$4.65 | $8.40 | -$8.40 |

Basis: "The payment processing, Connect and currency conversion fees from the original transaction are not returned." [S1, S38]. Refunds under Adaptive Pricing: "You pay nothing to cover the refund" [S28]. Cancelling an uncaptured authorization costs nothing: "You can cancel a payment before it's completed at no cost." [S39] https://docs.stripe.com/refunds

### 3.3 (iv) Disputed and lost (domestic card)

| Order P | Fee kept | Lost, not countered (fee + $15) | % of P | Lost, countered (fee + $30) | % of P | Total cash out incl. reversed P (countered) | Won, countered (fee + $15) | Won via Smart Disputes (fee + $15 + 30% of P) |
|---|---|---|---|---|---|---|---|---|
| $10 | $0.59 | $15.59 | 155.9% | $30.59 | 305.9% | $40.59 | $15.59 | $18.59 |
| $15 | $0.74 | $15.74 | 104.9% | $30.74 | 204.9% | $45.74 | $15.74 | $20.24 |
| $25 | $1.03 | $16.03 | 64.1% | $31.03 | 124.1% | $56.03 | $16.03 | $23.53 |
| $60 | $2.04 | $17.04 | 28.4% | $32.04 | 53.4% | $92.04 | $17.04 | $35.04 |
| $150 | $4.65 | $19.65 | 13.1% | $34.65 | 23.1% | $184.65 | $19.65 | $64.65 |

International card with FX, disputed and lost: not countered = $15.84 / $16.11 / $16.65 / $18.54 / $23.40; countered = $30.84 / $31.11 / $31.65 / $33.54 / $38.40 for $10 / $15 / $25 / $60 / $150. All excludes any unrecoverable wholesale cost paid to the registrar for the domain and excludes "in rare cases, network fees also apply" [S1].

Rows above are Stripe-side only. A partially won dispute keeps both $15 fees: "The $15 fees to receive the dispute and to counter the dispute will not be returned." [S35]

### 3.4 Optional add-ons on a domestic order (per order)

| Order P | Domestic fee | + Tax Basic no-code (0.5%, registered states only) | + Radar Standard ($0.05) | All three | All-in % | Tax via API instead ($0.50) all-in |
|---|---|---|---|---|---|---|
| $10 | $0.59 | $0.05 | $0.05 | $0.69 | 6.90% | $1.14 (11.40%) |
| $15 | $0.74 | $0.08 | $0.05 | $0.87 | 5.80% | $1.29 (8.60%) |
| $25 | $1.03 | $0.13 | $0.05 | $1.21 | 4.84% | $1.58 (6.32%) |
| $60 | $2.04 | $0.30 | $0.05 | $2.39 | 3.98% | $2.59 (4.32%) |
| $150 | $4.65 | $0.75 | $0.05 | $5.45 | 3.63% | $5.20 (3.47%) |

(Tax via API "all three" swaps the 0.5% for $0.50 and keeps Radar Standard: $10 -> 0.59+0.50+0.05 = $1.14.) Whether Tax Basic's 0.5% is computed on a tax-inclusive total is not stated (unverified).

### 3.5 ACH for reference

0.8% capped at $5: $0.08 / $0.12 / $0.20 / $0.48 / $1.20 for $10 / $15 / $25 / $60 / $150. Settlement is 4 business days [S16] and failed payments cost $4.00 [S2], so ACH does not fit "register the domain now" flows without a pending state.

### 3.6 Expected dispute cost per order (illustrative; dispute rate d, lost, not countered: `d*(P+15)` per order)

| Order P | d = 0.30% (Sift all-industry Q3 2025) | d = 0.75% (Stripe's "excessive" line) | d = 1.5% (Visa Excessive merchant ratio) |
|---|---|---|---|
| $10 | $0.08 | $0.19 | $0.38 |
| $15 | $0.09 | $0.23 | $0.45 |
| $25 | $0.12 | $0.30 | $0.60 |
| $60 | $0.23 | $0.56 | $1.13 |
| $150 | $0.50 | $1.24 | $2.48 |

These are on top of the processing fee and exclude unrecoverable wholesale cost.

## 4. Disputes, refunds, payouts: rules that drive the formulas

| Claim | Exact quote | Source |
|---|---|---|
| Dispute received fee is $15 and is not returned (outside Mexico), including on a win | "For businesses outside Mexico, the fee for receiving a dispute is non-refundable." ; "Stripe returns the dispute countered fee if you win the dispute. Unless otherwise stated in your Stripe contract, we never return the dispute received fee." | [S8] https://docs.stripe.com/disputes/how-disputes-work |
| Dispute countered fee $15, returned only on a win | "Dispute countered fee $15.00 for each dispute you respond to manually. You get this fee back for won disputes. You don't get this fee back for lost disputes." | [S1] |
| Fee structure origin | New counter fee applies to disputes initiated after 2025-06-17; existing received fee unchanged | "a new dispute counter fee will apply when you counter disputes initiated after June 17, 2025. This fee will be returned if you win. Your existing dispute fee is not changing." | [S35] |
| Smart Disputes waives the counter fee | "The new dispute counter fee will be waived when a dispute is countered with Smart Disputes." | [S35] |
| Received fee cannot be avoided by refunding after the dispute opens | "Once a cardholder initiates a dispute, the dispute received fee can't be avoided." ; "If a dispute is opened after you've fully refunded the payment ... The dispute received fee may still apply." | [S40] https://support.stripe.com/questions/dispute-fees-faq |
| Contrast (payout-availability-delay context only): Stripe covers dispute fees on flagged charges refunded before dispute | "Note that if a dispute is filed after you have refunded a charge, Stripe will cover any related dispute fees." | [S17] https://support.stripe.com/questions/payout-availability-delays |
| Disputed amount is debited immediately, dispute can take up to 3 months to decide | "Stripe in turn debits your Stripe balance for the disputed amount plus a dispute fee." ; "This can take up to 3 months." | [S8] |
| Cardholders can dispute for 120 days or more | "cardholders can dispute a charge up to 120 days after a payment was made (and sometimes even later)" | [S41] https://docs.stripe.com/disputes/measuring |
| Early fraud warnings are reported even if refunded; authorization-only avoids the report | "Issuers are required to report possible fraud for a captured payment, even if it gets refunded, but aren't required to report it for a payment authorization." | [S9] https://docs.stripe.com/disputes/monitoring-programs |
| Stripe guidance on refunding EFW charges | "optimal point for issuing a refund on early fraud warnings is on charges that are roughly less than or equal to your dispute fee" | [S8] |
| Authorization hold window (online card) | "Usually, an authorization for an online card payment is valid for 7 days." ; set `payment_intent_data[capture_method]=manual` on the Checkout Session | [S42] https://docs.stripe.com/payments/place-a-hold-on-a-payment-method |
| Negative balance handling | "if you receive 100 USD in payments but refund 200 USD of prior payments, your account balance would be -100 USD ... Stripe creates a payout that debits your bank account." | [S16] |
| Card-network fines are passed to the user | "User is responsible for all Assessed Fines and must reimburse Stripe for its payment of Assessed Fines" (Financial Services Terms 2.5) | [S43] https://stripe.com/legal/ssa-service-terms (Financial Services Terms last modified September 28, 2026) |
| Stripe can delay payouts for likely disputes | "Stripe may delay or withhold paying out a Transaction amount from funds owed to User if Stripe reasonably believes that a Dispute is likely to occur with respect to that Transaction." (Stripe Payments terms 5.2(a)(i)) | [S43] |

## 5. Card-network programs and dispute-rate benchmarks

### 5.1 Visa VAMP (Visa Acquirer Monitoring Program)

Primary: Visa fact sheet PDF [S10] https://corporate.visa.com/content/dam/VCOM/corporate/visa-perspectives/security-and-trust/documents/visa-acquirer-monitoring-program-fact-sheet-2025.pdf (text extracted locally).

| Date | Event | Exact quote / value | Source |
|---|---|---|---|
| 2025-06-01 | Updated VAMP thresholds effective; single program replaces VAMP, VFMP, VDMP | "Updates to the program thresholds will be effective 1 June 2025" | [S10] |
| 2025-06-01 | VAMP ratio defined on settled transactions | "VAMP Ratio = Count of [Fraud (TC40) + Disputes (TC15)] ÷ Count of Settled Transactions (TC05)" (footnote: "Effective 1 June 2025") | [S10] |
| through 2025-09-30 | Advisory period | "Program advisory period ends 30 September 2025." | [S10] |
| 2025-10-01 onward | Enforcement (fees) begins (secondary reading of the advisory end) | "During the advisory period through September 30, 2025, there were no direct penalties from Visa." | [S44] (secondary, Chargeflow) |
| 2025-06 to 2026-03 | Excessive Merchant ratio, US/Canada/EU/AP | "VAMP Ratio: ≥220bps" and "Monthly count of fraud and disputes: ≥1,500" | [S10] |
| 2026-04-01 | Excessive Merchant ratio drops to 150 bps in AP, Canada, EU, US | "Excessive Merchant threshold reduced to >=150bps in AP, Canada, EU, and U.S. regions on 1 April 2026." | [S10] |
| Ongoing | LAC threshold already 150 bps; CEMEA 220 bps with count >=150 and amount >= USD 75,000 | "LAC: VAMP Ratio: ≥150bps" ; "CEMEA ... ≥150 and amount ≥ USD 75,000" | [S10] |
| Ongoing | Acquirer level: Above Standard >= 50 bps, Excessive >= 70 bps; merchant thresholds apply when the acquirer is not flagged | "Above Standard if its VAMP ratio is ≥50bps and as Excessive if ≥70bps" | [S10] |
| Ongoing | Enumeration (card testing) thresholds | "VAMP Enumeration Ratio ... ≥ 2000 bps" and "VAMP Enumeration Transaction Count ... ≥ 300,000" | [S10] |
| Exclusions | Pre-dispute resolutions and CE 3.0-qualified TC40 fraud excluded | "Excludes disputes resolved through pre-dispute solutions" ; "Excludes TC 40 fraud qualified for Compelling Evidence 3.0" | [S10] |

Stripe's own description (US, accessed 2026-09-29) [S9] https://docs.stripe.com/disputes/monitoring-programs:

| Criteria | Non-compliant | Excessive |
|---|---|---|
| VAMP count | 5 | 1,500 (US, Canada, EU, AP, LAC); 150 CEMEA |
| VAMP ratio | 0.5% | 1.5% (US and others); 2.2% CEMEA |

Quote: "Visa assesses fees to merchants that exceed the Excessive threshold and may assess fees to merchants that exceed the Non-Compliant threshold." Stripe also states EFWs count: "Visa's VAMP program includes them in its calculations" and "Visa identifies an account by the static component of its statement descriptor and its acquiring bank."

Fee level: "Merchants enrolled in VAMP are assessed a fee of $8 per fraudulent or disputed transaction." and "First-time violations within a rolling twelve-month period qualify for a three-month grace period" [S45] https://merchantriskcouncil.org/learning/resource-center/member-news/blog/2026/stricter-vamp-ratio-thresholds-are-now-in-effect-heres-how-to-stay-compliant (trade body, secondary). Chargeflow also reports "~$8 per dispute / fraud transaction" [S44]. Conflicting source: Sift says "the 'excessive' threshold is set at 1.5% starting October 1, 2025, dropping to 0.9% on January 1, 2026, with a $10 fee per disputed transaction" [S46] https://sift.com/index-reports-disputes-q4-2025/. That conflicts with Visa's own fact sheet (220 bps until 1 April 2026, then 150 bps); the Visa document is treated as authoritative and Sift's schedule as unreliable.

Practical reading (inference, not a quoted rule): the Excessive Merchant tier needs both the ratio and at least 1,500 fraud+dispute events in a month, which at 1.5% implies about 100,000 settled Visa CNP transactions in that month (1,500 / 0.015). Mosshatch cannot reach that at launch. Stripe monitors sooner: "The credit card processing industry standard recognizes dispute activity above 0.75% as excessive, but other factors, such as a sudden spike or steep upward trend can trigger placement in a monitoring program before dispute activity reaches the 0.75% threshold." [S41]

### 5.2 Mastercard Excessive Chargeback Program (ECP)

Mastercard's own rulebook (Security Rules and Procedures, Merchant Edition, August 2026 at mastercard.com) returned HTTP 403 (Akamai "Access Denied") to curl and to headless Chromium; thresholds below are from Stripe's documentation of the program [S9].

| Program | Chargeback count | Chargeback rate | Fines (Stripe doc) |
|---|---|---|---|
| ECM (Excessive Chargeback Merchant) | 100-299 | 1.5%-2.99% | month 1: $0; months 2-3: $1,000; 4-6: $5,000; 7-11: $25,000; 12-18: $50,000; 19+: $100,000 (+$5 per chargeback over 300 from month 4) |
| HECM (High Excessive Chargeback Merchant) | 300+ | 3% | month 1: $0; 2: $1,000; 3: $2,000; 4-6: $10,000; 7-11: $50,000; 12-18: $100,000; 19+: $200,000 |
| EFM (Excessive Fraud Merchant) | fraud chargebacks (codes 4837/4863) net fraud volume > $50,000, >= 1,000 e-commerce MC payments, fraud chargeback rate > 0.50%, 3DS on <= 10% of MC payments | | month 2: $500; 3: $1,000; 4-6: $5,000; 7-11: $25,000; 12-18: $50,000; 19+: $100,000 |

Quote: "Mastercard's Excessive Chargeback Program (ECP) consists of two levels: Excessive Chargeback Merchant (ECM) and High Excessive Chargeback Merchant (HECM)". Rate basis: "The ratio of the chargeback count for the current month to the total number of captured payments from the preceding month". ECM needs at least 100 chargebacks, i.e. roughly 6,700 Mastercard transactions in the preceding month at 1.5%. Monitoring "don't consider dispute outcomes" and "don't consider refunds when identifying disputes." [S9]

### 5.3 Published typical dispute rates for digital goods (low confidence; vendor blogs, mostly unnamed underlying sources)

| Figure | Claim | Source |
|---|---|---|
| 0.26% | Average chargeback rate across the Sift network reached 0.26% in Q3 2025 (0.17% in Q1 2025) | "Average chargeback rates climbed steadily across the year, reaching 0.26% in Q3 2025" [S46] |
| 0.54% (0.34% in 2023) | "Digital Goods and Subscription Services ... Chargeback rates increased 59% from 0.34% in 2023 to 0.54% in 2024" ; avg value "$77 for digital goods" | [S47] https://www.chargeflow.io/blog/chargeback-statistics-trends-costs-solutions |
| 0.6%-1.2% | "the digital goods and gaming industries often have chargeback rates around 0.6% to 1.2%" | [S48] https://paycompass.com/blog/chargeback-rates-by-industry/ |
| 3.62% | Same page's high-risk table lists "Digital Goods \| 3.62%" (high-risk merchants only) | [S48] |
| >0.75% | Stripe's stated industry line for "excessive" | [S41] |

Sources conflict by an order of magnitude and none names its dataset for digital goods. Use 0.3%-1.0% as planning scenarios (Section 3.6), not as a forecast.

## 6. Stripe Prohibited and Restricted Businesses: is domain registration or reselling allowed?

Page: [S12] https://stripe.com/legal/restricted-businesses, "Last updated: 2026-09-22" (page text: "Updated credit repair services from prohibited to supportable in the United States.").

| Finding | Exact quote / evidence | Source |
|---|---|---|
| Domain registration, domain names, registrar, web hosting, DNS: no entry on either list | Full-text search of the fetched prohibited and restricted lists found no occurrence of "domain", "registrar", "hosting" or "DNS" | [S12] |
| Closest prohibited line: no-value-added resale | Under "Unfair, deceptive, or abusive acts or practices": "No-value-added services, including the sale or resale of a service without added benefit to the buyer and resale of government offerings without authorization or added value" | [S12] |
| Restricted: payment facilitation | "Payment facilitation and aggregation (including receiving settlement proceeds for goods or services that you did not provide, on behalf of one or multiple third-party sellers)" | [S12] |
| Restricted: stored value | "Sale of stored value or credits maintained, accepted, and issued by anyone other than the seller. Seller-maintained stored value or credits may be subject to limits." and "Preloaded payment cards, gift cards, virtual credits" | [S12] |
| Prohibited use: undisclosed products | "Use of Stripe products to facilitate transactions on behalf of another undisclosed merchant or for products or services that weren't disclosed in the business's Stripe account application" | [S12] |
| Prohibited use: chargeback-program evasion | "Evasion of card network chargeback monitoring programs" | [S12] |
| Prohibited: IP infringement (relevant to trademark-abusive domains) | "Any other products or services that directly infringe or facilitate infringement upon the trademark, patent, copyright ... of any third party" | [S12] |
| Contract hook | SSA General Terms 1.2(a)(ix): "use the Services to conduct a Prohibited or Restricted Business ... unless Stripe has pre-approved the respective Prohibited or Restricted Business in writing." | [S13] https://stripe.com/legal/ssa (General Terms last modified September 28, 2026) |
| Restricted list means extra diligence | "Businesses in these categories require additional due diligence by Stripe in order to confirm our ability to support them." | [S12] |
| FAQ has no resale or domain guidance | Rendered FAQ contains no occurrence of "resell", "resale" or "domain"; its only "hosting" hit is "unhosted/decentralized wallet hosting" (crypto) | [S49] https://support.stripe.com/questions/prohibited-and-restricted-businesses-list-faqs |
| Managed Payments (Stripe MoR) eligibility does not mention domain names | Supported: "Electronically supplied business and web services, such as website hosting"; unsupported: "Physical goods", "Professional services", "Live in-person events" | [S50] https://docs.stripe.com/payments/managed-payments/eligibility |

Conclusion: reselling a registrar's wholesale API to end customers is not on any Stripe list, so it is allowed in principle subject to account review. Reselling a service is permitted when there is "added benefit to the buyer"; Mosshatch's vault, creature UX, scoped agent tokens and DNS tooling are the documented value-add and should be described in the Stripe application and on the site. Stripe publishes no statement specific to registrars (unverified).

## 7. Reserves and new-account treatment

| Claim | Exact quote | Source |
|---|---|---|
| Reserves are risk-based, no fixed new-account percentage published | "The size of a reserve is determined based on the level of risk associated with any business ... industry conditions, payment activity, dispute rate, refund rate, and financial stability" | [S15] https://support.stripe.com/questions/reserves-frequently-asked-questions |
| Triggers | "The business belongs to an industry with longer-than-average delivery windows" ; "The account has elevated dispute activity" ; "The account shows an unexplainable sharp increase in processing volume" | [S15] |
| Two types | "Stripe uses two different types of reserves: fixed and rolling." Example in Stripe's docs uses a 25% reserve, 30-day rolling window | [S15]; [S51] https://support.stripe.com/topics/reserves |
| Reserve can be indefinite in rare cases; reviewed before expiry | "In some rare cases, a reserve may be required indefinitely" | [S15] |
| Contract basis | "Where permitted in the Service Terms, Stripe may establish a Reserve ... User ... is not entitled to draw funds from any Reserve." (Financial Services Terms 3.3) | [S43] |
| Initial holding period | "Stripe may impose an additional holding period before making the initial settlement to a User Bank Account." (Stripe Payments terms 4.3(a)) | [S43] |
| First payout timing | "Stripe typically schedules your initial payout to complete within 7-14 days, depending on your industry, country of operation, and risk level." | [S16] |
| Payout availability delays favour new accounts | "Payout availability delays are most likely to be used on new Stripe accounts or those experiencing a sudden increase in risky transactions." ; "The payout for this charge will automatically be released 14 days from the notification date." | [S17] |
| Risk review inputs | "how far in advance your customers buy your products/services, and the reputation or history of your business" | [S52] https://support.stripe.com/questions/business-risk-level-considerations-and-evaluation |
| Reserve funding by deduction from balance or bank debit | "using funds that a Stripe Entity owes to any User Entity ... or debiting the User Bank Accounts." | [S43] |

Stripe's Service Terms sections were modified 2026-09-28 (one day before this research); a diff against the prior version was not performed (unverified what changed).

## 8. Stripe fee-schedule changes announced or visible for 2026

| Change | Detail | Source | Status |
|---|---|---|---|
| Headline card rates | No change found: 2.9% + 30¢, +1.5% intl, +1% FX. The public pricing-announcements page lists only 2024 items | [S1]; [S53] https://support.stripe.com/questions/stripe-pricing-announcements | Verified no public 2026 announcement; dashboard legal notices are account-specific and unreadable here |
| Dispute counter fee | New $15 counter fee from disputes initiated after 2025-06-17, returned on win | [S35] | Verified (2025, still current) |
| Smart Disputes | 30% of disputed amount on wins | [S1] | Verified |
| Radar restructure | Radar Lite (free), Standard ($0.05/screened), Plus, Pro; Radar docs: "On average, businesses block 42% more fraud on Standard compared to Lite." Blog dated May 27, 2026 announced new Radar capabilities | [S3], [S32], [S54] https://stripe.com/blog/expanding-stripe-radar-to-protect-more-of-your-business | Tiers verified; migration trial "through January 22, 2027" only in secondary sources [S33] |
| Tax plans | Tax Basic (0.5% / $0.50) and Tax Complete ($90+/month); subscription policy "Last updated: July 1, 2026" | [S4], [S55] https://support.stripe.com/questions/stripe-billing-and-tax-subscription-pricing-and-cancellation-terms | Verified |
| Managed Payments | 3.5% add-on; one-time payments now supported | [S1], [S37] | Verified |
| Stablecoins | 0.8% promotional through January 1, 2027, then +0.2% | "Promotional rate through January 1, 2027; + 0.2% thereafter" [S1] | Verified (not used by Mosshatch) |
| Shared Payment Tokens | $0.15 per SPT issued | "Use a secure payment primitive that helps agents facilitate purchases on behalf of customers. $0.15 per SPT issued" [S1] | Verified; relevant to the AI-agent roadmap only |
| Service Terms | Multiple sections "Last modified: September 28, 2026" | [S43], [S13] | Not diffed |

## 9. Merchant-of-record comparison (reference only)

| Provider | Fee (verified) | Dispute / int'l | Domain names? | Source |
|---|---|---|---|---|
| Stripe Managed Payments | +3.5% on top of Payments fees (so 6.4% + 30¢ for domestic cards) | Standard dispute fees may apply; MP includes dispute handling for eligible disputes | Not addressed; categories are digital products such as "website hosting" | [S1], [S37], [S50] |
| Paddle | "5% + 50¢ per Checkout transaction"; "If you're selling products under $10 or require invoicing contact us for custom pricing" | Fraud and chargeback protection in headline price | Not listed. Paddle "is built to serve software companies"; prohibits "resale of any product without a valid reseller certificate" and "Any product or service that enables non-Paddle Sellers to sell products and services to customers" | [S18] https://www.paddle.com/pricing ; [S19] https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle |
| Lemon Squeezy | "5% + 50¢" per transaction; +1.5% international, +1.5% PayPal, +0.5% subscriptions; sub-$10 products need custom pricing; payouts free to US banks, 1% outside US | not stated in the fetched pages | Not listed. Prohibits "Services of any kind" and "Any products restricted by our payment processing partners"; "we allow selling of digital goods that can be fulfilled through Lemon Squeezy's website" | [S20] https://docs.lemonsqueezy.com/help/getting-started/fees ; [S21] https://docs.lemonsqueezy.com/help/getting-started/prohibited-products ; [S22] https://www.lemonsqueezy.com/pricing |
| Polar | Starter "5% + 50¢"; Pro $20/mo "3.8% + 40¢"; Growth $100/mo "3.6% + 35¢"; Scale $400/mo "3.4% + 30¢"; +1.5% international cards; Early Member (orgs created before 2026-05-27) 4% + 40¢ | "Disputes cost $15 per dispute regardless of outcome"; Polar says networks penalise chargeback rates of "~0.7%+" and it may intervene or suspend accounts | Not listed. AUP allows "Software & SaaS" and digital products; prohibits "Reselling software licenses without authorization", "Marketplaces", "Regulated services or products" | [S23] https://polar.sh/docs/merchant-of-record/fees ; [S56] https://polar.sh/legal/acceptable-use-policy |

Comparison of total fees on the same orders (domestic/US card; +1.5% international shown separately where documented):

| Order P | Stripe direct (2.9% + 30¢) | Stripe + Managed Payments (6.4% + 30¢) | Paddle / LS / Polar Starter (5% + 50¢) | LS / Polar Starter with intl (+1.5%) | Polar Pro (3.8% + 40¢, excl. $20/mo) |
|---|---|---|---|---|---|
| $10 | $0.59 | $0.94 | $1.00 | $1.15 | $0.78 |
| $15 | $0.74 | $1.26 | $1.25 | $1.48 | $0.97 |
| $25 | $1.03 | $1.90 | $1.75 | $2.13 | $1.35 |
| $60 | $2.04 | $4.14 | $3.50 | $4.40 | $2.68 |
| $150 | $4.65 | $9.90 | $8.00 | $10.25 | $6.10 |

Reading: an MoR costs roughly 1.5-2x direct Stripe on these order sizes, buys global tax handling, and none of the four documents that domain registrations are accepted; every MoR page restricts the catalog to software and digital products delivered immediately. Whether a domain registration is permitted at Paddle, Lemon Squeezy or Polar is unverified (no explicit rule found; would need written confirmation).

## 10. Design implications

1. The 30¢ fixed fee is 3% of a $10 order: any flat-fee model must satisfy `F - fee(W+F) > 0`; pricing examples: net-to-Mosshatch shrinks by 5.90% at $10 versus 3.10% at $150.
2. Use Checkout Sessions with automatic tax (0.5%, registered states only), never the tax API (`$0.50`, equal to 5% of a $10 order), until volume justifies a subscription plan.
3. Authorize first, capture after the registrar API confirms (`payment_intent_data[capture_method]=manual`, 7-day window): a cancelled authorization costs nothing and is not reported as fraud; a captured-then-refunded fraudulent charge still feeds Visa's fraud counts and still costs the fee.
4. Keep launch pricing USD-only. Foreign-currency presentment adds 1% unless Adaptive Pricing is on, where the merchant pays 0% extra and the customer pays 2-4%.
5. Never counter low-value disputes by default: countering a $10-$25 order risks $30 for a $10-$25 principal; the $15 received fee is sunk either way. Refund early fraud warnings on charges at or below roughly the $15 dispute fee, knowing the EFW still counts toward VAMP.
6. Use one static statement descriptor prefix across all descriptors so Visa aggregates them; monitor Stripe's VAMP dashboard; keep the dispute rate under 0.75%.
7. Disclose the reseller model in the Stripe application, describe the value-add, and do not let any third party (including the registrar) receive settlement proceeds. If a prepaid-balance or credits feature for agents is ever planned, note it is a Restricted category ("Sale of stored value or credits").
8. Plan working capital for a 7-14 day first payout, possible 14-day payout availability delays and a possible reserve, plus negative-balance bank debits if refunds outrun sales.
9. Store passkey approval, agent-token scope and device or IP evidence per order as dispute evidence (inference: strong evidence for "unauthorized" claims).
10. Stay with direct Stripe rather than an MoR unless multi-state sales-tax burden outweighs the extra ~1.5-3.5 points of fees; none of the MoRs confirms domain-name acceptance.

## 11. Unverified, conflicts and needs-a-professional

Unverified (with reasons):
- Stripe's explicit position on domain registrars or resale: not on any list; no statement found. Confirm at account review or with Stripe support.
- Visa's $8 VAMP fee: only secondary sources (MRC, Chargeflow); the Visa fact sheet does not state fee amounts.
- Sift's schedule (1.5% on 2025-10-01, 0.9% on 2026-01-01, $10 fee) conflicts with Visa's fact sheet (220 bps to 150 bps on 2026-04-01): unreconciled, Visa document preferred.
- Stripe's "Non-compliant" merchant tier (0.5%, count 5) appears in Stripe docs only, not in Visa's fact sheet.
- Mastercard ECP thresholds in Mastercard's own rulebook: blocked by bot protection (403), used Stripe's documentation instead.
- Radar migration trial to January 22, 2027 and Plus/Pro PAYG rates ($0.07/$0.09): secondary sources only (Corgi Labs article, HN thread).
- Whether Stripe rounds the fee total or components; whether Tax Basic 0.5% applies to a tax-inclusive total.
- Whether the 1.5% international-card fee still applies with Adaptive Pricing (docs say the merchant pays "0%" additional for Adaptive Pricing; the intl-card fee is a card-issuer-country fee and is assumed to remain).
- Numeric new-account reserve or holding policy: none published.
- Paddle, Lemon Squeezy, Polar and Managed Payments acceptance of domain names.
- Typical digital-goods dispute rate: vendor figures conflict (0.54% vs 0.6-1.2% vs 3.62%).
- What changed in Stripe's 2026-09-28 terms update.
- Registry/registrar recovery of wholesale cost on refunds (Add Grace Period) and sales-tax treatment of domain registrations are out of scope for this dossier.

Needs a lawyer or accountant:
- Sales-tax nexus and taxability of domain registrations by state before enabling Stripe Tax registrations.
- Whether Mosshatch is the seller of record versus agent relative to the registrar (payment-facilitation restriction, registrant agreement, ICANN reseller terms).
- Any prepaid balance, credits or agent wallet (stored value, money transmission).
- Dispute-liability and refund allocation clauses in the wholesale registrar contract.

## 12. Source index (all accessed 2026-09-29)

- S1 https://stripe.com/pricing (US)
- S2 https://stripe.com/pricing/local-payment-methods
- S3 https://stripe.com/radar/pricing (rendered with Chromium; "Show pricing" expanded)
- S4 https://stripe.com/tax/pricing (rendered)
- S5 https://stripe.com/payments/payment-methods (fetched; method index only, rates taken from S2)
- S6, S7 (alias numbers, unused; see S27 and S40)
- S8 https://docs.stripe.com/disputes/how-disputes-work
- S9 https://docs.stripe.com/disputes/monitoring-programs
- S10 https://corporate.visa.com/content/dam/VCOM/corporate/visa-perspectives/security-and-trust/documents/visa-acquirer-monitoring-program-fact-sheet-2025.pdf
- S11 (alias number, unused; see S41)
- S12 https://stripe.com/legal/restricted-businesses (Last updated: 2026-09-22)
- S13 https://stripe.com/legal/ssa (Last modified: September 28, 2026)
- S14 (alias number, unused; see S16)
- S15 https://support.stripe.com/questions/reserves-frequently-asked-questions
- S16 https://docs.stripe.com/payouts
- S17 https://support.stripe.com/questions/payout-availability-delays
- S18 https://www.paddle.com/pricing
- S19 https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle
- S20 https://docs.lemonsqueezy.com/help/getting-started/fees
- S21 https://docs.lemonsqueezy.com/help/getting-started/prohibited-products
- S22 https://www.lemonsqueezy.com/pricing
- S23 https://polar.sh/docs/merchant-of-record/fees
- S24 https://stripe.com/blog/changelog (no rate changes found in the listed entries)
- S25 https://support.stripe.com/questions/understanding-stripe-s-fee-structure-for-international-and-refunded-payments
- S26 https://support.stripe.com/questions/pricing-for-apple-pay-with-stripe
- S27 https://support.stripe.com/questions/pricing-for-google-pay-with-stripe
- S28 https://support.stripe.com/questions/adaptive-pricing
- S29 https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing
- S30 https://docs.stripe.com/currencies
- S31 https://support.stripe.com/questions/rounding-rules-for-stripe-fees
- S32 https://docs.stripe.com/radar/how-radar-works
- S33 https://www.corgilabs.ai/insights/stripe-radar-pricing-change (secondary)
- S34 https://support.stripe.com/questions/understanding-stripe-tax-pricing
- S35 https://support.stripe.com/questions/june-2025-pricing-updates-for-disputes
- S36 https://support.stripe.com/questions/june-2024-pricing-update-for-instant-payouts-for-businesses-in-the-united-states
- S37 https://support.stripe.com/questions/managed-payments-pricing
- S38 https://support.stripe.com/questions/understanding-fees-for-refunded-payments
- S39 https://docs.stripe.com/refunds
- S40 https://support.stripe.com/questions/dispute-fees-faq
- S41 https://docs.stripe.com/disputes/measuring
- S42 https://docs.stripe.com/payments/place-a-hold-on-a-payment-method
- S43 https://stripe.com/legal/ssa-service-terms
- S44 https://www.chargeflow.io/blog/vamp-visa-acquirer-monitoring-program (secondary)
- S45 https://merchantriskcouncil.org/learning/resource-center/member-news/blog/2026/stricter-vamp-ratio-thresholds-are-now-in-effect-heres-how-to-stay-compliant (secondary, trade body)
- S46 https://sift.com/index-reports-disputes-q4-2025/ (secondary; conflicting VAMP schedule)
- S47 https://www.chargeflow.io/blog/chargeback-statistics-trends-costs-solutions (secondary)
- S48 https://paycompass.com/blog/chargeback-rates-by-industry/ (secondary)
- S49 https://support.stripe.com/questions/prohibited-and-restricted-businesses-list-faqs
- S50 https://docs.stripe.com/payments/managed-payments/eligibility
- S51 https://support.stripe.com/topics/reserves
- S52 https://support.stripe.com/questions/business-risk-level-considerations-and-evaluation
- S53 https://support.stripe.com/questions/stripe-pricing-announcements
- S54 https://stripe.com/blog/expanding-stripe-radar-to-protect-more-of-your-business
- S55 https://support.stripe.com/questions/stripe-billing-and-tax-subscription-pricing-and-cancellation-terms
- S56 https://polar.sh/legal/acceptable-use-policy

Blocked or failed fetches: Mastercard Security Rules PDF and ECP e-learning page (HTTP 403 Akamai bot protection, not an egress policy block); polar.sh/pricing and stripe.com/checkout/pricing (404); WebSearch quota exhausted after 200 calls, so no further searches were possible.
