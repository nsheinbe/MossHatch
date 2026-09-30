# Cheaper upstreams than OpenSRS: research of 2026-09-30

Prepared 2026-09-30 for the Mosshatch plan. Research only: no account was opened, nothing was paid, and no provider API was called except Internet.bs's public test host with its published test credentials. Every price was read on 2026-09-30 from the provider's own pricing page, the price feed behind that page, or its contract, unless a line says otherwise. All amounts are USD unless marked EUR. This file does not change `docs/PLAN.md`; section 2b lists what the plan and the dossiers should correct.

Method: four parallel sweeps (EU wholesale registrars, US low-cost registrars, large reseller programs, other routes including own accreditation). A second researcher then re-fetched the load-bearing prices and clauses of the strongest candidates to try to refute them. Raw captures are in the session scratchpad (`/tmp/claude-0/-home-user-MossHatch/ad0e8470-2706-5667-8cc2-5a06140ce3ab/scratchpad/`, subfolders `r/` and `up/`); like the earlier `working-directory/` paths, they are not kept.

**Status marks used on every number.**
- **confirmed**: read on the provider's own page, feed or contract on 2026-09-30 and reproduced by the second researcher the same day.
- **corrected**: the second researcher changed or qualified the first reading. The corrected value is shown.
- **sweep only**: read on a primary source on 2026-09-30 by one researcher and not re-checked.
- **UNVERIFIED**: the page was blocked, behind a login or not published, or the figure comes from a third party.
- **inferred**: arithmetic from published figures, not a published price.

The baseline and the floor:
- OpenSRS Essential `.com` is 14.50 today and 15.25 from 2026-11-01. The increase is announced on OpenSRS's price-changes page (confirmed).
- The `.com` cost floor is Verisign's registry fee plus the ICANN fee: 10.26 + 0.20 = 10.46 today, and 10.97 + 0.20 = 11.17 from 2026-11-01. The 10.97 fee comes from Verisign's own SEC release and ICANN's published fee schedule (confirmed).

## 1. Answer

**Yes. One upstream is materially cheaper for `.com` and fits Mosshatch's model, but only if some contract conditions are cleared first. A second is a smaller saving with the cleanest contract. A third is cheap, but its contract blocks Mosshatch's own customer agreement until that is resolved in writing.**

**1. Openprovider (Hosting Concepts B.V. d/b/a Registrar.eu, Rotterdam, IANA 1647), paid Membership.**
- `.com` prices for members are 10.46 to register, renew or transfer (confirmed). That is the cost floor exactly. Non-members pay 11.98 to register and 16.98 to renew (confirmed).
- No price after 2026-11-01 is published, and the price feed carries no scheduled prices. Expect about **11.17** if the Verisign increase is passed through at cost (inferred, +0.71).
- The membership adds to that: 49.99 a year covers 100 registrations, renewals or transfers (Basic S), 199.99 covers 500 (Basic M), and 499.99 covers 2,000 (Basic L) (confirmed). That is 0.50, 0.40 or 0.25 per operation when the whole quota is used, and more when it is not. The effective `.com` cost after November is therefore about 11.42 to 11.67, against 15.25 at OpenSRS.
- Break-even against OpenSRS: 49.99 / (15.25 − 11.17) = 12.3, so 13 or more `.com` operations a year (confirmed by the second researcher). Below that volume, or if the membership lapses (renewals then cost 16.98), OpenSRS is cheaper.
- It is also the cheapest verified source for the other five extensions (confirmed): `.dev` 12.20, `.app` 14.20, `.io` 50.00, `.studio` 31.20 and `.ai` 80.00 a year (160.00 for the 2-year minimum). The `.studio` price probably rises to about 40.20 after the registry increase on 2026-10-06 (inferred).
- Resale fit:
  - Resale is explicit. T&C Art. 4: "The Reseller is free to determine which products and services it provides to its Clients at which price, within the limitations set out by Openprovider in the offer."
  - Mosshatch's own customer terms are allowed but "may not conflict with" Openprovider's terms.
  - It has a REST API and a self-serve sandbox.
  - Blocking conditions are in section 4.

**2. Netim (NETIM SAS, Lille), free Reseller Program.**
- A new account starts at Bronze: `.com` 12.79 to register and 12.79 to renew (confirmed). Silver is 12.21 and Gold 11.63. Transfer is 11.63 at every tier.
- No price after November is published. Expect about **13.50** at Bronze (inferred): CGU-REV 6.5 says Netim will "pass on any unexpected increase initiated by one of its suppliers".
- Whether the ICANN fee is included is not stated (UNVERIFIED). If it is added on top, the price is 13.70.
- There is no membership or other fixed fee. The saving against OpenSRS is 1.75 per `.com`-year.
- It has a dedicated reseller contract (CGU-REV 1.7, 2026-08-11). The contract makes Mosshatch pass Netim's requirements down to its customers, but no clause makes Netim's terms prevail over Mosshatch's customer agreement. The reseller's indemnity and Netim's liability are both capped at 12 months of fees.
- There is no registrant-facing web interface to switch off.
- At Bronze, `.dev` (18.30) and `.io` (64.00) cost more than at OpenSRS (17 and 60).

**3. Dynadot / Global Domain Group (IANA 3956), free Reseller Program.**
- `.com` is 10.88 to register and renew, ICANN fee included (confirmed for today). It must rise to at least 11.17 when Verisign's does; nothing has been announced. Expect about **11.59** (inferred, +0.71).
- Global Domain Group publishes no prices, so the price for an account opened there, the route the plan would need, is UNVERIFIED.
- The contract blocks the model until it is clarified in writing. Dynadot ToU s3.1(d), version 2026-08-18, requires that "the terms of this Agreement shall prevail over the terms of the agreement between You and that third party".

Nothing else found is both cheaper and usable today. NameSilo is 11.05 today and must rise (its reseller terms are unreadable). DomainNameAPI is 11.31 to register and 11.51 to renew, but its contracting company is in Northern Cyprus and its contract has many problems. The rest fail on the contract or the API: Sav.com's API cannot register, GoDaddy resells only to business customers, and Internet.bs's price for a new account is unpublished. The OpenSRS Advanced tier (14.25 after November) needs 100 new registrations in a calendar year and would apply from 1 April at the earliest. Details are in section 2.

### Price and expected margin for `.com` after 2026-11-01

Price = upstream cost + flat fee F. Margins come from the plan's model (`docs/research/unit-economics.py`), run unchanged with only the wholesale price replaced. The model's assumptions:
- Stripe 2.9% + 0.30 on domestic cards, +1.5% on the 15% of orders paid with international cards.
- Refunds on 3% of first orders and 0.5% of renewals, with 90% of the `.com` wholesale recovered upstream on a first-order refund.
- Failed registrations on 1% of first orders.
- Disputes on 0.5% of first orders and 1.0% of renewals: USD 15 fee when received, USD 15 when countered, 70% lost.
- Support cost of 1.50 per refund, 5 per dispute and 2 per failure.

Figures are USD per domain-year.

| Upstream and `.com` cost used | Price at F = 4 / 3 / 2 | Expected contribution, first order, F = 4 / 3 / 2 | Expected contribution, renewal, F = 4 / 3 / 2 |
|---|---|---|---|
| OpenSRS Essential, 15.25 (announced) | 19.25 / 18.25 / 17.25 | 2.62 / 1.69 / 0.77 | 2.55 / 1.60 / 0.64 |
| Openprovider member, 11.17 (inferred), before membership | 15.17 / 14.17 / 13.17 | 2.77 / 1.84 / 0.92 | 2.73 / 1.77 / 0.82 |
| same, after Basic S fully used (−0.50 per operation) | same | **2.27 / 1.34 / 0.42** | **2.23 / 1.27 / 0.32** |
| same, after Basic L fully used (−0.25 per operation) | same | 2.52 / 1.59 / 0.67 | 2.48 / 1.52 / 0.57 |
| Netim Bronze, 13.50 (inferred) | 17.50 / 16.50 / 15.50 | 2.68 / 1.76 / 0.83 | 2.63 / 1.67 / 0.72 |
| Netim Bronze if the ICANN fee is extra, 13.70 (inferred) | 17.70 / 16.70 / 15.70 | 2.67 / 1.75 / 0.82 | 2.62 / 1.67 / 0.71 |
| Dynadot/GDG, 11.59 (inferred) | 15.59 / 14.59 / 13.59 | 2.75 / 1.83 / 0.90 | 2.71 / 1.76 / 0.80 |

Before 2026-11-01, Openprovider's prices would be 14.46, 13.46 and 12.46 (cost 10.46, confirmed), with margins before membership of 2.80, 1.87 and 0.95.

**Worked arithmetic: Openprovider, F = 4, first order, cost W = 11.17.**
- Order total T = 11.17 + 4.00 = 15.17.
- Stripe fee on a domestic card: 0.029 × 15.17 + 0.30 = 0.73993. On an international card: 0.73993 + 0.015 × 15.17 = 0.96748. Blended at 15% international: 0.85 × 0.73993 + 0.15 × 0.96748 = 0.77406.
- A clean order (95.5% of orders = 1 − 3% refunds − 0.5% disputes − 1% failures) earns 4.00 − 0.77406 = 3.22594.
- A refund (3%) costs −0.77406 − (1 − 0.90) × 11.17 − 1.50 = −3.39106.
- A failed registration (1%) costs −2.00.
- A dispute (0.5%) costs 0.7 × (−11.17 − 0.77406 − 15 − 15 − 5) + 0.3 × (4.00 − 0.77406 − 15 − 5) = 0.7 × (−46.94406) + 0.3 × (−16.77406) = −37.89306.
- Expected contribution: 0.955 × 3.22594 + 0.03 × (−3.39106) + 0.01 × (−2.00) + 0.005 × (−37.89306) = 3.08077 − 0.10173 − 0.02000 − 0.18947 = **2.77**.
- After the membership: 2.77 − 49.99 / 100 = **2.27**.

The renewal case uses 0.5% refunds with no upstream recovery, 1.0% disputes and no failures: 0.985 × 3.22594 + 0.005 × (−0.77406 − 11.17 − 1.50) + 0.01 × (−37.89306) = 3.17755 − 0.06722 − 0.37893 = 2.73, and 2.23 after the membership. The other cells come from the same script (a copy was run in the scratchpad; the repository file was not edited).

**What the table means.**
- Because the price is cost plus a flat fee, a cheaper upstream lowers the customer's price; it hardly raises the margin. At the same fee the margin moves only through a smaller Stripe percentage and a smaller loss on disputes: +0.15 at F = 4 for Openprovider against OpenSRS.
- Openprovider's membership takes more than that back. At Basic S the margin at F = 4 is 2.27 against OpenSRS's 2.62, but the customer pays 15.17 instead of 19.25.
- The case for switching is therefore about price and positioning, not margin. At F = 4, Mosshatch's `.com` would cost 15.17 instead of 19.25.
- The plan's test is at least 1.50 a domain-year on a first order (PLAN 4.2). F = 3 passes at Netim (1.76) and Dynadot (1.83). At Openprovider it passes only when the membership costs 0.34 or less per operation, which means Basic L used for at least about 1,450 operations a year (499.99 / 0.344). F = 2 fails everywhere.
- The membership can also be counted as a fixed cost instead: Basic S is 4.17 a month, next to the plan's 201 to 204. The margin is then 2.77 at F = 4, and the break-even volumes in PLAN 4.2 barely move.
- If the membership is shown to the customer as part of "registrar cost" (cost 11.67), the price at F = 4 is 15.67 and the margin is 2.75.

**Two risks the table leaves out.**
- **Funding the Openprovider balance.** A USD account cannot be funded by wire: wire transfer is "only available for EU* resellers ... AND currency set to EURO". A US reseller would top up by card, PayPal (at most EUR 15,000 a payment) or crypto, and "Transaction costs may be charged"; the amount is unpublished (UNVERIFIED).
  - If card funding costs what it costs at OpenSRS (+3.09% of wholesale), the margin at F = 4 falls from 2.77 to 2.43 (first order) and from 2.73 to 2.39 (renewal), before the membership. This is an illustration: Openprovider's card fee is unknown.
  - A EUR account can be wired, but it carries an exchange-rate markup (T&C Art. 12) and currency risk.
- **Netim billing currency.** Netim's reseller billing appears to be in EUR only (a search snippet of its blocked support site; UNVERIFIED). USD prices would then be charged in EUR at the ECB rate, and Mosshatch would carry the EUR/USD risk.

### Other extensions at Openprovider, under the plan's three fee levels (D-003)

D-003 sets the fee by the extension's standard wholesale: USD 4 under 50 a year, USD 9 from 50 to under 100, and USD 10 from 100. At Openprovider's member prices, `.studio` (about 40.20 after 2026-10-06, inferred) moves to the USD 4 level, and `.ai` (80.00) moves to the USD 9 level. Results from the same model, before membership:

| Extension | Openprovider cost / OpenSRS cost | Fee | Customer price, Openprovider / OpenSRS | Contribution, first order / renewal (Openprovider) | OpenSRS first order at its own D-003 fee |
|---|---|---|---|---|---|
| `.dev` | 12.20 / 17.00 | 4 | 16.20 / 21.00 | 2.73 / 2.69 | 2.55 |
| `.app` | 14.20 / 21.00 | 4 | 18.20 / 25.00 | 2.66 / 2.60 | 2.40 |
| `.studio` | about 40.20 (inferred) / 51.00 | 4 (OpenSRS 9) | 44.20 / 60.00 | 1.68 / 1.48 | 5.91 |
| `.io` | 50.00 / 60.00 | 9 | 59.00 / 69.00 | 4.59 / 5.84 | 3.95 |
| `.ai` (2-year minimum) | 80.00 / 111.00 a year | 9 (OpenSRS 10) | 178.00 / 242.00 for two years | 2.92 / 4.84 | 1.85 |

Two results need care:
- `.studio` at the USD 4 level earns 1.48 on renewal, just under the 1.50 test.
- Whether a 2-year `.ai` registration uses one or two membership operations is UNVERIFIED.

## 2. Comparison

Prices are USD per year; "reg / renew" is the 1-year price. "After 11-01" is the `.com` price from 2026-11-01. The "other TLDs" column gives renewal-basis prices for `.dev` / `.app` / `.io` / `.studio` / `.ai`.

| Provider | Program | Resale fit for Mosshatch | `.com` reg / renew | Other TLDs (renew basis) | Fixed costs | API / sandbox | Status | Red flags |
|---|---|---|---|---|---|---|---|---|
| **OpenSRS Essential** (Tucows), the plan's primary | MSA; self-serve; USD 95 activation credited | Yes, explicit (MSA) | 14.50 / 14.50; after 11-01 **15.25** (announced) | 17 / 21 / 60 / 42 (51 from 2026-10-06) / 111 (2-year minimum) | USD 95, credited; prepaid; 3% card top-up fee | XML; Horizon sandbox; HMAC webhooks | confirmed | Uncapped indemnity (MSA 22.1); auction from day 41 to 45; see PLAN 4.1 |
| **OpenSRS Advanced** | Same MSA. Needs USD 2,000 spend and 100 new registrations or transfers in a calendar year. Reviewed in January, applies from 1 April | Yes | 13.50 / 13.50; after 11-01 14.25 (announced) | 16 / 20 / 59 / 40 (49 from 10-06) / 107 | As Essential | As Essential | confirmed | Earliest date for an account opened now is 2027-04-01. Renewals do not count toward the 100. A mid-year review is discretionary |
| **Openprovider** Membership | Paid membership on a free, self-serve account | Yes (Art. 4). Own prices and own terms, which must not conflict with Openprovider's. Art. 35 "mutatis mutandis" needs counsel | Member 10.46 / 10.46; non-member 11.98 / 16.98; after 11-01 about 11.17 (inferred, not published) | 12.20 / 14.20 / 50.00 / 31.20 (about 40.20 after 10-06, inferred) / 80.00 (160.00 per 2 years) | Basic S 49.99 / 100 operations, M 199.99 / 500, L 499.99 / 2,000, Professional S 999.99 / 5,000, Professional M 1,999 / 10,000. Cannot be cancelled. A lapse means non-member prices. EUR 25 to refund the balance | REST `/v1` (OpenAPI); self-serve sandbox; bearer token; rate limits unpublished; no idempotency key or webhooks in the spec | confirmed (two independent re-fetches) | May take over Mosshatch's customers after termination for breach (Art. 4). Expired names parked with ads, then deleted, auctioned or transferred after 40 days (Art. 11). Price changes "effective immediately" and +4% allowed each 1 January (Art. 12). Fines policy at EUR 80 or 50 an hour. Liability capped at EUR 10,000. Dutch law |
| **Netim** Reseller Program | Free; self-serve; CGU-REV 1.7 (2026-08-11) | Yes: dedicated reseller contract; pass-down duties but no "prevail" clause | Bronze 12.79 / 12.79 (Silver 12.21, Gold 11.63); after 11-01 about 13.50 Bronze (inferred); ICANN fee inclusion UNVERIFIED | Bronze 18.30 / 19.60 / 64.00 / 40.60 / 88.00 (176 per 2 years); Gold 15.90 / 16.80 / 54.00 / 34.40 / 83.00 | None. Prepaid. EUR 30 to refund the balance. Billing probably EUR only (UNVERIFIED). Gold deposit threshold unpublished | SOAP 2.0 primary, REST in beta; OTE exists but its docs are bot-blocked (UNVERIFIED); API use must be "proportionate to the portfolio" | confirmed (with corrections, see 2b) | No resale at a loss (6.5). Change of control needs consent (15). May return Mosshatch to customer prices if activity is "clearly insufficient" (7.5). Prices may change "without prior notice" (CG-ND 4). French law; GDPR joint controllers |
| **Dynadot / GDG** | Free; application-gated; must be a new account | Blocked until written confirmation (ToU s3.1(a), (c), (d)); the GDG ToS has no "prevail" clause | 10.88 / 10.88 today; must rise to at least 11.17; about 11.59 (inferred), not announced | 12.50 / 14.50 / 53.50 / 43.02 from 2026-10-06 / 85.60 (171.20 per 2 years) | None; prepaid; USD 5 minimum, non-refundable | REST v2 (beta-labelled) and v1; sandbox; `.dev` and `.app` missing from the API TLD list | Price confirmed; contract fit not confirmed | May move customer accounts to Dynadot without notice (Reseller Agreement). Gave 7 days' notice of the 2026-10-06 rise. GDG publishes no prices |
| **NameSilo** | Click-through Reseller Manager plus the free Discount Program | UNVERIFIED (reseller terms are shown only after login) | 11.05 / 11.05 (tier 0+, paid from account funds); must rise before 11-01; about 11.76 (inferred) | 14.89 / 16.89 / 69.89 / 40.89 / 94.99 | None; USD 50 minimum per top-up | GET API with the key in the URL; no idempotency key or webhooks; sandbox on request | Price confirmed; resale UNVERIFIED | One account holds every customer. Paying with a card `payment_id` gives the retail price (17.29). 30-day termination without cause |
| **DomainNameAPI** (contract with Atakonline, Northern Cyprus; registrar Atak Domain, IANA 1601) | Self-serve per marketing; the ToU requires "reseller approval" | Permitted in principle: Mosshatch must have its own Customer Agreement (RA 3.9). Sub-reselling is prohibited (RA 11.7) | 11.31 / 11.51 at the Reseller tier (Premium 10.91 / 11.11 with USD 1,000 held); after 11-01 not published; ICANN fee UNVERIFIED | Reseller tier: .dev 20.43 and .app 23.99 (register or renew not recorded); .io 44.99 register / 64.90 renew; .studio 16.51 / 38.77; .ai 199.80 (basis unclear) | None, but top-up fees: 2% card, 3.5% Stripe, 6.3% + 0.30 PayPal | REST; OT&E Swagger | Price confirmed; corrected on terms | Counterparty outside the US and EU. Auto-renews unless written notice 3 months ahead (ToU 5.5). Changes take effect on publication. The English contract contains untranslated Turkish. The refund clauses contradict each other |
| **Internet.bs** (CentralNic group) | FAQ: "All our accounts are automatically enabled for reselling" | UNVERIFIED (terms blocked) | Member tier (a new account): UNVERIFIED. Insider tier (more than 500 domains), test host: 11.30 / 11.59 | Insider: 14.27 / 15.71 / 51.24 / 34.67 / 100.80 | None; prepaid | Public sandbox, exercised; 60 + N calls a minute; "not intended for ... High-frequency domain availability checking" | corrected (Member price not established) | Terms, price page and API reference all blocked. Bahamas company |
| **Realtime Register** GO!ORANGE | Self-serve; resale "upon separate request" | Probably (4.2, own prices); the Reseller Agreement is behind a login | UNVERIFIED (behind a login); claims "cost price" | UNVERIFIED | USD 5 a month up to 100 domains; +0.03 per domain a month up to 1,000 | REST; OT&E; HMAC webhooks; 1 request a second for bulk work | sweep only | Balance forfeited on termination (10.7). Liability capped at two weeks of payments (9.3) |
| **Sav.com** | Reseller Agreement via support | No: customers must accept Sav's DNRA and UTOS, and the documented API cannot register or renew | 10.87 / 10.15 (renewal is below the registry fee alone) | 12.68 / 14.76 / 51.99 / 32.44 / 83.19 | None | 12 GET endpoints; no register, renew or availability | Price confirmed; fit refuted | "We therefore take ownership of expired domains". Prices change "with or without notice". Two versions of the reseller text differ |
| **GoDaddy API Reseller** | "select businesses"; certification test; annual licence fee | No for a consumer shop: "solely to business customers" (revision of 2/2/2026) | 10.69 on an undated help page; UNVERIFIED as a buy rate (see 2b) | Not in the wholesale table | Licence fee amount UNVERIFIED; prepaid by wire | v3 has no renew, transfer or auth-code endpoint; v1/v2 credential deprecated in 2026 | corrected; terms read from Wayback copies (live 403) | Must "transition all of your customers" to GoDaddy on termination |
| **eNom** (Tucows) | Self-serve | Yes | Same as OpenSRS at every tier and date | Same as OpenSRS | USD 50 enrolment (list 195); 5% card fee | XML; static IP required even in test | sweep only | No advantage over OpenSRS |
| **Name.com** | Self-serve API reseller | Yes, but "the Name.com Registration Agreement will control" | 12.99 first year (list 17.99) / 19.99, then 21.99 from 2026-10-31 | 22.99 / 26.99 / 79.99 / 58.99 (74.99 from 10-06) / 99.99 | None | Best API of the group (idempotency, webhooks, sandbox) | sweep only | Retail cost basis; not cheaper |
| **CentralNic Reseller** (the plan's fallback) | Wholesale MSA and Reseller Schedule | Yes | Basic Plus 18.33; Pro Plus 16.12; Elite Plus (over 1,000 domains) 13.82 | None public after 2026-09-30 | EUR 75 prepay; account service fee not quantified | REST (OpenAPI); OT&E | sweep only | Cheaper than OpenSRS only above 1,000 domains |
| **InterNetX / AutoDNS** | Sales-led; individual contract | Probably; contract unpublished | Public list EUR 24.00; reseller price UNVERIFIED | Public EUR 45.20 / 50.40 / 171.00 / 59.00 / 256.00 | White-label Pro EUR 49.90 (US site USD 79.90) a month | JSON REST; sandbox via sales; 3 requests a second | sweep only | Only the German text binds. May lock end customers' sites if the reseller defaults |
| **Spaceship** | None (affiliate program only) | No program | UNVERIFIED (third-party 9.08 / 10.18) | UNVERIFIED | None | API; no sandbox | UNVERIFIED | Terms blocked |
| **ResellerClub** | Slab program | Per LogicBoxes template only | UNVERIFIED (site blocked) | UNVERIFIED | Archived 2025 slabs USD 25 to 2,999 | LogicBoxes API | UNVERIFIED | Cannot be costed without signing up |
| **101domain** | Closed to new applicants | n/a | Retail 14.99 / 19.99 | Retail 23.99 / 30.49 / 73.49 / 57.49 / 143.00 | n/a | New API cannot register | sweep only | Closed |
| **EuroDNS** | Contract via sales; price by quote | UNVERIFIED | Quote only; retail renewal EUR 21.00 (EUR 22 from 11-01) | Retail only | Unknown | XML; test server; IP allow-list required | sweep only | Only the French text binds |

Notes:
- OpenSRS Premium (USD 50,000 spend and 500 new registrations or transfers) is 12.50 for `.com`, 13.25 from 2026-11-01. Enterprise (USD 100,000 and 1,000) is 11.50, then 12.25. Both confirmed. Neither is reachable at launch volume.
- Cloudflare has no reseller product. Its "registrar-as-a-service" had not launched according to its API docs updated 2026-09-16 (sweep only).

### 2b. What the existing research got wrong or is now stale

Each item is ready to apply to `docs/PLAN.md` 4.1 or the named dossier.

1. **PLAN 4.1 says OpenSRS is "the only one of the researched candidates"** that combines a resale contract, published wholesale prices for all six extensions and a sandbox. That was true only of the providers screened. Openprovider and Netim meet all three at lower prices (confirmed) and were never screened. Neither were Realtime Register, InterNetX, DomainNameAPI and Sav.com.
2. **PLAN 4.1 calls Dynadot's `.com` 10.88 the lowest list price researched.** Openprovider's member price, 10.46, is lower and equals the floor. Dynadot's 10.88 and GoDaddy's 10.69 are both below the floor of 11.17 that applies from 2026-11-01, so neither can be a November price.
   - GoDaddy's wholesale help page is not a reliable buy rate. Wayback captures show it at 8.99 from 2021 to 2023-11, when Verisign's fee was already 9.59. It has shown 10.69 since 2024-05, unchanged through the 2024-09-01 step. The binding rate is the "Price Catalog" behind a login (corrected).
3. **Dynadot `.studio` renewal goes from 33.39 to 43.02 on 2026-10-06 at 17:00 UTC** (Dynadot post dated 2026-09-29; confirmed). PLAN 4.1 and the `dynadot_list` route in `unit-economics.py` still use 33.39, so the `.studio` rows for that route in `unit-economics-output.md` are stale.
4. **GoDaddy's terms are no longer unreadable.** Wayback copies of the Reseller Agreement (Last Revised 2/2/2026) restrict resale "solely to business customers", with no "personal, family, or household purposes". That rules GoDaddy out for Mosshatch. The 11/12/2024 revision had no such clause.
5. **The OpenSRS tier timing is not a conflict.** KB 201000063182 reconciles the two statements (confirmed):
   - placement holds for the calendar year;
   - the January review uses the previous January to December;
   - changes take effect on 1 April with at least 30 days' notice;
   - "Redemptions and renewals count toward total spend but not toward the transaction count";
   - a mid-year review is only a request.
   For an account opened in October 2026, Advanced pricing applies from 2027-04-01 at the earliest.
6. **OpenSRS promotion end dates are published, in eNom's feed** (the same Tucows price book): `.dev` 10 until 2026-12-31, `.app` 14 until 2026-12-01, `.io` 34 until 2026-12-31, all for registration only (sweep only; that OpenSRS uses the same dates is inferred).
7. **Internet.bs in PLAN 4.1 ("Other routes screened") and `reg-screen-others.md` §7:**
   - The prices quoted are the Insider tier, which needs more than 500 domains. They come from the test host, and only with `&version=2` does the price list say so (corrected).
   - Renewals are higher: `.com` 11.59, `.dev` 14.27, `.app` 15.71, `.io` 51.24, `.studio` 34.67, `.ai` 100.80.
   - Resale is supported only by a help-centre FAQ, not by a contract.
   - Internet.bs has been owned by CentralNic since 2014, the same group as the plan's fallback.
8. **`reg-namesilo.md`:**
   - `.com` 11.05 is "roughly 0.59 above cost" only until 2026-11-01; after that it is below the 11.17 floor, so an increase is certain.
   - The restore fee is published after all. NameSilo's own blog says "$75 at NameSilo only if the domain has actually entered the redemption period".
   - The 100+ tier has a `.com` registration promotion (8.75), which a new account cannot use.
   - An API order must not send a card `payment_id`, or it pays the retail 17.29 (confirmed).
9. **`reg-namecom.md` §5:** the TLD Price List docs say the account-level price includes "applicable rebates, promotions" and equals retail when there is no account pricing. The 12.99 first-year `.com` price therefore probably applies to API orders; only promo codes are unsupported (sweep only). Renewal is 19.99, then 21.99 from 2026-10-31.
10. **`reg-screen-others.md` §10 says escrow is "at your own cost".** That is misleading: the ICANN-designated agent (DENIC) is "at no charge to the registrar" (sweep only). The ICANN transaction fee, previously marked unverified, is 0.20 per transaction-year (ICANN FY27 budget).
11. **CentralNic's only non-`.com` public prices** (the `.app` and `.dev` promotion at 15.00) ended on 2026-09-30. From 2026-10-01 CentralNic has no public price for any launch extension other than `.com` (sweep only).
12. **`tld-registry-facts.md` at-cost floors are now corroborated.** The figures derived from Cloudflare (`.com` 10.46, `.dev` 12.20, `.app` 14.20, `.io` 50.00, `.studio` 31.20, `.ai` 80.00) equal Openprovider's published member prices exactly (confirmed). The `.studio` floor will be stale after 2026-10-06.
13. **OpenSRS's markup over cost is larger than PLAN 4.1 conveys.** Per year: `.com` +4.08 after November (15.25 − 11.17), `.dev` +4.80, `.app` +6.80, `.io` +10.00, `.studio` +10.80 (both before and after 10-06, inferred), `.ai` +31.00.
14. **The first sweep's summary was wrong on one point:** Netim is cheaper than OpenSRS on every extension only at Gold, which needs more than 1,000 services or an unpublished deposit. At Bronze, `.dev` (18.30 vs 17) and `.io` (64.00 vs 60) are dearer. The Netim grid opens with Gold pre-selected, so the first figures a visitor sees are Gold prices (corrected).
15. **`.com` price steps ahead** (sweep only; ICANN-published .com agreement):
   - The 2026-11-01 increase is the first of the four +7% steps that the .com agreement allows in the final four Pricing Years of each six-year period. Three remain, starting on or after 2027-10-26, 2028-10-26 and 2029-10-26.
   - At the maximum, the registry fee would reach about 11.74, 12.56 and 13.44 (inferred), plus 0.20 ICANN.
   - Verisign must give 6 months' notice (RRA 5.1(b)). This applies to every upstream equally.

## 3. The accreditation route

Mosshatch would become an ICANN-accredited registrar with its own Verisign contract.
- Its marginal `.com` cost would be the floor: 10.46 today and 11.17 from 2026-11-01.
- Every other extension needs its own registry contract: Google Registry for `.dev` and `.app` (behind a sign-in, UNVERIFIED), Identity Digital for `.studio` and `.ai` (nic.ai shows a 4-step onboarding, amounts not stated), and `.io` (route UNVERIFIED). Until those are signed, the other five still come from a reseller.

**Cash to ICANN** (ICANN pages and FY27 budget, sweep only):

| Item | Amount |
|---|---|
| Application | USD 3,500, one-time, non-refundable |
| Annual accreditation | USD 4,000 a year (or 1,000 a quarter) |
| Per-registrar variable fee | USD 3.8 million a year shared among about 3,165 registrars. Registrars with fewer than 350,000 names pay one third of the standard share. ICANN publishes no per-registrar figure; our derived estimate is about USD 1,000 to 1,200 a year (inferred) |
| Transaction fee | 0.20 per domain-year (already inside the 11.17 floor) |
| Data escrow | USD 0 with the ICANN-designated agent (DENIC) |
| Insurance (RAA 3.10) | Waived since 2015-09-28 |

In total: about **USD 8,500 to 8,700 in year 1 and USD 5,000 to 5,200 a year after**.

**Capital and deposits, not spent but tied up:**
- ICANN asks for evidence of USD 70,000 of liquid capital ("a lesser amount will be accepted upon a showing").
- Verisign requires a payment security (letter of credit or cash deposit) sized to expected monthly registrations. No minimum is published.

**Not in those figures:**
- a registrar platform (EPP client, RDAP, WHOIS, escrow deposits, transfer and expiry notices), or one licensed from:
  - CentralNic RAM (price on request);
  - Realtime Register (platform licensing by quote, plus a "Registry Gateway" that adds one own accreditation "free of charge" to a GO!ORANGE account; whether it covers RDAP, escrow and ICANN notices is UNVERIFIED);
  - Tucows (hosted registrar service confirmed in its 2026 10-Q, no public offer);
- a 24x7 abuse contact and compliance staff;
- counsel.

**Time:** ICANN responds within 30 days and allows up to a year to complete. Verisign contracting and OT&E add unpublished time.

**When it beats resale, on ICANN cash alone:**
- **Against OpenSRS Essential** the saving is 15.25 − 11.17 = 4.08 per `.com`-year.
  - Year 2 onward: 5,000 to 5,200 / 4.08 = about **1,230 to 1,280 `.com` domain-years a year**.
  - Year 1: 8,500 to 8,700 / 4.08 = about 2,080 to 2,130.
  - With other annual costs X (platform, compliance, counsel), the break-even is (5,100 + X) / 4.08. For example, X = 20,000 gives about 6,150 `.com` domain-years a year. X is our assumption; nothing here prices it.
- **Against Openprovider** the marginal cost is the same (11.17), so accreditation saves only the membership: 0.20 to 0.50 per operation.
  - Even at 0.25 per operation, 5,100 / 0.25 = about 20,400 operations a year before X, and Openprovider quotes its own price above 15,000.
  - In practice, accreditation does not beat Openprovider on cost at any volume Mosshatch will see in its first years.
- Worked all-in `.com` cost per domain-year with ICANN cash only, year 2 onward: about 21.4 at 500 domains, 13.7 at 2,000 and 11.7 at 10,000 (inferred: 11.17 + 5,150 / volume).

**Verdict.** Accreditation is a scale option. It pays against OpenSRS only above roughly 1,250 `.com`-years a year before platform and staff, and realistically several thousand after them. It never pays against a cost-price reseller such as Openprovider. It adds direct ICANN compliance duties and a capital requirement. Revisit it when volume passes several thousand domains a year.

## 4. What would have to be true before switching or adding a second upstream

The adapter already supports per-extension routing, so the engineering cost is a second adapter implementation and its tests. The rest is paper, money handling and the product rules below. Nothing here needs a code change today.

### 4a. For any second upstream

1. **Contract.**
   - Written confirmation, or a signed amendment, that Mosshatch's own customer agreement governs its customers. Only the ICANN, registry and registrar registration terms may be passed down; nothing may make the upstream's terms prevail over the whole agreement.
   - Counsel must read the specific clauses named in 4b.
   - The end customer must be the registrant of record.
2. **No takeover of customers** except to protect registrants after a genuine failure. Openprovider Art. 4, the Dynadot Reseller Agreement and Realtime Register 4.7 all reserve rights to approach or move Mosshatch's customers. Netim 4.2 is the model: it undertakes not to solicit them.
3. **Expiry behaviour that fits D-008** (registrar-side auto-renew off, charge first, renew second):
   - a per-account setting to turn registrar auto-renew off;
   - written dates for the expiry grace period, the parking switch, deletion and auction;
   - an opt-out from parking with ads.
4. **Price-change notice that fits the 21-day reminder.**
   - Registry increases carry 6 months' notice for `.com`, so Mosshatch can track them at the registry.
   - The upstream's own changes need notice in writing of at least 30 days. Openprovider says "effective immediately"; Netim says "without prior notice"; Dynadot gave 7 days on 2026-10-06.
   - Without that, Mosshatch absorbs any change that lands inside 21 days of a charge.
5. **Money:**
   - a USD account;
   - funding by ACH or wire without card fees or an exchange-rate markup;
   - a stated refund of the balance on closure (Realtime Register forfeits it; Openprovider charges EUR 25; Netim EUR 30);
   - the tax position of a US business buying from an EU supplier (UNVERIFIED for Openprovider and Netim).
6. **API**, exercised in the sandbox before any live use:
   - all thirteen `RegistrarAdapter` methods, including auth-code release and transfer-out;
   - duplicate-order behaviour, since none of the three cheaper candidates documents an idempotency key;
   - written rate limits for availability search. Netim's "proportionate to the portfolio" clause and Openprovider's unpublished limits both matter for the six-extension search;
   - an IP allow-list that fits Vercel Static IPs (optional at Openprovider and Dynadot; at Netim, optional only according to search snippets of its blocked support site, UNVERIFIED).
7. **Registrant-facing channels.**
   - Who sends the ICANN notices (registrant verification, WDRP, ERRP), and under whose brand.
   - Whether any registrant-facing panel exposes auth codes outside Mosshatch's step-up. Netim has none. Openprovider is not known; ask.
8. **Data protection.** A data-processing agreement. Netim CGU-REV 11.2 makes the parties GDPR joint controllers.

### 4b. Written questions and contract points, by provider

**Openprovider (before it becomes an upstream)**
- Have counsel read:
  - Art. 4: no conflict with Openprovider's terms; client takeover; unlimited indemnity; "may only extend agreements without the permission of its Clients in the event of extenuating circumstances";
  - Art. 11: default auto-renew; parking; the 40-day Soft Quarantine; deletion, auction or transfer;
  - Art. 12: immediate price changes; +4% each 1 January; FX markup; rights in the customer's domains on a chargeback;
  - Art. 13: EUR 10,000 cap; claims by registered letter within 30 days;
  - Art. 35: "mutatis mutandis" to Mosshatch's customer agreements;
  - the Domain Registration Agreement ("no less protective of Registrar"; renewal and transfer of expired names to a third party);
  - the Fines Recovery Policy (EUR 80 and 50 an hour; two penalties within 12 months allow suspension).
- Ask in writing:
  1. that Art. 35 does not make Openprovider's T&C the terms of Mosshatch's customer contract;
  2. waiver or cap of the 4% annual increase;
  3. opt-out from parking, auction and third-party transfer of expired reseller domains;
  4. what happens to a domain "cancelled on its expiration date" when auto-renew is off, and whether it can still be renewed or restored in the registry grace period and at what price;
  5. whether a 2-year registration counts as one or two membership operations;
  6. which price applies when the quota runs out and triggers the membership's auto-renewal;
  7. USD funding by ACH or wire for a US account;
  8. the actual API rate limits;
  9. the "supplementary terms and conditions" for resellers (T&C Art. 1), which are not published;
  10. the `.com` member price from 2026-11-01;
  11. whether 10.46 already includes the ICANN fee (implied by 10.46 = 10.26 + 0.20 but not stated).
- Operationally:
  - alert on balance and on remaining quota, so the membership never lapses to non-member prices (`.com` renewal 16.98);
  - switch auto-renew off at account level before the first registration.

**Netim**
- Have counsel read:
  - 6.5 (no resale at a loss, which rules out below-cost promotions);
  - 15 (change of control needs Netim's written consent, otherwise automatic termination; relevant to any fundraising or sale);
  - 7.5 and 7.7 (return to retail prices if activity is "clearly insufficient");
  - 5.1.3(vii) (Mosshatch's customers must comply with Netim's terms);
  - which versions of CG-NETIM and CG-ND are operative (the PDF labels disagree).
- Ask in writing:
  1. whether the ICANN fee is included in the grid prices;
  2. whether a USD-billed reseller account exists;
  3. the deposit that reaches Gold;
  4. API limits and the OTE's scope (the support site is bot-blocked);
  5. one month's notice for price changes.

**Dynadot / GDG** (unchanged from PLAN 4.1, now sharper)
- Written confirmation that an account created at Global Domain Group is governed by the GDG ToS only, and that Dynadot ToU s3.1(a), (c), (d) and s13.1(b), (c) do not apply.
- GDG (IANA 3956) named as registrar of record.
- A waiver of the "data derived" API clauses (GDG ToS s12.1(b), (c)).
- GDG's actual price list.
- Confirmation that `.dev` and `.app` work through the API.

### 4c. Product and adapter rules for running two upstreams

1. **Route new registrations and transfers-in only.** An existing domain stays with the upstream that holds it until its registrant transfers it: an ICANN inter-registrar transfer, with the registrant's code and approval, one paid year added, and a 60-day lock after registration or a completed transfer. Routing is not failover. Both upstreams run side by side indefinitely, and each domain records its upstream.
2. **One price per extension.** Route each extension wholly to one upstream for new orders, so two customers buying the same extension on the same day see the same "registry and registrar cost". D-003's fee level is set by that upstream's standard wholesale.
   - Renewals are charged at the holding upstream's price. Customers on the old upstream therefore renew at a different cost from new ones, and the Hatch sheet and renewal reminders must show each domain's own figure.
3. **Volume splits.** Splitting volume makes each upstream's thresholds harder to reach: OpenSRS Advanced needs 100 new registrations or transfers a year, and Openprovider's quota costs less per operation only when used. Moving all six extensions to Openprovider (a switch, not an addition) avoids this. Keeping OpenSRS then only serves the domains already registered there.
4. **Working capital.** Two prepaid balances, each with its own float and alert (PLAN 4.2, "Working capital").
5. **Egress.** Both allow-lists must accept the registrar project's static addresses.
6. **Premium guard.** The premium price guard (D-031) runs against each upstream's own standard price.
7. **Before the second upstream goes live:**
   - the written answers above;
   - counsel's sign-off on the clauses named in 4b;
   - a sandbox pass of all thirteen adapter methods;
   - a live rehearsal with one real registration, renewal, auth-code release and transfer-out, as PLAN Phase 6 requires for OpenSRS.

## 5. Sources

All accessed 2026-09-30. "BLOCKED" means the page could not be read, and any value from it is UNVERIFIED.

**Baseline and cost floor**
- https://opensrs.com/domains/pricing (rendered; Essential, Advanced, Premium and Enterprise tabs): Essential ".com Register=$14.50 Transfer=$14.50 Renew=$14.50"; Advanced "'.com $13.50 $13.50 $13.50 — $80.00'"; Premium ".com $12.50"; Enterprise ".com $11.50"; "Your pricing tier will be honored until the end of the calendar year, at which time, it will be reassessed". (confirmed)
- https://opensrs.com/domains/tld-price-changes (rendered, "Last updated: Sep 29, 2026"): ".com $14.50 $15.25▲ Nov 1, 2026"; ".studio $42.00 $51.00▲ Oct 6, 2026"; Advanced tab ".com | $13.50 | $14.25▲ | Nov 1, 2026". (confirmed)
- https://support.opensrs.com/support/solutions/articles/201000063182: "Any change takes effect on April 1, and you receive at least 30 days' notice"; "Redemptions and renewals count toward total spend but not toward the transaction count." (confirmed)
- https://domains.opensrs.guide/docs/get_price: "This value includes the OpenSRS price and the ICANN fee." (confirmed)
- https://www.sec.gov/Archives/edgar/data/0001014473/000101447326000019/q12026earningsrelease.htm (Verisign Q1 2026): "increase the annual registry-level wholesale fee for each new and renewal .com domain name registration from $10.26 to $10.97 effective Nov. 1, 2026." (confirmed)
- https://itp.cdn.icann.org/en/files/registry-agreements/com/com-fees-01-11-2026-en.pdf: ".COM FEE SCHEDULE EFFECTIVE NOVEMBER 1, 2026 ... Initial Registration (per annual increment) $10.97"; restore "$40.00". (sweep only)
- https://itp.cdn.icann.org/en/files/registry-agreements/com/com-agreement-html-01-12-2024-en.htm: RRA 5.1(b) "any price increase shall be made only upon six (6) months prior notice to Registrar"; 7.3(d)(ii) "multiplied by 1.07 ... in each Pricing Year of the final four Pricing Years of every six year period, with the first six year period beginning on October 26, 2018". (sweep only)

**Openprovider**
- https://www.openprovider.com/api/domains/full?tld=com&currency=USD&years=1-3&operations=all (the feed behind https://www.openprovider.com/domains/tlds/com): create 1y "nonMemberPrice":"11.98","membershipPrice":"10.46"; renew 1y "nonMemberPrice":"16.98","membershipPrice":"10.46". (confirmed)
- https://tld-price-api.op-prod.net/api/sheets/domains/filter?page=1&size=5000&currency=USD&years=1&operation=create (the feed loaded by go.openprovider.com's `module_tld-table.min.js`): {"tld":"com","operation":"create","nonMemberPrice":"11.98","membershipPrice":"10.46"}; ai 80.00; io 50.00; dev 12.20; app 14.20; studio 31.20. The same feed with operation=renew gives com membershipPrice "10.46", nonMemberPrice "16.98". (confirmed)
- https://assets.openprovider.com/tld-catalogue/?tld=com&price_usd: create/renew 1y "non_member": "11.98"/"16.98", "basic": "10.46". (confirmed)
- https://www.openprovider.com/api/domains/full?tld={dev,app,io,studio,ai}&currency=USD: membershipPrice dev "12.20", app "14.20", io "50.00", studio "31.20" (membershipPromoPrice "17.99" until 2026-12-31), ai "80.00"; the dev and app membershipPromoPrice "9.00" ends 2026-09-30. (confirmed)
- https://www.openprovider.com/domains/tlds/ai: ".ai domains can only be registered for an initial period of two years." (confirmed)
- https://www.openprovider.com/membership-plans and https://www.openprovider.com/membership-pricing: "Basic S Membership ... up to 100 domain operations ... $4.16/month (Billed annually. Price excludes VAT)"; "Your Membership plan will expire in either of the following cases: - One calendar year has passed since the plan was activated. - The maximum number of domain operations has been reached"; "It is not possible to cancel your Membership after you have purchased it." (confirmed)
- https://www.openprovider.com/_next/static/chunks/799-82866a0a5ad395d1.js (pricing bundle of the membership page): Basic S price {USD:"49.99",EUR:"49.99"}, Basic M {USD:"199.99"}, Basic L {USD:"499.99"}, Professional S "$999.99", Professional M {USD:"1,999"}; "Promotion applies to new Members for their first year only, valid on Basic S Membership. Auto renewal after 12 months at full-price $49.99." (confirmed)
- https://go.openprovider.com/1/memberships: "Basic S ... Up to 100 domain transactions at cost price ... $49.99 $4.99 ... Limited-time introductory rate". (confirmed as displayed; whether it applies in the control panel is UNVERIFIED)
- https://support.openprovider.eu/api/v2/help_center/en-us/articles/360026572873.json (KB via Openprovider's Zendesk API; the HTML page is BLOCKED, 403): "The operations are: registration, renewal, and transfer."; "When the counter reaches 100/100, the membership will auto-renew, if the balance is sufficient". (confirmed)
- https://support.openprovider.eu/api/v2/help_center/en-us/articles/360033362034.json: "the operations left with your current plan will not be added to the new plan". (confirmed)
- https://support.openprovider.eu/api/v2/help_center/en-us/articles/4402037589906.json: "Account Currency: Choose your preferred currency. Please note that this cannot be changed later. The available options include EUR, USD, and GBP." (confirmed)
- https://support.openprovider.eu/api/v2/help_center/en-us/articles/216644258.json: "Wire transfer ... only available for EU* resellers ... AND currency set to EURO. (not available for accounts in Dollar, Pounds, etc)"; credit card "a maximum amount applies ... Transaction costs may be charged". (confirmed)
- https://support.openprovider.eu/api/v2/help_center/en-us/articles/24055139207058.json: the ICANN fee "will be automatically added to the domain's price at checkout and will not appear separately in your cart". (confirmed; whether the feed price already includes it is inferred)
- https://support.openprovider.eu/api/v2/help_center/en-us/articles/4415268651538.json: "An administrative fee of €25 will be charged ... A refund can take up to 6 weeks". (confirmed)
- https://www.openprovider.com/legal/terms-conditions ("Last Updated on April 9, 2026"): Art. 4 "free to determine which products and services it provides to its Clients at which price, within the limitations set out by Openprovider in the offer"; Art. 4 "Openprovider will acquire the right to approach, inform and acquire Reseller Clients and transfer its domain Clients to Openprovider"; Art. 11 "At the end of Soft Quarantine, Openprovider may, in its sole discretion, delete a domain, put a domain up for auction or transfer it to another registrant."; Art. 11 "Automatic Renewal is the default setting"; Art. 12 "effective immediately without need for further notice to you or ... ideally at least 2 weeks before"; Art. 12 "entitled to raise all rates ... by 4% per year on 1 January"; Art. 13 "exceed a sum of € 10,000"; Art. 35 "apply, mutatis mutandis, to any agreements between the Reseller and its Clients". (confirmed)
- https://www.openprovider.com/company/policies, and the Fines Recovery Policy linked from it (https://drive.google.com/file/d/1wRSaMOwi6Fd8N6Q4mw8Xaax3-bvjl8hs/view): "It forms an integral part of the reseller agreement"; "EUR 80 per hour for time expended by its legal personnel and EUR 50 per hour for time expended by operational staff". (confirmed)
- https://assets.openprovider.com/wp-content/uploads/2025/08/Domain-Registration-Agreement.pdf: "no less protective of Registrar than this Agreement"; "we may, in our sole discretion, renew and transfer the domain name to a third party on your behalf as an expired domain transfer". (confirmed)
- https://assets.openprovider.com/wp-content/uploads/2025/08/Auto-Renewal-and-Domain-Deletion-Policy.pdf: "If auto-renewal is disabled ... the domain will be cancelled on its expiration date in Openprovider." (confirmed)
- https://docs.openprovider.com/: "/v1beta endpoints which will be discontinued as of September 2026 ... Existing integrations must move to /v1 before 30 June 2027". (confirmed)
- https://developer.openprovider.com/ and /get-started.html: "No charges, no registry calls"; "API access is off by default and is enabled per contact person." (confirmed)
- https://www.openprovider.com/legal/fair-use-policy: "We have API limits in place ... Exceeding those limits may lead to blocking your API access." (confirmed)
- https://support.openprovider.eu/api/v2/help_center/articles/search.json?query=price%20increase%202026: newest newsletter "Domains Newsletter - April 2026"; no notice of the 2026-11-01 `.com` price found. (confirmed; the future price is UNVERIFIED)
- https://www.iana.org/assignments/registrar-ids/registrar-ids-1.csv: "1647,Hosting Concepts B.V. d/b/a Registrar.eu,Accredited". (confirmed)

**Netim**
- https://www.netim.com/en/reseller-program (POST selectTierLevel=REV-1/2/3, extension currency on): .com "$12.79" Bronze, "$12.21" Silver, "$11.63" Gold, register and renew; transfer "$11.63"; restore "$51.16"; .ai "2 to 10 years" "$88.00" Bronze, "$83.00" Gold; default view '<option value="REV-3" selected>'; "Prices Excl. VAT, Premium domains fees, specific launch phases fees and optional services are extra". (confirmed)
- https://www.netim.com/contracts/CG-RES-1.7.EN.pdf ("CGU-REV version 1.7, last revision: August 11, 2026"): 6.5 "Resale at a loss is strictly prohibited" and "obliged to pass on any unexpected increase initiated by one of its suppliers"; 7.5 "a return to standard Customer status if its activities are clearly insufficient"; 8.2 and 14.4 caps at "the total fees paid by the Reseller to NETIM during the twelve (12) months"; 11.2 "act as joint controllers"; 15 "change of control ... without the prior express written consent". (confirmed)
- https://www.netim.com/contracts/CG-ND-2.5.EN.pdf: Clause 4 "may be modified at any time, without prior notice for future services". (confirmed; the PDF header reads "CG-NETIM version 2.6")
- https://www.netim.com/contracts/CG-NETIM-2.5.EN.pdf: 8.5 "funds can be refunded subject to a fee of thirty (30) EUR". (confirmed)
- https://www.netim.com/en/payment-methods: prepaid account "is the only one available to resellers ... Accepted currencies: EUR, USD, CHF, GBP." (confirmed)
- https://www.netim.com/en/reseller-program/netim-api: "SOAP API REST API (currently in beta) ... Access to a sandbox environment". (confirmed)
- https://support.netim.com/en/docs/resellers/manage-my-reseller-account/billing and /apis/testing-environment: BLOCKED (Cloudflare 403). Search snippet only: "Currently, resellers cannot select their currency and payments are made only in Euro." (UNVERIFIED)

**Dynadot / Global Domain Group**
- https://www.dynadot.com/domain/com: "Registration $10.88 Renew $10.88 Transfer $10.88". (confirmed)
- https://www.dynadot.com/domain/prices (rendered, Reseller tab): ".com $10.88 $10.88 $10.88"; ".dev $12.84 $12.50"; ".app $14.98 $14.50"; ".io $28.89 $53.50"; ".ai $85.60 $85.60 $171.20". (confirmed)
- https://www.dynadot.com/help/question/icann-fee: "we do not charge a ICANN fee on top of our domain registration fee". (confirmed)
- https://www.dynadot.com/blog/price-changes-for-over-200-identity-digital-tlds (dated 2026-09-29): "New prices take effect on October 6, 2026, at 17:00 UTC"; ".studio $43.02". (confirmed)
- https://www.dynadot.com/terms-of-use (version 2026-08-18): s3.1 "(d) Any agreement between You and that third party shall provide that the terms of this Agreement shall prevail". (confirmed)
- https://www.dynadot.com/reseller-agreement (version 2023-08-15): "terminate this Agreement without notice, transfer any and all of Your customer accounts to Dynadot accounts". (confirmed)
- https://www.globaldomaingroup.com/terms-of-service (version 2026-08-18): Part I 1.1 "applies to any person or entity which creates a user account with GDG"; no "prevail" clause in Part I s3. (confirmed)
- https://www.globaldomaingroup.com/reseller-tlds and https://www.globaldomaingroup.com/controller/reseller/tld/list: the table and its feed contain TLD names and types only, no prices. (confirmed)
- https://www.dynadot.com/help/question/API-supported (updated 2026/01/13): the list has ai, com, io and studio entries and no dev or app entry. (confirmed)

**NameSilo, DomainNameAPI, Internet.bs, Sav.com, Spaceship**
- https://www.namesilo.com/pricing (headless browser; curl got 403): "com | $17.29 | $17.19 | $17.09 | $11.05 | ..."; https://www.namesilo.com/public/api/pricing/renewal: com [[17.29,17.29],[11.05,11.05],...]. (confirmed)
- https://www.namesilo.com/discount-program: "Discounts apply only when checking out using Account Funds at time of purchase."; "you must add at least $50 each time". (confirmed)
- https://www.namesilo.com/support/v2/articles/domain-manager/reseller-frequently-asked: "You will be required to accept our reseller terms and conditions."; "There is no special pricing for resellers". (confirmed; the in-account terms are BLOCKED)
- https://www.namesilo.com/blog/en/domain-name-search/cheapest-domain-registrars-in-2026-5-year-total-cost-compared (2026-02-20): "$75 at NameSilo only if the domain has actually entered the redemption period". (confirmed)
- https://www.domainnameapi.com/domain/getallprices?lang=en: ".com" "price_Res_Registration":11.31, "price_Res_Renew":11.51, "price_Prem_Registration":10.91, "price_Plat_Registration":10.81. (confirmed)
- https://www.domainnameapi.com/domain-reseller: "Manage 101–1,000 domains or maintain a $1,000 deposit to access Premium pricing". https://www.domainnameapi.com/payment-options: "A 2% fee applies to TRY payments, and a 2% fee applies to USD payments."; "PayPal | 6.3% Fee". (confirmed)
- https://www.domainnameapi.com/assets/documents/Terms-of-Use.pdf: "operated by Atakonline Domain Hosting Internet and Information Technologies LTD ... Lefkoşa, K.K.T.C."; 5.5 "unless Domain Name API receives written notice to the contrary at least three (3) months before the service expiration date". https://www.domainnameapi.com/assets/documents/Reseller-Agreement.pdf: 3.9 "you are obliged to prepare a Customer Agreement"; 11.7 "Prohibition of Sub-Reselling". (confirmed)
- https://testapi.internet.bs/Account/PriceList/Get?ApiKey=testapi&Password=testpass&ResponseFormat=JSON&version=2: "pricelevel":"Insider"; .com registration '11.30', renewal '11.59'. https://faq.internetbs.net/api/v2/help_center/en-gb/articles/4517127326877.json: "Insider pricing is for customers who have more than 500 domains". https://internetbs.net/en/domain-name-registrations/price.html and /termsandconditions.html: BLOCKED. (corrected; Member price UNVERIFIED)
- https://domain.api.sav.com/v1/tld/prices/all?currency=usd: 'com': {'registration': 10.87, 'renewal': 10.15}. Postman collection behind https://documenter.getpostman.com/view/9688716/TzzANHFJ: 12 endpoints, none that register, renew or check availability. https://marketing.sav.com/legal/reseller: "provided such terms and conditions do not conflict in any manner with any agreement or policy of Sav". (confirmed)
- https://www.spaceship.com/domains/gtld/com/ and /legal/*: BLOCKED (Cloudflare 403). Third-party https://tldes.com/registrars/spaceship: "$9.08 COM Registration, $10.18 COM Renewal". (UNVERIFIED)

**Large programs**
- https://www.godaddy.com/help/wholesale-rates-for-api-resellers-40891: "Buy rate (USD)" ".com $10.69". Wayback captures https://web.archive.org/web/20231130002706/https://www.godaddy.com/help/wholesale-rates-for-api-resellers-40891: ".com $8.99". (corrected: not a reliable buy rate)
- https://web.archive.org/web/20260717082244/https://www.godaddy.com/legal/agreements/reseller-agreement ("Last Revised: 2/2/2026"; the live page is BLOCKED, 403): "solely to business customers, and that you will not knowingly permit the Services to be purchased or used for personal, family, or household purposes"; "All Reseller Programs are subject to an annual licensing fee." (confirmed from the archive)
- https://www.enom.com/wp-admin/admin-ajax.php (action=rockn_tld_pricing, the feed behind https://www.enom.com/reseller/domain-name-reseller-pricing-plans/): '.com_2' SILVER 14.5 until '2026-11-01 0:00', '.com' 15.25 from '2026-11-01 0:00'; '.dev_2' sale '10' to 2026-12-31; '.app_2' sale 14 to 2026-12-01; '.io_2' sale 34 to 2026-12-31. The pricing page: "One-time enrollment fee $195 $50". (sweep only)
- https://www.name.com/ajax/pricing/?duration=1&tlds=com,ai,io,dev,app,studio: com 'registration_price':'12.99', 'renewal_price':'19.99', 'future_renewal_price':'21.99', 'future_renewal_start_date':'2026-10-31'. https://docs.name.com/api/v1/reference/tld-pricing/tld-price-list.md: "Your price, including any applicable rebates, promotions, or account-level discounts." (sweep only)
- https://www.resellerclub.com/domain-reseller/pricing: BLOCKED (Cloudflare 403). (UNVERIFIED)

**EU and other routes**
- https://realtimeregister.com/solutions/domains/go-orange-domains-at-cost-price: "A GO!ORANGE partner account costs €/$5 per month and includes up to 100 domains at cost price. From 101 up to 1,000 domains, you pay an additional €/$0.03 per domain per month"; "Add one of your own accreditations with our Registry Gateway, free of charge". https://kb.realtimeregister.com/article/31-my-price-list: "Login the Domain Manager and go to Finance > My price list". https://realtimeregister.com/legal-trust/general-terms-conditions: 4.1 "Upon separate request ... RTR may however refuse"; 10.7 "the balance is forfeited to RTR". (sweep only; prices UNVERIFIED)
- https://www.internetx.com/api/tld/list/?L=1 (feed of https://www.internetx.com/en/top-level-domain-list/): com "create_price": "24.00", "renew_price": "24.00". https://www.internetx.com/en/domain-reseller-program/: "Based on your business plan, we will offer you the best terms". (sweep only)
- https://www.centralnicreseller.com/domain-reseller-pricing/: ".com | USD 18.33 ... USD 16.12 ... USD 13.82". https://www.centralnicreseller.com/domain-reseller-promotions/: ".app | 15.00 USD | Jul 1, 2026 | Sep 30, 2026". (sweep only)
- https://www.101domain.com/international_domain_reseller_program.htm: "This program is not available to new applicants at this time." (sweep only)
- https://www.eurodns.com/blog/domain-reseller-business-solutions: "we'll calculate a reduced cost for you"; https://www.eurodns.com/blog/domain-price-updates-october-2026: ".com 22 € 01/11/2026". (sweep only)
- https://developers.cloudflare.com/registrar/registrar-api/index.md ("Last updated Sep 16, 2026"): "Renewals are not yet available through the API." (sweep only)

**Accreditation**
- https://www.icann.org/en/contracted-parties/accredited-registrars/registrar-accreditation-agreement/registrar-accreditation-financial-considerations-25-02-2012-en: "US$3,500 application fee, which is non-refundable"; "US$4,000 yearly accreditation fee"; "US$70,000 or more will be deemed adequate, although a lesser amount will be accepted upon a showing". (sweep only)
- https://www.icann.org/en/system/files/files/adopted-icann-budget-fy2027-published-2026-en.pdf, pp. 39 to 41: "quarterly installments of $1,000"; "Fewer than 350,000 gTLD names under its management"; "dividing $950,000 (one-fourth of $3.8 million, if approved) equally among all registrars ... taking into consideration the forgiveness factor"; "billed at $0.20 per transaction"; "an average of 3,165 accredited registrars in FY27". (sweep only; the per-registrar amount is our derivation)
- https://www.verisign.com/resources/become-a-registrar/: "Verisign requires registrars to establish a payment security based on expected monthly registration volume." (sweep only)
- https://www.icann.org/en/announcements/details/icann-announces-denic-as-sole-icann-designated-registrar-data-escrow-agent-17-07-2023-en: "an ICANN-designated RDE agent (at no charge to the registrar)". (sweep only)
- https://itp.cdn.icann.org/en/files/accredited-registrars/registrar-accreditation-agreement-21jan24-en.htm: insurance clause "waived by the ICANN Board of Directors, effective 28 September 2015". (sweep only)
- https://www.centralnicreseller.com/registry-account-management-ram/: "RAM allows you to use the CentralNic Reseller system to submit orders to the registry under your own accreditation"; "Please contact us for details." (sweep only)
- https://www.sec.gov/Archives/edgar/data/0000909494/000090949426000003/tcx-20260630.htm: "for other registrars under their own accreditations." (sweep only)
- https://www.registry.google/registrars/: BLOCKED (sign-in). https://www.logicboxes.com/icann-registrar-accreditation-program/: BLOCKED (403). (UNVERIFIED)
