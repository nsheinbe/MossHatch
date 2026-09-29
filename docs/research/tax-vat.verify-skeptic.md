# tax-vat: skeptic verification notes

Verifier: skeptic lens. Date of all fetches: 2026-09-29 (UTC 20:1x to 20:4x). Workspace: `working-directory/research/tax-verify-skeptic/` (raw fetches in `raw/`, my helper `f.sh`, `pw.js`).

Method: I did not reuse the analyst's cached text. Every page below was re-fetched by me (curl through the proxy with a browser UA; headless Chromium for canada.ca, EUR-Lex, Alabama admin code, Avalara). WebSearch quota was still exhausted (200/200), so I could not search for contrary sources; I tried GOV.UK's search API (useless) and one search-engine page (bot challenge, not pursued). No TLS verification was disabled. Blocked or unreachable, recorded and not worked around: ATO (HTTP 403), nysenate.gov (Cloudflare challenge; the proxy also logged `brunhild.challenges.cloudflare.com:443 connect_rejected`), ilga.gov (TLS chain error), tax.ri.gov (403), Justia (403), duckduckgo (202 challenge), NTA Japanese Q&A URLs (soft-404), Mississippi DOR (no page found), Wyoming DOR (no page found).

Verdict key: confirmed = re-derived from a primary source I opened (for claims about Stripe's own product, price or docs, Stripe's page is the primary source). corrected = partly right. refuted. unverifiable = could not re-check against a primary source (including claims that rest only on Stripe's summary of foreign or state law).

## A. Headline results

Corrections that matter:
1. "Or 200 transactions" is stale for at least North Carolina and Maine (dossier, TL;DR point 3 and Appendix A). NC G.S. 105-164.8(b)(9) (current text, last amended 2025-25) has a single test: gross sales over $100,000. 36 M.R.S. section 1754-B(1-A)(B) (Maine, current text) has a single test: gross sales of TPP or taxable services over $100,000. Stripe's own NC and ME pages still say "or 200 transactions", so the analyst copied a stale aggregator. Wyoming: Stripe says 200 transactions, the Sales Tax Institute (as of 8/1/2026) says removed 7/1/2024; I could not reach a Wyoming primary source (unresolved).
2. Kansas is misclassified. K.S.A. 79-3702(h)(1)(G)(i)(b) counts "cumulative gross receipts from sales by the retailer to customers in this state" over $100,000, not only taxable sales. The dossier puts Kansas in the "taxable only" group; it belongs with the gross-receipts states (so at least 23, not 22).
3. The "domain registration is not mentioned" line for Washington is wrong. WAC 458-20-15503, subsection (m): "Advertising services do not include web hosting services and domain name registration." That is not a taxability holding, but it is a WAC mention, which contradicts "not mentioned" and the "no state page names domain registration" statement (it is a state regulation, not a revenue-department web page, so the softer version of the statement survives).
4. "Register for me requires a US bank account" overstates. Stripe's text: "Have a US bank account. This is required in states that charge fees or require banking details." (TaxJar filing separately requires a US bank account for remittance.)

Not refuted, but the analyst's key gap stays open: nothing I could fetch says whether a domain name registration is an electronically supplied service (EU, UK) or taxable in any given US state.

## B. Claim-by-claim

### B1. EU VAT treatment of domain names

| Claim | Verdict | What I re-fetched |
| --- | --- | --- |
| Domain names are not named in EU Annex I / explanatory notes / VAT Committee guidelines / HMRC guidance | confirmed (as an absence) | Full text search for "domain" in: VAT Committee guidelines PDF (2,291 KB; only hit is "public domain" in a hedging paragraph); Commission Explanatory Notes 2015 PDF (0 hits); Explanatory Notes e-commerce "Published July 2026" PDF (0 hits); Council Implementing Regulation 282/2011 original text fetched from EUR-Lex through headless Chromium (0 hits; Annex I(1) lists "Website hosting and webpage hosting" etc.); HMRC Notice 741A (0 hits); HMRC digital services guidance (0 hits); HMRC VAT Notice 700/1 (0 hits). |
| 2003 VAT Committee test: e-service includes "a service which provides, or supports a business or personal presence on an electronic network (e.g., web site or web page)" | confirmed | Guidelines from the 67th meeting of 8 January 2003 (Document A, TAXUD/2303/03), page (3/9). The document carries the caveat that guidelines are only views of a consultative committee and bind neither the Commission nor Member States. |
| A domain registration "plausibly fits" | unverifiable | Inference only. Article 7 test ("essentially automated, minimal human intervention, impossible without IT") is consistent with an automated registrar flow but I found no authority applying it to domain names. The dossier correctly calls this an open question for a VAT advisor. |
| Stripe: "Other services ... Taxable in the country your business is based in when provided to individuals" (txcd_20030000), so PTC choice flips EU B2C treatment for a non-EU seller | confirmed as a statement about Stripe Tax behaviour | docs.stripe.com/tax/supported-countries/european-union.md line 60. Caveat: this is Stripe's model of the Article 45 general B2C rule; if a domain is in fact an e-service, using txcd_20030000 would under-collect. |
| Non-Union OSS: any non-EU taxable person supplying services to non-taxable persons; free choice of Member State of identification; no tax representative | confirmed | vat-one-stop-shop.ec.europa.eu/one-stop-shop/register-oss_en ("Any taxable person, not established in the EU, who supplies services to non-taxable persons taking place in the EU, can register in the non-Union scheme"; "can choose any Member State to be the Member State of identification"). Intermediary is import-scheme only. Stripe EU page: "You don't need to appoint a tax representative to use the OSS non-Union scheme." |
| EUR 10,000 place-of-supply threshold does not apply to non-Union scheme suppliers | confirmed | Explanatory Notes (July 2026): "This threshold does not apply to: i) supplies of TBE services made by a supplier not established in the EU (non-Union scheme)". |
| Registration effective first day of the next quarter; or from first supply if notified by the 10th of the following month | confirmed | OSS register page, "When will the registration take effect" (examples given). Application on 2026-09-29 gives 2026-10-01. |
| Quarterly returns incl. nil returns, due end of following month; records kept 10 years | confirmed | OSS declare-and-pay page; record-keeping page ("kept for 10 years from the end of the year in which the transaction was made"). |
| Two items of non-contradictory evidence; IP address plus its geolocation is one item; bank details confirmed by the payment provider are one item | confirmed | Explanatory Notes 2015, section 9.5 and Article 24f list ((a) billing address, (b) IP address or geolocation, (c) bank details such as location of the bank account or billing address held by that bank ...). Billing address plus card-issuing country are separate items (a)+(c). Three items are needed to rebut a presumption (section 9.5.5). |
| A supplier may treat a customer without a VAT ID as a consumer; a communicated VAT ID lets it treat an EU customer as taxable | confirmed | Explanatory Notes 2015 (text located in sections 5 and 9). |
| VIES REST API is keyless and live | confirmed | I called `GET /check-status` (`vow.available: true`, per-country list), `POST /check-vat-test-service` (DE/100 returned `valid: true`, "John Doe"), and `POST /check-vat-number` for IE 6388047V (returned `valid: true`, `requestIdentifier: ""`, trader match fields `NOT_PROCESSED`). |
| ViDA: revised notes "24 July 2026" add changes effective 1 January 2027; further Single VAT Registration changes essentially 1 July 2028 | confirmed with a date note | The PDF says "Published July 2026" and quotes "will, essentially, enter into force on 1 July 2028". The exact day "24 July 2026" is not in the PDF; it appears in a listing page only. |

### B2. US state list and thresholds

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Wayfair: overruled Quill; SD law reached more than $100,000 of goods or services or 200 transactions | confirmed | supremecourt.gov 17-494 opinion (syllabus "physical presence rule of Quill is unsound and incorrect"; text "deliver more than $100,000 of goods or services into the State or engage in 200 or more separate transactions"). |
| California $500,000, counts only TPP | confirmed | R&TC 6203(c)(4)(A) via cdtfa.ca.gov law guide: "total combined sales of tangible personal property for delivery in this state ... exceed $500,000". |
| New York $500,000 and more than 100 sales, TPP only | confirmed | tax.ny.gov TB-ST-175: "gross receipts from sales of tangible personal property delivered into the state exceeded $500,000, and you made more than 100 sales of tangible personal property". |
| Texas $500,000, gross including nontaxable | confirmed | comptroller.texas.gov/taxes/sales/remote-sellers.php: "total Texas revenue is based on gross revenue from taxable and nontaxable sales of tangible personal property and services". |
| Alabama $250,000, retail sales of TPP only | confirmed | Ala. Admin. Code r. 810-6-2-.90.03(1) (Chromium): "retail sales of tangible personal property sold into the state exceed $250,000 per year". |
| Mississippi $250,000 gross sales | unverifiable | Stripe and Sales Tax Institute agree; I found no Mississippi primary page. |
| Washington counts gross receipts | confirmed | RCW 82.04.067(1)(c)(i) and (2)(a): "More than one hundred thousand dollars of cumulative gross receipts from this state" including "all of a person's gross income of the business attributed to this state". |
| North Carolina counts gross sales | confirmed (but 200-transaction prong refuted) | G.S. 105-164.8(b)(9). |
| Florida TPP only | confirmed | F.S. 212.0596: "Substantial number of remote sales" means taxable remote sales over $100,000; "remote sale" is a retail sale of TPP. |
| New Jersey and Maine count only taxable items | confirmed | NJ Division of Taxation remote seller page: "gross revenue from sales of tangible personal property, specified digital products, or taxable services"; 36 M.R.S. 1754-B. |
| Kansas counts only taxable sales | refuted | K.S.A. 79-3702(h)(1)(G): "cumulative gross receipts from sales by the retailer to customers in this state". |
| "Mostly $100,000 or 200 transactions" with ME, NC, WY on the "or 200" list | corrected | ME, NC: single dollar test in the statutes (see A.1). WY unresolved. Stripe's own pages are stale; Sales Tax Institute's chart (8/1/2026) records removals for AK (1/1/2025), IL (1/1/2026), IN (1/1/2024), KY (8/1/2026), ME (1/1/2022), NC (7/1/2024), SD, UT, WY (7/1/2024). Note the Sales Tax Institute labels ME, NJ, MD, RI as "gross sales", which the ME and NJ primary texts contradict, so it is a cross-check, not an authority. |
| 22 states count gross sales including nontaxable; 9 count TPP only | corrected | Of the 22, I confirmed TX, WA, NC on primary sources. Of the 9, CA, NY, AL, FL confirmed. Kansas moves into the gross group (23+). Maryland and Rhode Island unresolved (MD statute page did not load; RI 403). The remaining states rest on Stripe's per-state pages. |
| Some states count nontaxable sales (AZ, IN, NC) and may force zero or information returns | confirmed as Stripe's statement; NC confirmed on statute | docs.stripe.com/tax/monitoring.md line 37; NC G.S. above. |
| 24 SSUTA states | confirmed (with precision) | streamlinedsalestax.org home page: 23 full member states plus Tennessee as an associate member. |
| Marketplace facilitator laws in every sales-tax state and DC | unverifiable | Stripe's US page says so; not checked against statutes. |
| NY 1997 advisory opinion TSB-A-97(87)S | confirmed (low weight) | The opinion asks in issue (1) whether "Domain Registration and InterNIC Registration" charges are subject to sales tax and concludes web-site development charges described in (1), (2), (4) are "not subject to sales and compensating use tax". |
| Texas 94-127: "creating web (home) page and providing server space" | confirmed text; low relevance | comptroller.texas.gov/taxes/publications/94-127.php line 279. Publication dates from 1994; it does not address domain names. |
| WA excludes web hosting from digital automated services; "domain registration not mentioned" | corrected | WAC 458-20-15503(n): "This exclusion includes providing space on a server for web hosting". Domain registration is mentioned in (m) (advertising services). |
| Avalara SW050300 / SW050301 exist as separate individual and business domain codes | confirmed (dates not re-derived) | taxcode.avatax.avalara.com/search?q=domain (Chromium): "Website / domain registration / individual use" and "... / business use". The 2022-05-01 effective date is from the analyst's cached API JSON, which I read but did not re-fetch. |

### B3. Stripe Tax product tax codes and pricing

| Claim | Verdict | Evidence |
| --- | --- | --- |
| No domain-name PTC in the 677-code list | confirmed | docs.stripe.com/tax/tax-codes.md: 677 table rows, zero matches for "domain", "registrar", "DNS". Page states it is the complete list "except tax codes available only through a preview feature". Nearest: txcd_10000000, txcd_10701100 Website Hosting, txcd_20030000 General - Services. |
| txcd_10000000 quote ("similar to those for a generic digital item like downloaded music") and txcd_20030000 EU note | confirmed | Same page. |
| 104 listed jurisdictions; all-PTC countries can be the business location; India digital-only and customer-location only | confirmed | supported-countries.md: 104 country rows; 42 "All PTCs" countries (the analyst's list omits HK, ZA, AE, PR, LI); IN row: Digital products, IGST, business location not supported. |
| Zero tax without a registration | confirmed | tax-codes.md intro. |
| Tax Complete $90 / $430 / $1,000 / $1,500 per month, 1-year contract; 2/4/6/10 registrations; 200/1,000/2,500/5,000 transactions; 4/12/20/32 filings; fees outside the US may be extra | confirmed | stripe.com/tax/pricing (fetched 2026-09-29). Non-US registration services are provided by Taxually (same page). |
| Tax Basic 0.5% no-code (Checkout, Billing, Invoicing, Payment Links) or 50c API (10 calculation calls included, 5c each above), "where you're registered" | confirmed | Same page. Missed nuance: docs say the fee "might apply even when ... the tax amount calculated is zero" (docs.stripe.com/tax/how-tax-works.md), so registering in a state where domains are nontaxable still costs the fee. |
| No fee for threshold monitoring | confirmed | how-tax-works.md: "We don't charge a fee to ... Monitor tax thresholds based on your past Stripe payments". Monitoring is also listed as included in both plans on the pricing page. |
| Reverse charge applied on tax-ID format regardless of government check | confirmed | docs.stripe.com/invoicing/customer/tax-ids.md line 178. |
| Stripe validates EU VAT (VIES), GB VAT (HMRC), ABN (ABR); only validity, not name or address | confirmed | Same page, lines 158-164. |
| EU digital services use a single address, not two-item evidence | confirmed | european-union.md line 55. |
| Register for me: remote seller, no physical presence | confirmed | use-stripe-to-register.md. |
| Register for me requires a US bank account | corrected | Conditional: "required in states that charge fees or require banking details". State fees list (AZ 12, CO 16 + 50 deposit, CT 100, HI 20, IN 25, NV 15 + deposit, SC 50, WA 50 + 5/DBA, WV 30, WI 20, WY 60) confirmed. Non-US owners need EIN plus SSN or ITIN. |
| Register for me does not prepare returns or remit tax; TaxJar filing in 46 US locations | confirmed | filing.md; file-with-stripe.md ("Automated US filing is available in all 46 US locations with a state-level sales and use tax"; needs Tax Complete and a US bank account). |
| Automatic tax behavior: USD and CAD exclusive, others inclusive | confirmed | products-prices-tax-codes-tax-behavior.md line 21. |

### B4. Merchant-of-record statements

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Paddle: 5% + 50c per Checkout transaction; "built to serve software companies"; domain names not named; reseller exclusions | confirmed | paddle.com/pricing and paddle.com/help/.../what-am-i-not-allowed-to-sell-on-paddle (last updated 13 April 2026). No "domain" hit. Prohibits "resale of any product without a valid reseller certificate", "Reseller Products (Microsoft, Adobe)", "products that enable non-Paddle Sellers to sell". Missed: Paddle's pricing page says sellers under $10 per product must ask for custom pricing. |
| Lemon Squeezy: prohibits "Services of any kind (including marketing, design, web development, consulting ...)" and marketplaces; domain names not named; $1.67 fee example on $15 + 20% VAT | confirmed | docs.lemonsqueezy.com/help/getting-started/prohibited-products; .../payments/sales-tax-vat ("$0.50 + 5% of total + 1.5% int'l payment" = $1.67). Lemon Squeezy terms: no "domain name" hit. |
| Polar: "serves software companies"; marketplaces and non-Polar sellers prohibited; domain names not named; Starter 5% + 50c, Pro $20 3.8% + 40c | confirmed | polar.sh acceptable-use (URL now redirects to polar.sh/legal/acceptable-use-policy) and polar.sh/docs/merchant-of-record/fees (Growth $100 3.6% + 35c and Scale $400 3.4% + 30c also confirmed; +1.5% international cards). Zero "domain" hits. |
| Stripe Managed Payments: 3.5% on top of Payments fees; direct sales only; no Connect, Elements, subscriptions outside Checkout/Payment Links, third-party tax integrations | confirmed | stripe.com/pricing; managed-payments/eligibility.md; managed-payments.md. Supported categories include "Electronically supplied business and web services, such as website hosting"; domain names not named. Missed: the seller must assign an eligible digital tax code (txcd_10000000 or the hosting code are on the list) and sell "a fully automated digital product"; if Stripe finds the product ineligible the seller bears the indirect tax. |
| FastSpring publishes no price and no public prohibited list | unverifiable (absence) | Pricing page says "Get your pricing quote"; four guessed policy URLs returned 404. |
| Domain names are on none of the four prohibited lists | confirmed | Zero "domain" hits on all four policy pages. Written confirmation is still needed from each. |

### B5. Non-resident registration thresholds

| Jurisdiction | Verdict | Evidence |
| --- | --- | --- |
| UK: NETP has no threshold, must register for taxable supplies of any value, tell HMRC within 30 days; B2B-only reverse-charge escape; HMRC may direct a representative or security | confirmed | HMRC VAT Notice 700/1 paras 3.1, 9.3, 9.4. Nuance missed: for digital services HMRC lets a supplier accept other evidence of business status when a customer has no VAT number (hmrc digital-services page), so a valid-VAT-ID-only gate is stricter than the UK rule (EU rule is VAT ID). |
| UK: B2C general rule places supply where the supplier belongs; HMRC e-service list includes "website supply or web hosting services", not domains | confirmed | Notice 741A para 6.2 and the digital-services page. |
| Norway: NOK 50,000 / 12 months, quarterly return by the 20th, VOEC B2C only, scope "remotely deliverable services, including electronic services" | confirmed | skatteetaten.no VOEC page. Stripe adds that non-EEA sellers outside VOEC need a Norwegian VAT representative. |
| Canada: CAD 30,000 / 12 months simplified GST/HST; "generally taxable supplies of intangible personal property or services"; unregistered entities count as specified recipients; no security deposit | confirmed | canada.ca cross-border-threshold-amounts, charge-collect/cross-border, register-get-ready (Chromium). Domain names not named; the CRA's list includes "traditional services such as legal and accounting services", which supports the analyst's broad-scope reading. |
| Quebec CAD 30,000; BC CAD 10,000; SK and MB 1 transaction | unverifiable | Stripe's Canada pages match the dossier; no provincial primary source fetched. Provincial taxability of a domain registration is also unaddressed. |
| Australia AUD 75,000 | unverifiable | ATO returned 403; Stripe AU page matches; legislation.gov.au renders only a shell. |
| India: no threshold, register from first B2C sale | unverifiable | Only Stripe's India page (text matches); no Indian primary source reached. |
| Japan: JPY 10 million base-period threshold; B2B electronic services excluded from taxable sales; Tax Agent required; self-serve "for business use" is B2C | confirmed | NTA English brochure "National Tax Agency, July 2024" (PDF). Domain registration not named; NTA Japanese Q&A URLs I tried were soft-404s. |
| Switzerland: CHF 100,000 worldwide, representative mandatory, register within 30 days, reverse-charge-only foreign sellers exempt, FTA generally no longer requires security | confirmed | estv.admin.ch vat-liability-foreign-companies. Stripe's page still says "provide cash or bank guarantee" (conflict real; ESTV preferred). Nuance missed: Stripe's Swiss page says reverse charge applies to VAT-registered customers or customers acquiring more than CHF 10,000 of such services a year, so a small unregistered Swiss business is not a clean B2B sale. |

### B6. Upstream registrar tax statements (outside the five-point lens; spot check)

Gandi ("Only Gandi accounts/organizations with an address in the European Union, Great Britain, or Taiwan are charged the VAT"): confirmed. OpenSRS ("you are responsible for collecting and remitting the correct taxes for your customers' locations. Tucows does not manage tax collection on your behalf"): confirmed, but the sentence is in the Storefront-reseller context. GoDaddy API reseller ("must collect the appropriate sales taxes"; "we reserve the right to assess charges equal to your API reseller account's sales tax liability"): confirmed (the deadline text dates from 2015). Name.com Reseller Agreement tax clause: not re-derived (Chromium returned a 1,362-character shell), unverifiable.

## C. Things the analyst missed

1. The transaction prong matters more than the dollar prong for a $15 product: 200 transactions is about $3,000 of revenue, so in states that kept "or 200 transactions" (AR, DC, GA, HI, MD, MI, MN, NE, NV, NJ, OH, PR, RI, VT, VA, WV, plus WY if Stripe is right) Mosshatch crosses nexus at roughly 3% of the dollar threshold. The dossier states the numbers but not this consequence.
2. Economic nexus for non-sales taxes is unaddressed: Washington B&O uses the same $100,000 gross-receipts nexus (RCW 82.04.067) and applies to service revenue regardless of sales-tax taxability; the Texas Comptroller page also states a $500,000 gross-receipts economic nexus for franchise (margin) tax. Others (Ohio CAT, Oregon CAT) exist. A "sales tax only" ledger will miss these.
3. Stripe Tax fee applies even when the calculated tax is zero (docs), which matters if Mosshatch registers voluntarily in a state where domains are nontaxable.
4. Register for me is also refused where the applicant already received a notice or opened an online account with the state, or acquired a business; non-US owners need EIN and SSN or ITIN.
5. UK accepts alternative evidence of business status; Switzerland's reverse charge depends on registered status or CHF 10,000 a year.
6. Sales Tax Institute's chart (as of 8/1/2026) is a free cross-check that would have exposed the stale 200-transaction entries; conversely, its "gross sales" label is wrong for ME and NJ, so neither aggregator should be used without the statute.
7. Stripe Managed Payments requires an eligible digital PTC and a fully automated product; Paddle asks sellers of products under $10 for custom pricing (relevant to cheap TLDs).
8. The polar.sh acceptable-use URL cited by the analyst now redirects to polar.sh/legal/acceptable-use-policy.
