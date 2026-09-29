# Mosshatch Phase 0: HATCHKIND name knockout and the hatchkind.com share-host proposal

## TL;DR

1. **HATCHKIND is clear of identical/near-identical marks** in USPTO, EUIPO eSearch plus and TMview (81 offices incl. UKIPO, WIPO, CIPO, IP Australia, JPO, CNIPA). Closest: HATCHKINZ (US Reg. 7054458, plush toys, class 28, Ribble LLC) and two dead HATCHKINS filings. `Hatch Kind` and `Hatchkinds` returned 0 hits everywhere. [S7][S8][S9]
2. **HATCH itself is crowded.** USPTO live: 23 solo "HATCH" marks in classes 9/35/36/42/45 (18 registered, 5 pending), 60 more live marks containing the word HATCH, 63 live HATCH-compounds. TMview: 104 live exact-"HATCH" records in those classes across about 20 offices. Class 42 is densest (10 solo US), class 45 thinnest (2). New 2025-26 filings: HATCH LABS (5 apps, classes 35/36/42/45), HATCHIFY "HATCH" (35/38/42), Hatch Ltd. (EU/UK, 2026-07-30). Read: medium risk, needs counsel. [S7][S8]
3. **RDAP:** hatchkind.com and mosshatch.com were both created 2026-09-29T17:48:38Z (about 75 minutes before the check), expire 2027-09-29, registrar NameCheap (IANA 1068), status `client transfer prohibited`, NS dns1/dns2.registrar-servers.com, no DNSSEC. Registrant is not in public RDAP, so ownership by the user is unverifiable from public data. The label is unregistered in .net .org .io .ai .dev .app .studio (RDAP 404); .co is DNS-only. [S2][S3][S4]
4. **Could not query:** WIPO Global Brand Database (captcha loop), UK IPO direct (Cloudflare Turnstile, challenge host blocked by egress policy), rdap.nic.io / rdap.nic.co and web.archive.org (blocked by egress policy). UK and WIPO marks were covered only through TMview. [S10][S11][S12]
5. **Recommendation on hatchkind.com as share host: yes to a separate registrable domain, with conditions.** It is cross-site and cross-origin from mosshatch.com, so cookies, storage and passkeys are isolated. It must be a credential-free, read-only, no-cookie origin, because path URLs (`/<domain>`) put every card in ONE origin. [S15][S16][S17][S20]
6. **UGC risk is mainly phishing/impersonation by domain name.** Gate publishing (passkey step-up, Web Risk check, typosquat screen), render names as text not links, show punycode, `noindex` by default, report link, DMCA agent and DSA Art. 16 notice-and-action. [S23][S25][S29][S31][S32]
7. **Email:** hatchkind.com should send nothing: `v=spf1 -all`, null MX, `p=reject` DMARC. Send from a mosshatch.com subdomain (Resend's own recommendation). Both domains currently carry registrar-default forwarding MX/SPF and no DMARC. [S36][S37][S35][S38][S46]
8. **Timing:** both domains are "New Domains" (under 30 days) in Cloudflare Gateway's category until about 2026-10-29; ICANN lets a registrar deny a transfer within 60 days of creation (until about 2026-11-28). [S40][S41]
9. **Name decision:** keep hatchkind.com registered, but do not build public brand equity in HATCHKIND until counsel clears it; make the share host a config value so a rename is a redirect, not a rewrite.

Research only, not legal advice. Prepared 2026-09-29 (all sources accessed 2026-09-29; times UTC). Each `[Sn]` tag resolves in section 10 to URL, access date and a short exact quote. Raw captures are in `scratchpad/research/raw/` and `scratchpad/research/src/`.

---

## 1. Scope, method and what was and was not queried

| Source | Queried? | How | Result |
|---|---|---|---|
| USPTO Trademark Search (tmsearch.uspto.gov) | YES | Headless Chromium passed the AWS WAF check; queries POSTed in-page to `/prod-stage-v1-0-0/tmsearch` (the same API the UI uses). Word-mark search of live and dead records. | Full results below. Data seen up to filings of 2026-09-19. [S7] |
| TMview (tmdn.org) | YES | Headless Chromium; in-page POST to `/tmview/api/search/results`. 143,032,652 marks, 81 offices, USPTO/EUIPO/UKIPO/WIPO all "updated 29/09/2026". | Full results below. [S8] |
| EUIPO eSearch plus | YES | Headless Chromium; in-page POST to `/copla/ctmsearch/json` (MarkVerbalElementText). | 0 hits for all HATCHKIND variants. [S9] |
| WIPO Global Brand Database | NO | Page loads, then loops on `api.branddb.wipo.int/captcha` and `/news` (HTTP 401) in headless mode. Not bypassed. WO marks covered via TMview office WO only. | Unverified directly. [S10] |
| UK IPO (trademarks.ipo.gov.uk) | NO | HTTP 403 "Just a moment..." Cloudflare Turnstile; challenge host `brunhild.challenges.cloudflare.com` is blocked by egress policy. Not bypassed. GB marks covered via TMview office GB only. | Unverified directly. [S11][S12] |
| RDAP .com .net .org .ai .dev .app .studio | YES | IANA bootstrap then registry RDAP. | Section 2. [S1][S2][S4] |
| RDAP .io and .co | NO | Not in the IANA RDAP bootstrap; `rdap.nic.io` and `rdap.nic.co` are blocked by egress policy. .io answered by Identity Digital's RDAP (404, control github.io = 200). .co has no working control, DNS-only. | Section 2. [S1][S5][S12] |
| Open web | PARTIAL | 2 WebSearch queries (tool budget then exhausted); DuckDuckGo HTML endpoint returned a bot challenge (not worked around). | No exact "hatchkind" hit. [S14] |
| Handles / package names | PARTIAL | npm, PyPI, crates.io, Docker Hub via registry APIs; GitHub via search API (direct GitHub API/web blocked by org policy). Social sites not reliably checkable. | Section 6. [S13] |
| Common-law use, app stores, state marks, non-Latin scripts, design marks | NO | Out of reach in this session. | Unverified. |

Search-term definitions used: "solo HATCH" = the whole word mark is exactly HATCH; "contains HATCH" = HATCH is one word of a longer mark; "HATCH-compound" = a single token starting with HATCH (HATCHLY, HATCHBED, ...). TMview criteria: `I` = "Is" (exact whole mark), `C` = contains, `B` = begins with, `F` = fuzzy. Classes searched: 9, 35, 36, 42, 45 (class 38 also noted where it appeared).

## 2. Domain facts: what RDAP shows for hatchkind.com (and mosshatch.com)

Source: `https://rdap.verisign.com/com/v1/domain/hatchkind.com` and `.../mosshatch.com`, fetched 2026-09-29 ~19:05 UTC; bootstrap from `https://data.iana.org/rdap/dns.json` (publication 2026-09-28T22:00:03Z). [S1][S2][S3]

| Field | hatchkind.com | mosshatch.com |
|---|---|---|
| RDAP handle | 3147612639_DOMAIN_COM-VRSN | 3147612638_DOMAIN_COM-VRSN |
| Registrar | NameCheap, Inc. (IANA Registrar ID 1068) | same |
| Registration (created) | 2026-09-29T17:48:38Z | 2026-09-29T17:48:38Z |
| Expiration | 2027-09-29T17:48:38Z (one year) | same |
| Last changed | 2026-09-29T17:48:42Z | same |
| EPP status | `client transfer prohibited` | same |
| Nameservers | DNS1.REGISTRAR-SERVERS.COM, DNS2.REGISTRAR-SERVERS.COM | same |
| DNSSEC | `delegationSigned: false` | same |
| Registrant | not present in RDAP (verify in the registrar account) | same |

Quote (S2): `"eventAction":"registration","eventDate":"2026-09-29T17:48:38Z"` and `"status":["client transfer prohibited"]`.

Interpretation: consecutive handles and identical timestamps show the two names were registered together today. That fits the user's statement, but public data cannot confirm who the registrant is.

DNS observed via DoH (`dns.google/resolve`) [S46]: both names have an A record (`192.64.119.89` / `192.64.119.39`), MX `eforward1-5.registrar-servers.com`, TXT `v=spf1 include:spf.efwd.registrar-servers.com ~all`, no `_dmarc` record (NXDOMAIN), no CAA, no DS. These look like registrar-default parking/forwarding records (inference). Certificate Transparency (crt.sh, `[]` for `%.hatchkind.com`, `mosshatch.com`, `%.mosshatch.com`) shows no certificates yet; crt.sh completeness is not guaranteed. [S47]

### Label availability across the requested TLDs

| Domain | RDAP (authoritative) | DNS NS via DoH | Verdict |
|---|---|---|---|
| hatchkind.com | Registered 2026-09-29 (above) | NS dns1/2.registrar-servers.com | Held (by user, unverified) |
| hatchkind.net | 404 (rdap.verisign.com/net) | NXDOMAIN | Unregistered |
| hatchkind.org | 404 "Object not found" (rdap.publicinterestregistry.org) | NXDOMAIN | Unregistered |
| hatchkind.io | 404 "Object not found" (rdap.identitydigital.services; control github.io returned 200) | NXDOMAIN | Unregistered |
| hatchkind.ai | 404 on 4th attempt (endpoint intermittently 429/Cloudflare 1015; controls google.ai 200) | NXDOMAIN | Unregistered |
| hatchkind.dev | 404 "hatchkind.dev not found" (pubapi.registry.google) | NXDOMAIN | Unregistered |
| hatchkind.app | 404 "hatchkind.app not found" (pubapi.registry.google) | NXDOMAIN | Unregistered |
| hatchkind.studio | 404 "Object not found" (identitydigital) | NXDOMAIN | Unregistered |
| hatchkind.co | UNVERIFIED (not in IANA bootstrap; rdap.nic.co blocked; rdap.registry.co returned 404 even for registered google.co, so it is not a valid control) | NXDOMAIN | Probably unregistered, DNS-only |

Also checked (DoH NS): `hatch-kind.*` and `hatchkinds.*` across the same nine TLDs, and `mosshatch.{net,org,io,ai,dev,app,co,studio}`: all NXDOMAIN [S6]. NXDOMAIN is weaker evidence than RDAP because a registered-but-undelegated name also returns NXDOMAIN.

Side fact for the reseller plan: ICANN Transfer Policy lets the registrar deny a transfer "requested within 60 days of the creation date" (3.7.5), so moving these two names from Namecheap to the reseller's upstream registrar is not guaranteed before about 2026-11-28. [S41]

---

## 3. Trademark knockout for HATCHKIND (also "Hatch Kind", "Hatchkinds")

### 3.1 Identical and near-identical marks

| Query | Database | Result | Notes |
|---|---|---|---|
| `hatchkind` (WM/PM match, phrase and term) | USPTO | **0 hits** (`"hits":{"totalValue":0`) | live and dead records both searched. [S7] |
| `hatchkinds` | USPTO | 0 | |
| `hatch kind` with AND operator; wildcards `*hatchkind*`, `*hatch*kind*`, `*kind*hatch*` | USPTO | 0 each | catches "HATCH KIND" and "HATCH-KIND". |
| token prefix `hatchk` | USPTO | **3**: HATCHKINS (serial 76709989, filed 2011-12-14, ABANDONED 2013-06-24, plush, Jay At Play Intl HK); HATCHKINS (serial 87294254, filed 2017-01-09, ABANDONED 2018-01-15, "Dolls", Make Ideas LLC); **HATCHKINZ (serial 97350291, LIVE, Reg. 7054458, registered 2023-05-16, "Plush toys; Stuffed toy animals; Stuffed and plush toys; Toy stuffed animals", class 28, Ribble LLC, Virginia)** | closest hits. [S7][S8] |
| `hatchkid*`, `hatchkynd*`, `hatchkined*`, `hatchcind*`, `hatchkyn*`, `hatch`+`kin*`, `kind`+`hatch*` | USPTO | 0 | sound-alike and reversed variants. |
| `mosshatch`, `mosshat*`, `moss`+`hatch*` (the product name) | USPTO | 0 | HATCH-formative crowding still applies to MOSSHATCH. |
| `hatchkind` (Is), (Contains), (Begins with) | TMview, all 81 offices | 0 / 0 / 0 | [S8] |
| `hatchkind` fuzzy | TMview | 3 (the same US HATCHKINS x2, HATCHKINZ) | fuzzy across EM, GB, WO added nothing. |
| `hatchkinds`, `hatch-kind` (Contains) | TMview | 0; `hatch-kind`/`hatch kind` returned 3 Japanese "KIND PATCHES" (Class 3/5, unrelated) | |
| `mosshatch` (Contains) / fuzzy | TMview | 0 / 3 Japanese "MOSSCATCH SYSTEM" (classes 37/40/41, status Ended) | unrelated. |
| `hatchkind`, `hatch kind`, `hatch-kind`, `hatchkinds`, `hatchkin`, `mosshatch` (contains) | EUIPO eSearch plus | 0 each | [S9] |

### 3.2 Why HATCHKINZ matters (and why it may not)

HATCHKINZ is a live registration (Reg. 7054458) differing by one letter (KINZ vs KIND). Goods are plush/stuffed toys (class 28), not software, domains, finance or legal services. The overlap risk is not in the five target classes; it appears if Mosshatch ever sells creature plush, toys or merchandise, or licenses creatures as collectibles. Adjacent creature-and-hatch themed marks that show the theme is already used by others: HATCHIMALS (Spin Master; EUIPO 015217797 classes 9/28/41; US Reg. 5681162 classes 9/16/18/25), HATCHLINGS (Rovio; EUIPO 014884902, WO 1330775, US Reg. 8397680 classes 9/16/18/25/28/41/43; and Hatchlings, Inc. US Reg. 6033529 classes 9/41). These sit in class 9 games and apps and class 41, not in the registrar classes. [S7][S8]

### 3.3 Which class does a registrar file in?

In the USPTO data, "domain name registration" language in live records sits overwhelmingly in **class 45**: of 106 matching goods/services strings in the first 100 hits, 97 were IC 045, 6 were IC 042, 1 each IC 035/038/039 (query: goodsAndServices phrase "domain name registration", alive=true, 757 total hits). Example: GOAT, "IC 045: Domain name registrar services; Domain name registration services; Leasing of internet domain names...". [S7] Consequence: a registrar mark is most naturally filed in 45 (registrar service), with 42 (SaaS/vault/agent platform) and 9 (downloadable app) as the other likely classes. 36 (payments) and 35 are secondary.

### 3.4 The wider word HATCH: crowding by class

**USPTO (live records, word HATCH as one token or prefix).** Total prefix-`hatch` records: 1,081 (412 live). [S7]

| Class | Live solo "HATCH" marks | Live marks containing word HATCH (incl. solo) | Live HATCH-compounds (HATCHER, HATCHLING, HATCHFUL...) |
|---|---|---|---|
| 9 | 6 | 23 | 26 |
| 35 | 9 | 32 | 27 |
| 36 | 5 | 10 | 3 |
| 42 | 10 | 26 | 16 |
| 45 | 2 | 5 | 4 |
| Union of the five classes | 23 (18 registered, 5 pending) | 83 | 63 |

Live solo HATCH marks in any of the five classes (generated from the raw pull; "Pending" includes Madrid/66(a) requests without a US registration number yet):

| USPTO no. | Status | Classes | Owner | Filed | First goods/services (truncated) |
|---|---|---|---|---|---|
| serial 50045179 | Pending | 35,38,42 | HATCHIFY INC. | 2026-08-11 | Artificial intelligence as a service (AIAAS) services featuring software using artificial intelligence (AI) fo |
| serial 98849353 | Pending | 9,44 | Hatch Baby, Inc. | 2024-11-12 | Portable ambient sound machine, namely, a sound transmitting apparatus for rest, sleep and wellness; ambient s |
| serial 79292458 | Pending | 7,9,35,38,40 | Nanoco Limited | 2020-04-07 | Telecommunication services, namely, providing wireless telephone services, long distance telephone service, lo |
| serial 50109546 | Pending | 9 | Runaway Play Limited | 2026-09-15 | Downloadable computer game software; Recorded computer game software; Downloadable video game software; Record |
| serial 88313863 | Pending | 35 | Tatopani Pty Ltd | 2019-02-25 | Career placement; Career placement consulting services; Career planning services; Collection and compilation o |
| 5537244 | Reg | 42 | Adammatic LLC | 2017-09-25 | Computer services, namely, providing an online sales and custom engagement search software platform to allow u |
| 7530248 | Reg | 42 | Ahead, Inc. | 2023-11-13 | Platform as a service (PAAS) featuring computer software platforms for ordering, integrating, and managing inv |
| 7459802 | Reg | 36,37 | Alhambra Agora LLC | 2022-12-01 | Real estate management of life sciences space. |
| 5161705 | Reg | 35,36,43 | Eli Lilly and Company | 2015-04-08 | charitable services, namely, organizing and developing community service projects that aim to improve the live |
| 8357217 | Reg | 42 | Fulcrum Chicago, Inc. | 2024-08-09 | Application service provider, namely, hosting, managing, developing, and maintaining applications, software, a |
| 5778499 | Reg | 35 | HATCH Collection LLC | 2017-10-17 | Retail store services featuring clothing, beauty care and skin care product. |
| 2911963 | Reg | 35,42 | HATCH LTD./HATCH LTEE | 2002-01-17 | ENGINEERING AND DESIGN SERVICES IN THE FIELDS OF CIVIL, MECHANICAL, AND ELECTRICAL ENGINEERING, INCLUDING PROV |
| 5943618 | Reg | 9,11,14,20 | Hatch Baby, Inc. | 2019-06-07 | Weighing scale for toddlers; weighing scale for toddlers that connects to a wireless communication network * e |
| 7292549 | Reg | 36 | Hatch Bank | 2019-12-05 | Banking services, namely, provision of certificates of deposit, business checking accounts, business lines of  |
| 7292550 | Reg | 36 | Hatch Bank | 2019-12-05 | Banking services, namely, provision of certificates of deposit, business checking accounts, business lines of  |
| 7547689 | Reg | 35,42,45 | Hatch Ltd./Hatch Ltee | 2023-05-01 | Permitting services for regulatory compliance, namely, obtaining environmental, design, zoning and other gover |
| 7547690 | Reg | 35,42,45 | Hatch Ltd./Hatch Ltee | 2023-05-01 | Permitting services for regulatory compliance, namely, obtaining environmental, design, zoning and other gover |
| 6087219 | Reg | 36 | Hatch Realty, LLC | 2019-10-01 | Real estate agency services; real estate brokerage. |
| 7077830 | Reg | 9,42 | Hatch, Inc. | 2020-10-28 | Downloadable children's educational computer software; Recorded children's educational computer software; Down |
| 7191178 | Reg | 42 | Playful Software Inc. | 2022-07-21 | Providing temporary use of on-line non-downloadable software development tools for developing mobile and compu |
| 3783828 | Reg | 9 | SAFARILAND, LLC | 2009-08-21 | Protective clothing and gear for law enforcement personnel, namely, gloves, knee and elbow pads [,  riot suits |
| 5076118 | Reg | 35,41 | Twitter, Inc. | 2015-03-12 | arranging, organizing and conducting business contests and competitions in the fields of software development  |
| 7388980 | Reg | 42 | Visuwell, Inc. | 2022-07-26 | Platform as a service (PAAS) featuring computer software platform for use by healthcare provider groups for ma |

Notable HATCH-formative marks nearest to Mosshatch's fields (software, agents, secrets, domains, payments):

| Mark | Owner | Office / no. | Classes | Status | Why it matters |
|---|---|---|---|---|---|
| HATCH | Playful Software Inc. | US 7191178 | 42 | Registered 2023-10-10 | "software development tools for developing mobile and computer software applications and websites" (developer SaaS, nearest to a developer-facing product). |
| HATCH LABS (5 applications 99244905/-910/-915/-923/-928) | Hatch Labs Holdings LLC | US, filed 2025-06-20, basis 1(b) | 45, 36, 42, 42, 35 | Pending; published for opposition 2025-12-16 and 2026-02-24 | Covers "Software design and development", SaaS marketplaces, software licensing, venture capital, business development; spans four of the five target classes. |
| HATCH | HATCHIFY INC. | US serial 50045179, filed 2026-08-11 | 35, 38, 42 | Pending (1(a)) | AI-as-a-service and messaging; new. |
| HATCH | Hatch Ltd. / Hatch Ltee | US 2911963, 7547689, 7547690; EUIPO 019402520 and UK00004423741 (both filed 2026-07-30, classes 35/36/37/42/45, "Filed"); WO 1778177/1779930 | 35, 42, 45 (and 36, 37 in the 2026 filings) | Registered / Filed | Large engineering consultancy; broad new EU/UK filing that includes 42 and 45 and 36. |
| HATCH | Hatch Bank | US 7292549, 7292550 | 36 | Registered | Banking; "POWERED BY HATCH" 42 also registered (US 6765856). |
| HATCH / Hatch a Home | Hatch Credit, Inc.; HatchaHome Ltd | UK00801531710 (36,42); UK00004239596 (9,35,42,45); UK00004261001 (9,36,42,45) | 36, 42, 9, 35, 45 | Registered (GB) | Fintech/property; UK-specific. |
| HATCH | Hatch B.V. | WO 1606852 | 9, 42 | Registered | Madrid designation. |
| HATCHED / HATCHED | Hatch Networks Inc. (dating); Hatched Investments | US 7038654 (9,45); 7245754 (35) | 9, 45, 35 | Registered | Class 45 and class 9 use of "HATCHED". |
| HATCHTOOLS, HatchTech, Hatchpad, Hatchly | Sparos Lda; HatchTech Group; Hatchpad Ltd; Hatchly Ltd | EM 019127085 (9,42); UK00003607642 (9,36,42); UK00003562557 (42) | 9, 36, 42 | Registered | Software-related HATCH compounds outside the US. |

**TMview, exact mark "HATCH" (criteria Is), classes 9/35/36/42/45, all offices:** 159 records, of which 88 Registered + 16 Filed = **104 live**, 55 expired/ended. Live by office (top 20 shown of the 104): US 23, GB 16, WO 10, NZ 10, AU 6, EM 6, CA 6, MX 5, BR 5, CN 3, NO 2, MY 2, BX 2, and one each AR, TR, IN, CL, FR, DE, JP. In just EM/GB/WO for those classes: EM 9 records (6 live), GB 22 (16 live), WO 11 (10 live). Begins-with "hatch" in the same classes: EM 31, GB 66, WO 21 records. [S8]

### 3.5 Read-out (not legal advice)

* **No identical or near-identical HATCHKIND mark exists in the data queried.** The nearest, HATCHKINZ, is in a different field (toys) and is a different word ending.
* **HATCH-formatives are dense in every target class, including new 2025-26 filings by parties with adjacent goods (HATCH LABS, HATCHIFY, Hatch Ltd.).** Crowding narrows what each owner can claim over the bare word, but HATCHKIND contains HATCH in full as its leading element, so a likelihood-of-confusion refusal or an opposition cannot be ruled out, most plausibly in class 42 (software/SaaS) where 10 solo HATCH marks are live.
* **Class 45 (where registrar services are filed) is the least crowded** (2 solo US marks: both Hatch Ltd., engineering permitting services).
* **"Hatch" is also a heavy web name**: Hatch (sleep devices, Hatch Baby), Hatch Apps, Hatch (AI CSR, YC), Hatch Kids (SheKnows), Hatchlings (game), DigitalOcean Hatch (startup programme), Hatch (low-code, Picnik founders). None is a registrar or an exact "hatchkind". [S14]
* The same HATCH crowding applies to MOSSHATCH (HATCH is the second element). MOSSHATCH itself: 0 exact hits.

Recommended follow-up (counsel): full clearance search (design marks, phonetic and translation equivalents, state and common-law use, app stores, non-Latin scripts), then an opinion on classes 9/36/42/45 and whether to file intent-to-use in the US and via Madrid.

---

## 4. Open web, handles and package names for the label

| Check | Result | Confidence |
|---|---|---|
| Web search `"hatchkind"` and `"Hatch Kind" OR "HatchKind" brand company app` | No exact-match page; results were Hatch (sleep), Hatch Apps, Hatch Kids, Hatchlings, Hatch Kings etc. [S14] | medium (2 queries only) |
| npm `hatchkind`, `hatch-kind`, `@hatchkind/core`, `mosshatch`, `@mosshatch/core` | `npm view` E404 for all; registry search `scope:hatchkind` and `scope:mosshatch` return `total: 0` (an empty npm org/scope could still exist) [S13] | high for packages, low for scope ownership |
| PyPI `hatchkind`, `hatch-kind`, `mosshatch` | HTTP 404 | high |
| crates.io `hatchkind`, `mosshatch` | HTTP 404 | high |
| Docker Hub user `hatchkind`, `mosshatch` | HTTP 404 | medium |
| GitHub user/org `hatchkind`, `mosshatch` | GitHub search API (via MCP) `total_count: 0` for `hatchkind in:login` and `mosshatch in:login`; direct api.github.com and github.com are blocked for this session by policy | medium |
| X, Instagram, TikTok, Reddit, Bluesky, YouTube, LinkedIn, Product Hunt, Mastodon | UNVERIFIED: statuses were login walls, 403 or SPA 200s (a 200 or 404 from these sites is not evidence). Bluesky returned "Service Unavailable" for `hatchkind.bsky.social`; `mosshatch.bsky.social` returned "Profile not found". | none |
| `hatchkind.vercel.app` | HTTP 404 (not proof of availability of the Vercel project name) | low |
| Wayback Machine history for hatchkind.com | Blocked by egress policy (HTTP 403 "Blocked by egress policy"); domain was created today so prior-owner history cannot be inferred from RDAP | n/a |

---

## 5. Proposal under review: hatchkind.com as public gallery and share-card host

**Proposal:** `https://hatchkind.com/<domain>` serves the public animated creature card and Open Graph share card for a domain; the product app (passkey login, vault, agent tokens, Stripe checkout) stays at `mosshatch.com`. Cards are private until the owner publishes them.

### 5.1 Same-site vs same-origin: what each hosting choice means

Definitions (web.dev): "Websites that have the same combination of scheme, hostname, and port are considered 'same-origin'" and "Websites that have the same scheme and the same eTLD+1 are considered 'same-site'". Their table lists `https://login.example.com:443` vs `https://www.example.com:443` as "Cross-origin: different subdomains" but "Same-site: different subdomains don't matter". [S15] MDN: two URLs share an origin only if protocol, port and host match; `http://news.company.com` vs `http://store.company.com` is "Different host". [S16]

| Layout | Relationship to app at `https://mosshatch.com` | Cookies (Domain-scoped) | Web storage / SW | WebAuthn RP ID | Blast radius of XSS on the card host |
|---|---|---|---|---|---|
| **A. `hatchkind.com/<domain>` (proposed)** | cross-site AND cross-origin | Cannot share (different registrable domain); `SameSite=Strict` app cookies are not sent on cross-site requests, and `Lax` ones only on top-level safe navigations [S17] | Isolated | App RP ID `mosshatch.com` is not usable from hatchkind.com without Related Origin Requests [S21][S22] | Whole hatchkind.com origin (all cards + gallery), **not** the app |
| B. `cards.mosshatch.com/<domain>` | same-site, cross-origin | A cookie with `Domain=mosshatch.com` is sent to it: "Setting the domain makes the cookie available to that domain and all its subdomains" [S17]; sibling can set/overwrite (cookie tossing) unless `__Host-` prefix used | Isolated per origin | Usable (RP ID mosshatch.com is a registrable suffix) [S21] | All cards on that host; session-fixation/cookie-tossing paths toward the app |
| C. `mosshatch.com/c/<domain>` | same-origin | Shared | Shared | Same | **Everything, including the passkey session and vault UI** |
| D. `<label>.hatchkind.com` (subdomain per card) | cross-site; each card its own origin | n/a | Isolated per card | n/a | One card only, if wildcard TLS and PSL are in place (5.4) |

Google's own precedent for user content: "we reacted to this raft of content hosting problems by placing some of the high-risk content in separate, isolated web origins—most commonly *.googleusercontent.com. There, the 'sandboxed' files pose virtually no threat to the applications themselves, or to google.com authentication cookies. For public content, that's all we need: we may use random or user-specific subdomains, depending on the degree of isolation required between unrelated documents". [S20] Note: Google's design gives non-public documents no cookies and moves the secret to an unguessable URL token, so authentication cookies are never copied to the sandbox domain ("Copying users' normal authentication cookies to the 'sandbox' domain would defeat the purpose"). [S20]

**Consequence for the proposal:** the separate registrable domain is the right primitive for isolating the app from public content. Layout A gives no isolation between cards, and cards will be near-identical templates plus a domain string, so the risk of one card's content executing script depends on output encoding rather than origin separation. Keep the origin credential-free so that even total compromise yields defacement/phishing on hatchkind.com and nothing more.

### 5.2 Cookie isolation and what to put on hatchkind.com

* Set **no cookies at all** on hatchkind.com (analytics with cookies excluded). If any cookie is ever needed, use `__Host-` prefix: it "guarantees that such cookies are only sent to the host that set them, and not to any other host on the domain" and cannot be set with a `Domain` attribute. [S17]
* The app's session cookies should be host-only (omit `Domain`): "If omitted, the cookie is returned only to the host that sent it (i.e., it becomes a 'host-only cookie')". [S17]
* `SameSite` is defined relative to *site*: it "controls whether or not a cookie is sent with cross-site requests", so a `fetch()` from a hatchkind.com page to a mosshatch.com API will not carry `Strict` cookies and, being a subrequest, not `Lax` ones either; CORS additionally blocks cross-origin reads by default ("Cross-origin reads are typically disallowed"). [S17][S16]
* Private-card preview by the owner must not use a hatchkind.com session cookie. Use a short-lived signed URL minted by mosshatch.com (Google's capability-URL approach; note its Referer-leak caveat: "there are more ways to accidentally leak a capability-bearing URL than there are to accidentally leak cookies"). [S20]

### 5.3 XSS blast radius and content rules

* OWASP: "Ensuring that all variables go through validation and are then escaped or sanitized is known as perfect injection resistance... no framework is perfect and security gaps still exist in popular frameworks like React and Angular." [S43] React auto-escapes text nodes, but `dangerouslySetInnerHTML`, `href={userValue}`, SVG/`srcdoc`, and three.js text/texture sources are the usual escape hatches.
* Domain labels are constrained (LDH plus IDNA/punycode), which shrinks the injection surface, but any *other* owner-supplied string (creature nickname, notes, "about" text, images/SVG) reopens it. Rule: cards may contain only server-rendered fields from a fixed schema, with no HTML, SVG upload or user-supplied URLs.
* CSP: "Content Security Policy (CSP) is a feature that helps to prevent or minimize the risk of certain types of security threats"; use a nonce/hash-based strict CSP for scripts. [S44] On hatchkind.com set `default-src 'none'` style allowlists, `frame-ancestors 'none'` (or a specific allowlist if embeds are wanted), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and Cross-Origin-Opener-Policy `same-origin`.
* Serve the OG/share image as a **pre-rendered static PNG/WebP** generated server-side from the published snapshot, so link unfurlers never run the three.js page and the DOM surface for the social image is zero.

### 5.4 Public Suffix List considerations

* PSL defines the site boundary browsers use: "owners of privately-registered domains who themselves issue subdomains to mutually-untrusting parties may wish to be added to the PRIVATE section". [S18] MDN: a cookie `Domain` "cannot be a public suffix such as com, co.uk, or github.io". [S17] web.dev uses `.github.io` as the eTLD example. [S15]
* **Layout A (path per card) gets nothing from the PSL**; the PSL only matters for layout D (`<label>.hatchkind.com`).
* If D is ever considered: PSL guidelines require that "Does every domain in the PRIVATE section have at least two years remaining in the registration term?" and warn that "registration periods of less than a year may result in the automatic removal"; the PSL page adds "We will generally decline small projects or experimental / lab requests or short-term entries", and requests must come from the domain owner with `_psl` TXT validation. hatchkind.com currently expires 2027-09-29 (one year) and would have to be extended. [S18][S19]
* D also needs a wildcard certificate: Vercel issues wildcard certs by DNS-01 and "require[s] nameservers to be with Vercel to use wildcard domains" (or `_acme-challenge` delegation). [S42] A subdomain that embeds a lookalike (`paypal-com.hatchkind.com`) is itself a phishing pattern; if D is used, do not embed the raw domain as a dotted host prefix.

### 5.5 WebAuthn/passkeys

* Passkeys are scoped to an RP ID that "be equal to the origin's effective domain, or a registrable domain suffix of the origin's effective domain" (WebAuthn Level 3, now a W3C Recommendation dated 2026-08-25). [S21] Credentials created for `mosshatch.com` cannot be exercised on hatchkind.com by default.
* Related Origin Requests can bridge two brand domains ("where alternative or brand domains are required"), but support is "Chrome and Safari. As of January 2026, Firefox is still considering the feature", and Chrome processes at most 5 eTLD+1 labels. [S21][S22]
* Design conclusion: **never run a passkey ceremony or "approve" UI on hatchkind.com**. All authentication and every money-approval prompt stays on `mosshatch.com`; the gallery links out. This also protects the "human passkey must approve" guarantee from look-alike UI on the public host.

### 5.6 User-generated-content risks specific to cards that display arbitrary domain names

Threats (inference from the mechanics, with policy sources for the enforcement side):

| Risk | How it arises | Mitigation |
|---|---|---|
| Phishing/brand impersonation by name | An abuser registers `paypal-secure-login.com` through Mosshatch, publishes `hatchkind.com/paypal-secure-login.com`, then shares the reputable-looking URL | Screen names against brand/typosquat lists at publish; Web Risk lookup at publish and daily; hold-for-review for high-similarity names; do not render as a clickable link (or send through an interstitial); `rel="ugc nofollow noopener noreferrer"` [S27] |
| IDN homographs | Card shows a mixed-script or confusable domain that reads as a known brand | Display punycode and Unicode side by side; block mixed-script labels per Unicode's confusable detection (UTS #39, v18.0.0, 2026-08-27: "incorrect usage can expose programs or systems to possible security attacks") [S45] |
| Link laundering / spam | Cards used to drive traffic or SEO to abusive domains | noindex by default, nofollow/ugc links [S25][S27] |
| Platform-level reputation contagion | One bad card gets the host flagged; Safe Browsing matches by host suffix and path prefix ("host suffix (or full host) and a path prefix (or full path)") so entries may be page-level or host-level [S30] | Fast takedown, unpublish switch, monitoring; avoid "repeat offender" oscillation [S24] |
| Enumeration of private cards | `hatchkind.com/<domain>` is guessable; a 403 vs 404 reveals which domains sit at Mosshatch | Return identical 404 (body, headers, timing) for private and non-existent cards |
| Legal notices | Trademark/copyright complaints about names or imagery | DMCA agent and notice-and-action (5.8) |

Google's enforcement text: "A social engineering attack is when a web user is tricked into doing something dangerous online... The site tricks users into revealing their personal information... the content pretends to act, or looks and feels, like a trusted entity". Web pages are flagged when they "Pretend to act, or look and feel, like a trusted entity... or the website itself". [S23] Also: "Embedded social engineering content is a policy violation for the host page." [S23] A share card that only shows a creature and a domain name does not itself solicit credentials, but the *link target* and the page framing can be read as deceptive.

Safe Browsing repeat-offender rule: "Sites that repeatedly switch between compliant and noncompliant behavior within a short window of time will be classified as Repeat Offenders... Repeat Offender status persists for 30 days, after which the website owner will be able to request a review." [S24] This is the reason to remove bad cards permanently and quickly instead of toggling.

### 5.7 Google Safe Browsing and Web Risk for a UGC host

* Google's guidance for platforms: publish a clear abuse policy; "allow trusted users to report content"; consider `noindex` on "posts that come from new users that don't have any reputation"; add `nofollow` or `ugc` to all links in untrusted content; use manual approval for suspicious interactions; block automated account creation; "Monitor your property for phishing and malware-infected pages... use the Google Safe Browsing API to regularly test URLs from your service." [S25]
* Search spam policy lists "Spammy accounts on hosting services that anyone can register for" as user-generated spam. [S26]
* **Licensing:** "The Safe Browsing API is for non-commercial use only. If you need to use APIs to detect malicious URLs for commercial purposes - meaning 'for sale or revenue-generating purposes' - please refer to the Web Risk API." [S28] Mosshatch is commercial, so use **Web Risk**. Pricing (fetched 2026-09-29): Lookup API `uris.search` "free for up to 100,000 calls per month", then "$0.50 per 1,000 calls" for 100,001 to 10,000,000. [S29] Web Risk's overview states "The information returned by the Web Risk must not be redistributed" and "some risky sites may not be identified, and some safe sites may be classified in error". [S29]
* Safe Browsing's own client guidance is to "Prevent users from posting links to known infected pages from your site", which maps to the publish gate. [S28]

### 5.8 Abuse reports and takedown process

* **US, DMCA 17 U.S.C. 512(c)(2):** limitation of liability applies only if "the service provider has designated an agent to receive notifications of claimed infringement... by making available through its service, including on its website in a location accessible to the public, and by providing to the Copyright Office" the agent details. A counter-notice restores material "not less than 10, nor more than 14, business days" after receipt unless the complainant files suit. [S31] (Copyright Office directory fee and renewal term: unverified, the fee page did not load.)
* **EU, DSA (Regulation (EU) 2022/2065), Article 16:** "Providers of hosting services shall put mechanisms in place to allow any individual or entity to notify them of the presence on their service of specific items of information that the individual or entity considers to be illegal content. Those mechanisms shall be easy to access and user-friendly, and shall allow for the submission of notices exclusively by electronic means." Notices must enable an explanation, exact URL, name/email (except certain offences) and a good-faith statement; confirmation of receipt is required "without undue delay". Articles 11 and 12 require single points of contact for authorities and recipients for all intermediary services. Article 19 exempts micro and small online platforms from the additional online-platform section (but not from Article 16, which is in the hosting section for all sizes; recital 50: "all providers of hosting services, regardless of their size"). [S32]
* **Operational shape:** one report link on every card that goes to `mosshatch.com/report?card=...` (so the form, staff tooling and audit trail live on the app origin); `abuse@` mailbox on the mosshatch.com side; unpublish-and-purge (CDN invalidation) as the first action; log notice, decision and reasons; a repeat-infringer/abuse account policy. No statute fixes an hours-level SLA for hosting notices; a working target (e.g., triage within 24 hours) is a product decision, not a legal citation.
* GDPR/privacy: a card that shows a domain name containing a person's name may be personal data; lawyer question (section 9).

### 5.9 SEO and branding tradeoffs

* Google Search "does not support site names at the subdirectory level"; site names come from the domain or subdomain home page. A path-per-card design under hatchkind.com therefore shows the hatchkind.com home-page identity; a home page must exist and carry consistent name signals (`WebSite` structured data, `og:site_name`, `<title>`). [S33]
* Indexing control: `noindex` via meta tag or `X-Robots-Tag: noindex` header. [S34] Google's UGC guidance itself recommends noindex for low-reputation contributors. [S25] Default recommendation: cards are **noindex** until the owner opts in to "list in gallery"; only opted-in cards go in the sitemap. This turns SEO from an accident into a feature.
* Separate registrable domain splits link equity between two properties and starts with no history; for a share-card host the SEO value is small anyway (thin, template pages), whereas the app's marketing SEO is better served at mosshatch.com. (Judgment; Google's documentation retrieved here does not state a ranking preference between separate domains and subdirectories, so treat that as unverified.)
* Branding: a short, friendly, memorable public host (`hatchkind.com/example.dev`) helps shares, but adds a second brand that users must learn ("this site has no login"). The passkey phishing story is stronger if users learn one place to authenticate. Risk of URL confusion: `hatchkind.com/paypal.com` reads oddly; visible text should always say what is a card vs. what is the domain.
* New-domain reputation: Cloudflare Gateway's security categories include "New Domains: Domains registered within the past 30 days" and "Newly Seen Domains: ...resolved for the first time within the past 30 days" and "Parked & For Sale Domains: not connected to a hosting service". [S40] Both domains qualify until about 2026-10-29 for customers who block those categories; do not launch share links into corporate/school networks before then, and connect both names to real hosting early.
* Trademark side of branding: HATCHKIND is not cleared (section 3). If the gallery becomes a marketed brand, treat that as trademark use; if it is only a technical host with the Mosshatch brand on every page, exposure is lower but not zero. Counsel question.

### 5.10 Email and DMARC isolation

Current state: both domains carry registrar-default MX (`eforward*.registrar-servers.com`) and `v=spf1 include:spf.efwd.registrar-servers.com ~all`, with no `_dmarc`. [S46]

* RFC 9989 (DMARC, May 2026, obsoletes RFC 7489): domains are in "relaxed alignment if they have the same Organizational Domain"; "strict alignment if and only if they are identical". `np=` covers non-existent subdomains. [S35] hatchkind.com and mosshatch.com are different Organizational Domains, so a DMARC policy on one says nothing about the other. Each needs its own records.
* A domain that never sends mail should say so: SPF `www.example.com. IN TXT "v=spf1 -all"` ("Publishing SPF records for domains that send no mail is a well-established best practice") [S36], a null MX `MX 0 .` ("a domain announces that it accepts no mail") [S37], and `_dmarc` with `p=reject`. Suggested (verify before publishing):
  * `hatchkind.com TXT "v=spf1 -all"`
  * `hatchkind.com MX 0 .`
  * `_dmarc.hatchkind.com TXT "v=DMARC1; p=reject; adkim=s; aspf=s; rua=mailto:dmarc@mosshatch.com"`  (a cross-domain `rua` normally needs an external-destination authorization record; check the DMARC reporting documents RFC 9990/9991 before enabling)
  * Remove the Namecheap forwarding MX/SPF unless you deliberately want inbound `abuse@hatchkind.com` forwarding.
* Sending domain for the app: Resend "recommend[s] sending your emails from one or more subdomains (e.g., updates.example.com) instead of your root domain to isolate your sending reputation"; multiple subdomains for different purposes; transactional (passkey recovery, approvals) separate from any marketing. [S38] Suggested: `notify.mosshatch.com` for transactional; keep root `mosshatch.com` at `p=reject` with strict alignment for those subdomains only if DKIM/SPF alignment tests pass (relaxed alignment is the default).
* Gmail's sender rules (Feb 1, 2024) apply above 5,000 messages/day, but "always" recommends SPF, DKIM, DMARC: "Set up DMARC email authentication for your sending domain. Your DMARC enforcement policy can be set to none." Spam rate must stay "below 0.30%". [S39]
* **Do not send share invitations from hatchkind.com.** Sending "your creature is live" mail from a UGC-adjacent domain would tie its reputation to abuse events on the gallery; use mosshatch.com subdomain and link to the card.

### 5.11 Options and recommendation

| Option | Isolation from app | Card-to-card isolation | Cost/complexity | Verdict |
|---|---|---|---|---|
| A. hatchkind.com/<domain> (proposed) | Strong (cross-site, cross-origin) | None (one origin) | Low | **Adopt**, with the hardening in 5.12 |
| B. cards.mosshatch.com | Weak (same-site) | None | Low | Reject (cookie tossing, shared reputation, RP ID reachable) |
| C. mosshatch.com path | None | None | Lowest | Reject |
| D. `<label>.hatchkind.com` | Strong | Strong | Wildcard TLS via Vercel nameservers, PSL (>=2-year term, may be declined), lookalike-host risk | Defer; revisit only if cards ever carry owner-supplied rich content |
| E. Neutral usercontent-style domain (e.g., a `mosshatch-cards.*` name) | Strong | Same as A | One more domain; loses "friendly brand" | Fallback if counsel says HATCHKIND is too risky |

**Recommendation:** Use a **separate registrable domain** for public cards (option A now), because it is the mechanism the platform gives for cookie, storage, service-worker and passkey isolation and it matches Google's own sandbox-domain practice. Treat hatchkind.com strictly as an untrusted, credential-free, read-only origin. Keep the **name** provisional: the trademark knockout is clean for HATCHKIND itself but not for the HATCH-formative field, so pay for counsel before promoting "Hatchkind" as a brand, and make the share host a configuration value (canonical URL, `og:url`, sitemap, redirects) so a switch to option E is a redirect.

### 5.12 Hardening checklist for the hatchkind.com origin (design implications)

1. Separate Vercel project, separate env vars, no shared secrets, DB role with `SELECT` on a `published_cards` view only (no vault, token or user tables).
2. No `Set-Cookie`; no auth; no passkey UI; no calls to app APIs with credentials.
3. Strict CSP (nonce/hash), `nosniff`, `Referrer-Policy: no-referrer`, COOP, `frame-ancestors`; HSTS with preload only after both domains are stable (preload is hard to undo).
4. Uniform 404 for private/unknown cards; publish/unpublish purges CDN and OG image immediately.
5. Publish gate: passkey step-up on mosshatch.com, verified email, rate limit, Web Risk lookup, typosquat/brand screen, IDN mixed-script block; daily re-scan of published cards.
6. Render the domain as text with punycode shown; outbound link only via interstitial with `rel="ugc nofollow noopener noreferrer"`.
7. `X-Robots-Tag: noindex` default; sitemap only for opted-in cards.
8. Report link to mosshatch.com/report; DMCA agent registered; DSA Art. 11/12/16 contact and notice mechanism; audit log of notices and decisions.
9. DNS: null SPF/MX and `p=reject` on hatchkind.com; CAA record limiting issuance to the chosen CA; DNSSEC if Namecheap/registrar supports it (currently `delegationSigned:false`).
10. Domain hygiene: extend hatchkind.com and mosshatch.com to multiple years (also a PSL precondition for option D), enable registrar lock and 2FA on the registrar account.

---

## 6. Compliance and policy checklist for the public gallery

| # | Item | Requirement (source) | Applies to | Suggested handling |
|---|---|---|---|---|
| 1 | DMCA designated agent | Limitation of liability applies only if the provider "has designated an agent to receive notifications of claimed infringement" on its website and with the Copyright Office (17 U.S.C. 512(c)(2)) [S31] | Public cards (US) | Register agent; page at mosshatch.com/dmca; fee/renewal term to confirm |
| 2 | Notice and action | DSA Art. 16: mechanisms "easy to access and user-friendly... exclusively by electronic means"; confirmation of receipt "without undue delay" [S32] | Public cards seen by EU users | Report form on every card; audit log |
| 3 | Points of contact | DSA Art. 11 and 12: single points of contact for authorities and for recipients [S32] | All intermediary services | Published contact page |
| 4 | Commercial URL screening | Safe Browsing API is non-commercial only; commercial use requires Web Risk [S28]; Web Risk free to 100,000 lookups/month then $0.50 per 1,000 [S29] | Publish gate | Use Web Risk Lookup API |
| 5 | UGC anti-spam | Publish an abuse policy, allow reports, noindex new-user content, `nofollow`/`ugc` links [S25][S27] | Card pages | See 5.12 |
| 6 | Non-sending domain hygiene | SPF `-all` [S36], null MX [S37], DMARC `p=reject` [S35] | hatchkind.com | DNS change at registrar |
| 7 | Sending reputation isolation | Send from a subdomain [S38]; Gmail bulk rules above 5,000/day [S39] | mosshatch.com mail | `notify.` subdomain |
| 8 | WebAuthn RP ID scope | RP ID must equal or be a registrable domain suffix of the origin; ROR is Chrome/Safari only [S21][S22] | Passkeys | Ceremonies only on mosshatch.com |
| 9 | PSL private-section rules | >=2 years remaining, owner-submitted, small/experimental usually declined [S18][S19] | Only if option D is used | Defer |
| 10 | Transfer lock | Registrar may deny a transfer within 60 days of creation [S41] | Moving both names to the upstream registrar | Plan for after about 2026-11-28 |

---

## 7. Unverified items and why

1. **Ownership** of hatchkind.com/mosshatch.com by the user: RDAP shows no registrant; only creation today at Namecheap.
2. **WIPO Global Brand Database** direct search: captcha loop in headless mode (not bypassed). WO marks seen only through TMview.
3. **UK IPO direct search**: Cloudflare Turnstile plus blocked challenge host (not bypassed). GB marks seen only through TMview.
4. **.co RDAP** and **.io/.co registry RDAP hosts** `rdap.nic.io`, `rdap.nic.co`: blocked by egress policy; .co conclusion is DNS-only. `hatchkind.ai` RDAP needed four attempts because of Cloudflare rate limiting (429/1015); final answer 404.
5. **Social handles** (X, Instagram, TikTok, Reddit, Bluesky, YouTube, LinkedIn, Product Hunt, Mastodon): not reliably checkable by HTTP status; npm org/scope ownership (an empty scope can exist).
6. **Open-web coverage**: only 2 search-engine queries ran before the tool budget was exhausted; DuckDuckGo returned a bot challenge. Absence of an exact "hatchkind" page is not proof of no use.
7. **Pending or very recent filings** not yet in USPTO/TMview/EUIPO indexes; USPTO data seen up to filings of 2026-09-19.
8. **Design marks, phonetic and translation equivalents beyond the variants listed, non-Latin scripts, common-law/state marks, app stores**.
9. **Whether** any HATCH owner enforces against HATCH-formatives, and how an examiner would weigh dilution; no case-law research done.
10. **Google's ranking treatment** of a separate domain vs subdirectory, and whether Safe Browsing flags at page, path or host level in a given case (documentation retrieved describes the matching mechanism only).
11. **DMCA directory fee and renewal period** (the copyright.gov page did not load with fee details); DSA Art. 13 legal-representative duty and whether Mosshatch is a "micro or small enterprise".
12. **IDN display policy of browsers** (Chromium's IDN document returned HTTP 503); UTS #39 was used instead.
13. **Wayback / prior history** for hatchkind.com: web.archive.org is blocked by egress policy.
14. Gmail/Yahoo sender requirements were checked only on Google's page (Yahoo's not fetched).

## 8. Needs a lawyer (or accountant)

* Trademark clearance and filing strategy for HATCHKIND (and for MOSSHATCH): likelihood-of-confusion analysis against the HATCH-formatives above, class selection (45/42/9/36/35), intent-to-use vs use-based filings, Madrid extension, and the HATCHKINZ (class 28) merchandise question.
* Whether operating hatchkind.com as a technical share host, versus a marketed brand, changes infringement exposure.
* DMCA safe-harbour, DSA applicability and size classification, terms of service and abuse policy, repeat-infringer policy.
* Privacy: whether a domain name that identifies a person on a public card is personal data (GDPR/CCPA), and the lawful basis for publishing it.
* Registrar/reseller obligations that follow from displaying names of domains sold through the reseller (out of scope here).

## 9. Design implications (short list)

1. Treat hatchkind.com as an **untrusted, credential-free origin**: no cookies, no auth, no passkeys, read-only DB view (5.2, 5.12).
2. Make the share host **configurable** (`PUBLIC_CARD_ORIGIN`) so a rename or option E is a redirect.
3. **Uniform 404** for private/unknown cards; instant purge on unpublish.
4. **Publish gate**: passkey step-up, Web Risk lookup, typosquat and IDN screening, rate limits, re-scan.
5. **Pre-render** OG images; keep three.js interactive card behind a strict CSP; only fixed-schema server-rendered fields.
6. **noindex by default**, opt-in to gallery listing and sitemap.
7. **Report path** on the app origin, DMCA agent, DSA contact, audit log.
8. **DNS/email**: null SPF/MX and DMARC reject on hatchkind.com; transactional mail from a mosshatch.com subdomain; remove Namecheap default forwarding.
9. **Launch timing**: expect "New Domains" filtering until about 2026-10-29; connect both names to real hosting early; transfers blocked until about 2026-11-28.
10. Do **not** promote "Hatchkind" as a public brand or file marks until counsel has reviewed the HATCH-formative landscape.

---

## 10. Sources (all accessed 2026-09-29)

| Tag | URL | Short exact quote or observed value |
|---|---|---|
| S1 | https://data.iana.org/rdap/dns.json | `"publication": "2026-09-28T22:00:03Z"`; com -> `https://rdap.verisign.com/com/v1/`; ai, studio -> `https://rdap.identitydigital.services/rdap/`; dev, app -> `https://pubapi.registry.google/rdap/`; io and co absent from the 1,204 listed TLD labels |
| S2 | https://rdap.verisign.com/com/v1/domain/hatchkind.com | `"eventAction":"registration","eventDate":"2026-09-29T17:48:38Z"`; `"expiration"... "2027-09-29T17:48:38Z"`; `"status":["client transfer prohibited"]`; registrar `NameCheap, Inc.` IANA `1068`; NS `DNS1.REGISTRAR-SERVERS.COM`, `DNS2.REGISTRAR-SERVERS.COM`; `"delegationSigned":false` |
| S3 | https://rdap.verisign.com/com/v1/domain/mosshatch.com | same values; handle `3147612638_DOMAIN_COM-VRSN` |
| S4 | https://rdap.verisign.com/net/v1/domain/hatchkind.net ; https://rdap.publicinterestregistry.org/rdap/domain/hatchkind.org ; https://pubapi.registry.google/rdap/domain/hatchkind.dev and `.app` ; https://rdap.identitydigital.services/rdap/domain/hatchkind.studio, `.io`, `.ai` | HTTP 404; bodies `"hatchkind.dev not found"`, `"hatchkind.app not found"`, `"Object not found"`; controls: google.ai and github.io returned HTTP 200 from the Identity Digital host |
| S5 | https://www.iana.org/domains/root/db/io.html ; .../ai.html ; .../co.html | io: `WHOIS Server: whois.nic.io` (no RDAP server listed); ai: `RDAP Server: https://rdap.identitydigital.services/rdap/`; co: `WHOIS Server: whois.registry.co` |
| S6 | https://dns.google/resolve?name=hatchkind.io&type=NS (and the other labels/TLDs) | `"Status":3` (NXDOMAIN) with SOA `a0.nic.io` for hatchkind.io; same for the other unregistered labels in `raw/doh-ns.txt` |
| S7 | https://tmsearch.uspto.gov/search/search-information (API `POST /prod-stage-v1-0-0/tmsearch`) | hatchkind: `"hits":{"totalValue":0,"totalRelation":"eq"`; prefix `hatchk`: 3 hits; prefix `hatch`: `"totalValue":1081`; HATCHKINZ `"registrationId":"7054458","registrationDate":"2023-05-16"`, goods `IC 028: Plush toys; Stuffed toy animals; Stuffed and plush toys; Toy stuffed animals.` |
| S8 | https://www.tmdn.org/tmview/ (API `POST /tmview/api/search/results`) | `"numberOfTrademarks":"143032652"`; offices EM 2,786,132, GB 3,666,269, WO 1,544,530, US 13,868,607, all `updated 29/09/2026`; hatchkind Is/Contains/Begins = 0; fuzzy = 3 US; HATCH (Is) in classes 9/35/36/42/45: 159 records |
| S9 | https://euipo.europa.eu/eSearch/ (API `POST /copla/ctmsearch/json`) | `{"total":0,"items":[],...` for hatchkind, hatch kind, hatch-kind, hatchkinds, hatchkin, mosshatch; UI shows `Trade marks (0)` |
| S10 | https://branddb.wipo.int/en/quicksearch?by=brandName&v=hatchkind | Observed: repeated `GET api.branddb.wipo.int/captcha` and `/news` returning HTTP 401; no result list rendered in 30 s |
| S11 | https://trademarks.ipo.gov.uk/ipo-tmtext | HTTP 403, page title `Just a moment...`, text `This security check is required for you to continue` |
| S12 | http://127.0.0.1:37695/__agentproxy/status ; https://web.archive.org/cdx/search/cdx?url=hatchkind.com | `connect_rejected` for `rdap.nic.io:443`, `rdap.nic.co:443`, `brunhild.challenges.cloudflare.com:443`; wayback CDX HTTP 403 `Blocked by egress policy` |
| S13 | `npm view`; https://registry.npmjs.org/-/v1/search?text=scope:hatchkind ; https://pypi.org/pypi/hatchkind/json ; https://crates.io/api/v1/crates/hatchkind ; https://hub.docker.com/v2/users/hatchkind/ ; GitHub MCP `search_users` | npm `E404`; scope search `"total":0`; PyPI/crates/Docker 404; GitHub `"total_count":0` |
| S14 | WebSearch queries `"hatchkind"` and `"Hatch Kind" OR "HatchKind" brand company app` | Results were Hatch (sleep), Hatch Apps, Hatch Kids, Hatchlings, Hatch Kings; "The search results primarily returned items with similar names rather than an exact match for 'hatchkind.'" |
| S15 | https://web.dev/articles/same-site-same-origin | `Websites that have the same combination of scheme, hostname, and port are considered "same-origin".` / `Websites that have the same scheme and the same eTLD+1 are considered "same-site".` / `https://login.example.com:443 ... Same-site: different subdomains don't matter` |
| S16 | https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy | `Two URLs have the same origin if the protocol, port (if specified), and host are the same for both.` / `Cross-origin reads are typically disallowed` |
| S17 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie | `Setting the domain makes the cookie available to that domain and all its subdomains.` / `If omitted, the cookie is returned only to the host that sent it (i.e., it becomes a "host-only cookie").` / `It cannot be a public suffix such as com, co.uk, or github.io.` / `__Host-: ... only sent to the host that set them, and not to any other host on the domain.` |
| S18 | https://publicsuffix.org/submit/ | `owners of privately-registered domains who themselves issue subdomains to mutually-untrusting parties may wish to be added to the PRIVATE section` / `We will generally decline small projects or experimental / lab requests or short-term entries.` |
| S19 | https://raw.githubusercontent.com/wiki/publicsuffix/list/Guidelines.md (mirror of the GitHub wiki "Guidelines") | `Does every domain in the _PRIVATE_ section have at least two years remaining in the registration term?` / `registration periods of less than a year may result in the automatic removal of the domain.` |
| S20 | https://security.googleblog.com/2012/08/content-hosting-for-modern-web.html | `placing some of the high-risk content in separate, isolated web origins—most commonly *.googleusercontent.com` / `Copying users' normal authentication cookies to the "sandbox" domain would defeat the purpose.` / `there are more ways to accidentally leak a capability-bearing URL than there are to accidentally leak cookies` |
| S21 | https://www.w3.org/TR/webauthn-3/ (read at https://w3c.github.io/webauthn/) | `W3C Recommendation, 25 August 2026`; `Web Authentication requires that the RP ID be equal to the origin's effective domain, or a registrable domain suffix of the origin's effective domain.` |
| S22 | https://web.dev/articles/webauthn-related-origin-requests | `Related Origin Requests are supported on Chrome and Safari. As of January 2026, Firefox is still considering the feature.` / `In Chrome, the maximum number of labels is 5.` |
| S23 | https://developers.google.com/search/docs/monitor-debug/security/social-engineering | `the content pretends to act, or looks and feels, like a trusted entity` / `Embedded social engineering content is a policy violation for the host page.` |
| S24 | https://developers.google.com/search/docs/monitor-debug/security/safe-browsing-repeat-offenders | `Sites that repeatedly switch between compliant and noncompliant behavior within a short window of time will be classified as Repeat Offenders.` / `Repeat Offender status persists for 30 days` |
| S25 | https://developers.google.com/search/docs/monitor-debug/prevent-abuse | `consider adding the noindex robots meta tag on posts that come from new users that don't have any reputation` / `consider adding a nofollow or ugc rel attribute to all links in untrusted content` / `you can use the Google Safe Browsing API to regularly test URLs from your service` |
| S26 | https://developers.google.com/search/docs/essentials/spam-policies | `Spammy accounts on hosting services that anyone can register for` (user-generated spam); page last updated 2026-08-28 |
| S27 | https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links | `We recommend marking user-generated content (UGC) links, such as comments and forum posts, with the ugc value.` |
| S28 | https://developers.google.com/safe-browsing | `The Safe Browsing API is for non-commercial use only. If you need to use APIs to detect malicious URLs for commercial purposes ... please refer to the Web Risk API.` / `Prevent users from posting links to known infected pages from your site.` |
| S29 | https://cloud.google.com/web-risk/docs/overview ; https://cloud.google.com/web-risk/pricing | `The information returned by the Web Risk must not be redistributed.` / `Lookup API uris.search: free for up to 100,000 calls per month.` / `100,001 to 10,000,000 calls per month: $0.50 per 1,000 calls` |
| S30 | https://developers.google.com/safe-browsing/v4/urls-hashing | `Each suffix/prefix expression consists of a host suffix (or full host) and a path prefix (or full path)` |
| S31 | https://www.law.cornell.edu/uscode/text/17/512 | `the service provider has designated an agent to receive notifications of claimed infringement described in paragraph (3), by making available through its service, including on its website in a location accessible to the public, and by providing to the Copyright Office` / `not less than 10, nor more than 14, business days` |
| S32 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065 (rendered in headless Chromium) | Art. 16(1): `Providers of hosting services shall put mechanisms in place to allow any individual or entity to notify them of the presence on their service of specific items of information that the individual or entity considers to be illegal content.` Recital 50: `all providers of hosting services, regardless of their size`. Art. 19(1): `This Section, with the exception of Article 24(3) thereof, shall not apply to providers of online platforms that qualify as micro or small enterprises` |
| S33 | https://developers.google.com/search/docs/appearance/site-names | `Google Search does not support site names at the subdirectory level.` |
| S34 | https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag | `<meta name="robots" content="noindex">` and `X-Robots-Tag: noindex` |
| S35 | https://datatracker.ietf.org/doc/draft-ietf-dmarc-dmarcbis/ (now RFC 9989, May 2026, "Obsoletes RFC 7489, RFC 9091") | `Domains are said to be in "relaxed alignment" if they have the same Organizational Domain` / `domains are in "strict alignment" if and only if they are identical` |
| S36 | https://www.rfc-editor.org/rfc/rfc7208.txt | `Publishing SPF records for domains that send no mail is a well-established best practice. The record for a domain that sends no mail is: www.example.com. IN TXT "v=spf1 -all"` |
| S37 | https://www.rfc-editor.org/rfc/rfc7505.txt | `formalizes the existing mechanism by which a domain announces that it accepts no mail` |
| S38 | https://resend.com/docs/dashboard/domains/introduction | `We recommend sending your emails from one or more subdomains (e.g., updates.example.com) instead of your root domain to isolate your sending reputation` |
| S39 | https://support.google.com/a/answer/81126 | `Starting February 1, 2024, email senders who send more than 5,000 messages per day to Gmail accounts must meet the requirements` / `Set up DMARC email authentication for your sending domain. Your DMARC enforcement policy can be set to none.` / `Keep spam rates reported in Postmaster Tools below 0.30%.` |
| S40 | https://developers.cloudflare.com/cloudflare-one/traffic-policies/domain-categories/ | `New Domains: Domains registered within the past 30 days.` / `Parked & For Sale Domains: Domains that are not connected to a hosting service.` |
| S41 | https://www.icann.org/resources/pages/transfer-policy-2016-06-01-en | `3.7.5 The transfer was requested within 60 days of the creation date as shown in the registry Whois record for the domain name.` |
| S42 | https://vercel.com/docs/domains/working-with-ssl ; https://vercel.com/docs/domains/working-with-domains/add-a-domain | `For wildcard requests, we use the DNS-01 challenge method. This is why we require nameservers to be with Vercel to use wildcard domains`; alternative: delegate `_acme-challenge` |
| S43 | https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html | `no framework is perfect and security gaps still exist in popular frameworks like React and Angular. Output encoding and HTML sanitization help address those gaps.` |
| S44 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP | `Content Security Policy (CSP) is a feature that helps to prevent or minimize the risk of certain types of security threats.` / `recommended practice is to use nonce- or hash- based fetch directives. This is called a strict CSP.` |
| S45 | https://www.unicode.org/reports/tr39/ | `Version 18.0.0 ... Date 2026-08-27`; `incorrect usage can expose programs or systems to possible security attacks.` |
| S46 | https://dns.google/resolve?name=hatchkind.com&type=A (also MX, TXT, CAA, DS; mosshatch.com; `_dmarc.*`) | hatchkind.com A `192.64.119.89`; MX `10 eforward1-4.registrar-servers.com`, `20 eforward5...`; TXT `v=spf1 include:spf.efwd.registrar-servers.com ~all`; `_dmarc` NXDOMAIN; CAA/DS empty. mosshatch.com A `192.64.119.39`, same MX/TXT |
| S47 | https://crt.sh/?q=%25.hatchkind.com&output=json (also `mosshatch.com`, `%.mosshatch.com`) | `[]` (no logged certificates) |
