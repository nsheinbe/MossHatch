# MOSSHATCH: trademark and name-collision knockout (research, not legal advice)

Prepared 2026-09-29 for the Mosshatch Phase 0 plan. All facts below were fetched live on 2026-09-29 (accessed date on every citation). This is a **knockout** screen, not a clearance opinion and not legal advice. A lawyer-run clearance search must precede any filing or launch spend.

## TL;DR

1. No identical or near-identical MOSSHATCH / MOSS HATCH / MOSSHATCHED mark was found in USPTO, EUIPO eSearch plus, TMview (81 offices incl. GB, US, EU, WIPO/Madrid, CA, AU, JP, KR, CN) or WIPO Global Brand Database on 2026-09-29. Exact, contains, begins-with, wildcard, fuzzy and phonetic modes were all run.
2. Domain-name registration services are **Nice Class 45** (not 42): USPTO ID Manual 13-2026 "Domain name registration services" is Class 045 and its note says resellers may use that wording. Class 42 is for SaaS/hosting/vault/auth, 9 for downloadable software.
3. Closest collision is **CROSSHATCH** (Olympus Technologies Inc., US Reg. 7836851, Class 42 data-storage/API SaaS, WO 1766322): two letters different, rhymes with MOSSHATCH. Its own site says the company shut down July 2025, so practical risk is lower but the registration is live.
4. The formatives are crowded: HATCH (many Class 42/9/45/35 software marks, incl. HATCHIFY AI-agent SaaS filed 2026-08-11) and MOSS (Nufin GmbH fintech SaaS in 9/35/38/42; Polyarc creature VR game in 9/41). Avoid "Moss" or "Hatch" as stand-alone product or feature names.
5. Risk read: Class 45 low; Class 42 medium (CROSSHATCH plus crowded fields); Class 9, 35, 36, 38 low. Overall knockout verdict: no blocker found; proceed to professional clearance.
6. RDAP: mosshatch.com is registered (Namecheap, created 2026-09-29T17:48:38Z, expires 2027-09-29, parked defaults, registrant privacy-masked so ownership is not publicly verifiable). .net .org .io .ai .dev .app .studio return not-found; .co has no usable RDAP (DNS NXDOMAIN only).
7. Handles: npm, PyPI, crates.io, RubyGems, NuGet, YouTube, TikTok, X, Bluesky and Play Store look free; GitHub login search shows no "mosshatch" user (direct profile fetch blocked); Instagram and npm scope could not be verified.
8. Could not query: UK IPO direct (Cloudflare Turnstile host blocked by egress policy; GB covered via TMview), Google/Bing/DDG search, GitHub REST API. WebSearch budget was exhausted, so open-web coverage is thin (Brave, Wikipedia, HN, Steam, Companies House, EDGAR).
9. Meaning: coined compound of moss (plant) + hatch (emerge from egg; door; cross-hatch shading). Not in Wiktionary. "Moss Hatch" appears only as a surname pairing and a baby-hat colourway.

## 1. What could and could not be queried

| Source | Route | Status | Notes |
|---|---|---|---|
| USPTO Trademark Search | https://tmsearch.uspto.gov, headless Chromium; site's own JSON API `POST https://tmsearch.uspto.gov/prod-stage-v1-0-0/tmsearch` called from the page (AWS WAF challenge solved by the page's own script) | Queried | Data current: contains a mark filed 2026-09-27 (TALES OF MOSSHELM, serial 50131398). Includes dead marks. |
| EUIPO eSearch plus | https://euipo.europa.eu/eSearch/ (v5.13.0-RC1.2), JSON `POST https://euipo.europa.eu/copla/ctmsearch/json` | Queried | EUTMs and IRs designating the EU. |
| TMview | https://www.tmdn.org/tmview/, `POST https://www.tmdn.org/tmview/api/search/results` | Queried | 143,032,652 marks, 81 offices in `api/general/globals`; feed update dates (dd/mm/yyyy in the API, shown here as ISO): GB, US, EM, WO 2026-09-29; JP 2026-09-25; CA 2026-09-24; CN 2026-09-03; IN 2026-05-04 (stale). |
| WIPO Global Brand Database | https://branddb.wipo.int, headless Chromium; page's proof-of-work captcha solved by the page's own widget; `POST https://api.branddb.wipo.int/search` from the verified page; response decoded with the page's own bundled decoder | Queried, with gaps | 76,822,006 records per `https://api.branddb.wipo.int/dbinfo`. Several requests returned HTTP 401 and are marked "not obtained" below. Flag: the API response is client-side encoded; I decoded it only with the app's own routine. |
| UK IPO trade mark search | https://trademarks.ipo.gov.uk/ipo-tmtext | **Blocked by egress policy / not queried directly** | HTTP 403 "Security check" page; challenge host `brunhild.challenges.cloudflare.com:443` was `connect_rejected` by the proxy. GB data taken from TMview's GB feed (updated 29/09/2026) instead. |
| Justia / Trademarkia mirrors | not used | n/a | Primary USPTO route worked, so mirrors were unnecessary. |
| Web search | WebSearch tool: budget exhausted (200/200). Google: CAPTCHA ("unusual traffic"). DuckDuckGo: proxy 502. Bing: returns unrelated results (unusable). Brave via Chromium: worked for 3 queries then HTTP 429. | Partial | Open-web section is therefore medium/low confidence. |
| GitHub REST / github.com | `api.github.com` and `github.com/<user>` returned 403 "sessions are bound to their configured repositories" | Blocked by session policy | Used the provided GitHub search tools instead (user/repo/code search). |
| .co RDAP | Not in IANA bootstrap; `rdap.nic.co` and `rdap.nic.io` `connect_rejected`; `rdap.registry.co` and `rdap.centralnic.com/co` return 404 even for google.co | Unavailable | DNS (DoH) only. |
| Instagram, npmjs.com, Reddit, GitLab, Medium, Product Hunt | HTTP 429 / 403 bot walls | Not verified | |
| Wayback Machine, crt.sh | 429 / connection reset / 502 | Not obtained | Prior history of mosshatch.com therefore unverified. |

## 2. Domain registrations for the label MOSSHATCH (RDAP)

Method: IANA RDAP bootstrap (https://data.iana.org/rdap/dns.json, publication 2026-09-28T22:00:03Z, accessed 2026-09-29) maps .com to `rdap.verisign.com/com/v1/`, .net to `rdap.verisign.com/net/v1/`, .org to `rdap.publicinterestregistry.org/rdap/`, .ai and .studio to `rdap.identitydigital.services/rdap/`, .dev and .app to `pubapi.registry.google/rdap/`. The bootstrap file has no entry for .io or .co. Each "not found" was paired with a control lookup on the same server.

| Domain | Endpoint (accessed 2026-09-29) | Result | Control on same server |
|---|---|---|---|
| mosshatch.com | https://rdap.verisign.com/com/v1/domain/mosshatch.com | **Registered** (details below) | n/a |
| mosshatch.net | https://rdap.verisign.com/net/v1/domain/mosshatch.net | HTTP 404, not registered | example.net 200 |
| mosshatch.org | https://rdap.publicinterestregistry.org/rdap/domain/mosshatch.org | 404 "Object not found" | wikipedia.org 200 |
| mosshatch.io | https://rdap.identitydigital.services/rdap/domain/mosshatch.io | 404 "Object not found" | nic.io 200 (created 2003-09-15), google.io 200. Note .io is not in the IANA bootstrap, so this endpoint is an inference (medium confidence). |
| mosshatch.ai | https://rdap.identitydigital.services/rdap/domain/mosshatch.ai | 404 "Object not found" (first tries were 429 rate limits, later 404) | nic.ai 200 in retry log |
| mosshatch.dev | https://pubapi.registry.google/rdap/domain/mosshatch.dev | 404 "mosshatch.dev not found" | google.dev 200 |
| mosshatch.app | https://pubapi.registry.google/rdap/domain/mosshatch.app | 404 "mosshatch.app not found" | google.app 200 (created 2018-03-29) |
| mosshatch.studio | https://rdap.identitydigital.services/rdap/domain/mosshatch.studio | 404 "Object not found" | nic.studio 200 (created 2015-04-27) |
| mosshatch.co | none usable | RDAP **unverified**. DoH NS query returns NXDOMAIN (Status 3, SOA `ns0.centralnic.net`) | google.co resolves NS via DoH |

Corroboration by DNS-over-HTTPS (https://cloudflare-dns.com/dns-query, NS type, accessed 2026-09-29): NXDOMAIN for mosshatch .net .org .io .ai .dev .app .co .studio and for about 40 other TLDs (xyz, me, info, biz, us, uk, co.uk, de, eu, fr, tech, cloud, site, online, store, shop, games, gg, tv, sh, art, design, software, systems, tools, live, world, space, fun, page, link, club, network, digital, agency, ca, au, com.au, nl, se, jp, in, cc, pro) and for moss-hatch.com, mosshatched.com, mosshatchs.com. NXDOMAIN alone does not prove a name is unregistered (registered names without delegation also give NXDOMAIN); it is used only as support where RDAP exists. mosshatch.ws is inconclusive because .ws wildcards every label (random label zzqxjvkwplm93.ws resolves to the same 64.70.19.203).

### mosshatch.com record (user says they own it)

Source: https://rdap.verisign.com/com/v1/domain/mosshatch.com and https://rdap.namecheap.com/domain/MOSSHATCH.COM, accessed 2026-09-29 (~19:04 to 19:43 UTC).

| Field | Value |
|---|---|
| Registrar | NameCheap, Inc., IANA Registrar ID 1068 |
| Created | 2026-09-29T17:48:38Z (`"eventAction":"registration"`) |
| Expires | 2027-09-29T17:48:38Z (`"eventAction":"expiration"`; Namecheap RDAP: `registrar expiration`) |
| Last changed | 2026-09-29T17:48:42Z |
| Status | `client transfer prohibited` at Verisign; Namecheap RDAP adds `add period` (the 5-day add grace period) |
| Nameservers | DNS1.REGISTRAR-SERVERS.COM, DNS2.REGISTRAR-SERVERS.COM |
| DNSSEC | `"delegationSigned":false` |
| Registrant | masked: `Privacy service provided by Withheld for Privacy ehf` (Reykjavik, IS) in the Namecheap RDAP |
| DNS records (DoH) | A 192.64.119.39; MX 10 eforward1..3.registrar-servers.com, 15 eforward4, 20 eforward5; TXT `"v=spf1 include:spf.efwd.registrar-servers.com ~all"`. These are Namecheap default forwarding/parking-style records; nothing is deployed. |

Reading: created about 1h15m before this research ran, at Namecheap, privacy-masked, parked, still inside the add grace period. That is consistent with a fresh purchase by the user today, but **public data cannot confirm who the registrant is**; confirm inside the Namecheap account. Because the creation date is today, an earlier owner cannot be excluded (a dropped name gets a new creation date) and the Wayback history could not be fetched. Related timing evidence: the public GitHub repo `nsheinbe/MossHatch` was created 2026-09-29T18:55:04Z (GitHub search tool, accessed 2026-09-29); this is circumstantial only.

## 3. Nice classes: which class covers domain-name registration?

Answer (verified, replaces the "42 vs 45" memory): **Class 45**. Historically Class 42; moved to 45 by the 9th Nice edition (2007).

| Evidence | Source | Quote |
|---|---|---|
| Nice 13-2026 Class 45 explanatory note | https://nclpub.wipo.int/enfr/?basic_numbers=show&class_number=45&explanatory_notes=show&lang=en&menulang=en&mode=flat&notion=&version=20260101&pagination=no (accessed 2026-09-29) | "This Class includes, in particular: ... registration of domain names;" Alphabetical list also has "registration of domain names [legal services]" and "leasing of internet domain names". |
| Nice Class 35 cross-reference | https://nclpub.wipo.int/enfr/?...class_number=35... (accessed 2026-09-29) | "registration of domain names ( Cl. 45 )." |
| USPTO ID Manual, version 13-2026, entry 42239 | https://idm-tmng.uspto.gov/api/search/public?search-term=domain%20name&version=13-2026 (site https://idm-tmng.uspto.gov/id-master-list-public.html, accessed 2026-09-29) | Class 045 "Domain name registration services": "Domain name registration services are the services of domain registry operators, ICANN-accredited domain name registrars and their authorized re-sellers involving the reservation of particular Internet addresses on a given top-level domain. These services do not include the technological activities of domain registry operators, which are computer services in Class 42." |
| USPTO ID Manual, entry 49845 "Domain name registrar services" (Class 045) | same | "Registrars are distinguishable from re-sellers, who may provide domain name registration services under authorization from registrars, but are not themselves ICANN-accredited registrars. Domain name registration services is acceptable wording in Class 45 for any entity or person that provides such services." |
| Other Class 045 entries (all status A) | same | "Registration of domain names" (90446), "Registration of domain names for others" (74119), "Leasing of internet domain names" (60137), "Domain name monitoring services", "Consultancy relating to domain name registration services". |
| History | same, entry 90632 (status D) | "01-01-2007 - Transferred from Class 42 pursuant to 9th edition of Nice Agreement." |
| Class 42 domain-adjacent entries | same | "Domain name search services, namely, conducting online computerized searches for the availability of domain names" and "Providing computer servers for others for electronic storage of domain name addresses" are Class 042. |

Other classes Mosshatch will plausibly touch (Nice 13-2026 list, same nclpub URLs, accessed 2026-09-29):

| Class | Why | Nice entries found |
|---|---|---|
| 42 | SaaS, hosting, encrypted vault, agent tokens, auth | "software as a service (SaaS), platform as a service (PaaS)"; "hosting computer websites"; "data encryption services"; "electronic data storage"; "user authentication services using single sign-on technology for online software applications"; "providing online non-downloadable computer software" |
| 9 | Downloadable app/CLI/SDK/browser extension | "computer software applications, downloadable"; USPTO ID Manual has "Downloadable browser extension software for {specify the function ...}" |
| 35 | Online retail / marketplace, business services | "provision of an online marketplace for buyers and sellers of goods and services"; class note excludes domain registration ("Cl. 45") |
| 36 | Only if Mosshatch itself handles payments/escrow | "processing of credit card payments"; "electronic funds transfer"; "e-wallet payment services". Stripe Checkout use would not by itself make this a Mosshatch service. |
| 38 | Only if Mosshatch offers email/messaging services | "transmission of electronic mail" |

## 4. Trademark database results

Search terms: MOSSHATCH, MOSS HATCH, MOSSHATCHED, MOSSHATCHING, plus phonetic and spelling neighbours (MOSSATCH, MOSHATCH, MOSHATCH, MOSSHACH, MOSS-HATCH, MOSSY HATCH, MORSE HATCH, MOSH HATCH, MOS HATCH, MOSSHAT*, MOSSH*). Controls confirmed each engine returns hits for a known neighbour (CROSSHATCH).

### 4.1 USPTO (https://tmsearch.uspto.gov, accessed 2026-09-29)

| Query (field WM = wordmark) | Hits |
|---|---|
| match_phrase "mosshatch" / "moss hatch" | 0 / 0 |
| wildcard `*mosshatch*`, `*moss*hatch*`, `moss*hatch*`, `mosshat*`, `*mosshach*`, `*mossatch*`, `*mosshatcher*` | 0 each |
| both tokens moss AND hatch; mossy AND hatch; morse AND hatch; mosh AND hatch | 0 each |
| owner name wildcard `*mosshatch*`; owner text "moss hatch"; goods/services text "mosshatch" and "moss hatch"; pseudo-mark "moss hatch" and "mos hatch" | 0 each |
| fuzzy "mosshatch" edit distance 1 | 0 |
| fuzzy "mosshatch" distance 2 | 20: all CROSSHATCH-family (Geiger furniture Class 20; BOI Trading clothing Classes 3/9/18/25, mostly dead; Carr Winery Class 33; Olympus Technologies Class 42), COSHATCH (Class 25), LOSSWATCH (dead, Class 42, 1996) |
| fuzzy "mosshatched" distance 2 | 16, all MISSMATCHED / MM MOMSMATCHED (dead) |
| fuzzy "moshatch", "mossatch", "mosshach", "mossyhatch" (1-2) | COSHATCH only, otherwise 0 |
| fuzzy "morsehatch" (2) | MOVIEHATCH, HORSEMATCH, MOREWATCH, MOUSEPATCH (irrelevant) |
| Controls | wildcard `*crosshatch*` returned 19; fuzzy family returned CROSSHATCH marks |

Result: **no MOSSHATCH-identical or near-identical US filing, live or dead.**

### 4.2 EUIPO eSearch plus (https://euipo.europa.eu/eSearch/, accessed 2026-09-29)

MarkVerbalElementText CONTAINS and STARTS_WITH for mosshatch, mosshatched, mosshat, mosshatc, mossatch, moshatch, mos hatch, morse hatch, mossy hatch, mosshach, hatchmoss, mosshatchery, mossh: all 0 except CONTAINS "mossh" = 1 (MOSSHI, EUTM 010383727, Hong Kong applicant, Classes 18/25/28, "Registration expired"; irrelevant). Two-term AND (moss + hatch in one mark): 0. Basic search UI for "mosshatch": "Trade marks (0)". A literal "moss hatch" with a space returned a server "Problem detected" page, so the space case was covered by the AND query. Control: "crosshatch" returned 22 trade marks (including W01766322 CROSSHATCH, Class 42, "IR accepted").

### 4.3 TMview (https://www.tmdn.org/tmview/, accessed 2026-09-29; all 81 offices)

| Mode | mosshatch | Other terms |
|---|---|---|
| Contains (C) | 0 | "moss hatch": 3 (Moss Off Thatch, Moss Off Thatch Roof, GB Classes 37/40; Moss Bach JP Class 25, ended); mosshatched, mossatch, moshatch, mosshach, morse hatch, mossy hatch: 0 |
| Begins with (B), Exact (E) | 0 | all variants 0 |
| Fuzzy (F) | 3, all JP モスキャッチシステム / MOSSCATCH SYSTEM (Ended, Classes 37/40/41, individual applicant) | mossatch/moshatch: MosCatch (IN, Classes 21/37/44, MNR Marketing LLP), MOSPATCH (KR), MOSCATCH (KR Class 5), COSHATCH (US 25), LOSHATCH (CN expired 27). mosshach: **MOSSMACH** (CN, registered, Classes 9/35/38/42, applicant 妙算神机科技（上海）有限公司, filed 2023-12-05) |
| Controls | crosshatch: C 135, B 90, E 58 | |

### 4.4 WIPO Global Brand Database (https://branddb.wipo.int, accessed 2026-09-29)

| Term / strategy | Result |
|---|---|
| mosshatch / Simple ("contains the word") | 0 |
| mosshatch / Exact | 0 |
| mosshatch / Fuzzy | 172; top of list all CROSSHATCH-family, MOSCATCH, LOSSWATCH, MISSMATCH, OSSPATCH, MOUSNATCH, COSHATCH, MOSPATCH, MOSSBACH (JP) |
| mosshatch / Phonetic ("sounds like") | 36,517, noisy; top scores MACHATCH (GB, Classes 6/19), MASACH (Classes 6/40), MOSACH (Class 35, US ended), MASHACH (MX 35/38/41), MASATS. None similar in Class 45/42/9. |
| mosshatch / Stemming | not obtained (HTTP 401) |
| moss hatch / Exact | 0 |
| moss hatch / Simple | not obtained (401) |
| mosshatched / Simple, Fuzzy | 0; 25 (MISSMATCHED, MM MOMSMATCHED) |
| mosshatching / Fuzzy | 1 (MOMSWATCHING.COM) |
| moss hatch / Fuzzy | 120,041 (noise, not reviewed) |

### 4.5 UK IPO

Not queried directly (blocked by egress policy, see section 1). TMview GB feed (updated 29/09/2026) shows no MOSSHATCH mark in contains/begins/exact/fuzzy modes. Confidence: medium.

## 5. Potential conflicts (owner, classes, status, goods/services, similarity)

"Live" = registered or pending per the register on 2026-09-29. Similarity notes are my screening judgement, not an opinion.

| # | Mark | Owner | Jurisdiction / number | Classes | Status | Goods/services (short) | Similarity to MOSSHATCH | Relevance |
|---|---|---|---|---|---|---|---|---|
| 1 | CROSSHATCH | Olympus Technologies Inc. (Delaware) | US Reg. 7836851 (serial 98179406, registered 2025-06-17); WO 1766322 (Class 42; EUIPO shows W01766322 "IR accepted") | 42 | Live. Owner's site https://crosshatch.io states: "We shut down July 2025." | API software for user data; electronic and cloud data storage; SaaS for data sharing preferences | 2-letter edit distance (CRO to MO), identical SSHATCH tail, rhymes; different meaning (cross-hatch). | Highest for Class 42 storage/vault SaaS. Non-use for 3 consecutive years is prima facie abandonment (15 U.S.C. 1127) but that is years away; registration could also be assigned. |
| 2 | MOSS | Nufin GmbH (Germany) | US Reg. 7369253 (serial 79315217, reg. 2024-04-30); GB UK00003694023; WO 1601251 | 9, 35, 36 (GB/WO), 38, 42 | Live | Expense/finance management software, PaaS, hosting of transaction platforms, e-payments | Shares the leading MOSS element; MOSSHATCH is a longer unitary compound. | Medium-low for Class 42/9 SaaS and any payments feature. Well-known fintech (McKinsey article "Hyperscaling a fintech start-up: Lessons from Moss"). |
| 3 | MOSS | Polyarc, Inc. (Delaware) | US Reg. 5846030; GB UK00801402364; WO 1402364 | 9, 41 (WO adds 28) | Live | Video game software (VR game "Moss", creature protagonist) | Same leading element. | Low for Class 45/42; relevant only if Mosshatch ships downloadable creature games/apps (Class 9). |
| 4 | MOSS | Moss & Associates, LLC | US Reg. 5317577, 5317578 | 42, 37 | Live | Structural design, construction | MOSS element only | Low (unrelated field). |
| 5 | MOSSO | Diffuse Digital LLC (Wyoming) | US serial 99921598, filed 2026-07-03 | 36, 42 | Pending | SaaS for music publishing royalties; fee collection | One-letter variant of MOSS, not of MOSSHATCH | Low; watch. |
| 6 | HATCH | Playful Software Inc. | US Reg. 7191178 | 42 | Live | SaaS/online software development tools for apps and websites | Shares HATCH word; MOSSHATCH is a compound | Medium-low for a developer/agent platform description. |
| 7 | HATCH | Hatch, Inc. (North Carolina) | US Reg. 7077830 | 9, 42 | Live | Children's educational software | HATCH | Low. |
| 8 | HATCH | Ahead, Inc.; Visuwell, Inc.; Adammatic LLC; Fulcrum Chicago, Inc. | US Regs. 7530248; 7388980; 5537244; 8357217 (Fulcrum registered 2026-07-21) | 42 | Live | PaaS for IT hardware; healthcare PaaS; sales-engagement search platform; application-service-provider hosting/note-taking/AI data entry | HATCH | Shows HATCH is crowded in Class 42 (dilution helps MOSSHATCH); each is a possible objector to a HATCH-only sub-brand. |
| 9 | HATCH | HATCHIFY INC. (Delaware) | US serial 50045179, filed 2026-08-11 | 42, 35, 38 | Pending | AI-as-a-service and SaaS for creating and managing AI agents, sales automation | HATCH | Watch: same AI-agent space as Mosshatch's agent feature. Do not use "Hatch" alone. |
| 10 | HATCH | Hatch Ltd./Hatch Ltee (Canada) | US Regs. 7547690, 7547689, 2911963 | 45, 35, 42 | Live | Engineering; environmental permitting services (Class 45) | HATCH | Low (engineering); shows "HATCH" already in Class 45 for permitting. |
| 11 | HATCH / COHATCH / ENHATCH / DEVHATCH / SKILLHATCH | various | e.g. EM 018151237 (Hatch Baby, Classes 9/42); GB Hatch marks in 9/35/42/45 (e.g. HatchaHome UK00004239596, 9/35/42/45); COHATCH US 97918976 (42) | 9, 35, 36, 42, 45 | Live | Assorted | HATCH | Confirms HATCH is common in software/business classes across US, EU, GB. |
| 12 | MOSSMACH | 妙算神机科技（上海）有限公司 | CN 75587550 (42), 75599543 (35), 75593117 (9), 75610953 (38), filed 2023-12-05 | 9, 35, 38, 42 | Registered | not shown in TMview list | Edit distance 2 | Relevant only for China. |
| 13 | CROSSHATCH (other owners) | Geiger International; BOI Trading; Carr Winery | US, WO | 20, 25, 33, 3/9/18/25 | mixed | furniture, clothing, wine | Same CROSSHATCH word | Low (different goods). |
| 14 | MOSSHEAD; COSHATCH; MOSSCATCH SYSTEM; MOSSHI | various | US/JP/EM | 25, 41; 25; 37/40/41 (ended); 18/25/28 (expired) | mixed/dead | apparel, misc. | 1-2 letter neighbours | Negligible. |

Open-web namesakes (not registrations): "Moss" fintech (Berlin); "Moss" real-time semantic search for conversational AI (Y Combinator company, founded 2024, https://www.ycombinator.com/companies/moss, seen via Brave, accessed 2026-09-29); "Hatch Apps" (YC fellowship software-development automation startup); a 2010 blog comment "crosshatch, mosshatch - whatever you do" (http://gwenbuchanan.blogspot.com/2010/05/cross-hatching-practicing.html); "Organic Top-Knot Hat in Moss Hatch" (colourway, https://www.lovedbaby.com/products/organic-top-knot-hat-in-moss-hatch); "Minnie Moss Hatch" obituary (person, https://www.russonmortuary.com/obituaries/minnie-moss-hatch). No company, product, app, game, software or publication named MOSSHATCH was found.

## 6. Risk read per class

| Class | Use in Mosshatch | Risk | Reason |
|---|---|---|---|
| 45 | Domain name registration (reseller) | **Low** | Zero MOSSHATCH-like marks; no CROSSHATCH in 45; HATCH in 45 is engineering permitting (Hatch Ltd.) and personal-name MOSS marks. |
| 42 | SaaS, vault, hosting, agent tokens, auth | **Medium** | CROSSHATCH (live, storage/API SaaS, rhymes, though owner reportedly shut down), MOSS (Nufin SaaS), many HATCH SaaS marks incl. 2026 AI-agent filing. A unitary coined compound is defensible, but this is the class where an examiner or opposer has something to cite. |
| 9 | Downloadable app, CLI, SDK | Low | MOSS (Polyarc games, Nufin finance apps) and HATCH (Hatch Inc., Hatch Baby, Runaway Play) exist; different marks as a whole. |
| 35 | Online retail/marketplace | Low | MOSS/HATCH retail marks are in apparel/food/consulting; no MOSSHATCH. |
| 36 | Only if payments/escrow offered | Low | HATCH banking/realty and MOSS (Terra Vista carbon credits; Nufin) marks are single-word formatives. |
| 38 | Only if email/messaging offered | Low | HATCH Entertainment / Nanoco HATCH; nothing near MOSSHATCH. |

Overall: **low** at knockout level, with Class 42 the watch item. Foreign: CN MOSSMACH is the only oddity.

## 7. Handles and package names (accessed 2026-09-29)

| Namespace | Check | Result | Confidence |
|---|---|---|---|
| npm package | https://registry.npmjs.org/mosshatch (also moss-hatch, mosshatched, @mosshatch/core) | 404, unpublished. `-/v1/search?text=mosshatch` total 0. | high (name), scope ownership unverified |
| npm scope @mosshatch / user | npmjs.com 403; registry user endpoint 401 | unverified | n/a |
| PyPI | https://pypi.org/pypi/mosshatch/json (also moss-hatch, mosshatched) | 404 | high |
| PyPI user | https://pypi.org/user/mosshatch/ | bot-challenge page | unverified |
| crates.io, RubyGems, NuGet, Packagist, Homebrew, Open VSX, VS Marketplace publisher | API lookups | all 404 | high/medium |
| Docker Hub | https://hub.docker.com/v2/users/mosshatch/ and /orgs/mosshatch/ | 404 | medium |
| GitHub user/org | GitHub search tool, `mosshatch in:login`: total_count 0; `"moss hatch" in:fullname`: 0. Direct profile fetch blocked (403 by session policy). Only repo hit: nsheinbe/MossHatch (public, created 2026-09-29T18:55:04Z). Code search hits (5) are WoW emulator "Deepmoss Hatchling" scripts (false positives). | no mosshatch account found | medium |
| X | https://x.com/mosshatch | HTTP 404, title "User Profile Not Found - X \| 404 Error" | medium |
| Instagram | https://www.instagram.com/mosshatch/ | HTTP 429 / login wall | unverified |
| YouTube | https://www.youtube.com/@mosshatch (and @moss-hatch) | 404 | medium-high |
| TikTok | https://www.tiktok.com/@mosshatch | page data `statusCode` 10221, "Couldn't find this account" | medium |
| Bluesky | public API getProfile for mosshatch.bsky.social | "Profile not found" | medium |
| Others | mastodon.social/@mosshatch 404; dev.to/mosshatch 404; LinkedIn company/mosshatch 404 (logged-out, low confidence) | free/none | low-medium |
| Apple App Store | iTunes Search API (software, iPad, Mac; terms mosshatch, moss hatch, mosshatched) | no app named Mosshatch; results are other "Moss" apps (MoorMOSS, Bryophyte Lens, Moss - Plant Care & Rescue) | medium |
| Google Play | https://play.google.com/store/search?q=mosshatch&c=apps | "No results for mosshatch"; package IDs com.mosshatch, app.mosshatch, com.mosshatch.app, io.mosshatch return 404. For "moss hatch": Hatch Sleep, Moss (Nufin GmbH), Moss Slots, Hatch Dragons (Runaway Play) | medium |
| Steam | https://store.steampowered.com/api/storesearch/?term=mosshatch | total 0 | medium |
| Hosting subdomains | mosshatch.vercel.app "DEPLOYMENT_NOT_FOUND"; mosshatch.netlify.app 404; mosshatch.github.io 404; mosshatch.pages.dev, .fly.dev, .workers.dev NXDOMAIN | unclaimed | high |

Company registers: UK Companies House search "mosshatch": "No results found" (https://find-and-update.company-information.service.gov.uk/search/companies?q=mosshatch); SEC EDGAR company search: "No matching companies."; Wikipedia search "mosshatch": 0 hits; Hacker News (Algolia): no story or comment about a Mosshatch brand; Steam 0; Marginalia none. US state registers (e.g. Delaware, Wyoming) and OpenCorporates were not searched.

## 8. Meaning and connotation

- MOSSHATCH is not a dictionary word: Wiktionary has no entry (HTTP 404 for `mosshatch`, https://en.wiktionary.org/w/index.php?title=mosshatch&action=raw, accessed 2026-09-29).
- English "moss": "Any of various small, green, seedless plants growing on the ground or on the surfaces of trees, stones" (https://en.wiktionary.org/w/index.php?title=moss&action=raw). Also a surname and "Moss" is a town/municipality in Østfold, Norway (Wiktionary "Moss", Norwegian Bokmål and Nynorsk entries). Hungarian "moss" is the imperative "wash!" (Wiktionary, pronounced roughly "mosh"). Luxembourgish slang "Moss" = "chick, bird, girl". Low German "Moss" = moss.
- English "hatch": "To emerge from an egg"; "A horizontal door in a floor or ceiling"; "To devise (a plot or scheme)"; and "To shade an area of (a drawing, diagram, etc.) with fine parallel lines" (https://en.wiktionary.org/w/index.php?title=hatch&action=raw). Fits the creature-hatches-from-domain theme; the cross-hatch sense drives the CROSSHATCH resemblance.
- "Moss Hatch" in commerce: a colourway name (L'ovedbaby hat) and a surname pair. The word MOSSHATCH itself was not found used as a brand.
- German "Moos", Dutch "mos", Swedish "mossa", East-Asian transliterations (Japanese katakana such as モスハッチ, Chinese phonetic renderings) were not verified; the JP MOSSCATCH SYSTEM and CN MOSSMACH hits show why transliterations need a search. Possible pronunciations to search: "moss-hatch", "mosh-atch", "mo-shatch".
- No offensive or sensitive meaning found in English, Norwegian, Hungarian, Luxembourgish or Low German; other languages unverified.

## 9. What a real clearance search must add

1. Full-text and prefix/suffix search of live and dead marks in **all** Nice classes 9, 35, 36, 38, 41, 42, 45 in US, EU, UK, plus each launch market (CA, AU, CH, JP, KR, CN, IN, BR); include the -SSHATCH and MOSS- word families (CROSSHATCH, MOSS, MOSSO, MOSSMACH) and HATCH-suffix compounds.
2. Phonetic and translated/transliterated search (mosh-atch, moss-hatch, katakana, hanzi/pinyin, Cyrillic, Arabic), using a vendor with a real sound-alike engine; the free WIPO "phonetic" mode is too noisy to rely on.
3. Design-mark search with Vienna codes if a creature logo will be filed (USPTO design search codes, EUIPO/WIPO Vienna); creature logos may collide with animal/plant figurative marks.
4. Common-law use: web, app stores, social, marketplaces, podcasts, GitHub organisations, domain aftermarket, plus state trademark registers and state business-name registers (Delaware, Wyoming, etc.), OpenCorporates, D&B; and unregistered "Mosshatch" uses that a lawyer's vendor report pulls from news and dockets.
5. Pending/ITU and recently filed applications: rerun the search on the filing date (USPTO data here runs to 2026-09-27; new filings such as HATCHIFY and MOSSO appeared within the last 90 days).
6. Status diligence on CROSSHATCH (US Reg. 7836851, WO 1766322): current owner, whether the business is dormant, assignment records, and whether a consent or coexistence letter or a later non-use challenge is worthwhile.
7. Domain and UDRP/URS screening of the .com and defensive TLDs, and check for prior ownership history of mosshatch.com.
8. Counsel opinion on likelihood of confusion (US DuPont factors; EU relevant-public test) for Classes 42 and 45, and on whether a reseller (not ICANN-accredited registrar) can use the Class 45 wording, then decide filing strategy (US ITU under 1(b); Madrid designations).

## 10. Design implications

- Keep the name as one unitary word "Mosshatch". Do not shorten to "Moss" or "Hatch" in product, agent, feature or SDK names (MOSS: Nufin, Polyarc; HATCH: many Class 42/9/45/35 owners; HATCHIFY AI agents pending).
- Do not describe or brand the vault or storage feature with "cross-hatch" wording.
- File first in Class 45 (core service) and Class 42 (vault/SaaS/auth), Class 9 if apps or CLI ship; defer 35/36/38 unless those services are actually offered.
- All eight starter TLDs other than .com look unregistered by RDAP (and .co by DNS only). Defensive registration is cheap, but availability and premium pricing must be checked at the registrar, not from RDAP.
- Reserve handles now: GitHub org, npm scope @mosshatch, PyPI/crates names, X, Instagram, YouTube, TikTok, Bluesky; verify Instagram and the npm scope manually.
- Keep the GitHub repo name in mind: it is public since 2026-09-29 (evidence of first public use of the name, of little legal weight before any commercial use).
- The .com is inside the 5-day add grace period at Namecheap; the registrant is privacy-masked, so keep account access documented for future WIPO/UDRP standing.

## 11. Sources (all accessed 2026-09-29)

- IANA RDAP bootstrap: https://data.iana.org/rdap/dns.json
- Verisign RDAP: https://rdap.verisign.com/com/v1/domain/mosshatch.com ; https://rdap.verisign.com/net/v1/domain/mosshatch.net
- Namecheap RDAP: https://rdap.namecheap.com/domain/MOSSHATCH.COM
- PIR RDAP: https://rdap.publicinterestregistry.org/rdap/domain/mosshatch.org
- Identity Digital RDAP: https://rdap.identitydigital.services/rdap/domain/mosshatch.io (also .ai, .studio)
- Google Registry RDAP: https://pubapi.registry.google/rdap/domain/mosshatch.dev (also .app)
- USPTO: https://tmsearch.uspto.gov/ ; ID Manual https://idm-tmng.uspto.gov/id-master-list-public.html
- EUIPO: https://euipo.europa.eu/eSearch/
- TMview: https://www.tmdn.org/tmview/
- WIPO GBD: https://branddb.wipo.int/ ; Nice: https://nclpub.wipo.int/enfr/
- UK IPO (blocked): https://trademarks.ipo.gov.uk/ipo-tmtext
- Statutes: https://www.law.cornell.edu/uscode/text/15/1127 ("Nonuse for 3 consecutive years shall be prima facie evidence of abandonment.") ; https://www.law.cornell.edu/uscode/text/15/1052 (2(d): "so resembles a mark registered in the Patent and Trademark Office ... as to be likely ... to cause confusion")
- CROSSHATCH owner site: https://crosshatch.io
- Wiktionary: https://en.wiktionary.org/w/index.php?title=moss&action=raw ; hatch ; Moss ; mosshatch
- Registries/APIs: https://registry.npmjs.org/mosshatch ; https://pypi.org/pypi/mosshatch/json ; https://crates.io/api/v1/crates/mosshatch ; https://itunes.apple.com/search?term=mosshatch&entity=software ; https://play.google.com/store/search?q=mosshatch&c=apps ; https://store.steampowered.com/api/storesearch/?term=mosshatch ; https://x.com/mosshatch ; https://www.youtube.com/@mosshatch ; https://www.tiktok.com/@mosshatch ; https://find-and-update.company-information.service.gov.uk/search/companies?q=mosshatch

Raw captures (JSON, screenshots, scripts) are in `working-directory/research/tm/`.
