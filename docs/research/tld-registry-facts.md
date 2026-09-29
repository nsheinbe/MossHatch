# Registry-level facts for Mosshatch starting TLDs: .com .ai .dev .io .app .studio

Analyst: Phase 0 research. Dossier date and access date for every source: **2026-09-29**. Raw fetches are kept in `working-directory/research/tld/` (files named in the source register).

## TL;DR

1. **.com**: Verisign. Registry wholesale is **$10.26 today and $10.97 from 2026-11-01** (Verisign 10-Q, filed for the quarter ended 2026-06-30). The RA allows up to +7% per year in each of the last four years of a six-year cycle that began 2024-10-26 (ceiling about $13.4 by 2029-30), with 6 months' notice and a right to pre-buy up to 10 years at the old price. ICANN registrar transaction fee is **$0.20** per add/renew/transfer-year (FY26 approved; FY27 budget repeats $0.20, FY27 vote not found).
2. **.ai**: ccTLD of Anguilla; Identity Digital runs it since Jan 2025. Wholesale **$80/yr, 2-year minimum ($160)** since 2026-03-05 (secondary sources + Cloudflare at-cost price). No ICANN fee. ICANN policies do not apply; transfers add 2 years.
3. **.dev / .app**: Google Registry (Charleston Road Registry). **The whole TLD is on the HSTS preload list: HTTPS is mandatory for every site**. Wholesale is not public (partner-only); implied about $12.00 / $14.00 plus $0.20 ICANN.
4. **.io**: ccTLD manager Internet Computer Bureau (an Identity Digital subsidiary). Chagos treaty signed 2025-05-22 but **not in force**; on 2026-09-22/23 the UK said it will rework the deal after Trump's criticism. IANA delegation unchanged (record last updated 2023-01-18); ICANN says any retirement means a 5-year window (max 10). No newer ICANN/IANA/registry statement than ICANN's 2024-11-14 blog was found.
5. **.studio**: Dog Beach LLC / Identity Digital, new gTLD. Wholesale implied about $31.00; a third-party tracker shows **+29% scheduled 2026-10-06** (masked figures, unverified).
6. **ICANN Transfer Policy and the 60-day rules apply to .com/.dev/.app/.studio, not to .ai/.io** (registry rules; largely undocumented). The reformed Transfer Policy (TAC, 30-day lock) is not adopted: GNSO page says Board resolution "TBD".
7. Retail on 2026-09-29 (renewal, USD): .com 10.46-11.08, .ai 80.00-85.60, .dev 12.20-12.87, .app 14.20-14.93, .io 50.00-53.50, .studio 31.20-33.39 (Cloudflare / Porkbun / Dynadot). Cloudflare's at-cost figures are the best public proxy for registry + ICANN. Namecheap could not be fetched (bot protection).
8. Not verifiable from primary sources: wholesale for .dev/.app/.studio/.io/.ai, ccTLD lock/grace rules, any first-party Identity Digital statement on .io continuity, FY27 registrar-fee vote result.

---

## 0. Method, limits, blocked hosts

- Fetched primary pages with curl (browser User-Agent) and headless Chromium where JS was required; PDFs converted with pypdf; SEC filing fetched with a declared automated-agent User-Agent as SEC requires.
- WebSearch quota for the session ran out (200/200, shared with parallel analysts) part-way through; remaining gaps were closed by direct fetches only. Search snippets were **never** used as evidence: every claim below rests on a page that was opened.
- Not fetchable (recorded, not worked around): namecheap.com (Cloudflare challenge; challenge host blocked by egress policy), iso.org OBP (Cloudflare challenge), tld-list.com (403), investor.verisign.com (403), stocktitan (403), commonslibrary/lordslibrary/hansard/bills.parliament.uk (Cloudflare 403), itv.com (upstream failure), france24.com and cdapress.com and newarab.com (403), registrar.identitydigital.services (Cloudflare 403).
- "Derived" means arithmetic on published numbers; "third-party" means a non-primary aggregator. Both are labelled.

## 1. Master table (one row per TLD)

| | .com | .ai | .dev | .app | .io | .studio |
|---|---|---|---|---|---|---|
| Type | gTLD (non-sponsored, legacy) | ccTLD (Anguilla) | new gTLD | new gTLD | ccTLD (British Indian Ocean Territory) | new gTLD |
| Registry operator / manager (IANA) | VeriSign Global Registry Services | Government of Anguilla | Charleston Road Registry Inc. (Google) | Charleston Road Registry Inc. (Google) | Internet Computer Bureau Limited | Dog Beach, LLC c/o Identity Digital |
| Backend / who runs it | Verisign | Identity Digital (since Jan 2025; before: CoCCA platform) | Google Registry | Google Registry | ICB, an Identity Digital subsidiary; registrar front "powered by Name.com" | Identity Digital |
| Governing contract | ICANN .com RA, dated 2024-12-01 | none with ICANN (ccTLD); 5-year contract Anguilla-Identity Digital | ICANN base RA, dated 2014-10-16 | ICANN base RA, dated 2015-05-14 | none with ICANN; nic.io Terms and Rules | ICANN base RA, dated 2015-02-11 |
| Wholesale (latest) | **$10.26 now; $10.97 from 2026-11-01** (primary) | **$80.00/yr; $160 per 2-yr minimum** since 2026-03-05 (secondary, corroborated) | not public; implied **$12.00** (derived) | not public; implied **$14.00** (derived) | not public; implied **$50.00** renewal (derived; third-party) | not public; implied **$31.00** (derived) |
| Next known wholesale change | up to +7% per Pricing Year starting 10-26 in 2027, 2028, 2029 (ceilings, not announced) | none found | none found | none found | +12.0% on 2027-01-19 (third-party, masked; about $56 if base is $50) | +29.0% on 2026-10-06 (third-party, masked; about $40 if base is $31) |
| Price-setting rule | contractual cap (RA 7.3) | set by Government of Anguilla; Identity Digital operates | registry sets; 30-day notice (new regs), 180-day (renewals) | same | registry sets; no ICANN rule | registry sets; 30/180-day notice |
| ICANN transaction fee | $0.20 (registrar-paid) | none | $0.20 | $0.20 | none | $0.20 |
| Minimum term | 1 yr (max 10) | **2 yrs** (max 10) | 1 yr (max 10) | 1 yr (max 10) | 1 yr (max 10 at registrars) | 1 yr (max 10) |
| ICANN Transfer Policy / 60-day rules | apply | do not apply (own rules) | apply | apply | do not apply (own rules) | apply |
| Special obligations | none beyond ICANN | abusive-use rules, UDRP adopted, no IDNs | **HSTS-preloaded: HTTPS only** | **HSTS-preloaded: HTTPS only** | content rules (no porn), 2 nameservers, sovereignty risk | reserved-names list held by registry |

## 2. Per-TLD findings

### 2.1 .com

**(a) Operator.** IANA lists the sponsoring organisation as "VeriSign Global Registry Services" [S1]. ICANN's agreement page lists operator "VeriSign, Inc.", agreement date 1 December 2024 [S9]. Verisign's 10-Q: "we renewed the .com Registry Agreement with ICANN, pursuant to which we will remain the sole registry operator for the .com registry through November 30, 2030" [S7].

**(b) Price rule and latest price.**
- Rule: RA section 7.3(d)(ii): Verisign may raise the Maximum Price "in each Pricing Year of the final four Pricing Years of every six year period, with the first six year period beginning on October 26, 2018" by the smaller of 1.07 x the previous Maximum Price or 1.07 x the highest price charged [S8]. Pricing Year is 26 October to 25 October (7.3(d)(iii)) [S8].
- Verisign 10-Q: "The current such six-year period began on October 26, 2024." and "On April 23, 2026, we announced that we will increase the annual registry-level wholesale fee for each new and renewal .com domain name registration from $10.26 to $10.97 effective November 1, 2026." [S7]. Previous step: $9.59 to $10.26 effective 2024-09-01 [S7].
- Ceilings (derived): 10.97 x 1.07 = 11.74; x 1.07 = 12.56; x 1.07 = 13.44. These are contractual maxima for Pricing Years starting 2027-10-26, 2028-10-26, 2029-10-26, not announced prices. (Domain Name Wire gives $13.42; arithmetic differs by rounding.)
- Notice and lock-in: "Registry Operator shall provide no less than six months prior notice in advance of any increase for new and renewal domain name registrations" and "continue to offer for periods of up to ten years new and renewal domain name registrations fixed at the price in effect at the time such offer is accepted" (7.3(f)) [S8].
- Same price for all: "Registry Operator shall charge the same price for Registry Services ... to all ICANN-accredited registrars" (7.3(e)); the price applies to new, renewal and inter-registrar transfer (7.3(c)) [S8].
- Third-party tracker agrees: current $10.26, scheduled $10.97 effective 2026-11-01 [S33].

**ICANN fees on .com.** Verisign pays ICANN a registry-level fee: "multiplied by US$0.25" per annual increment (7.2(a)); the RA says the Maximum Price "does not include ... the ICANN Variable Registry-Level Fee" (7.3(g)); that variable fee's transactional part "shall not exceed US$0.25" and is only charged in quarters where ICANN does not collect the variable accreditation fee from registrars (7.2(b)) [S8]. In practice registrars pay ICANN **$0.20** (see 3.1).

**(c) Premium / reserved.** No registry premium tier: 7.3 obliges one price at or below the Maximum Price for the whole bundle of Registry Services, same for every registrar [S8]. Reserved labels are in the RA "Schedule of Reserved Names" (ICANN/IANA names, all single-character labels, etc.) [S8].

**(d) Lifecycle.** ICANN consensus policies apply (Transfer Policy, ERRP, AGP Limits): see section 5.

### 2.2 .ai

**(a) Operator.** IANA: ccTLD manager "Government of Anguilla"; registration services URL https://nic.ai; RDAP at rdap.identitydigital.services; record last updated 2025-02-11 [S2]. nic.ai is the "Official Registry Operator Website", copyright Identity Digital [S19]. Domain Name Wire (2024-10-15): "the deal operates on a revenue share, with Anguilla retaining the majority of revenue. Identity Digital is providing a mimimum revenue guarantee." and "It is a five-year contract." ".Ai previously used the CoCCA (Council of Country Code Administrators) platform." [S17]. Handoff completed mid-January 2025 [S18].

**(b) Price.**
- Domain Name Wire 2026-02-02: "The minimum two-year registration period costs $70 per year, meaning registrants pay at least $140 for the two-year registration." and "Starting March 5, the wholesale cost will increase by $10 per year or $20 per registration or renewal, raising the fee to $160." [S15]. Domain Incite 2026-02-03 agrees (+14.3%, "two-year minimum commitment") [S16]; third-party tracker shows last update 2026-03-05, "Register - 2yr", +33.3% since tracking began (120 to 160, derived) [S33].
- Cloudflare, which says it sells "at cost", lists .ai at $80.00/yr [S34], consistent with $80 wholesale and no ICANN fee.
- Registry's own price notice was **not found** (nic.ai FAQ last updated 2025-04-24 has no price; registrar portal is login-gated). Confidence: medium-high on $80/yr.
- Earlier statement (Jan 2025, Identity Digital's Ram Mohan): "Identity Digital does not have plans to change the wholesale pricing at this time." [S18] Superseded by the March 2026 change.
- Set-by: Wikipedia calls the base fee "as established by Anguilla" (secondary); revenue-share contract above.

**(c) Premium / reserved.** Dynadot: "This TLD supports premium domains. Please note that premium domains have different pricing." on its .ai page [S36]. Premium renewal behaviour: **unverified**. Expired .ai names have been auctioned: "Expired domains are currently auctioned through Dynadot" (Jan 2025), with Identity Digital and Anguilla "working ... to finalize the .ai domain auction process" [S18]; current process unverified.

**(d) Lifecycle.**
- Minimum term 2 years: Porkbun "Note: .AI Domains require a minimum term of 2 years for registration and renewals. .AI transfers include a 2 year renewal." [S35]; Dynadot ".AI domains require a minimum registration or renewal term of 2 years." [S36]; Identity Digital confirmed transfers "included the extension of the domain by 2 years on Jan. 15, 2025" [S18].
- ICANN policies: none bind a ccTLD. ICANN: "Registrations of domain names within two-letter country-code top-level domains (ccTLDs) ... are administered by country-code managers." [S42]. nic.ai FAQ: "The .ai Registry adheres to the Uniform Domain-Name Dispute Resolution Policy (UDRP)" (voluntary) [S19]. Registry-level transfer lock / grace / redemption rules: **not published**; unverified.
- Rules of use: abusive use (malware, phishing, spam, botnets, DoS...) prohibited; privacy/proxy services permitted; zone file access "currently paused" [S19]. Name syntax 1-63 chars, letters/digits/hyphens, no IDNs (Dynadot page) [S36].

### 2.3 .dev and .app

**(a) Operator.** IANA: sponsoring organisation "Charleston Road Registry Inc."; RDAP pubapi.registry.google; .dev delegated 2014-11-20, .app 2015-06-25 [S3][S4]. Google Registry FAQ: "Charleston Road Registry (CRR), also known as Google Registry, is a wholly-owned subsidiary of Google." [S22]. ICANN RA dates: .dev 16 Oct 2014; .app 14 May 2015; both "Base, Non-Sponsored" [S14]. Renewal status of these 10-year agreements: not checked.

**(b) Price.**
- Wholesale is **not public**. Registrar materials are gated: "please log into Google with your registry.google credential and follow the link below for a Google Drive folder containing the materials" [S23]. Google states "We offer equivalent terms to all registrars in terms of pricing" [S22].
- Rule: base RA 2.10: price increases need "no less than thirty (30) calendar days" notice for initial registrations and "no less than one hundred eighty (180) calendar days" for renewals; registrars may buy 1-10 years at the current price [S13]. No cap.
- Implied wholesale (derived): Cloudflare charges $12.20 (.dev) and $14.20 (.app) "at cost" [S34] = $12.00 / $14.00 + $0.20 ICANN. Third-party tracker (masked) shows one change each since 2024-08-01: .dev +20.0% (10 to 12) and .app +16.7% (12 to 14), consistent with those figures [S33]. Confidence: medium.
- Base-RA fees: registry pays ICANN $0.25 per transaction only after more than 50,000 transactions in a quarter (6.1) [S13]; that cost sits inside wholesale.

**(c) Premium / reserved.** Google's premium schedule and reserved list are not public. Base RA 2.10(c) requires uniform renewal pricing except where "the applicable registrant expressly agreed in its registration agreement with registrar to higher Renewal Pricing at the time of the initial registration ... following clear and conspicuous disclosure of such Renewal Pricing" [S13]. Spec 5 reserved-names schedule applies [S13].

**HSTS / HTTPS-only (load-bearing for Mosshatch).**
- Google Registry .dev page: "The .dev top-level domain is included on the HSTS preload list, making HTTPS required on all connections to .dev websites and pages without needing individual HSTS registration or configuration." [S20]. .app page: "The .app top-level domain is included on the HSTS preload list, making HTTPS required on all connections to .app websites" [S21].
- Chromium's static list has both as `{ "name": "dev", "policy": "public-suffix", "mode": "force-https", "include_subdomains": true }` and the same for "app" [S24]. hstspreload.org API returns `"status":"preloaded"` for dev and app and `"unknown"` for com, ai, io, studio [S24].
- Effect: plain HTTP is not usable in preload-aware browsers for any name or subdomain under .dev/.app, so a valid certificate is required from the first request. This is a browser behaviour, not a registrar contract term.

### 2.4 .io (incl. Chagos status)

**(a) Operator.** IANA: ccTLD manager "Internet Computer Bureau Limited" c/o Sure (Diego Garcia) Limited; technical contact ICB in Orpington, UK; **"Record last updated 2023-01-18."** [S5]. nic.io FAQ: "Internet Computer Bureau Ltd (ICB) is the country code top level domain manager and registry operator for the .IO, .AC, and .SH top level domains"; registrar services "powered by Name.com" [S32]. Domain Incite: "Identity Digital runs .io via a UK-based shell company it acquired several years ago." [S29]; ICB reported 2024 revenue of GBP 31.6 million (about $42.4 million) [S29 tag page, 2025-10-20 item]. Governing terms are nic.io Terms and Rules, not an ICANN contract: "neither the UK nor Mauritius has a direct governance or contractual relationship with .io" [S29].

**(b) Price.** Wholesale not public. Cloudflare lists .io at $32.00 first year and **$50.00 renewal** (no ICANN fee on a ccTLD) [S34]. Third-party tracker: Identity Digital, ccTLD, tracking since 2026-01-19, "+11.1% since tracking started" and a scheduled **+12.0% effective 2027-01-19**; dollar figures masked [S33]. Derived: 45 to 50 (+11.1%) then about 56 (+12.0%); a June 2025 reader comment on Domain Incite put wholesale at $45 [S29 comment]. **Unverified**: no registry notice found. The first-year vs renewal split ($32 vs $50) is unexplained.

**(c) Premium / reserved.** Dynadot: ".IO ... supports premium domains" with different pricing [S36]. nic.io rules: "Certain single letter, two or more letters or number domain names are available for registration in a controlled and equitable manner" [S32]. No public premium schedule.

**(d) Lifecycle.** Fee "covers a period of one (1) year for each new registration, and one (1) year for each renewal" [S32]; "NIC.IO reserves the right to charge a fee for all transfers, modifications or deletions" and transfers require "payment of the appropriate transfer fee applicable at the time of the transfer" (clauses 13, 18) [S32]. Registrars price .io transfer = one renewal year (Porkbun 51.80, Dynadot 53.50) [S35][S36]. Rules: at least two nameservers, no sexual/pornographic use, registry may "immediately deactivate the offending registration" [S32]. Lock/grace/redemption at registry level: unpublished; unverified.

**Delegation continuity: what is on record (newest first).**

| Date | Source | What it says |
|---|---|---|
| 2026-09-22/23 | Gulf News (AFP wire), https://gulfnews.com/world/asia/uk-says-will-revisit-chagos-deal-after-latest-trump-criticism-3-1.500685166 | "Britain will rework its deal to return the Chagos Islands to Mauritius, a minister confirmed Wednesday, after US President Donald Trump branded the agreement 'terrible' during his first meeting with UK leader Andy Burnham." Streeting: Trump's position "as currently drafted is not changing"; annual payments "would not be made 'at this stage'." [S28] |
| 2026-09-06 (page edit) | Wikipedia, Chagos sovereignty dispute | "In April 2026, it was announced that the deal would not be approved before the end of the parliamentary session" [S31] |
| 2026-04-13 | Domain Incite | "The UK has run out of time to pass legislation approving the treaty ... in the current parliamentary session"; "While UK ministers have denied over the weekend that the Chagos deal is fully dead"; success now depends on Trump "or his successor" [S29] |
| 2025-05-22 | Treaty text, gov.uk PDF | Article 18: "This Agreement shall enter into force on the first day of the first month following the date of receipt of the later note by which the Parties notify each other that they have completed their respective internal requirements" [S27]. The text contains no reference to domain names (searched: "domain", "internet", "top-level" absent). |
| 2024-11-14 | ICANN blog by Kim Davies (VP IANA Services) | "'IO' persists in the ISO 3166-1 standard and there has been no change to the standard as a result of the announcement." "In essence, a five-year time window will commence during which time usage of the domain will need to be phased out." "It is not a foregone conclusion that a change in sovereignty will result in a change to the .io domain" [S25] |
| policy | IANA ccTLD retirement guide | "When a ccTLD is no longer eligible, IANA will notify the ccTLD manager..."; "By default the ccTLD will be removed after five years"; extensions "limited to a maximum of five additional years, therefore the maximum possible period for a retirement is 10 years." [S26] |

Status summary (as of 2026-09-29): the treaty is signed and not in force; UK ratification legislation lapsed; the UK government says it is reworking the deal; IANA's .io record is unchanged since 2023; ICANN has said no change to ISO 3166-1 "IO" as of Nov 2024; ISO's own current listing could not be fetched (iso.org blocked). Retirement, if it ever happens, is triggered by ISO removing "IO" and then IANA's 5-to-10-year process, i.e. earliest realistic loss of resolution is years after any ISO change. Domain Incite reports Identity Digital also became back-end for Mauritius's .mu (2025-03-04) [S29 tag page]. **No first-party Identity Digital / ICB statement on continuity was found** (nic.io FAQ, Identity Digital newsroom first page).

### 2.5 .studio

**(a) Operator.** IANA: sponsoring organisation "Dog Beach, LLC" c/o Identity Digital Inc.; name servers v0n0.nic.studio etc.; record last updated 2025-10-07 [S6]. ICANN RA: operator Dog Beach, LLC, dated 11 February 2015, Base, Non-Sponsored [S14].

**(b) Price.** Not public. Cloudflare at-cost $31.20 = about $31.00 + $0.20 [S34]. Third-party tracker (Identity Digital, new gTLD): "+77.1% since tracking started" and a scheduled **+29.0% effective 2026-10-06**, figures masked; it also appears on the tracker's public "Upcoming" list [S33]. Derived: about $31 to about $40. **Unverified**: under base RA 2.10(b) a renewal increase needs 180 days' notice, so a registrar notice should exist; not retrievable. Porkbun's page says registry premium ("Higher-priced domains known as premium (or 'registry premium') domains") are on sale for .studio [S35].

**(c) Premium / reserved.** Identity Digital policy: "Reserved for operations and other purposes, including without limitation certain premium names, which the registry may change from time to time"; "Registrars may request the reserved domain names list from their account managers." [S45]. So the list is registrar-gated.

**(d) Lifecycle.** ICANN policies apply (section 5).

## 3. ICANN fees and how the price is made

### 3.1 ICANN per-transaction fee (gTLDs only)
- FY26 (1 Jul 2025-30 Jun 2026), approved by registrars: "$0.20 per transaction is assessed on each annual increment of an add, renew, or transfer transaction that has survived a related add or auto-renew grace period." [S10]
- FY27 budget (May 2026): "If approved, these fees will be billed at $0.20 per transaction." and "ICANN does not intend to raise fees in FY27." [S11]. The FY27 registrar vote result was not found: **unverified whether ratified**, but no increase is planned.
- Payer and pass-through: paid by the registrar; ICANN's own page: "This fee can be billed by the registrar separately on its invoice to the registrant, but is paid by the registrar to ICANN." [S12]
- Fees are not due on names deleted inside the add grace period (transaction must have "survived" it). ccTLDs .ai/.io carry no ICANN transaction fee.
- Registry-side fees (inside wholesale): .com $0.25 (RA 7.2(a)) [S8]; new gTLDs $0.25 above 50,000 transactions/quarter (RA 6.1) [S13].

### 3.2 Components of a price (for the "how the price is made" disclosure)

| Component | Who sets it | .com | .ai | .dev | .app | .io | .studio |
|---|---|---|---|---|---|---|---|
| 1. Registry wholesale (per year) | Registry | 10.26 (10.97 from 2026-11-01) | 80.00 | about 12.00 (implied) | about 14.00 (implied) | about 50.00 (implied) | about 31.00 (implied; about 40 after 2026-10-06 if tracker is right) |
| 2. ICANN transaction fee | ICANN, paid by registrar | 0.20 | 0 | 0.20 | 0.20 | 0 | 0.20 |
| **At-cost floor (1+2)** | | **10.46** (11.17 from 2026-11-01) | **80.00** | **12.20** | **14.20** | **50.00** | **31.20** |
| 3. Registrar margin | Registrar (observed spread over floor, renewal) | 0 (CF) to 0.62 (PB) | 0 to 5.60 | 0 to 0.67 | 0 to 0.73 | 0 to 3.50 | 0 to 2.19 |
| 4. Reseller flat fee | Mosshatch | flat | flat | flat | flat | flat | flat |
| 5. Payment processing, taxes | Stripe / tax authorities | not covered here | | | | | |

Worked example, .com at 2026-09-29 vs after 2026-11-01: floor 10.46 to 11.17 (+0.71) before any margin. Cloudflare "sells domains at cost: you pay the registry and ICANN list price with no markup" [S34]; its .com price of 10.46 equals 10.26 + 0.20 exactly, which validates the model.

Disclosure notes: show first-year vs renewal price separately (registrar promos: Porkbun .dev 8.75 first year vs 12.87 renewal; .io 28.12 vs 51.80). ICANN ERRP requires renewal, post-expiration renewal and restore fees be "reasonably available ... at the time of registration" [S39]. Wholesale for non-.com TLDs can change with 30/180 days' notice, so the disclosure should state price date and that renewal follows the price at renewal time.

## 4. Premium and reserved names; how premium prices surface

- **Contract layer.** New gTLD base RA 2.10(c): renewal prices must be uniform, except for names where the registrant expressly agreed to higher Renewal Pricing "following clear and conspicuous disclosure" at initial registration [S13]. So a premium name can renew at a premium price only if disclosed at purchase. .com has no premium tier (7.3) [S8]. ccTLDs .ai/.io: no such rule; renewal-at-premium behaviour **unverified**.
- **Protocol layer.** EPP Fee Extension (RFC 8748): "Objects may be assigned to a particular class, category, or tier, each of which has a particular fee or set of fees associated with it." Servers must use "standard" for ordinary objects and publish the list of other values out of band [S43]. Fees are returned by `check`/`info` per command (create, renew, transfer, restore).
- **Registrar API layer.**
  - Cloudflare Registrar API (beta): `tier: "standard" | "premium"` ("Premium domain with higher pricing from the registry"); `pricing.registration_cost` and `renewal_cost` may differ, "especially for premium domains where initial registration often costs more than renewals"; "premium registration is not currently supported by this API. Surface the premium pricing to the user, but do not proceed"; planned: "When supported, premium domains will require explicit fee acknowledgement before registration." [S44]
  - Dynadot API: `premium=1` must be passed to register/transfer a premium domain; `show_price=1` returns premium details and price in the account currency [S50].
  - Registrar retail pages flag premium support per TLD (Dynadot shows the same "supports premium domains" sentence on all six; not TLD-specific evidence) [S36].
- **Reserved lists.** .com: RA schedule (public) [S8]. New gTLDs: RA Specification 5 (public) plus registry-held reserved lists (Identity Digital: available to registrars on request) [S13][S45]. .io: nic.io allocation rules [S32]. .ai / Google: not public.
- Mosshatch rule of thumb: quote and approve per name, using the registrar's live `check` response; treat any non-standard tier as a separate, human-approved flow with the renewal price shown.

## 5. Lifecycle and transfer rules

### 5.1 gTLDs (.com .dev .app .studio): ICANN consensus policies apply
| Item | Rule | Source |
|---|---|---|
| Add grace period | "typically the five-day period following the initial registration"; AGP Limits Policy caps refunds at "10% of that Registrar's net new registrations ... or fifty (50) domain names, whichever is greater" | [S40] |
| Auto-renew grace | length is registry-specific (not in RAs); Cloudflare docs show its own 30-day+10-day suspension model, not the registry's | unverified at registry level; [S44] |
| Redemption Grace Period | "all gTLD registries must offer a Redemption Grace Period ('RGP') of 30 days"; registry disables DNS and prohibits transfer during RGP | [S39] |
| Pending delete | "After five calendar days following the end of the redemptionPeriod, your domain is purged" | [S41] |
| Expiry notices | at least two before expiry (about 1 month and 1 week), another within 5 days after; DNS interruption for the last 8 renewable days; expired page must say so | [S39] |
| Minimum / maximum term | 1 to 10 years | [S13][S8] |
| Transfer Policy in force | Updated 2024-02-21 for Registration Data Policy; "must implement no later than 21 August 2025" | [S37] |
| 60-day rules | Registrar "may deny a transfer request only in the following specific instances": 3.7.5 "requested within 60 days of the creation date"; 3.7.6 within 60 days after a transfer; and "The Registrar must impose a 60-day inter-registrar transfer lock following a Change of Registrant" unless the registrant opted out beforehand | [S37] |
| Auth code | Registrars "must provide the Registered Name Holder with the unique 'AuthInfo' code and remove the 'ClientTransferProhibited' within five (5) calendar days" if no self-service | [S37] |
| Transfers add a year | .com transfers pay a full renewal year (RA 7.3(c)) | [S8] |
| Reform pending | GNSO TPR page (Last Updated 21 April 2026): Board resolution "Adopted on: TBD"; implementation "TBD" | [S38] |
| Registration Data Policy | "today marks the effective date of the Registration Data Policy" (2025-08-21) | [S47] |

Dynadot notes that some registries enforce the 60-day lock themselves: Verisign (.com) and Identity Digital gTLDs "60-day lock after initial registration"; "Each registry sets its own policies. Some TLDs don't have a 60-day lock." [S36] (registrar statement, secondary).

### 5.2 ccTLDs (.ai .io): not bound by ICANN consensus policies
- ICANN: ccTLD registrations "are administered by country-code managers" [S42]; RFC 1591: the manager is "trustee" for the nation and the Internet community [S42]. ICANN consensus policies are imposed by gTLD registry agreements and the RAA, which ccTLD managers do not sign. The Transfer Policy and ERRP are drafted for "generic top-level domain" registrars/registries [S37][S39].
- **.ai**: 2-year minimum; transfers add 2 years; UDRP adopted voluntarily; expiry may end in auction; lock/grace/redemption not published (unverified).
- **.io**: 1-year units; transfer fee applies; registry T&Cs allow the registry to "vary the terms of the Registration Agreement on renewal or transfer" (clause 19) [S32]; lock/grace/redemption not published (unverified).
- Registrar retail tables show identical grace/redemption fields for all TLDs (Dynadot grace 30, delete 5) so they do not evidence registry rules [S36].
- Practical: apply Mosshatch's own conservative 60-day lock and 5-day auth-code SLA to all six TLDs; verify actual ccTLD behaviour in the upstream registrar's sandbox.

## 6. Retail cross-check (USD per year, accessed 2026-09-29)

| TLD | Cloudflare reg / renew [S34, third-party mirror] | Porkbun reg / renew / transfer [S35, own API] | Dynadot reg / renew / transfer [S36, own page] | At-cost floor (derived) |
|---|---|---|---|---|
| .com | 10.46 / 10.46 | 11.08 / 11.08 / 11.08 | 10.88 / 10.88 / 10.88 | 10.46 |
| .ai | 80.00 / 80.00 | 82.70 / 82.70 / 165.09 (2 yr) | 85.60 / 85.60 / 171.20 (2 yr) | 80.00 |
| .dev | 12.20 / 12.20 | 8.75 promo / 12.87 / 12.87 | 8.00 sale (list 12.00) / 12.50 / 11.99 | 12.20 |
| .io | 32.00 / 50.00 | 28.12 promo / 51.80 / 51.80 | 28.89 sale (list 53.50) / 53.50 / 53.50 | 50.00 |
| .app | 14.20 / 14.20 | 8.75 promo / 14.93 / 14.93 | 9.99 sale (list 14.00) / 14.50 / 13.99 | 14.20 |
| .studio | 31.20 / 31.20 | 11.84 promo / 32.44 / 32.44 | 11.96 sale (list 33.39) / 33.39 / 33.39 | 31.20 |

- Porkbun: `POST https://api.porkbun.com/api/json/v3/pricing/get` (no auth) returned 910 TLDs, e.g. `"com": {"registration":"11.08","renewal":"11.08","transfer":"11.08"}` [S35].
- Cloudflare figures come from cfdomainpricing.com (third party, "Updated 2026-09-29"; per-TLD updatedAt 2026-09-17 to 2026-09-28); Cloudflare's own docs say prices are at cost [S34]. Cloudflare's dashboard was not accessible.
- Dynadot: per-TLD pages (https://www.dynadot.com/domain/com etc.). Its bulk price table (/domain/prices) rendered in EUR to this client (e.g. .com EUR 9.81), with a JSON-LD USD/EUR ratio of about 1.137 (.io 29.62 USD vs 26.05 EUR); the per-TLD USD pages were used instead.
- Namecheap: **not retrieved** (Cloudflare challenge). Fourth registrar left as a gap.
- Observation: spread over the at-cost floor is 0 to 5.60 USD/yr; largest on .ai (percentage small, dollars large). After 2026-11-01 all .com retail will rise by at least the 0.71 wholesale step.
- Coverage: all six TLDs are sold by all three registrars. API-level TLD support (which of them a registrar's reseller API can register) was not checked here; Cloudflare's API is a beta covering "only a subset" of extensions [S44].

## 7. Obligations checklist for Mosshatch

(Reseller of an ICANN-accredited registrar; details of the upstream contract are outside this file.)

| # | Obligation | Applies to | Source | How Mosshatch meets it (design) |
|---|---|---|---|---|
| 1 | Serve all traffic over HTTPS; no HTTP-only forwarding, parking or creature pages; valid cert from first request, apex and subdomains | .dev, .app | [S20][S21][S24] | Auto-provision TLS before publishing DNS; HTTPS-only redirector; test with preload-aware browser |
| 2 | Reseller flow-down: registration agreement must include "all registration agreement provisions and notices required by the ICANN Registrar Accreditation Agreement and any ICANN Consensus Policies"; identify sponsoring registrar; publish Registrants' Benefits and Responsibilities; link ICANN registrant education | gTLDs (and by contract usually all) | [S46] RAA 3.12.2-3.12.7 | Legal pages templated from upstream registrar's reseller terms |
| 3 | Make renewal, post-expiration renewal and redemption/restore fees "reasonably available ... at the time of registration" | gTLDs | [S39] ERRP 4.1 | Show renew price and restore fee on checkout and in the creature card |
| 4 | Expiry notices (about 1 month and 1 week before; another within 5 days after); interrupt DNS for the last 8 renewable days with an expired page giving renewal instructions | gTLDs | [S39] | Resend schedule + expiry landing state; note DNS interruption conflicts with "creature stays alive" UX |
| 5 | Redemption Grace Period 30 days; restore only via registrar; fee applies | gTLDs | [S39][S41] | Expose "restore" as a passkey-approved paid action |
| 6 | Release AuthInfo/transfer authorisation within 5 calendar days; no more restrictive than contact changes; no refusal over payment dispute | gTLDs | [S37] 5.2-5.4 | Vault-held auth code, human passkey to reveal; agents cannot fetch |
| 7 | Deny/lock transfers within 60 days of creation or of a transfer; impose 60-day lock after Change of Registrant unless opted out beforehand | gTLDs | [S37] 3.7.5, 3.7.6, II.C.2 | Enforce same rule for all six TLDs (conservative) |
| 8 | Watch pending reform: TAC replaces AuthInfo, 30-day lock, no change-of-registrant lock (Board adoption "TBD") | gTLDs | [S38] | Keep lock logic configurable |
| 9 | Registration Data Policy in effect since 2025-08-21 | gTLDs | [S47] | Data-minimising registrant schema |
| 10 | Price change notice: .com 6 months; new gTLD 30 days (new regs) / 180 days (renewals); multi-year purchase at current price up to 10 years | .com; .dev .app .studio | [S8][S13] | Price table with effective dates; re-quote before capture |
| 11 | Uniform renewal pricing unless higher renewal price disclosed at initial registration | .dev .app .studio | [S13] 2.10(c) | Premium names: store and show renewal price at purchase |
| 12 | 2-year minimum on registration and renewal; transfers add 2 years | .ai | [S35][S36][S18] | Checkout shows 2-year total; no 1-year option |
| 13 | Abusive-use prohibitions (malware, phishing, spam, botnets, DoS); UDRP applies | .ai | [S19] | AUP mirrors registry list |
| 14 | Content rules: no sexual/pornographic use; at least two nameservers; registry may deactivate | .io | [S32] | AUP + DNS validation |
| 15 | Sovereignty risk disclosure at .io purchase; retirement would be a 5-year (max 10) IANA process | .io | [S25][S26][S28] | Risk note plus optional block on long prepay (business decision) |
| 16 | Registry-held reserved/premium lists: names may be unavailable or premium regardless of search | .studio (and other Identity Digital gTLDs) | [S45] | Always use live availability + tier from upstream |
| 17 | ICANN transaction fee applies only to gTLD add/renew/transfer that survive grace; pass through | gTLDs | [S10][S12] | Itemise or fold into flat fee; refund in AGP returns fee |

## 8. Design implications

1. Never hard-code wholesale: fetch price and tier from the upstream registrar's check/quote call, and keep an effective-dated price table (known steps: .com 2026-11-01; .studio 2026-10-06 and .io 2027-01-19 unverified).
2. The human-approval step must bind to a price: pin the quote (registration, renewal, tier) in the approval, re-check at capture, and require re-approval if the price moved.
3. Offer multi-year prepay for gTLDs before known increases (up to 10 years at current price under .com RA 7.3(f) and base RA 2.10(b)); this is a price-lock feature, not a discount.
4. Model ccTLD differences explicitly: .ai min 2 years and 2-year transfer add; .io sovereignty risk; no RGP/ERRP guarantees.
5. .dev/.app: bake TLS automation into the creature-hosting path; HSTS applies to every subdomain including vault and agent endpoints under such names.
6. Treat premium/non-standard tier as blocked in v1 or as a separate flow with renewal price shown (mirrors Cloudflare API behaviour).
7. Pricing page copy: "registry price + ICANN fee + Mosshatch flat fee", with date stamp and next-change notice.

## 9. Unverified / gaps

- Wholesale for .dev, .app, .studio, .io (no public registry price; implied from Cloudflare at-cost + third-party tracker); .ai only via secondary sources plus Cloudflare.
- .studio +29% on 2026-10-06 and .io +12% on 2027-01-19 (third-party masked tracker).
- Any first-party Identity Digital / ICB statement on .io continuity; ISO 3166-1 current status of "IO" (iso.org blocked); UK Parliament and gov.uk pages on the lapsed bill (blocked; relied on AFP via Gulf News, Domain Incite, Wikipedia).
- ICANN registrar vote on FY27 fees.
- ccTLD (.ai, .io) transfer lock, grace, redemption, auction rules at registry level.
- Auto-renew grace length at Verisign/Google/Identity Digital (registry EPP documentation not public).
- Premium renewal behaviour for .ai, .io, .dev, .app.
- Namecheap retail prices.
- Renewal status of 2014/2015 base RAs for .dev/.app/.studio.

## 10. Source register (all accessed 2026-09-29)

| ID | URL | Note |
|---|---|---|
| S1 | https://www.iana.org/domains/root/db/com.html | IANA .com record (updated 2026-03-10) |
| S2 | https://www.iana.org/domains/root/db/ai.html | IANA .ai record (updated 2025-02-11) |
| S3 | https://www.iana.org/domains/root/db/dev.html | IANA .dev (updated 2025-04-11) |
| S4 | https://www.iana.org/domains/root/db/app.html | IANA .app (updated 2025-04-11) |
| S5 | https://www.iana.org/domains/root/db/io.html | IANA .io (updated 2023-01-18) |
| S6 | https://www.iana.org/domains/root/db/studio.html | IANA .studio (updated 2025-10-07) |
| S7 | https://www.sec.gov/Archives/edgar/data/0001014473/000101447326000028/vrsn-20260630.htm | Verisign Form 10-Q, quarter ended 2026-06-30 |
| S8 | https://itp.cdn.icann.org/en/files/registry-agreements/com/com-agreement-html-01-12-2024-en.htm | .com RA (2024-12-01) |
| S9 | https://www.icann.org/en/registry-agreements/details/com | ICANN RA listing |
| S10 | https://www.icann.org/en/announcements/details/icann-accredited-registrars-approve-registrar-level-fees-for-fiscal-year-2026-21-07-2025-en | FY26 registrar fees approved |
| S11 | https://www.icann.org/en/system/files/files/adopted-icann-budget-fy2027-published-2026-en.pdf | FY27 budget (May 2026) |
| S12 | https://www.icann.org/en/resources/registrars/accreditation/financials | Registrar financial considerations |
| S13 | https://itp.cdn.icann.org/en/files/registry-agreements/dev/dev-agmt-html-16oct14-en.htm | Base RA text (.dev); same base for .app/.studio |
| S14 | https://www.icann.org/en/registry-agreements/details/dev (also /app, /studio) | Operators and agreement dates |
| S15 | https://domainnamewire.com/2026/02/02/ai-domain-name-prices-going-up-20/ | .ai +$10/yr from 2026-03-05 (secondary) |
| S16 | https://domainincite.com/31540-ai-hits-seven-figures-raises-prices | .ai price rise (secondary) |
| S17 | https://domainnamewire.com/2024/10/15/identity-digital-inks-ai-domain-deal-with-anguilla/ | Contract terms (secondary) |
| S18 | https://domainnamewire.com/2025/01/23/identity-digital-is-now-managing-ai-domains-heres-what-this-means-for-registrants/ | Identity Digital Q&A (secondary) |
| S19 | https://www.nic.ai/faq | .ai registry FAQ (last updated 2025-04-24; answers rendered by clicking accordions) |
| S20 | https://www.registry.google/domains/dev/ | .dev HSTS statement |
| S21 | https://www.registry.google/domains/app/ | .app HSTS statement |
| S22 | https://www.registry.google/faqs/ | Google Registry FAQ |
| S23 | https://www.registry.google/for-partners/ | Partner resources gated |
| S24 | https://raw.githubusercontent.com/chromium/chromium/main/net/http/transport_security_state_static.json ; https://hstspreload.org/api/v2/status?domain=dev | Chromium preload list; status API |
| S25 | https://www.icann.org/en/blogs/details/the-chagos-archipelago-and-the-io-domain-14-11-2024-en | ICANN/IANA statement on .io |
| S26 | https://www.iana.org/help/cctld-retirement | ccTLD retirement guide |
| S27 | https://assets.publishing.service.gov.uk/media/682f25afc054883884bff42a/CS_Mauritius_1.2025_Agreement_Chagos_Diego_Garcia.pdf | Treaty text |
| S28 | https://gulfnews.com/world/asia/uk-says-will-revisit-chagos-deal-after-latest-trump-criticism-3-1.500685166 | AFP report, 2026-09-23 |
| S29 | https://domainincite.com/31642-io-safe-for-now-as-trump-puts-chagos-deal-on-ice ; https://domainincite.com/tag/chagos ; https://domainincite.com/tag/io ; https://domainincite.com/31086-io-questions-in-sharp-focus-as-uk-signs-chagos-treaty | Domain Incite .io coverage |
| S30 | https://www.rusi.org/explore-our-research/publications/commentary/uks-chagos-islands-deal-where-are-we-now | RUSI commentary 2026-04-10 (opinion; context only) |
| S31 | https://en.wikipedia.org/wiki/Chagos_Archipelago_sovereignty_dispute ; https://en.wikipedia.org/wiki/.io | Secondary, edited 2026-09-06 and 2026-09-27 |
| S32 | https://www.nic.io/terms.htm ; /rules.htm ; /faq.htm ; /policy.htm | .io registry terms, rules, FAQ |
| S33 | https://www.tldpricechanges.com/tld/{com,ai,io,dev,app,studio} ; https://www.tldpricechanges.com/upcoming | Third-party registry price tracker (masked prices) |
| S34 | https://cfdomainpricing.com/prices.json ; https://developers.cloudflare.com/registrar/llms-full.txt | Cloudflare prices (third-party mirror) and Cloudflare docs |
| S35 | https://api.porkbun.com/api/json/v3/pricing/get ; https://porkbun.com/tld/{ai,dev,app,io,studio} | Porkbun prices and notes |
| S36 | https://www.dynadot.com/domain/{com,ai,dev,io,app,studio} ; https://www.dynadot.com/blog/60-day-domain-locks ; https://www.dynadot.com/domain/prices | Dynadot prices, lock blog, table |
| S37 | https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers/policy | Transfer Policy in force |
| S38 | https://gnso.icann.org/en/group-activities/active/transfer-policy-review | TPR PDP status (updated 2026-04-21) |
| S39 | https://www.icann.org/resources/pages/errp-2013-02-28-en | Expired Registration Recovery Policy |
| S40 | https://www.icann.org/resources/pages/agp-policy-2008-12-17-en | AGP Limits Policy |
| S41 | https://www.icann.org/resources/pages/epp-status-codes-2014-06-16-en | EPP status codes |
| S42 | https://www.icann.org/resources/pages/cctlds-21-2012-02-25-en ; https://www.rfc-editor.org/rfc/rfc1591.txt | ccTLD administration |
| S43 | https://www.rfc-editor.org/rfc/rfc8748.txt | EPP Fee Extension |
| S44 | https://developers.cloudflare.com/registrar/llms-full.txt | Cloudflare Registrar docs/API (premium tier, lifecycle) |
| S45 | https://www.identity.digital/policies/reserved-names ; https://www.identity.digital/premium-catalog | Identity Digital reserved/premium |
| S46 | https://www.icann.org/en/contracted-parties/accredited-registrars/registrar-accreditation-agreement/2013-registrar-accreditation-agreement-17-09-2013-en | 2013 RAA (3.12 reseller clauses) |
| S47 | https://www.icann.org/en/announcements/details/icann-registration-data-policy-now-in-effect-for-contracted-parties-21-08-2025-en | RDP in effect |
| S50 | https://www.dynadot.com/domain/api-commands | Dynadot API (`premium`, `show_price`) |
