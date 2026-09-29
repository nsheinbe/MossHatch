# tax-vat: sales tax / VAT / GST on Mosshatch domain registrations (Phase 0)

Research date: 2026-09-29 (every "accessed" date in this file is 2026-09-29). Analyst: research subagent, live-verified. Nothing under /home/user/MossHatch was touched. Raw fetches and helper scripts are in `working-directory/research/tax/`. Finding IDs (S1, U2, E7 ...) refer to the table in section 15; every quote in that table was machine-checked against the cached source text.

## TL;DR

1. Recommended launch: US-only. Block every non-US billing country at checkout until it is registered. Turn on Stripe Tax through Checkout (`automatic_tax`), which costs 0.5% per transaction only in jurisdictions where you hold a registration; threshold monitoring is free (S6b, S7).
2. Stripe Tax calculates but does not register or file on its own. Without a registration it returns zero tax. "Register for me" and TaxJar/Taxually filing need Tax Complete (from $90/month, 1-year contract, 2 registrations and 4 filings per year) (S4, S5, S6a). Stripe has no domain-name product tax code; the code you pick (txcd_10000000 vs txcd_20030000) changes the answer in the EU and in many US states (S2, S10).
3. US: economic-nexus thresholds are mostly $100,000 (or 200 transactions); CA, NY, TX are $500,000; AL and MS $250,000. 22 states count all gross sales, taxable or not, so a domain-only seller can owe registration and zero returns even where domains are not taxed; 9 states count only tangible goods (U2, U3, Appendix A). No state revenue-department page found that names domain registrations, so state-by-state taxability is UNVERIFIED and goes to the accountant.
4. EU: a non-EU seller has no EUR 10,000 de-minimis. B2C services need the Non-Union One-Stop Shop: one registration with a Member State of your choice, quarterly returns, no tax representative (E1, E2, E4, S11). B2B reverse charge should be gated on a VIES-valid VAT ID; the VIES REST API needs no key and answered live on 2026-09-29 (E8, E10). Whether a domain registration is an "electronically supplied service" is not stated in EU or HMRC texts I could reach (E9a, K4, K4b).
5. Other regimes for a non-resident B2C seller: UK registers from the first taxable sale (no threshold); Norway NOK 50,000/12 months; Canada CAD 30,000/12 months (simplified GST/HST, plus Quebec/BC/SK/MB); Australia AUD 75,000; Switzerland CHF 100,000 worldwide and a mandatory Swiss representative; Japan JPY 10 million and a tax agent; India from the first B2C sale (Stripe only) (K1, N1, C1, A1, H1, H2, J1a, J1b, I1).
6. Merchant of record is a poor fit for launch: 5% + 50c (Paddle, Lemon Squeezy, Polar Starter) or 3.5% on top of card fees (Stripe Managed Payments) is about 8% of a $15 domain against a flat-fee promise; none of the four prohibited lists names domain names, but Lemon Squeezy bans "Services of any kind", Paddle and Polar sell to software companies and ban marketplace/reseller categories, and Managed Payments is limited to Checkout/Payment Links with no Connect, Elements or custom domain, which constrains a bespoke agent + passkey flow (M1-M6, S16-S18b).
7. Upstream registrars treat the reseller as the tax collector: OpenSRS says so in words, GoDaddy API resellers must file a resale certificate or be assessed, Name.com passes any tax to the reseller, Gandi charges VAT only to EU/UK/Taiwan addresses (R1-R5).
8. Two traps: Stripe Tax applies reverse charge on tax-ID format alone (S8) and uses one address instead of the EU two-evidence test (S9). Mosshatch must implement its own B2B gate and evidence store.
9. Unverified and why: state DOR positions on domain registration; EU/UK/JP/AU/IN classification of domains; ATO and Indian GST portals (403 / connection reset); explicit MoR stance on domains. WebSearch quota was exhausted (200/200), so discovery relied on known URLs and site APIs (section 16).

## 0. Method and access log

- Fetching: `curl -sSL --http1.1` with the mandated browser User-Agent through the pre-configured proxy (TLS verification never disabled), Stripe docs via their `.md` twins, headless Chromium (Playwright, `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`) for JavaScript pages (canada.ca, name.com policy chunks, Avalara tax-code search, GoDaddy help), `pdfminer.six` in a local venv for PDFs.
- WebSearch: the session quota was used up before I started (200 of 200), so I found sources through known URLs, the GOV.UK search API, the Avalara tax-code API, Stripe's docs index and site navigation. That is why some gaps (state DOR pages on domain names) could not be closed.
- Not reachable, recorded as such: www.ato.gov.au and law.ato.gov.au (HTTP 403 from Akamai, including via Chromium; not worked around); www.gst.gov.in, tutorial.gst.gov.in, www.indiacode.nic.in (connection reset or timeout); taxinformation.cbic.gov.in (TLS certificate error, not bypassed); cbic-gst.gov.in Act pages (HTTP 404); eur-lex.europa.eu (HTTP 202 bot-challenge page, 0 bytes); oecd.org (403); namecheap.com knowledge base (Cloudflare bot challenge). The proxy status endpoint recorded `connect_rejected` (organization egress policy) for `brunhild.challenges.cloudflare.com:443`, a Cloudflare challenge asset host; treated as "blocked by egress policy" and not pursued.
- Where a claim is my own arithmetic or inference rather than a quote, the text says so.
- Assumptions I had to make because the plan does not fix them: a typical order of about $15 for the cost arithmetic; Mosshatch's legal entity domicile and the upstream registrar are not yet decided; no employees or contractors are assumed anywhere (the accountant must confirm physical presence).

## 1. Recommendation and launch-scope options

Recommended: Option A now, decide Option B/C after the accountant answers section 14, and keep the country gate configurable (section 13).

| Option | Scope | Registrations needed on day 1 | Recurring cost/effort | Main risks |
| --- | --- | --- | --- | --- |
| A (recommended) | US customers only (B2C and B2B). Every other billing country blocked with a waitlist message. | None unless Mosshatch has physical presence in a state (home state), or the accountant advises voluntary registration. Otherwise register state by state when a threshold trips (U2, U9, U10). | Stripe Tax monitoring free; 0.5% only where registered (S6b, S7); filing per state (self, TaxJar via Tax Complete, or accountant). | Gross-sales states can trigger registration on nontaxable domain revenue (U3). Over-collection if the PTC is wrong (S2). Define "customer location" as the billing address collected at checkout (section 13, S20), not the registrant contact, so a US buyer registering a domain with a foreign registrant contact is still a US sale. |
| B | A plus verified businesses in supported foreign countries (EU, UK, NO, CA, AU, CH, JP) under reverse charge. Foreign consumers still blocked. | None for foreign B2B sales where the customer accounts for the tax: UK says a seller whose UK sales are all to VAT-registered businesses may not need to register (K2); Switzerland exempts foreign sellers that only make reverse-charge supplies (H3); Norway's VOEC scheme is B2C only and B2B buyers account themselves (N2); Canada's regime only reaches recipients not registered under the normal GST/HST (C3); Australian sales to GST-registered businesses do not count toward the threshold (A1); Japanese B2B electronic services are reverse-charged only if the service is genuinely limited to businesses (J1b, J1c). For the EU, reverse charge applies when a valid VAT ID is provided (E8, E8b), but the sources I reached do not say whether a non-EU seller with only EU B2B sales needs any EU registration (accountant to confirm). | VIES / HMRC / ABR / CRA validation on every order; refusal when the ID is invalid or unavailable. | Need reliable business-status evidence per country; EU lets the supplier treat customers without a VAT ID as consumers, so a B2B claim without a valid ID must be refused (E8). Japan's B2B test depends on the nature or negotiated terms of the service, and a self-serve sign-up is likely B2C even if buyers are businesses (J1c). |
| C | B plus foreign consumers in the EU (Non-Union OSS) and UK (VAT), later NO (VOEC), CA, AU. | EU: 1 OSS registration, no threshold for non-EU sellers (E1, E2). UK: register from first taxable sale (K1). Both before the first consumer sale. | OSS quarterly return (E4), UK quarterly return, 10-year records (E5), Tax Complete or Taxually fees for non-US filing (S6c, S12b). | Depends on domain registration being an electronically supplied service in each place (E9a, K4, K4b); if it is not, EU/UK consumer sales to a US seller would arguably be outside EU/UK VAT and registering would be unnecessary. Get the written opinion first. Need two-evidence store (E7, S9). |
| D | Merchant of record (Stripe Managed Payments, Paddle, Lemon Squeezy, Polar, FastSpring) for everything. | None (MoR registers). | About 8% of a $15 domain (section 12). | Domain names not named on any list, reseller/service/marketplace exclusions apply, Managed Payments constrains a custom agent + passkey checkout (S18), and it breaks the wholesale-plus-flat-fee price promise. Not recommended for launch. |
| E | Self-managed worldwide. | 30+ registrations. | Not sensible for launch. | Switzerland and Japan need local representatives (H2, J1a). |

Cost arithmetic (mine, from quoted rates; assumes a $15 order): Stripe Tax Basic no-code 0.5% = $0.075; Stripe Tax API integration $0.50 = 3.3%; Tax Complete $90 tier covers 200 transactions/month, 2 registrations/year and 4 filings/year, so one state filed quarterly uses all four filing credits; $430 tier covers 1,000 transactions/month. MoR at 5% + 50c = $1.25 = 8.3%; Stripe Managed Payments at 3.5% plus the standard 2.9% + 30c = $1.26 = 8.4%.

## 2. Stripe Tax: what it covers, what it costs, what it does not do

Coverage (S1, Appendix B): 104 rows. The US, UK, every EU member, Canada, Australia, Japan, Norway, Switzerland, Liechtenstein, Singapore, New Zealand, Mexico accept all product tax codes and can be the business location. India is "Digital products" only and only as a customer location. Mosshatch's own business location must be one of the "business location: yes" countries; the company's domicile is not yet known to me, so the head-office setting is an open item.

Product tax code for domain names (S2): none. The complete list (677 codes) contains no "domain" string. Candidates and their consequences:

| Candidate PTC | What Stripe says | Consequence for a domain registration |
| --- | --- | --- |
| txcd_10000000 General - Electronically Supplied Services | "If you stay with this category, taxes will be similar to those for a generic digital item like downloaded music." Stripe also advises picking a more specific category, especially in the US. | US: taxable wherever generic digital goods are taxable (may over-collect where domain registration is a nontaxable service). EU/UK/etc.: taxed in the customer's country (B2C). |
| txcd_10701100 Website Hosting | "A service to enable a customer's website to be accessible on the internet." Digital-product category. | Same digital-product treatment; arguably closer in function, but hosting is not registration, and states treat hosting differently (Texas taxes server space, Washington excludes it from digital automated services; U6, U7). |
| txcd_20030000 General - Services | "EU only: Business-to-consumer sales are taxable at origin; business-to-business are taxable at destination." | EU B2C: taxable in the seller's country, i.e. no EU VAT for a non-EU seller (S10). US: taxed only where general services are taxed. This is the code that flips the EU answer, so it must not be chosen by default. |
| txcd_00000000 Nontaxable | "Any nontaxable good or service which can be used to ensure no tax is applied" | Only if the accountant concludes the product is outside scope everywhere; never as a default. |

Avalara, a comparable engine, has explicit domain codes SW050300 (individual use) and SW050301 (business use), effective 2022-05-01 (S3); the individual/business split shows that taxability differs by buyer type in the US. Stripe's own guidance is to create two Products when one item fits two codes, for example personal versus business use (S19).

Price (S6a, S6b, S6c): Tax Basic 0.5% per transaction on Checkout/Billing/Invoicing/Payment Links, or 50c per transaction through the API (10 calculation calls included, 5c each above that), charged only where you are registered. Tax Complete: $90, $430, $1,000, $1,500 per month (1-year contract) with registrations, calculations and filings included up to the tier limits (Appendix table in S6a); non-US registrations/filings may cost extra. Not charged: threshold monitoring, settings, abandoned Checkout Sessions, credit notes; refunds, voided invoices and chargebacks add no extra fee (S7, S7b).

What Stripe Tax does NOT do:
- It does not register you (Tax Basic). Tax Complete "Register for me" does, for remote US sellers, and Taxually does outside the US (S5, S13, S12b). It needs a US bank account (S13c) in states that charge fees; state fees are listed in the source doc (S13b: AZ $12 + local, CO $16 + $50 deposit, CT $100, HI $20, IN $25, NV $15 + deposit, SC $50, WA $50, WV $30, WI $20, WY $60).
- It does not file or remit unless you buy filing (TaxJar automated filing in all 46 states with a state-level tax on Tax Complete; Taxually/Marosa/Hands-off Sales Tax elsewhere) (S5, S5b, S12a, S12b). "Registration and filing are separate services."
- It returns zero tax wherever you have no registration, so a missing registration is silent (S4).
- It applies reverse charge when a tax ID has the right format, whatever the government check says (S8); it validates EU VAT (VIES), GB VAT (HMRC) and ABN (ABR) numbers but leaves `unverified`/`unavailable` handling and name/address matching to you (S8b).
- It uses one address as the customer's location instead of the EU's two items of non-contradictory evidence (S9); in Checkout it uses the address collected in the session (S20).
- Its threshold monitor is advisory and counts only Stripe-processed sales against your preset tax code (S15, S15b).
- Tax behavior 'Automatic' makes USD and CAD prices tax-exclusive and every other currency tax-inclusive; you cannot change exclusive/inclusive on a Price once set, so create separate Prices per market if EU/UK is added (S14).

## 3. United States

3.1 Nexus. Since South Dakota v. Wayfair (2018) physical presence is not required for a state to require collection; South Dakota's own law covered sellers delivering more than $100,000 of goods or services or making 200 or more transactions (U1, U1b). A seller has nexus through physical presence (remote employee, inventory) or economic activity (U9). Physical nexus is immediate and ignores thresholds; ask the accountant where founders/contractors sit. Thresholds per state are in Appendix A (source: Stripe's per-state pages, accessed 2026-09-29; an aggregator, not the individual state revenue departments). Summary: $100,000 in most states, some with "or 200 transactions" (AR, DC, GA, HI, ME, MD, MI, MN, NE, NV, NJ, NC, OH, PR, RI, VT, VA, WV, WY per Stripe) and CT "$100,000 and 200 transactions"; $500,000 in CA and TX; NY $500,000 and 100 transactions; $250,000 in AL and MS; no general state sales tax in DE, MT, NH, OR (AK has local taxes only).

3.2 What counts toward the threshold matters more for Mosshatch than the number (U3, U3b, Appendix A). Because Mosshatch sells no tangible goods:
- 22 states count gross sales including nontaxable revenue (AK, AZ, HI, ID, IN, IA, KY, LA, MA, MI, MS, NC, PA, SC, SD, TX, UT, VT, WA, WV, WI, WY) and 5 count retail sales including nontaxable services (CO, CT, DC, NE, and probably TN). A domain-only seller can cross these thresholds even if domain registration is nontaxable there, and Stripe notes this "might require businesses that sell only nontaxable goods or services register and file a zero or information tax return".
- 9 states count only tangible personal property (AL, CA, FL, GA, IL, MO, NV, NY, OK) per Stripe, so domain revenue does not create economic nexus there.
- 12 count only taxable sales, so it depends on the taxability answer (AR, KS, ME, MD, MN, NJ, NM, ND, OH, PR, RI, VA).
This is Stripe's reading of each state; the accountant should confirm against the statutes before relying on it.

3.3 Taxability of domain registration: UNVERIFIED state by state. What I could verify:
- No state revenue-department page I could reach names "domain name registration". The only official text found is a 1997 New York advisory opinion that treated web-design charges, including passed-through domain registration fees, as outside New York's enumerated services (U5; old, narrow facts, low weight).
- Texas taxes "creating web (home) page and providing server space" as data processing (U6) but does not list domain registration; Washington excludes web hosting from digital automated services (U7) and does not mention domain registration.
- Tax engines treat it as a distinct item that can differ for individuals and businesses (Avalara SW050300/SW050301, S3). Stripe has no such code (S2).
- Stripe's US state pages show which states tax "specified digital products" or "digital products, software" in their nexus base (New Jersey, Rhode Island) and which use broad service taxes, but they do not say how domain registration is treated.
Consequence: do not let a default PTC decide. The accountant must decide the treatment for (a) new registration, (b) renewal, (c) transfer-in, (d) any bundled vault/creature service (bundled or multiple supplies), in the home state and each state as it comes into scope.

3.4 Marketplace facilitators. Every sales-tax state and DC has a marketplace facilitator law (U4). Mosshatch contracts with the registrant in its own name, so it is the seller, not a facilitator. It would only meet the concept if it interposed third-party sellers. If a MoR were interposed, the MoR is the seller and collects (section 12). Verdict: not relevant to launch; revisit if Mosshatch ever lists third-party sellers (aftermarket, agents acting for others).

3.5 Mechanics. Register before collecting (U10). The 24 SSUTA states share one registration portal (U8). Grace periods after crossing a threshold vary from "when the threshold is exceeded" to the first of the next quarter or January 1 of the following year (Appendix C). Filing: TaxJar via Stripe in 46 states (S12a) or accountant. Filing frequency (monthly/quarterly/annual) is set by each state and changes with volume. "Register for me" needs no physical presence in that state (S13).

3.6 Upstream purchases and resale certificates (R2-R5). GoDaddy's API reseller programme requires resellers to collect tax from their customers and to file a Uniform Sales and Use Certificate or state reseller certificate, otherwise GoDaddy may assess the reseller's tax liability itself (R4, R4b). Name.com's Reseller Agreement passes to the reseller any sales, use, VAT or similar tax Name.com must pay on the reseller's use (R5). So the reseller must (i) know which upstream registrar it will use, (ii) hold resale certificates where the registrar's home state taxes domain sales, (iii) treat any upstream tax as a cost. Which registrar Mosshatch uses is decided elsewhere in Phase 0; the accountant needs that name.


## 4. European Union (non-EU seller)

- B2C services: Non-Union One-Stop Shop (E1). Any non-EU taxable person supplying services to non-taxable persons in the EU can register in one Member State of its choice (E1d); that state issues an EU-format number that works only for this scheme (E1b). The intermediary requirement applies only to the import scheme (E1c); Stripe also says no tax representative is needed (S11). A seller could instead register in each Member State, which is not sensible.
- No de-minimis: the EUR 10,000 place-of-supply threshold "does not apply to ... supplies of TBE services made by a supplier not established in the EU" (E2). Registration is needed from the first consumer sale.
- Timing (E3, E3b): normally effective from the first day of the calendar quarter after you tell the Member State; if you start supplying earlier you may use the scheme from the first supply provided you inform the Member State by the 10th day of the month after that first supply, otherwise you must register and account in each Member State of consumption. Today is 2026-09-29, so an application made now takes effect 2026-10-01.
- Returns (E4): one return per calendar quarter, including nil returns, submitted with payment by the end of the month after the quarter (31 Jan, 30 Apr, 31 Jul, 31 Oct), in euro converted at the ECB rate on the last day of the period (E4b). Records: 10 years (E5). Invoices: not mandatory under the non-Union scheme; if issued, the Member State of identification's rules apply (E6).
- Customer location (E7, E7b, E7c): for B2C electronic services with no special presumption, location is the place identified from two items of non-contradictory evidence, and the items must be independent (billing address plus self-certification of the same address counts once; an IP address and its geolocation count once; bank details confirmed by the payment provider count once). Stripe Tax does not implement this; it uses one address and stores the evidence on the Customer (S9). Mosshatch needs its own second item (for example card issuing country or IP country) and must retain both for 10 years.
- B2B (E8, E8b, E10, S8, S8b): a supplier of electronic services may treat a customer without a VAT ID as a consumer (E8), and a communicated VAT ID lets it regard an EU customer as a taxable person (E8d), i.e. reverse charge. Stripe Tax applies reverse charge on a well-formed ID (S8), so Mosshatch should call VIES itself before allowing the exemption. VIES REST API: `POST /check-vat-number`, `POST /check-vat-test-service`, `GET /check-status` under `https://ec.europa.eu/taxation_customs/vies/rest-api/`, no key; on 2026-09-29 the test endpoint answered `valid: true` for the documented test number and `check-status` returned `vow.available: true` with per-country availability. Requests can carry trader name and address to get match flags (swagger definition `CheckVatRequest`); the swagger text says a `requestIdentifier` is retrievable only when requester member state code and number are supplied, which a non-EU seller may not have, so store the full response and timestamp as the audit record.
- Classification (E9a, E9b): the legal list names "Website supply, web-hosting, distance maintenance of programmes and equipment"; domain names are not named in the Commission's 2015 e-services notes, the 2003 VAT Committee guide or the 2026 OSS notes. The 2003 VAT Committee test says an electronically supplied service includes "a service which provides, or supports a business or personal presence on an electronic network (e.g., web site or web page)". A domain registration plausibly fits, but that is inference; national tax administrations may differ. The answer decides whether B2C sales to EU consumers by a US seller carry EU VAT at all.
- Watch: ViDA (E11). The revised notes (24 July 2026) add changes effective 1 January 2027 (SME-scheme interaction, OSS refund procedures); more Single VAT Registration changes are essentially effective 1 July 2028. I found no change to non-Union eligibility.

## 5. United Kingdom

- A non-established taxable person has no registration threshold: it must register for any taxable supply of any value, including digital services (K1, K7). Contrast the GBP 90,000 threshold for established businesses (K9). Tell HMRC within 30 days of becoming liable (K7). Stripe: no UK registration through the EU OSS (K6).
- If the domain registration is a digital service, supplies to UK consumers are liable to UK VAT and an overseas supplier must register (K3). If it is not, the B2C general rule places the supply where the supplier belongs (K4), i.e. outside UK VAT for a US seller. HMRC's list of e-services names "website supply or web hosting services" but not domain names (K4b).
- B2B: an overseas seller whose UK sales are all to VAT-registered businesses that reverse-charge may not need to register (K2).
- HMRC can direct an NETP to appoint a UK VAT representative or pay a security (K5); otherwise an agent is optional.
- Validate GB VAT numbers with HMRC's service (Stripe does this automatically; S8b). I did not fetch HMRC's API documentation.

## 6. Canada

- Non-resident vendors selling digital products or services to Canadians must register for the simplified GST/HST regime once revenue from specified supplies exceeds CAD 30,000 over any 12-month period; specified supplies are generally taxable supplies of intangible personal property or services, so a domain registration falls in scope (C1, C2). 
- B2B: recipients that prove normal GST/HST registration are outside the regime (C3). Simplified regime: quarterly reporting, return due within one month after the quarter, no security deposit, USD or EUR reporting can be designated (C4, C4b, C6).
- Provincial layers per Stripe (medium confidence, C5): Quebec QST (specified regime for digital sales to Quebec individuals, threshold 30,000 CAD rolling), BC PST (10,000 CAD), Saskatchewan PST and Manitoba RST (1 transaction). Stripe's tax page says remote sellers may need up to five registrations in Canada (C7).

## 7. Australia

Stripe: register when sales of services to Australian individuals exceed AUD 75,000 in 12 months; sales to GST-registered businesses with an ABN are reverse-charged and do not count (A1). The ATO's own pages returned 403 to automated access and the GST Act on legislation.gov.au returned only a table of contents, so the primary text is unverified.

## 8. India (OIDAR)

Stripe: no registration threshold; register for IGST from the first B2C sale; non-resident sales to business customers do not trigger obligations; Stripe supports India only for digital products and only for remote sellers (I1, S1). Primary Indian sources (gst.gov.in, indiacode.nic.in, CBIC Act pages) were unreachable, so the statutory text and whether a domain registration is an OIDAR service are unverified.

## 9. Japan

Consumption tax on cross-border electronic services: B2C, the provider files and pays; B2B, the Japanese customer reverse-charges; foreign businesses without a Japan office must designate a Tax Agent; the exemption threshold is JPY 10 million taxable sales in the base period, excluding B2B electronic services (J1a, J1b). The NTA's examples of electronic services are e-books, newspapers, music, video, software, cloud software and storage, advertising and internet shopping platforms; domain registration is not named (J1d). A self-serve service that says "for business use" but cannot effectively restrict consumers is B2C, and B2C electronic services include those received by businesses (J1c), so a B2B-only Japan scope is impractical for a self-serve registrar. Skip Japan at launch.

## 10. Switzerland

Liable once worldwide turnover from taxable or zero-rated supplies reaches CHF 100,000 and supplies are made in Switzerland (H1). A Swiss tax representative is mandatory and online registration is impossible without one (H2). Foreign sellers that only make reverse-charge supplies are exempt (H3). Conflict on security: the Federal Tax Administration says it generally no longer requires a security (H4); Stripe's page says a cash or bank guarantee is needed (H5). Both accessed 2026-09-29; the tax authority's page is the more authoritative. Skip Switzerland at launch.

## 11. Norway

VOEC scheme: foreign businesses selling remotely deliverable services (including electronic services) to Norwegian consumers register at the latest when B2C sales reach NOK 50,000 in 12 months, and may register from the first sale (N1). B2B is outside VOEC: do not charge VAT to a business, and the seller need not prove the buyer is a business if the buyer says so (N2). Quarterly return and payment by the 20th of the month after the quarter (20 Jan, 20 Apr, 20 Jul, 20 Oct) (N2b). VOEC's scope is "remotely deliverable services, including electronic services" (N2c); domain names are not named. Stripe adds that non-EEA sellers otherwise need a Norwegian VAT representative (N3).

## 11A. Summary of non-US regimes for a non-resident B2C digital seller

| Jurisdiction | Registration trigger | Representative / security | Filing | B2B treatment | Stripe Tax |
| --- | --- | --- | --- | --- | --- |
| EU (27) | First consumer sale; no threshold for non-EU sellers; one Non-Union OSS registration (E1, E2) | None (E1, S11) | Quarterly, end of following month; 10-year records (E4, E5) | Reverse charge with valid VAT ID (E8, E8b) | Yes, add OSS registration (S1) |
| UK | First taxable sale; no threshold (K1, K7) | Optional; HMRC may direct rep or security (K5) | VAT returns, usually every 3 months (K8) | Reverse charge to VAT-registered business; B2B-only sellers may not register (K2) | Yes, separate from EU OSS (K6) |
| Norway | NOK 50,000 / 12 months (VOEC) (N1) | None under VOEC (N3) | Quarterly, 20th (N2) | Not charged; no proof needed (N2) | Yes (S1) |
| Canada | CAD 30,000 / 12 months, simplified GST/HST (C1) plus QC / BC / SK / MB (C5) | No representative requirement found; no security deposit (C4) | Quarterly, one month (C4, C6) | Registrants outside regime (C3) | Yes (S1) |
| Australia | AUD 75,000 / 12 months (A1) | not verified | not verified | ABN / GST-registered outside threshold (A1) | Yes (S1) |
| Switzerland | CHF 100,000 worldwide (H1) | Swiss representative mandatory (H2); security disputed (H4, H5) | not verified | Reverse-charge-only sellers exempt (H3) | Yes (S1) |
| Japan | JPY 10M base period (J1b) | Tax Agent required (J1a) | not verified | Reverse charge; excluded from threshold (J1b) | Yes (S1) |
| India | First B2C sale; no threshold (I1) | not verified | not verified | Not triggered by B2B (I1) | Digital products only, customer location only (S1) |

## 12. Merchant-of-record options

| Provider | Fee (as published) | Domain names on prohibited list? | Signals that matter for a domain reseller | Findings |
| --- | --- | --- | --- | --- |
| Stripe Managed Payments | 3.5% per successful transaction on top of Payments fees (2.9% + 30c standard card) | Not named. Eligible tax codes include txcd_10000000 and txcd_10701100; categories include "electronically supplied business and web services, such as website hosting". | Must sell "directly to customers, not through a platform or marketplace"; no Connect, no Elements/advanced integrations, no subscriptions outside Checkout/Payment Links, no third-party tax integration, no custom domain on checkout; customer sees Link as merchant of record; business must be based in a listed country. | S16, S17a, S17b, S17c, S18, S18b, S18c |
| Paddle | 5% + 50c per Checkout transaction | Not named (policy last updated 13 April 2026) | "built to serve software companies"; prohibits "Reseller Products" and "resale of any product without a valid reseller certificate"; prohibits products that enable non-Paddle sellers to sell. | M1, M2a, M2b, M2c |
| Lemon Squeezy | $0.50 + 5% of total + 1.5% international payment (example: $1.67 on a $15 order with 20% VAT) | Not named, but "Services of any kind (including marketing, design, web development, consulting ...)" and "Marketplaces" are prohibited; site banner announces a 2026 tie-up with Stripe Managed Payments (M3c) | Domain registration is arguably a service; ask before applying. | M3, M3b, M4 |
| Polar | Starter 5% + 50c (+1.5% international cards); Pro $20/mo 3.8% + 40c; Growth $100/mo 3.6% + 35c; Scale $400/mo 3.4% + 30c | Not named (AUP effective 25 March 2026) | "Polar serves software companies"; prohibits marketplaces and products that enable non-Polar sellers; "Reselling software licenses without authorization". | M5a, M5b, M5c, M5d |
| FastSpring | Not published ("Get your pricing quote") | No public prohibited list found | Positioned for "SaaS, software, and digital goods". | M6 |

Reading: no list forbids "domain names" by name, so "allowed?" is unanswered for all five; each would need written pre-approval. The percentage fee (about 8% of a $15 domain) also conflicts with a flat-fee promise, and a MoR is the merchant on the receipt, which changes the ICANN registrant-facing contract picture (lawyer item in section 14). Marketplace-facilitator law is what a MoR/marketplace would be caught by (U4).

## 12A. How upstream registrars invoice a reseller

| Registrar | Statement | Effect on Mosshatch | Finding |
| --- | --- | --- | --- |
| Gandi (France) | VAT charged only to accounts with an address in the EU, Great Britain or Taiwan; US and rest of world not charged; EU business outside FR/LU can present an intra-community VAT number to avoid VAT | A US reseller account is invoiced without VAT; an EU/UK-domiciled Mosshatch entity would pay VAT (possibly recoverable; accountant to confirm) | R1, R1b |
| OpenSRS (Tucows, Canada) | Storefront resellers are "responsible for collecting and remitting the correct taxes for your customers' locations. Tucows does not manage tax collection on your behalf." Canadian resellers are subject to GST / HST on funding | Mosshatch collects from its customers; only a Canadian reseller is taxed upstream | R2, R3 |
| GoDaddy API reseller | Resellers must collect the appropriate sales taxes from their customers; submit a Uniform Sales and Use Certificate or state reseller certificate; otherwise GoDaddy may assess charges equal to the reseller's sales tax liability. (Help article; the deadline text dates from 2015 but the page is live.) | Resale certificates are part of onboarding | R4, R4b |
| Name.com | Reseller Agreement: fees exclude taxes; the reseller pays sales, use, VAT etc. that Name.com must pay on the reseller's use | Potential pass-through if Name.com's home state taxes the sale; ask for resale-exempt treatment | R5 |
| Namecheap, Dynadot | No primary tax statement found (Namecheap KB behind a Cloudflare challenge; Dynadot help index has no tax article) | Unverified | none |

In every case the reseller is the customer of the registrar (B2B) and the seller of record to the end customer; upstream registrars do not collect tax on the reseller's end sales (R2, R4 state this outright; R1 and R5 are consistent with it). Whether the wholesale price can be shown as a disbursement is a separate question; HMRC's disbursement test requires that the payer acted as the customer's agent, the customer received the service and knew another supplier provided it, which a reseller in its own name does not meet (R6; accountant to confirm).

## 13. Design implications for the Mosshatch build

1. Country gate as data: a `tax_regions` table (`country`, `status` in supported | b2b_only | blocked, `registration_id`, `effective_from`) that checkout reads at request time; ship with US = supported, all else blocked. Reject before creating a Stripe Checkout Session.
2. Customer location = billing address collected in Checkout (`billing_address_collection: required`), because that is the address Stripe Tax uses in Checkout (S20). Record billing country, IP country and card issuing country on every order. Do not use the registrant contact country as the tax location.
3. Use Checkout with `automatic_tax` (0.5%) rather than the Tax API (50c per transaction, S6b). If the human-approval screen needs an exact tax-inclusive total before the passkey step, check with Stripe whether Calculations API previews are billed separately when the payment later completes in Checkout (unverified; the docs list API calculations as billable in registered jurisdictions, S21).
4. B2B path (needed for Option B/C): collect tax ID with `tax_id_collection`, validate server-side (VIES for EU, HMRC for GB, ABR for ABN, CRA for GST/HST) before setting the customer tax-exempt/reverse-charge; store validation payload, timestamp and status; if `unavailable`, hold the order rather than trusting Stripe's format-only reverse charge (S8).
5. Evidence store with 10-year retention (E5) and a GDPR-reviewed purpose for the IP and card-country data.
6. Product model: separate Stripe Products (and PTCs) for registration, renewal, transfer, and any bundled vault/creature item so the accountant can assign codes independently; make the PTC a config value, not code. Do not ship with txcd_10000000 or txcd_20030000 by default (S2, S10).
7. Price display: USD tax-exclusive in the US. If EU/UK are added, create separate inclusive Prices for those markets (S14); you cannot flip a Price later.
8. Agent boundary: agent tokens must never be able to change billing country, tax ID or tax status; those edits need a passkey-approved human action, because they change tax outcomes.
9. Refunds and deletions within grace windows must use Stripe refunds/credit notes so the tax transaction reverses (no extra Stripe Tax fee, S7b).
10. Threshold tracker: keep a rolling 12-month sales ledger by state that counts gross sales for the 22 gross-sales states, in addition to Stripe's monitor (which uses your preset PTC and Stripe-processed sales only; S15, U3).
11. Keep upstream invoices and any resale certificates linked to the purchase records (section 12A).
12. Abstract the tax provider behind an interface so a future MoR or Taxually/Avalara swap does not touch checkout code.


## 14. What the accountant or lawyer must confirm

Accountant (US sales and use tax):
1. Physical presence today: which states have founders, employees, contractors, equipment or inventory (and whether hosted infrastructure or AI-agent activity counts anywhere). Physical presence means registering there before the first sale, whatever the thresholds (U9).
2. A written taxability position, per state as each comes into scope (home state first, then the gross-sales states), for: new registration, renewal, transfer-in, and any bundled vault / creature / agent-token features, for both consumers and businesses. Then the matching Stripe product tax code for each (txcd_10000000, txcd_10701100, txcd_20030000 or txcd_00000000), and what happens if tax was collected in a state where the item turns out to be nontaxable.
3. Whether to register voluntarily before a threshold (home state; the 24-state Streamlined portal), and how to monitor the 22 gross-sales states and 5 retail-sales states where nontaxable revenue counts and zero or information returns may be due (U3).
4. Resale-certificate treatment of purchases from the chosen upstream registrar (which certificate form; which states), and treatment of any tax the registrar charges (R4, R5).
5. Filing set-up: who files (TaxJar through Tax Complete, or the accountant), frequency by state, the US bank account needed for state fees and remittance (S13c, S12a).
6. Principal versus agent on the domain sale: tax base is the full price if Mosshatch is the seller; whether any part of the wholesale cost can be a disbursement (section 12A).
7. Corporate domicile and Stripe head-office setting; whether Mosshatch is a "remote seller" in each state; Register-for-me eligibility for non-US owners (SSN / ITIN / EIN conditions in the Stripe doc) (S13).

EU / UK / other VAT advisor:
8. A written opinion on whether a domain registration is an electronically supplied service (EU Regulation 282/2011 Art. 7 and Annex I) and a digital service for UK VAT, for consumer and business buyers. This decides whether Option C is needed at all and how Option B is documented (E9a, E9b, K4). Same question for Norway, Australia, Canada, Japan, India.
9. If yes: pick the Member State of identification for the Non-Union OSS; timing (effective next quarter, or from first supply if notified by the 10th of the next month) (E3); who prepares the quarterly returns (E4); UK registration within 30 days and agent versus representative, and the security risk (K5, K7).
10. B2B acceptance standard: only a VIES / HMRC "valid" result? Behaviour when the service is unavailable; whether name/address matching is required; what to do when a customer supplies a VAT ID after purchase (EU notes contemplate refunding VAT and adjusting the OSS return, E8c); acceptance of Norwegian self-declaration (N2) and Canadian registrant evidence (C3).
11. Evidence rules for consumer location (two independent items, E7 / E7b), retention for 10 years (E5), and how that sits with data-protection law.
12. Whether to keep CH, JP, IN, AU, CA, NO blocked until volume justifies the cost of a Swiss representative (H2), a Japanese Tax Agent (J1a), Canadian multi-province registrations (C5) and others.

Lawyer:
13. Price display and marketing: US tax-exclusive prices versus consumer-law rules requiring tax-inclusive prices elsewhere; whether "one flat fee, no upsells" copy is accurate once tax is added at checkout.
14. ICANN / registrar flow-down: who is the seller and registrant-facing contracting party when Mosshatch resells an upstream registrar's service, and whether a merchant of record can sit in that chain; refund and deletion-grace rules and the tax consequences of refunds.
15. Receipt and invoice content required in each supported jurisdiction (tax ID display, reverse-charge wording, VAT invoice for UK B2B) and retention.

## 15. Findings table (all quotes machine-checked against cached source text; all accessed 2026-09-29)

| ID | Claim | Value | Source URL | Accessed | Short quote | Confidence |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Stripe Tax calculates tax in 104 listed jurisdictions; US, UK, all EU states, CA, AU, JP, NO, CH, SG, NZ, MX accept all product tax codes and can be the business location; India (IGST) is digital-products-only and customer-location-only | 104 rows; IN = Digital products, business location not supported | https://docs.stripe.com/tax/supported-countries | 2026-09-29 | "Stripe can calculate tax on sales in the locations listed in the table below." | high |
| S2 | Stripe's product tax code list has no domain-name category; nearest are txcd_10000000 General - Electronically Supplied Services (digital-goods treatment), txcd_10701100 Website Hosting and txcd_20030000 General - Services | no 'domain' string anywhere in the 677-code list (grep, 2026-09-29) | https://docs.stripe.com/tax/tax-codes | 2026-09-29 | "If you stay with this category, taxes will be similar to those for a generic digital item like downloaded music." | high |
| S3 | Avalara (Stripe-adjacent tax engine) models domain registration as its own code with separate individual-use and business-use variants | SW050300 (individual use), SW050301 (business use), both effective 2022-05-01 | https://taxcode.avatax.avalara.com/search?q=domain | 2026-09-29 | "This represents the service of registering and maintaining an internet domain name for a customer (registrant)" | high |
| S4 | Stripe Tax only calculates tax where an active registration exists; otherwise the result is zero tax | zero tax without registration | https://docs.stripe.com/tax/tax-codes | 2026-09-29 | "Without a registration in the customer’s location, the calculation returns zero tax." | high |
| S5 | Registration and filing are separate services; even Tax Complete 'Register for me' does not prepare returns or remit tax | registration != filing != remittance | https://docs.stripe.com/tax/filing | 2026-09-29 | "Register for me doesn’t prepare returns or remit tax." | high |
| S6a | Tax Complete plan price and entitlements | from $90/mo, 1-year contract (2 registrations/yr, 200 tx/mo, 4 filings/yr); $430 (4 reg, 1,000 tx, 12 filings); $1,000 (6, 2,500, 20); $1,500 (10, 5,000, 32); above that contact sales | https://stripe.com/tax/pricing | 2026-09-29 | "Starting at $90 per month with registrations, calculations, and filings included" | high |
| S6b | Tax Basic pay-as-you-go pricing: 0.5% per transaction on Checkout/Billing/Invoicing/Payment Links (no-code) or 50 cents per transaction via API, charged only where registered | 0.5% no-code; $0.50/tx API (+5c per calculation call above 10) | https://stripe.com/tax/pricing | 2026-09-29 | "Each transaction includes 10 calculation API calls. 5¢ per calculation API call above 10." | high |
| S6c | Tax Complete fees outside the US may be extra | additional registration/filing fees possible | https://stripe.com/tax/pricing | 2026-09-29 | "Additional fees may apply for registrations and filings outside of the US, or if you exceed your plan’s limits." | high |
| S7 | Stripe does not charge for threshold monitoring (the Tax fee applies to calculations on live transactions in registered jurisdictions) | no fee for threshold monitoring | https://docs.stripe.com/tax/how-tax-works | 2026-09-29 | "Monitor tax thresholds based on your past Stripe payments" | high |
| S8 | Stripe Tax applies reverse charge/zero rate when a tax ID merely has the right format, whatever the government verification result: Mosshatch must gate B2B itself | reverse charge on format only | https://docs.stripe.com/invoicing/customer/tax-ids | 2026-09-29 | "If you use Stripe Tax, Stripe Tax applies the reverse charge or zero rate according to applicable laws when the tax ID has the required number format, regardless of the government verification result." | high |
| S9 | For EU digital services Stripe Tax uses a single address, not the EU's two-items-of-non-contradictory-evidence test (it stores the evidence on the Customer) | single-address location logic | https://docs.stripe.com/tax/supported-countries/european-union | 2026-09-29 | "as the customer’s location when calculating tax instead of comparing two pieces of non-conflicting evidence." | high |
| S10 | Choice of product tax code flips EU B2C treatment: 'Other services' (e.g. txcd_20030000) are taxable in the seller's country for individuals (i.e. no EU VAT for a non-EU seller); digital services are taxable in the customer's country | PTC choice changes EU B2C outcome | https://docs.stripe.com/tax/supported-countries/european-union | 2026-09-29 | "Taxable in the country your business is based in when provided to individuals." | high |
| S11 | Non-Union OSS needs no tax representative (Stripe) | no representative for non-Union OSS | https://docs.stripe.com/tax/supported-countries/european-union | 2026-09-29 | "You don’t need to appoint a tax representative to use the OSS non-Union scheme." | high |
| S12a | Stripe automated US filing via TaxJar covers all 46 states with a state-level sales tax | 46 locations | https://docs.stripe.com/tax/file-with-stripe | 2026-09-29 | "Automated US filing is available in all 46 US locations with a state-level sales and use tax." | high |
| S12b | Outside the US, filing is via partners (Taxually, Marosa, Hands-off Sales Tax) | 3 partners | https://docs.stripe.com/tax/how-tax-works | 2026-09-29 | "For regions outside the US, Stripe Tax has filing partners—Taxually, Marosa, and Hands-off Sales Tax (HOST)—to help automate your tax filing." | high |
| S13 | 'Register for me' is only for remote, out-of-state sellers with no physical presence in the state you want to register in | eligibility condition | https://docs.stripe.com/tax/use-stripe-to-register | 2026-09-29 | "Be a remote, out-of-state seller with no physical presence in the state you want to register in." | high |
| S14 | Tax behavior 'Automatic' makes USD and CAD prices tax-exclusive and all other currencies tax-inclusive | USD/CAD exclusive; others inclusive | https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior | 2026-09-29 | "This selects exclusive pricing for USD and CAD and inclusive pricing for all other currencies" | high |
| S15 | Stripe's threshold monitor only flags potential obligations; the seller must confirm | advisory only | https://docs.stripe.com/tax/monitoring | 2026-09-29 | "The threshold monitoring tool highlights potential registration obligations, but it’s up to you to confirm whether registration is actually required in each jurisdiction." | high |
| S16 | Stripe Managed Payments (Stripe as merchant of record) fee | 3.5% per successful transaction on top of Payments fees (Standard card fee is 2.9% + 30c) | https://stripe.com/pricing | 2026-09-29 | "3.5% per successful Managed Payments transaction in addition to Payments fees" | high |
| S17a | Managed Payments requires the seller to sell directly to customers, not through a platform or marketplace; domain registrations are not named among eligible products | domain names not named | https://docs.stripe.com/payments/managed-payments/eligibility | 2026-09-29 | "You sell the product directly to customers, not through a platform or marketplace." | medium |
| S17b | Managed Payments product categories include electronically supplied business and web services such as website hosting | eligible PTCs include txcd_10000000 and txcd_10701100 | https://docs.stripe.com/payments/managed-payments/eligibility | 2026-09-29 | "Electronically supplied business and web services, such as website hosting" | high |
| S18 | Managed Payments does not support Connect, embeddable components/advanced integrations, invoice items or one-off invoices on its subscriptions, subscriptions created outside Checkout or Payment Links, or third-party tax integrations | constrains a bespoke agent/passkey checkout (my inference) | https://docs.stripe.com/payments/managed-payments | 2026-09-29 | "Managed Payments doesn’t support:" | high |
| S18b | Managed Payments checkout cannot use the merchant's custom domain | no custom domains | https://docs.stripe.com/payments/managed-payments/how-it-works | 2026-09-29 | "Custom domains aren’t supported on Managed Payments checkouts." | high |
| U1 | South Dakota's law (the one the Court examined in Wayfair) reached sellers delivering more than $100,000 of goods or services or making 200 or more transactions | $100,000 or 200 transactions (original SD law) | https://www.supremecourt.gov/opinions/17pdf/17-494_j4el.pdf | 2026-09-29 | "deliver more than $100,000 of goods or services into the State or engage in 200 or more separate" | high |
| U2 | Economic nexus thresholds mostly $100,000 (sometimes 'or 200 transactions'); California, New York and Texas $500,000; Alabama and Mississippi $250,000 | see Appendix A (52 rows) | https://docs.stripe.com/tax/supported-countries/united-states/collect-tax?tax-jurisdiction-united-states=texas | 2026-09-29 | "Remote sellers must register to collect and remit sales tax in Texas when, in the prior twelve months, they meet or exceed a sales threshold of 500,000 USD." | high |
| U3 | Some states count nontaxable sales toward nexus, which can force a registration and zero/information returns even when the product is nontaxable | e.g. Arizona, Indiana, North Carolina | https://docs.stripe.com/tax/monitoring | 2026-09-29 | "include nontaxable sales in their threshold calculations" | high |
| U3b | In several states the nexus threshold counts only tangible personal property and excludes services (California example); a services/digital-only seller may never reach nexus there | AL, CA, FL, GA, IL, MO, NV, NY, OK (per Stripe docs) | https://docs.stripe.com/tax/supported-countries/united-states/collect-tax?tax-jurisdiction-united-states=california | 2026-09-29 | "The threshold excludes sales of services, whether taxable or nontaxable." | high |
| U4 | Marketplace facilitator laws exist in every sales-tax state plus DC (relevant if a MoR/marketplace were interposed; Mosshatch sells in its own name) | all sales-tax states + DC | https://docs.stripe.com/tax/supported-countries/united-states | 2026-09-29 | "marketplace facilitator laws now exist in every state and territory with a sales tax, as well as the District of Columbia" | high |
| U5 | New York 1997 advisory opinion: web-design charges including passed-through domain registration fees not subject to sales tax (old, narrow facts; not a current ruling on standalone registrations) | TSB-A-97(87)S, 29 Dec 1997 | https://www.tax.ny.gov/pdf/advisory_opinions/sales/a97_87s.pdf | 2026-09-29 | "is not included among the enumerated services that are subject to New York State and local sales and compensating use taxes" | low |
| U6 | Texas taxes 'creating web (home) page and providing server space' as data processing; domain registration is not listed either way | domain registration not addressed | https://comptroller.texas.gov/taxes/publications/94-127.php | 2026-09-29 | "Internet services: creating web (home) page and providing server space." | medium |
| U7 | Washington excludes web hosting from 'digital automated services'; domain registration is not mentioned | domain registration not addressed | https://app.leg.wa.gov/WAC/default.aspx?cite=458-20-15503&full=true | 2026-09-29 | "This exclusion includes providing space on a server for web hosting or backing-up data or other information." | medium |
| U8 | 24 states are Streamlined Sales Tax members and share one registration portal | 24 SSUTA states | https://docs.stripe.com/tax/supported-countries/united-states | 2026-09-29 | "Twenty-four US states are members of the SSUTA agreement." | high |
| U9 | Physical presence (remote employees, inventory) creates nexus regardless of sales thresholds | physical nexus = immediate obligation | https://docs.stripe.com/tax/supported-countries/united-states | 2026-09-29 | "Physical activity, such as having remote employees based there or storing inventory in a warehouse." | high |
| U10 | In the US you must register in a state before collecting sales tax there | register first, then collect | https://docs.stripe.com/tax/use-stripe-to-register | 2026-09-29 | "In the US, you must register in a state before collecting sales tax there." | high |
| E1 | Non-Union OSS is open to any non-EU taxable person supplying services to non-taxable persons in the EU | B2C services in all 27 Member States through one registration | https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/register-oss_en | 2026-09-29 | "Any taxable person, not established in the EU, who supplies services to non-taxable persons taking place in the EU, can register in the non-Union scheme." | high |
| E2 | The EUR 10,000 micro-seller threshold does not apply to suppliers established outside the EU | no de-minimis for non-EU sellers | https://vat-one-stop-shop.ec.europa.eu/document/download/774b31ca-03c6-4fb1-8209-9e447aeeb1e9_en?filename=Explanatory%20Notes_revised_1Jan2027_0.pdf | 2026-09-29 | "supplies of TBE services made by a supplier not established in the EU (non-Union scheme)" | high |
| E3 | OSS registration normally takes effect on the first day of the calendar quarter after the seller informs the Member State of identification | quarter start | https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/register-oss_en | 2026-09-29 | "will take effect from the first day of the calendar quarter following that in which the taxable person informs the Member State of identification" | high |
| E4 | OSS returns are quarterly, due (with payment) by the end of the month after the quarter, nil returns required | Jan 31 / Apr 30 / Jul 31 / Oct 31 | https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en | 2026-09-29 | "required to be submitted by the end of the month following the tax period covered by the return." | high |
| E5 | OSS records must be kept 10 years | 10 years from end of year of supply | https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/record-keeping-and-audits-oss_en | 2026-09-29 | "These records must be kept for 10 years from the end of the year in which the transaction was made" | high |
| E6 | Under the non-Union scheme an invoice is not mandatory; if issued, the Member State of identification's rules apply | optional invoice | https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/record-keeping-and-audits-oss_en | 2026-09-29 | "In general, there is no obligation for the supplier to issue an invoice." | high |
| E7 | For B2C electronic services the customer's location is the place identified on the basis of two items of non-contradictory evidence | 2 items (3 to rebut a presumption) | https://taxation-customs.ec.europa.eu/system/files/2016-09/explanatory_notes_2015_en.pdf | 2026-09-29 | "it is presumed that the customer is established, has his permanent address or usually resides at the place identified as such by the supplier on the basis of two items of non-contradictory evidence" | high |
| E8 | A supplier of electronic services may treat a customer who does not provide a VAT identification number as a non-taxable person (consumer) | no VAT ID = may be treated as consumer | https://taxation-customs.ec.europa.eu/system/files/2016-09/explanatory_notes_2015_en.pdf | 2026-09-29 | "may regard any customer who does not provide him with a VAT identification number as a non-taxable person" | high |
| E9a | EU VAT Committee guide (2003): an electronically supplied service includes a service that provides or supports a business or personal presence on an electronic network; domain names are not named in Annex I, the explanatory notes or the guidelines | domain-name classification not explicit in EU sources | https://taxation-customs.ec.europa.eu/document/download/474e7e57-7e01-4de0-ac94-e55537e505ae_en?filename=guidelines-vat-committee-meetings_en.pdf | 2026-09-29 | "a service which provides, or supports a business or personal presence on an electronic network (e.g., web site or web page)" | medium |
| E9b | EU legal list (Annex II to the VAT Directive / Annex I to Reg. 282/2011) names 'Website supply, web-hosting, distance maintenance of programmes and equipment' | website hosting and webpage hosting listed; domain names not listed | https://taxation-customs.ec.europa.eu/system/files/2016-09/explanatory_notes_2015_en.pdf | 2026-09-29 | "Website supply, web-hosting, distance maintenance of programmes and equipment" | high |
| E10 | VIES has a keyless REST API (POST /check-vat-number, POST /check-vat-test-service, GET /check-status); live test on 2026-09-29 returned valid=true for the documented test number and a per-country availability list | no API key; status endpoint lists per-Member-State availability | https://ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml | 2026-09-29 | "Check a Vat Number for a specific country" | high |
| E11 | ViDA: revised Explanatory Notes (24 July 2026) add changes effective 1 January 2027; further Single VAT Registration changes are essentially effective 1 July 2028 | watch-list item, no change to non-Union eligibility found | https://vat-one-stop-shop.ec.europa.eu/document/download/774b31ca-03c6-4fb1-8209-9e447aeeb1e9_en?filename=Explanatory%20Notes_revised_1Jan2027_0.pdf | 2026-09-29 | "that will, essentially, enter into force on 1 July 2028" | medium |
| K1 | UK: a non-established taxable person has no registration threshold and must register for any taxable supplies, including digital services | register from first taxable sale (tell HMRC within 30 days) | https://www.gov.uk/government/publications/vat-notice-7001-should-i-be-registered-for-vat/vat-notice-7001-should-i-be-registered-for-vat | 2026-09-29 | "the registration threshold for taxable supplies does not apply to you, so you’ll have to register for VAT if you make taxable supplies of any value in the UK" | high |
| K2 | UK: an overseas seller selling only to VAT-registered UK businesses (reverse charge) may not need to register | B2B-only escape hatch | https://www.gov.uk/government/publications/vat-notice-7001-should-i-be-registered-for-vat/vat-notice-7001-should-i-be-registered-for-vat | 2026-09-29 | "all your sales to the UK are made to a VAT-registered business in Great Britain (England, Scotland and Wales) who will account for the VAT using the ‘reverse charge’ procedure" | high |
| K3 | UK: digital services to UK consumers are liable to UK VAT; overseas suppliers must register | B2C digital services taxable in the UK | https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers | 2026-09-29 | "If you are a business making supplies of digital services to UK consumers, those supplies are liable to UK VAT." | high |
| K4 | HMRC place-of-supply rule: B2C general-rule services are supplied where the supplier belongs, so a B2C service that is not a digital service supplied by a US seller is outside UK VAT | depends on classification of domain registration | https://www.gov.uk/guidance/vat-place-of-supply-of-services-notice-741a | 2026-09-29 | "B2C general rule services: supplied where the supplier belongs" | medium |
| K5 | HMRC can direct an NETP to appoint a UK VAT representative or pay a security | possible representative/security | https://www.gov.uk/government/publications/vat-notice-7001-should-i-be-registered-for-vat/vat-notice-7001-should-i-be-registered-for-vat | 2026-09-29 | "HMRC can direct you to appoint a VAT representative or ask you to pay a security." | high |
| C1 | Canada: non-resident digital vendors must register for simplified GST/HST when revenue from specified supplies to specified Canadian recipients exceeds CAD 30,000 in any 12 months | CAD 30,000 / 12 months | https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/find-out-need-register/cross-border-threshold-amounts.html | 2026-09-29 | "your threshold amount of applicable revenues exceeds $30,000 CAD over any 12-month period" | high |
| C2 | Canada: specified supplies are generally taxable supplies of intangible personal property or services (domain registration is a service/intangible) | broad scope | https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/charge-collect/cross-border.html | 2026-09-29 | "generally taxable supplies of intangible personal property or services" | high |
| C3 | Canada: B2B out-of-scope when the customer proves normal GST/HST registration | registrant evidence needed | https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/charge-collect/cross-border.html | 2026-09-29 | "A specified Canadian recipient includes a Canadian consumer and a Canadian entity who is not registered under the normal GST/HST regime." | high |
| C4 | Canada simplified regime: no security deposit is required from non-residents | no security deposit | https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/register-get-ready.html | 2026-09-29 | "you do not need to provide us with the security deposit that is normally required from non-residents who register for GST/HST" | high |
| C5 | Quebec QST (specified regime for digital sales to Quebec individuals) threshold per Stripe docs; BC PST CAD 10,000; Saskatchewan PST and Manitoba RST 1 transaction | QC 30,000 CAD rolling; BC 10,000 CAD; SK 1 tx; MB 1 tx | https://docs.stripe.com/tax/supported-countries/canada/collect-tax | 2026-09-29 | "30000 CAD per rolling year by quarter" | medium |
| A1 | Australia: remote sellers register when sales to Australian individuals exceed AUD 75,000 in 12 months; sales to GST-registered businesses excluded (ATO site itself returned 403 to automated access) | AUD 75,000 | https://docs.stripe.com/tax/supported-countries/asia-pacific/collect-tax | 2026-09-29 | "Remote sellers must register in Australia if their sales of services or low-value goods to Australian individuals exceed 75,000 AUD in the past 12 months" | medium |
| I1 | India OIDAR: no registration threshold, register from the first B2C sale; B2B sales by non-residents do not trigger obligations (per Stripe; CBIC/GST-portal text not reachable) | no threshold | https://docs.stripe.com/tax/supported-countries/asia-pacific/collect-tax | 2026-09-29 | "have no registration threshold. They must register for IGST purposes from the first sale." | medium |
| J1a | Japan: a foreign business without a head office or office in Japan must designate a Tax Agent | tax agent required | https://www.nta.go.jp/english/taxes/consumption_tax/0024006-219.pdf | 2026-09-29 | "are required to designate a Tax Agent to deal with submission of tax returns and notification documents, and tax payment." | high |
| J1b | Japan: JPY 10 million taxable-sales threshold in the base period; B2B electronic services excluded from taxable sales (reverse charge) | JPY 10,000,000 | https://www.nta.go.jp/english/taxes/consumption_tax/0024006-219.pdf | 2026-09-29 | "In principle, a business with taxable sales not exceeding 10 million yen in the base period for the taxable period is exempt from consumption tax obligation." | high |
| H1 | Switzerland: liable once worldwide turnover from taxable/zero-rated supplies reaches CHF 100,000 and supplies are made in Switzerland | CHF 100,000 worldwide | https://www.estv.admin.ch/en/vat-liability-foreign-companies | 2026-09-29 | "will become liable to VAT, if they generate a worldwide turnover of at least CHF 100 000 p. a." | high |
| H2 | Switzerland: a Swiss tax representative is mandatory; online registration is impossible without one | representative required | https://www.estv.admin.ch/en/vat-liability-foreign-companies | 2026-09-29 | "An online registration without the appointment of a Swiss tax representative is not possible." | high |
| N1 | Norway (VOEC): register once B2C sales to Norwegian consumers reach NOK 50,000 in 12 months; may register from first sale | NOK 50,000 / 12 months | https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/register/ | 2026-09-29 | "You must register the business at the latest when you’ve sold vatable goods and/or services to Norwegian consumers for NOK 50,000 or more in a period of 12 months." | high |
| N2 | Norway VOEC is B2C only; VAT must not be charged to businesses | B2B outside VOEC | https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/register/ | 2026-09-29 | "The VOEC scheme is only for sale to consumers (B2C). This means that you should not charge the buyer VAT when you sell to a business." | high |
| M1 | Paddle fee | 5% + 50c per checkout transaction | https://www.paddle.com/pricing | 2026-09-29 | "5% + 50¢ per Checkout transaction" | high |
| M2a | Paddle positions itself for software companies; domain names are not named on its prohibited list | domain names not named | https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle | 2026-09-29 | "Paddle is built to serve software companies (including B2B SaaS, Consumer Software, and Games)." | medium |
| M2b | Paddle AUP: resale of any product without a valid reseller certificate is prohibited | resale risk | https://paddle.com/support/aup/ | 2026-09-29 | "resale of any product without a valid reseller certificate" | medium |
| M3 | Lemon Squeezy prohibits 'Services of any kind' (including web development and consulting); domain names are not named | domain names not named | https://docs.lemonsqueezy.com/help/getting-started/prohibited-products | 2026-09-29 | "Services of any kind (including marketing, design, web development, consulting or other related services)" | medium |
| M4 | Lemon Squeezy fee example on a $15 sale with 20% VAT | $0.50 + 5% of total + 1.5% international = $1.67 | https://docs.lemonsqueezy.com/help/payments/sales-tax-vat | 2026-09-29 | "Lemon Squeezy platform fee ($0.50 + 5% of total + 1.5% int’l payment)" | high |
| M5a | Polar serves software companies; domain names are not named on its acceptable-use policy | domain names not named | https://polar.sh/docs/merchant-of-record/acceptable-use | 2026-09-29 | "Polar serves software companies (including B2B SaaS, Consumer Software, and Games)." | medium |
| M5b | Polar fee (Starter plan; paid plans lower the rate) | 5% + 50c (+1.5% international cards); Pro $20/mo 3.8% + 40c | https://polar.sh/docs/merchant-of-record/fees | 2026-09-29 | "Starter \| Free \| 5% + 50¢ \| Standard Support" | high |
| M6 | FastSpring publishes no price ('get your pricing quote') and no public prohibited-products list was found | quote-based | https://fastspring.com/pricing/ | 2026-09-29 | "Get your pricing quote" | medium |
| R1 | Gandi (French registrar): VAT is charged only to accounts with an address in the EU, Great Britain or Taiwan; US and rest-of-world accounts are not charged | US reseller account = no VAT | https://docs.gandi.net/en/billing/vat/index.html | 2026-09-29 | "Only Gandi accounts/organizations with an address in the European Union, Great Britain, or Taiwan are charged the VAT." | high |
| R2 | OpenSRS/Tucows: the reseller collects and remits tax on its own customers; Tucows does not | reseller = tax collector | https://support.opensrs.com/support/solutions/articles/201000127800-collecting-taxes | 2026-09-29 | "you are responsible for collecting and remitting the correct taxes for your customers' locations. Tucows does not manage tax collection on your behalf." | high |
| R3 | OpenSRS/Tucows charges GST/HST only to Canadian resellers when they fund their account | Canadian resellers subject to GST/HST | https://support.opensrs.com/support/solutions/articles/201000063400 | 2026-09-29 | "Canadian resellers are subject to GST" | high |
| R4 | GoDaddy API reseller programme: resellers must collect sales tax from customers and file a resale/reseller certificate or GoDaddy may assess the tax itself | resale certificate expected | https://www.godaddy.com/help/api-reseller-sales-tax-collection-information-form-12336 | 2026-09-29 | "API resellers must collect the appropriate sales taxes from their customers for purchases." | high |
| R4b | GoDaddy: failure to file the certificate lets GoDaddy assess charges equal to the reseller's sales tax liability | penalty clause | https://www.godaddy.com/help/api-reseller-sales-tax-collection-information-form-12336 | 2026-09-29 | "we reserve the right to assess charges equal to your API reseller account's sales tax liability" | high |
| R5 | Name.com Reseller Agreement: fees exclude taxes; the reseller pays any sales/use/VAT the registrar is required to pay on the reseller's use of the services | taxes passed to reseller | https://www.name.com/policies/api-reseller-agreement | 2026-09-29 | "If Name.com is required to pay ICANN fees or United States or international sales, use, property, value-added, royalty, license or other taxes based on the licenses granted in this RSA or on Your use of the Services, then You must pay such taxes or fees." | high |
| S8b | Stripe validates EU VAT numbers against VIES and GB VAT numbers against HMRC, and ABNs against the ABR, but only checks that the number is valid, not that name/address match; unverified/unavailable results are left to the seller | VIES/HMRC/ABR validation; seller decides on 'unverified' | https://docs.stripe.com/invoicing/customer/tax-ids | 2026-09-29 | "This process only validates whether or not the tax ID is valid—you still need to verify the customer’s name and address to make sure it matches the registration information." | high |
| S5b | Stripe does not file or remit on the seller's behalf under plain Stripe Tax (filing only via TaxJar/Taxually/etc. on Tax Complete or partner plans) | seller responsible for filing and remitting | https://docs.stripe.com/tax/supported-countries/canada | 2026-09-29 | "You’re responsible for filing and remitting your taxes. Stripe doesn’t file taxes on your behalf." | high |
| H3 | Switzerland: a foreign company that only makes supplies subject to reverse charge in Switzerland is exempt from tax liability (B2B-only escape hatch) | B2B reverse-charge-only sellers need not register | https://www.estv.admin.ch/en/vat-liability-foreign-companies | 2026-09-29 | "Companies domiciled abroad which exclusively provide supplies that are tax exempted or supplies of services subject to reverse charge on Swiss territory are – among others – exempt from tax liability." | high |
| E8b | EU reverse charge in Stripe Tax: a customer that provides a European VAT number is treated as reverse charge and no tax is calculated; Stripe assumes every service sold to a customer with a business tax ID is eligible | Stripe assumes eligibility; domestic tax IDs do not trigger reverse charge | https://docs.stripe.com/tax/supported-countries/european-union | 2026-09-29 | "If your customer is eligible for a reverse charge and provides their European VAT number in Stripe, we treat their transactions as a reverse charge and don’t calculate tax for them." | high |
| N3 | Norway: Stripe says non-EEA sellers must appoint a Norwegian VAT representative unless they use VOEC (available for B2C digital services and low-value goods); Skatteetaten's VOEC page describes VOEC for remotely deliverable services generally | VOEC avoids the representative | https://docs.stripe.com/tax/supported-countries/europe/collect-tax | 2026-09-29 | "Businesses located outside the EEA must appoint a Norwegian VAT representative unless they use the simplified registration procedure (VOEC)" | medium |
| E7b | EU evidence items must be independent: a billing address plus self-certification of the same address is one item, and an IP address plus geolocation pointing to the same place is one item | need two genuinely different items (e.g. billing country + card issuing country / IP country) | https://taxation-customs.ec.europa.eu/system/files/2016-09/explanatory_notes_2015_en.pdf | 2026-09-29 | "when the customer gives a billing address and later confirms that same address through self-certification, that can only be taken to constitute a single item of evidence" | high |
| K6 | Stripe: EU OSS registrations do not cover the UK; UK needs its own registration | separate UK registration | https://docs.stripe.com/tax/supported-countries/europe/collect-tax | 2026-09-29 | "don’t allow tax calculations in the UK, as the UK is no longer part of the EU" | high |
| K7 | HMRC: a person liable to register must tell HMRC within 30 days; NETPs also register if they expect a taxable supply in the next 30 days | 30-day clock | https://www.gov.uk/government/publications/vat-notice-7001-should-i-be-registered-for-vat/vat-notice-7001-should-i-be-registered-for-vat | 2026-09-29 | "Where you’re liable to register, you must tell HMRC within 30 days" | high |
| C6 | Canada simplified regime: calendar-quarter reporting periods, return due within one month after the period | quarterly, one month | https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/file-return.html | 2026-09-29 | "You are required to file your return within one month after the end of the reporting period." | high |
| H4 | Switzerland: the Federal Tax Administration says it generally no longer requires foreign businesses to provide a security (conflicts with H5) | FTA: generally no security. Stripe: guarantee required | https://www.estv.admin.ch/en/vat-liability-foreign-companies | 2026-09-29 | "In general, the Federal Tax Administration no longer requires foreign businesses to provide a security when registering for VAT in Switzerland." | high |
| H5 | Stripe's Swiss page states foreign businesses must appoint a fiscal representative and provide cash or bank guarantee | conflicts with H4 on the guarantee | https://docs.stripe.com/tax/supported-countries/europe/collect-tax | 2026-09-29 | "Foreign businesses must appoint a fiscal representative to register for VAT purposes in Switzerland and provide cash or bank guarantee for future VAT liabilities." | high |
| J1c | Japan: a self-serve site that says 'for business use' but cannot effectively restrict consumers is B2C; B2C electronic services include services received by businesses | B2B needs nature or individually negotiated terms, not an ID | https://www.nta.go.jp/english/taxes/consumption_tax/0024006-219.pdf | 2026-09-29 | "The “provision of B2C electronic services” is not limited to services that only consumers receive but also include services received by businesses." | high |
| K8 | UK VAT-registered businesses send a VAT return usually every 3 months | quarterly | https://www.gov.uk/vat-registration-thresholds | 2026-09-29 | "by sending a VAT return to HM Revenue and Customs (HMRC) - usually every 3 months" | high |
| S19 | Stripe recommends separate Products when one item fits several tax codes (e.g. personal vs business use) | two Products for two codes | https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior | 2026-09-29 | "If a product could fit multiple codes, for example, a SaaS product used for personal or business use depending on the type of customer, we recommend creating two separate products in Stripe and assigning the appropriate code to each." | high |
| S13b | States that charge a registration fee to remote sellers (AZ 12 USD + local, CO 16 USD per site + 50 USD deposit, CT 100, HI 20, IN 25, NV 15 + deposit, SC 50, WA 50 + 5 per DBA, WV 30, WI 20, WY 60) | fees per Stripe doc | https://docs.stripe.com/tax/use-stripe-to-register | 2026-09-29 | "The following states charge a fee to all remote sellers who register to collect tax." | high |
| C7 | Stripe: remote sellers marketing to Canadian customers may need up to five tax registrations | up to 5 registrations | https://stripe.com/tax | 2026-09-29 | "Remote sellers marketing to Canadian customers may need up to five tax registrations in Canada." | high |
| E4b | OSS return currency: euro, converted at the ECB rate on the last day of the period | EUR / ECB rate | https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en | 2026-09-29 | "use the exchange rate as published by the European Central Bank on the last date of the tax period" | high |
| E1b | Non-Union OSS number has the format EUxxxyyyyyz and can only be used for non-Union scheme supplies | scheme-specific EU number | https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/register-oss_en | 2026-09-29 | "This VAT identification number can only be used to declare supplies falling under the non-Union scheme." | high |
| E1c | An intermediary is required only for the import scheme when the seller is established outside the EU | no intermediary for non-Union scheme | https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/register-oss_en | 2026-09-29 | "If the taxable person is established outside the EU, he needs to appoint an intermediary to be able to use the import scheme." | high |
| E3b | Early start: a supplier can use the scheme from the date of its first supply if it informs the Member State of identification by the tenth day of the following month; otherwise it must register and account in each Member State of consumption | 10th-of-next-month rule | https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/register-oss_en | 2026-09-29 | "provided he has informed the Member State of identification that he has started activities under the scheme by the tenth day of the month following that first supply" | high |
| K9 | UK registration threshold for established businesses is GBP 90,000 of taxable turnover (not applicable to NETPs, see K1) | GBP 90,000 | https://www.gov.uk/vat-registration-thresholds | 2026-09-29 | "Businesses have to register for VAT if their VAT taxable turnover is more than £90,000." | high |
| C4b | Canada simplified regime: net tax can be calculated and paid in a qualifying foreign currency (US dollar or euro) after applying to the CRA | USD / EUR | https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/register-gst-hst.html | 2026-09-29 | "The qualifying foreign currencies are: U.S. dollar Euro" | high |
| J1d | Japan NTA examples of electronic services: e-books, digital newspapers, music, videos, software, cloud software and storage, internet advertising; domain registration not listed | domain names not named | https://www.nta.go.jp/english/taxes/consumption_tax/0024006-219.pdf | 2026-09-29 | "Provision of e-books, digital newspapers, music, videos, and software (including various applications such as games) via internet" | medium |
| S18c | Managed Payments: the customer sees Link as merchant of record | 'Sold through Link' on receipts | https://docs.stripe.com/payments/managed-payments/how-it-works | 2026-09-29 | "The customer sees Link as the merchant of record" | high |
| S17c | Managed Payments: business must be based in a supported location (US, CA, listed European countries, AU, HK, JP, SG) | location restriction | https://docs.stripe.com/payments/managed-payments/eligibility | 2026-09-29 | "Your business must be based in one of the supported business locations." | high |
| M2c | Paddle prohibits products that enable non-Paddle sellers to sell, such as digital marketplaces | marketplace exclusion | https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle | 2026-09-29 | "Any product or service that enables non-Paddle Sellers to sell products and services to customers, such as digital marketplaces" | medium |
| M3b | Lemon Squeezy prohibits marketplaces and reselling others' products | marketplace exclusion | https://docs.lemonsqueezy.com/help/getting-started/prohibited-products | 2026-09-29 | "Marketplaces - where you use your Lemon Squeezy store to “partner” to sell others’ products" | medium |
| M5c | Polar prohibits marketplaces and products that enable non-Polar sellers to sell | marketplace exclusion | https://polar.sh/docs/merchant-of-record/acceptable-use | 2026-09-29 | "Any product or service that enables non-Polar Sellers to sell products and services to customers;" | medium |
| R1b | Gandi: an EU business (outside France/Luxembourg) that adds its intra-community VAT number is not charged VAT | reverse charge via VAT number | https://docs.gandi.net/en/billing/vat/index.html | 2026-09-29 | "A company or organization located in the European Union (except France or Luxembourg) or the United Kingdom and you have correctly added your intra-community VAT number to your Gandi organization" | high |
| R6 | HMRC disbursement test: the customer, acting through you as its agent, must be the buyer of the third-party supply; a reseller supplying in its own name does not meet it (accountant to confirm) | disbursement unlikely for a reseller | https://www.gov.uk/guidance/vat-costs-or-disbursements-passed-to-customers | 2026-09-29 | "you paid the supplier on your customer’s behalf and acted as the agent of your customer" | medium |
| S20 | Stripe Checkout and Payment Links use the address collected during the session as the customer's location | billing address collected in session | https://docs.stripe.com/tax/customer-locations | 2026-09-29 | "Checkout and Payment Links use the address collected during the session." | high |
| S21 | Tax Calculations API calls are billed after completion when an active registration covers the customer jurisdiction | API previews are billable | https://docs.stripe.com/tax/how-tax-works | 2026-09-29 | "Fee charged after the API request is completed, if an active tax registration covers the customer jurisdiction" | high |
| S7b | Refunds, credit notes, voided invoices and chargebacks add no extra Stripe Tax fee | no fee on reversal | https://docs.stripe.com/tax/how-tax-works | 2026-09-29 | "no additional fee is charged for refund, credit note, voided invoice, or chargeback" | high |
| S15b | Stripe's monitor counts Stripe-processed sales (net of refunds) by customer location against thresholds, using your preset tax code | Stripe-processed sales only | https://docs.stripe.com/tax/monitoring | 2026-09-29 | "Stripe Tax tracks your Stripe-processed sales (minus refunds) based on each customer’s location" | high |
| U1b | Wayfair holding: Quill's physical-presence rule is unsound and incorrect; Quill and Bellas Hess overruled | economic nexus constitutional | https://www.supremecourt.gov/opinions/17pdf/17-494_j4el.pdf | 2026-09-29 | "the physical presence rule of Quill is unsound and incorrect" | high |
| E7c | EU evidence items must be independent: IP address plus geolocation pointing to the same place, or bank details confirmed by the payment provider, are one item | billing address + card/bank country are different items; IP + its geolocation are one | https://taxation-customs.ec.europa.eu/system/files/2016-09/explanatory_notes_2015_en.pdf | 2026-09-29 | "or when an IP address and the geolocation point to one and the same location" | high |
| E8c | If a customer supplies a VAT ID after the sale, the supplier may need to refund VAT already charged and adjust the OSS (MOSS) return | retroactive B2B adjustment allowed/needed | https://taxation-customs.ec.europa.eu/system/files/2016-09/explanatory_notes_2015_en.pdf | 2026-09-29 | "That could include refunding any VAT previously charged to the customer" | high |
| S13c | 'Register for me' requires a US bank account | US bank account | https://docs.stripe.com/tax/use-stripe-to-register | 2026-09-29 | "Have a US bank account. This is required in" | high |
| E1d | A non-EU seller can choose any Member State as its Member State of identification for the non-Union scheme | free choice of Member State | https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/register-oss_en | 2026-09-29 | "can choose any Member State to be the Member State of identification" | high |
| E8d | A communicated VAT identification number lets the supplier regard an EU customer as a taxable person | VAT ID communicated = business | https://taxation-customs.ec.europa.eu/system/files/2016-09/explanatory_notes_2015_en.pdf | 2026-09-29 | "That is the case when the customer communicates his VAT identification number" | high |
| K4b | HMRC's list of e-services includes 'website supply or web hosting services'; domain names are not named | domain names not named | https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers | 2026-09-29 | "website supply or web hosting services" | medium |
| N2b | Norway VOEC quarterly return and payment deadline | 20 Jan / 20 Apr / 20 Jul / 20 Oct | https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/register/ | 2026-09-29 | "The deadline for this is the 20th of the month after the end of the quarter." | high |
| N2c | Norway VOEC covers remotely deliverable services, including electronic services, sold to Norwegian consumers | domain names not named; scope is 'remotely deliverable services' | https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/register/ | 2026-09-29 | "Foreign suppliers of remotely deliverable services, including electronic services, must calculate and pay VAT when selling to Norwegian consumers." | high |
| M3c | Lemon Squeezy's site announces a 2026 tie-up with Stripe Managed Payments | 2026 banner | https://www.lemonsqueezy.com/pricing | 2026-09-29 | "2026 Update: Lemon Squeezy + Stripe Managed Payments" | high |
| M5d | Polar prohibits reselling software licences without authorization | resale exclusion | https://polar.sh/docs/merchant-of-record/acceptable-use | 2026-09-29 | "Reselling software licenses without authorization;" | medium |

## 16. Unverified, blocked or conflicting

1. State-by-state taxability of domain registration, renewal and transfer: no state revenue-department page naming domain registration was found; only the 1997 New York advisory (U5), Texas and Washington guidance about hosting (U6, U7) and Avalara's separate code (S3).
2. The nexus thresholds and "what counts" classification (Appendix A) are Stripe's summaries, not checked against each statute; some states have changed transaction-count tests over time.
3. Classification of domain registration as an electronically supplied / digital service in the EU, UK, Norway, Japan, Australia, India, Canada, Switzerland: none of the primary texts reached names domain names (E9a, E9b, K4, J1b).
4. Australia and India: ATO / law.ato.gov.au returned 403 (Akamai); gst.gov.in, tutorial.gst.gov.in and indiacode.nic.in reset the connection or timed out; taxinformation.cbic.gov.in had a certificate error (not bypassed); CBIC Act pages 404. Both jurisdictions rely on Stripe's documentation (medium confidence).
5. EUR-Lex (Regulation 282/2011 text) answered with a bot-challenge page; I relied on the Commission's explanatory notes, which quote the annexes.
6. Merchant-of-record acceptance of domain reselling: none of Paddle, Lemon Squeezy, Polar or Stripe Managed Payments names domain names; FastSpring has no public prohibited list or price; written confirmation needed from each.
7. Whether Stripe bills Tax Calculations API previews separately when the payment later completes in Checkout (docs list API calculations as billable in registered jurisdictions).
8. Namecheap and Dynadot reseller tax terms: not found or not reachable.
9. Current VAT/GST rates per country were not collected (Stripe Tax supplies them).
10. Switzerland: conflict between the tax authority (generally no security, H4) and Stripe (guarantee required, H5); authority page preferred.
11. HMRC, CRA, ABR and Swiss UID lookup APIs were not fetched or tested; only Stripe's statement that it validates EU (VIES), GB (HMRC) and ABN numbers (S8b) and my live test of VIES (E10).
12. Stripe does not publish which US states treat txcd_20030000 General - Services as taxable.
13. Discovery limits: WebSearch quota exhausted at 200/200 before this task started; sources not reachable by known URL or site navigation may exist.
14. Non-US "Register for me" (Taxually) fees are not published in the fetched Stripe text (S6c says extra fees may apply).

## Appendix A. US economic-nexus thresholds (Stripe docs per-state pages, accessed 2026-09-29)

Source pattern: `https://docs.stripe.com/tax/supported-countries/united-states/collect-tax?tax-jurisdiction-united-states=<state>` (fetched as `.md`). "Included transactions" is Stripe's field; the last column is my classification of Stripe's "threshold includes / excludes" sentence for a seller of nontaxable-or-taxable services or digital goods with no tangible goods. Counts: 22 gross-sales, 5 retail-sales-incl.-services, 9 tangible-goods-only, 12 taxable-only, 4 no general state sales tax (52 rows).

| State / territory | Tax type (Stripe) | Threshold (Stripe docs) | Included transactions (Stripe docs) | Would non-taxable domain/service revenue count? (derived) |
| --- | --- | --- | --- | --- |
| Alabama | Sales & seller use tax | 250,000 USD | Retail sales of tangible personal property | No: tangible personal property only; services excluded |
| Alaska | Local sales and use taxes (no state sales tax, with many local juri... | 100,000 USD. Local jurisdictions might adopt or vary the ARSSTC statewide threshold | Gross sales | Yes: gross sales (taxable or not) |
| Arizona | Sales & seller use tax | 100,000 USD | Gross sales, excluding marketplace sales | Yes: gross sales (taxable or not) |
| Arkansas | Sales & seller use tax | 100,000 USD or 200 transactions | Taxable sales | Only if the domain sale is itself taxable there |
| California | Sales & seller use tax | 500,000 USD | Sales of tangible personal property, including wholesale and marketplace sales | No: tangible personal property only; services excluded |
| Colorado | Sales & seller use tax | 100,000 USD | Retail sales, including sales of services | Yes: retail sales incl. nontaxable services |
| Connecticut | Sales & seller use tax | 100,000 USD and 200 transactions—both thresholds required | Retail sales, including marketplace sales and sales of services | Yes: retail sales incl. nontaxable services |
| Delaware | No general state or local sales tax (other business taxes apply) | N/A (no state sales tax registration to add in Stripe) | N/A (Delaware imposes other taxes, such as gross receipts tax) | n/a: no general state sales tax |
| District of Columbia | Sales & seller use tax | 100,000 USD or 200 transactions | Retail sales, including marketplace sales and sales of services | Yes: retail sales incl. nontaxable services |
| Florida | Sales & seller use tax | 100,000 USD | Taxable sales of tangible personal property | No: tangible personal property only; services excluded |
| Georgia | Sales & seller use tax | 100,000 USD or 200 transactions | Retail sales of tangible personal property | No: tangible personal property only; services excluded |
| Hawaii | Sales & seller use tax | 100,000 USD or 200 transactions | Gross sales | Yes: gross sales (taxable or not) |
| Idaho | Sales & seller use tax | 100,000 USD | Gross sales | Yes: gross sales (taxable or not) |
| Illinois | Sales & seller use tax | 100,000 USD | Sales of tangible personal property | No: tangible personal property only; services excluded |
| Indiana | Sales & seller use tax | 100,000 USD | Gross sales, excluding marketplace sales | Yes: gross sales (taxable or not) |
| Iowa | Sales & seller use tax | 100,000 USD | Gross sales | Yes: gross sales (taxable or not) |
| Kansas | Sales & seller use tax | 100,000 USD | Sales of tangible personal property, taxable services, marketplace sales, and wholesale sales | Only if the domain sale is itself taxable there |
| Kentucky | Sales & seller use tax | 100,000 USD | Gross sales | Yes: gross sales (taxable or not) |
| Louisiana | Sales & seller use tax | 100,000 USD | Gross sales, excluding marketplace sales | Yes: gross sales (taxable or not) |
| Maine | Sales & seller use tax | 100,000 USD or 200 transactions | Sales of tangible personal property and taxable services, including wholesale sales | Only if the domain sale is itself taxable there |
| Maryland | Sales & seller use tax | 100,000 USD or 200 transactions | Sales of tangible personal property and taxable services, including wholesale and marketplace sales | Only if the domain sale is itself taxable there |
| Massachusetts | Sales & seller use tax | 100,000 USD | Gross sales, excluding marketplace sales | Yes: gross sales (taxable or not) |
| Michigan | Sales & seller use tax | 100,000 USD or 200 transactions | Gross sales | Yes: gross sales (taxable or not) |
| Minnesota | Sales & seller use tax | 100,000 USD or 200 transactions | Retail sales, including marketplace sales and taxable services | Only if the domain sale is itself taxable there |
| Mississippi | Sales & seller use tax | 250,000 USD | Gross sales | Yes: gross sales (taxable or not) |
| Missouri | Sales & seller use tax | 100,000 USD | Taxable sales of tangible personal property | No: tangible personal property only; services excluded |
| Montana | No general state sales tax (Montana) — supports resort taxes in som... | N/A (no state sales tax registration to add in Stripe) | N/A for general sales tax. Resort taxes apply per local jurisdiction rules | n/a: no general state sales tax |
| Nebraska | Sales & seller use tax | 100,000 USD or 200 transactions | Retail sales, including marketplace sales and sales of services | Yes: retail sales incl. nontaxable services |
| Nevada | Sales & seller use tax | 100,000 USD or 200 transactions | Retail sales of tangible personal property, including marketplace sales | No: tangible personal property only; services excluded |
| New Hampshire | No general state or local sales tax (other business taxes apply) | N/A (no state sales tax registration to add in Stripe) | N/A (New Hampshire imposes other taxes, such as business profits tax) | n/a: no general state sales tax |
| New Jersey | Sales & seller use tax | 100,000 USD or 200 transactions | Sales of tangible personal property, specified digital products, and taxable services. This includes wholesale and marketplace sales | Only if the domain sale is itself taxable there |
| New Mexico | Sales & seller use tax | 100,000 USD | Taxable retail sales, including marketplace sales | Only if the domain sale is itself taxable there |
| New York | Sales & seller use tax | 500,000 USD and 100 transactions (both thresholds required) | Sales of tangible personal property, including wholesale and marketplace sales | No: tangible personal property only; services excluded |
| North Carolina | Sales & seller use tax | 100,000 USD or 200 transactions | Gross sales | Yes: gross sales (taxable or not) |
| North Dakota | Sales & seller use tax | 100,000 USD | Taxable sales | Only if the domain sale is itself taxable there |
| Ohio | Sales & seller use tax | 100,000 USD or 200 transactions | Retail sales, including marketplace sales and sales of taxable services | Only if the domain sale is itself taxable there |
| Oklahoma | Sales & seller use tax | 100,000 USD | Taxable sales of tangible personal property, excluding marketplace sales if the marketplace provider collects tax on behalf of sellers | No: tangible personal property only; services excluded |
| Oregon | No general state or local sales tax | N/A (no state sales tax registration to add in Stripe) | N/A (Oregon imposes other taxes, such as corporate income tax) | n/a: no general state sales tax |
| Pennsylvania | Sales & seller use tax | 100,000 USD | Gross sales, excluding marketplace sales if the marketplace provider collects tax on behalf of sellers | Yes: gross sales (taxable or not) |
| Puerto Rico | Sales tax | 100,000 USD or 200 transactions | Sales of tangible personal property and taxable services, including wholesale sales | Only if the domain sale is itself taxable there |
| Rhode Island | Sales & seller use tax | 100,000 USD or 200 transactions | Sales of tangible personal property, digital products, software, and services. This includes wholesale and marketplace sales | Only if the domain sale is itself taxable there |
| South Carolina | Sales & seller use tax | 100,000 USD | Gross sales | Yes: gross sales (taxable or not) |
| South Dakota | Sales & seller use tax | 100,000 USD | Gross sales | Yes: gross sales (taxable or not) |
| Tennessee | Sales & seller use tax | 100,000 USD | Retail sales | Likely yes: retail sales, taxable or nontaxable |
| Texas | Sales & seller use tax | 500,000 USD | Gross sales | Yes: gross sales (taxable or not) |
| Utah | Sales & seller use tax | 100,000 USD | Gross sales, excluding marketplace sales | Yes: gross sales (taxable or not) |
| Vermont | Sales & seller use tax | 100,000 USD or 200 transactions | Gross sales | Yes: gross sales (taxable or not) |
| Virginia | Sales & seller use tax | 100,000 USD or 200 transactions | Retail sales | Only if the domain sale is itself taxable there |
| Washington | Sales & seller use tax | 100,000 USD | Gross sales | Yes: gross sales (taxable or not) |
| West Virginia | Sales & seller use tax | 100,000 USD or 200 transactions | Gross sales | Yes: gross sales (taxable or not) |
| Wisconsin | Sales & seller use tax | 100,000 USD | Gross sales | Yes: gross sales (taxable or not) |
| Wyoming | Sales & seller use tax | 100,000 USD or 200 transactions | Gross sales, excluding marketplace sales | Yes: gross sales (taxable or not) |


## Appendix B. Countries Stripe Tax supports (Stripe docs, accessed 2026-09-29)

Source: https://docs.stripe.com/tax/supported-countries (fetched as `.md`; the "business location" and "customer location" columns are Stripe's tick marks). "All PTCs" means any product tax code; "Digital products" means only digital product tax codes.

| Country | Code | Product types Stripe Tax can calculate | Tax type | Your business can be based here | Customers here supported | Supported since |
| --- | --- | --- | --- | --- | --- | --- |
| Albania | AL | Digital products | VAT | no | yes | 12/18/2024 |
| Angola | AO | Digital products | VAT | no | yes | 12/18/2024 |
| Armenia | AM | Digital products | VAT | no | yes | 12/18/2024 |
| Aruba | AW | Digital products | Sales tax | no | yes | 5/2/2025 |
| Australia | AU | All PTCs | GST | yes | yes | 10/2/2023 |
| Austria | AT | All PTCs | VAT | yes | yes | 10/2/2023 |
| Azerbaijan | AZ | Digital products | VAT | no | yes | 5/2/2025 |
| Bahamas | BS | Digital products | VAT | no | yes | 12/18/2024 |
| Bahrain | BH | Digital products | VAT | no | yes | 4/25/2024 |
| Bangladesh | BD | Digital products | VAT | no | yes | 5/2/2025 |
| Barbados | BB | Digital products | VAT | no | yes | 12/18/2024 |
| Belarus | BY | Digital products | VAT | no | yes | 10/7/2024 |
| Belgium | BE | All PTCs | VAT | yes | yes | 10/2/2023 |
| Benin | BJ | Digital products | VAT | no | yes | 5/2/2025 |
| Bosnia and Herzegovina | BA | Digital products | VAT | no | yes | 12/18/2024 |
| Bulgaria | BG | All PTCs | VAT | yes | yes | 10/2/2023 |
| Burkina Faso | BF | Digital products | VAT | no | yes | 5/2/2025 |
| Cambodia | KH | Digital products | VAT | no | yes | 12/18/2024 |
| Cameroon | CM | Digital products | VAT | no | yes | 5/2/2025 |
| Canada | CA | All PTCs | GST and provincial taxes | yes | yes | 10/2/2023 |
| Cape Verde | CV | Digital products | VAT | no | yes | 5/2/2025 |
| Chile | CL | Digital products | VAT | no | yes | 8/17/2023 |
| Colombia | CO | Digital products | VAT | no | yes | 8/17/2023 |
| Costa Rica | CR | Digital products | VAT | no | yes | 10/7/2024 |
| Croatia | HR | All PTCs | VAT | yes | yes | 10/2/2023 |
| Cyprus | CY | All PTCs | VAT | yes | yes | 10/2/2023 |
| Czechia | CZ | All PTCs | VAT | yes | yes | 10/2/2023 |
| Democratic Republic of Congo | CD | Digital products | VAT | no | yes | 12/18/2024 |
| Denmark | DK | All PTCs | VAT | yes | yes | 10/2/2023 |
| Ecuador | EC | Digital products | VAT | no | yes | 10/7/2024 |
| Egypt | EG | Digital products | VAT | no | yes | 4/25/2024 |
| Estonia | EE | All PTCs | VAT | yes | yes | 10/2/2023 |
| Ethiopia | ET | Digital products | VAT | no | yes | 5/2/2025 |
| Finland | FI | All PTCs | VAT | yes | yes | 10/2/2023 |
| France | FR | All PTCs | VAT | yes | yes | 10/2/2023 |
| Georgia | GE | Digital products | VAT | no | yes | 4/25/2024 |
| Germany | DE | All PTCs | VAT | yes | yes | 10/2/2023 |
| Greece | GR | All PTCs | VAT | yes | yes | 10/2/2023 |
| Guinea | GN | Digital products | VAT | no | yes | 12/18/2024 |
| Hong Kong | HK | All PTCs | No tax | yes | yes | 10/2/2023 |
| Hungary | HU | All PTCs | VAT | yes | yes | 10/2/2023 |
| Iceland | IS | Digital products | VAT | no | yes | 10/2/2023 |
| India | IN | Digital products | IGST | no | yes | 4/14/2025 |
| Indonesia | ID | Digital products | VAT | no | yes | 8/17/2023 |
| Ireland | IE | All PTCs | VAT | yes | yes | 10/2/2023 |
| Italy | IT | All PTCs | VAT | yes | yes | 10/2/2023 |
| Japan | JP | All PTCs | JCT | yes | yes | 10/2/2023 |
| Kazakhstan | KZ | Digital products | VAT | no | yes | 4/25/2024 |
| Kenya | KE | Digital products | VAT | no | yes | 4/25/2024 |
| Kyrgyzstan | KG | Digital products | VAT | no | yes | 5/2/2025 |
| Laos | LA | Digital products | VAT | no | yes | 5/2/2025 |
| Latvia | LV | All PTCs | VAT | yes | yes | 10/2/2023 |
| Liechtenstein | LI | All PTCs | VAT | yes | yes | 1/1/2025 |
| Lithuania | LT | All PTCs | VAT | yes | yes | 10/2/2023 |
| Luxembourg | LU | All PTCs | VAT | yes | yes | 10/2/2023 |
| Malaysia | MY | Digital products | Service tax | no | yes | 8/17/2023 |
| Malta | MT | All PTCs | VAT | yes | yes | 10/2/2023 |
| Mauritania | MR | Digital products | VAT | no | yes | 12/18/2024 |
| Mexico | MX | All PTCs | VAT | yes | yes | 9/2/2025 |
| Moldova | MD | Digital products | VAT | no | yes | 10/7/2024 |
| Montenegro | ME | Digital products | VAT | no | yes | 12/18/2024 |
| Morocco | MA | Digital products | VAT | no | yes | 10/7/2024 |
| Nepal | NP | Digital products | VAT | no | yes | 12/18/2024 |
| Netherlands | NL | All PTCs | VAT | yes | yes | 10/2/2023 |
| New Zealand | NZ | All PTCs | GST | yes | yes | 10/2/2023 |
| Nigeria | NG | Digital products | VAT | no | yes | 4/25/2024 |
| North Macedonia | MK | Digital products | VAT | no | yes | 12/18/2024 |
| Norway | NO | All PTCs | VAT | yes | yes | 10/2/2023 |
| Oman | OM | Digital products | VAT | no | yes | 4/25/2024 |
| Peru | PE | Digital products | VAT | no | yes | 12/18/2024 |
| Philippines | PH | Digital products | VAT | no | yes | 5/2/2025 |
| Poland | PL | All PTCs | VAT | yes | yes | 10/2/2023 |
| Portugal | PT | All PTCs | VAT | yes | yes | 10/2/2023 |
| Puerto Rico | PR | All PTCs | Sales tax | yes | yes | 10/17/2023 |
| Romania | RO | All PTCs | VAT | yes | yes | 10/2/2023 |
| Russia | RU | Digital products | VAT | no | yes | 10/7/2024 |
| Saudi Arabia | SA | Digital products | VAT | no | yes | 8/17/2023 |
| Senegal | SN | Digital products | VAT | no | yes | 12/18/2024 |
| Serbia | RS | Digital products | VAT | no | yes | 10/7/2024 |
| Singapore | SG | All PTCs | GST | yes | yes | 10/2/2023 |
| Slovakia | SK | All PTCs | VAT | yes | yes | 10/2/2023 |
| Slovenia | SI | All PTCs | VAT | yes | yes | 10/2/2023 |
| South Africa | ZA | All PTCs | VAT | no | yes | 10/2/2023 |
| South Korea | KR | Digital products | VAT | no | yes | 8/17/2023 |
| Spain | ES | All PTCs | VAT | yes | yes | 10/2/2023 |
| Sri Lanka | LK | Digital products | VAT | no | yes | 7/1/2026 |
| Suriname | SR | Digital products | VAT | no | yes | 12/18/2024 |
| Sweden | SE | All PTCs | VAT | yes | yes | 10/2/2023 |
| Switzerland | CH | All PTCs | VAT | yes | yes | 10/2/2023 |
| Taiwan | TW | Digital products | VAT | no | yes | 10/1/2025 |
| Tajikistan | TJ | Digital products | VAT | no | yes | 12/18/2024 |
| Tanzania | TZ | Digital products | VAT | no | yes | 10/7/2024 |
| Thailand | TH | Digital products | VAT | no | yes | 8/17/2023 |
| Türkiye (Turkey) | TR | Digital products | VAT | no | yes | 8/17/2023 |
| Uganda | UG | Digital products | VAT | no | yes | 12/18/2024 |
| Ukraine | UA | Digital products | VAT | no | yes | 8/30/2024 |
| United Arab Emirates | AE | All PTCs | VAT | yes | yes | 10/2/2023 |
| United Kingdom | GB | All PTCs | VAT | yes | yes | 10/2/2023 |
| United States | US | All PTCs | Sales tax and some local taxes | yes | yes | 10/2/2023 |
| Uruguay | UY | Digital products | VAT | no | yes | 12/18/2024 |
| Uzbekistan | UZ | Digital products | VAT | no | yes | 10/7/2024 |
| Vietnam | VN | Digital products | VAT | no | yes | 8/17/2023 |
| Zambia | ZM | Digital products | VAT | no | yes | 12/18/2024 |
| Zimbabwe | ZW | Digital products | VAT | no | yes | 12/18/2024 |


## Appendix C. US registration grace periods (Stripe docs, accessed 2026-09-29)

Source: https://docs.stripe.com/tax/use-stripe-to-register

| State | Grace period after threshold is exceeded (Stripe docs) |
| --- | --- |
| Alabama | January 1 of the calendar year after the threshold is exceeded |
| Alaska | 1st day of the month not more than 30 days after the threshold is exceeded |
| Arizona | 1st day of the following month, 2 months after the threshold is exceeded |
| Arkansas | When the threshold is exceeded |
| California | When the threshold is exceeded |
| Colorado | 1st day of the following month, 90 days after the threshold is exceeded |
| Connecticut | January 1 of the calendar year after the threshold is exceeded over the 12 months ending September 30 |
| District of Columbia | When the threshold is exceeded |
| Florida | January 1 of the next calendar year after the threshold is exceeded |
| Georgia | When the threshold is exceeded |
| Hawaii | 1st day of the month not more than 30 days after the threshold is exceeded |
| Idaho | When the threshold is exceeded |
| Illinois | 1st day of the quarter after the threshold is exceeded |
| Indiana | When the threshold is exceeded |
| Iowa | 1st day of the month no more than 30 days after the threshold is exceeded |
| Kansas | 1st day of the month no more than 30 days after the threshold is exceeded |
| Kentucky | 1st day of the month no more than 30 days after the threshold is exceeded |
| Louisiana | 30 days after the threshold is exceeded |
| Maine | 1st day of the following month, 2 months after the threshold is exceeded |
| Maryland | 1st day of the month and not more than 30 days after the threshold is exceeded |
| Massachusetts | 1st day of the following month, 2 months after the threshold is exceeded |
| Michigan | January 1 of the next calendar year after the threshold is exceeded |
| Minnesota | 1st day of the following month, 2 months after the threshold is exceeded |
| Mississippi | When the threshold is exceeded |
| Missouri | 1st day of the following month, 90 days after the threshold is exceeded |
| Nebraska | 1st day of the following month, 2 months after the threshold is exceeded |
| Nevada | 1st day of the month and not more than 30 days after the threshold is exceeded |
| New Jersey | 1st day of the month and not more than 30 days after the threshold is exceeded |
| New Mexico | January 1 of the next calendar year after the threshold is exceeded |
| New York | 30 days after the threshold is exceeded |
| North Carolina | 60 days after the threshold is exceeded |
| North Dakota | 60 days after the threshold is exceeded or the following calendar year, whichever is earlier |
| Ohio | When the threshold is exceeded |
| Oklahoma | 1st day of the month and not more than 30 days after the threshold is exceeded |
| Pennsylvania | 1st day of the following month, 90 days after the threshold is exceeded |
| Puerto Rico | When the threshold is exceeded |
| Rhode Island | January 1 of the next calendar year after the threshold is exceeded |
| South Carolina | 1st day of the following month, 2 months after the threshold is exceeded |
| South Dakota | When the threshold is exceeded |
| Tennessee | 1st day of the following month, 3 months after the threshold is exceeded |
| Texas | 1st day of the following month, 4 months after the threshold is exceeded based on a rolling 12 months |
| Utah | When the threshold is exceeded |
| Vermont | 1st day of the month and not more than 30 days after the threshold is exceeded |
| Virginia | 1st day of the month and not more than 30 days after the threshold is exceeded |
| Washington | 1st day of the following month, 2 months after the threshold is exceeded |
| West Virginia | When the threshold is exceeded |
| Wisconsin | When the threshold is exceeded |
| Wyoming | When the threshold is exceeded |

