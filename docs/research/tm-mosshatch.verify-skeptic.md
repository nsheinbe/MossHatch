# tm-mosshatch: skeptic verification notes

Verifier: skeptic lens. Run 2026-09-29 (roughly 20:33 to 21:05 UTC). Raw captures and scripts: `working-directory/research/tmv-skeptic/`.
Method: I did not reuse the analyst's result files. I wrote my own queries (analyst scripts were read only to learn the JSON request shapes of the USPTO, EUIPO and TMview endpoints). Each register was queried with new query sets and the analyst's control (CROSSHATCH) was reproduced.
Ground rules kept: no TLS bypass, no proxy bypass, no work-arounds of egress blocks or bot challenges (UK IPO, DuckDuckGo, Yandex, Brave, EDGAR, Instagram left alone).

## Bottom line

The core conclusion holds: I found no MOSSHATCH / MOSS HATCH / MOSSHATCHED (or close phonetic or typo variant) mark in USPTO, EUIPO, TMview or WIPO GBD. Class 45 is the correct Nice class for domain-name registration (also for authorized resellers). The RDAP picture for the domains reproduces.
Things that need correction or a caveat:
1. The crosshatch.io page says "We shut down July 2025" (verified), but the page never names Olympus Technologies Inc. The link between the CROSSHATCH registrant and the defunct startup is an inference (goods description matches "Plaid for Personalized AI"), not something the page states.
2. The statement that HATCH in Class 45 is only engineering permitting (Hatch Ltd.) is incomplete. HATCH LABS (Hatch Labs Holdings LLC) has a US application in Class 45 for "Software licensing; Patent licensing; Product licensing services" plus Class 42 SaaS. Hatch Ltd. also has pending HATCH filings in Class 45/42 at EUIPO (019402520) and UK IPO (UK00004423741). None is close to MOSSHATCH, but "Class 45 = low" should say "HATCH-only naming is not free in Class 45".
3. "moshatch fuzzy (1-2): COSHATCH only" is right only at edit distance 1. At distance 2 the USPTO returns 59 records (noise plus COHATCH, POPHATCH, MODWATCH, MOSHATO, MISMATCH). None is MOSSHATCH-like.
4. The ID Manual API ignores its `version` parameter (12-2026, 13-2027, 14-2026 all return the same records). "13-2026" is a genuine Nice edition-version label (verified on nclpub), but the USPTO ID Manual quotes are simply the manual's current text; the label cannot be pinned via the API. Conclusion unaffected.
5. Not re-verifiable: open-web coverage (WebSearch budget exhausted, other engines challenge or return junk), .co registration status, Instagram, npm scope, EDGAR (403 undeclared automated tool), Wikipedia API (429), Wayback (429/reset), WIPO Phonetic (flaky UI in my runs).

## 1. RDAP and DNS re-run

IANA bootstrap https://data.iana.org/rdap/dns.json: publication 2026-09-28T22:00:03Z. com -> rdap.verisign.com/com/v1/, net -> .../net/v1/, org -> rdap.publicinterestregistry.org/rdap/, dev/app -> pubapi.registry.google/rdap/, ai/studio -> rdap.identitydigital.services/rdap/. No .io or .co entry (also confirmed on the IANA root DB pages https://www.iana.org/domains/root/db/io.html and co.html, which list WHOIS only, no RDAP).

| Domain | My result (2026-09-29) | Control on same server |
|---|---|---|
| mosshatch.com | HTTP 200 at https://rdap.verisign.com/com/v1/domain/mosshatch.com. registration 2026-09-29T17:48:38Z, expiration 2027-09-29T17:48:38Z, last changed 2026-09-29T17:48:42Z, status `client transfer prohibited`, NS DNS1/DNS2.REGISTRAR-SERVERS.COM, delegationSigned false, registrar IANA ID 1068. | n/a |
| mosshatch.com (Namecheap) | HTTP 200 at https://rdap.namecheap.com/domain/MOSSHATCH.COM. status `client transfer prohibited`, `add period`; registrant/tech = "Privacy service provided by Withheld for Privacy ehf" (Reykjavik). | n/a |
| mosshatch.net | 404 | example.net 200 |
| mosshatch.org | 404 | wikipedia.org 200 |
| mosshatch.dev / .app | 404 ("mosshatch.dev not found") | google.dev 200, google.app 200 |
| mosshatch.ai | first try 429 (Cloudflare 1015), retry 404 | nic.ai 200 |
| mosshatch.studio | first try 429, retry 404 | nic.studio 200 |
| mosshatch.io | 404 at Identity Digital server | google.io 200 (created 2002-10-01); nic.io got 429 (rate limit) on my runs. Caveat: .io is not in the IANA bootstrap, so this endpoint is an inference. |
| mosshatch.co | rdap.registry.co returns 404 for mosshatch.co, google.co and nic.co alike; rdap.nic.co unreachable | RDAP unusable, as the analyst said |

DoH (cloudflare-dns.com, NS): mosshatch.com NS dns1/dns2.registrar-servers.com; NXDOMAIN (Status 3) for mosshatch .net .org .io .ai .dev .app .studio .co and for moss-hatch.com and mosshatched.com; control google.co and nic.io resolve. A/MX/TXT for mosshatch.com: 192.64.119.39; 10 eforward1-3 / 15 eforward4 / 20 eforward5 .registrar-servers.com; `v=spf1 include:spf.efwd.registrar-servers.com ~all`. http://mosshatch.com redirects to www.mosshatch.com, a Namecheap default parking page ("has been recently registered with namecheap.com"). About 40 further TLDs from the dossier were NOT re-run.
Caveat that stands: NXDOMAIN is not proof of non-registration; RDAP 404 does not show reserved or premium status. Ownership of mosshatch.com cannot be shown from public data (privacy-masked).

## 2. Nice class and ID Manual

- Nice, WIPO nclpub, version 20260101, Class 45 explanatory note: "This Class includes, in particular: ... registration of domain names;" Alphabetical list has "450233 leasing of internet domain names" and "450213 registration of domain names [legal services]". URL: https://nclpub.wipo.int/enfr/?basic_numbers=show&class_number=45&explanatory_notes=show&lang=en&menulang=en&mode=flat&notion=&version=20260101&pagination=no
- Class 35 note: "registration of domain names ( Cl. 45 )". Class 42 page has no "domain" text; it lists software as a service, platform as a service, data encryption, user authentication, hosting computer websites, electronic data storage (all present). Class 9 page has no "domain" text.
- Nice version 20270101 (edition-version label 13-2027, effective 2027-01-01): Class 45 still lists "registration of domain names"; Class 42 has no domain text. That partly closes the analyst's unverified item on the 13-2027 change log (only the class 45 and 42 pages compared, not a full change log). The 2027 page also shows the labels 12-2023, 12-2024, 12-2025, 13-2026, 13-2027, so "13-2026" is a valid Nice label.
- USPTO ID Manual API `https://idm-tmng.uspto.gov/api/search/public?search-term=domain%20name&...&version=13-2026` returned 20 entries. Class 045, status A: 49845 "Domain name registrar services", 42239 "Domain name registration services", 90446 and 74119 "Registration of domain names (for others)", 90447 (acceptable wording, further specification not required), 60137 "Leasing of internet domain names", 70476 monitoring. Class 042: 41143 domain name search services, 100298, 100300 storage of domain name addresses, 48298 parking (status M).
- Verbatim, entry 49845: "Registrars are distinguishable from re-sellers, who may provide domain name registration services under authorization from registrars, but are not themselves ICANN-accredited registrars. Domain name registration services is acceptable wording in Class 45 for any entity or person that provides such services."
- Verbatim, entry 42239 (03-20-2014 note): "Domain name registration services are the services of domain registry operators, ICANN-accredited domain name registrars and their authorized re-sellers ... These services do not include the technological activities of domain registry operators, which are computer services in Class 42."
- Entry 90632 (status D, deleted 09-14-2023): "01-01-2007 - Transferred from Class 42 pursuant to 9th edition of Nice Agreement." It was replaced by "Registration of domain names for identification of users on a global computer network" in Class 45.
- Caveat: the ID Manual API returns identical data for version=12-2026, 13-2027 and 14-2026, so the version label cannot be pinned through it.

## 3. Trademark registers

### USPTO (tmsearch.uspto.gov JSON API via headless Chromium, my own queries)
Dataset current: serial 50131398 TALES OF MOSSHELM filed 2026-09-27 present.
Zero hits: match_phrase and match WM mosshatch; wildcards `*mosshatch*`, `mosshatch*`, `*osshatch*`, `*moss*hatch*`, `moss*hatch`, `moss*atch*`, `*mosh*atch*`, `*mossatch*`, `*moshatch*`, `*mossbatch*`, `*mosswatch*`, `*mossmatch*`, `*mosscatch*`, `*mossthatch*`, `*mosshat*`; wordmark-field wildcard; phrases "moss hatch", "moss hatchery", "mossy hatch"; token AND moss+hatch, mossy+hatch; moss + `hatch*`; fuzzy distance 1 for mosshatch (0) and moshatch (1: COSHATCH).
Fuzzy distance 2 mosshatch: 20 hits (CROSSHATCH family incl. Geiger Class 20, Carr Winery Class 33, Olympus Class 42; COSHATCH Class 25; LOSSWATCH dead Class 42); mosshatched: 16 (MISSMATCHED family dead). Controls: `*crosshatch*` = 19.
Other neighbours seen: MOTIONHATCH (41), MOVIEHATCH (42), MOSSHEAD (25/41, Reg 6687753), MOSSHAMMER, MOSHPIT (41/42 live), MOSH JD (42), SHATCHI, COHATCH (42/9/36/35/43), POPHATCH (35/42, Reg 8372916 filed 2025-04-14), MODWATCH (42). None is a MOSSHATCH conflict.
Record checks (all matched the dossier): CROSSHATCH Reg 7836851 / serial 98179406 filed 2023-09-14 registered 2025-06-17, Olympus Technologies Inc. (Delaware), IC 042, live, no abandon or cancel date. MOSS Nufin GmbH Reg 7369253 / serial 79315217, filed 2020-12-23, registered 2024-04-30, US classes 9/35/38/42 (not 36). MOSS Polyarc Reg 5846030 registered 2019-08-27, 9/41. HATCH Fulcrum Chicago 8357217 registered 2026-07-21 (42). HATCH Playful Software 7191178 registered 2023-10-10 (42). HATCHIFY INC. serial 50045179 filed 2026-08-11, 42/35/38, live application, goods include "SaaS ... for creating and managing artificial-intelligence (AI) agents". MOSSO Diffuse Digital LLC serial 99921598 filed 2026-07-03, 36/42 (music royalties).
Crowding: 59 US records with HATCH in Class 42 (28 live), including Adammatic 5537244, Ahead 7530248, Visuwell 7388980, Hatch Inc 7077830 (9/42), Hatch Ltd 2911963, HATCH LABS, HATCH SOCIAL 8137573, Hatch Bank PaaS marks. MOSS in Class 42: 46 records (17 live: Moss & Associates 5317577/78, Nufin, Polyarc, Moss Adams, interior design etc.).
Class 45 in the US: HATCH 10 records (5 live: Hatch Ltd x2 permitting, HATCH LABS software/patent/product licensing, ESCAPE HATCH genealogy, a legal-services slogan); MOSS 4 records (JOHNSON MOSS legal, DENISE MOSS foundation live). No HATCH or MOSS mark covers domain names in the US register (goods text queries "domain name(s)" with hatch/moss wildcard: 0; only a dead MOSSO, Mosso Ltd. Texas, Class 45 domain registration).

### EUIPO eSearch plus (own POSTs to /copla/ctmsearch/json)
CONTAINS and STARTS_WITH, 0 hits each: mosshatch, mosshatched, mosshatching, mossatch, moshatch, mosshach, mossyhatch, mosshat, mosshatchery, "morse hatch", "mosh atch"; sshatch STARTS_WITH 0; AND moss+hatch 0; AND mosh+atch 0. Some requests (including "moss hatch" with a space, "mos hatch") returned the server's HTML "Problem detected" page; those were retried or covered by the AND queries. Controls: crosshatch CONTAINS 22 (incl. W01766322 CROSSHATCH, Class 42, "IR accepted"; 018930332 CROSSHATCH Registered 3/18/25; 005115852 CROSSHATCH FORWARD THINKING).

### TMview (own POSTs to /tmview/api/search/results)
Contains, begins-with, exact: 0 for mosshatch, mosshatched, mosshatching, moshatch, mossatch, mosshach, morse hatch, mossy hatch, mosshat (all offices), and mosshatch Contains 0 per office GB, US, EM, WO and for the group CA/AU/CN/JP/KR/IN/CH/BR/DE/FR/ES/IT/MX/NZ. "moss hatch"/"moss-hatch" Contains: 3 (Moss Off Thatch and Moss Off Thatch Roof, GB, 37/40; moss Bach, JP, 25, ended). Fuzzy mosshatch: 3 (JP MOSSCATCH SYSTEM, ended, 37/40/41); fuzzy mosshatch per office GB/EM/US: 0. Fuzzy mosshach/mossmach: 4 x MOSSMACH, CN, Registered, classes 9, 35, 38, 42, applicant 妙算神机科技（上海）有限公司, numbers 75593117, 75599543, 75610953, 75587550, application date 2023-12-05. Fuzzy moshatch: MosCatch (IN), MOSPATCH (KR), COSHATCH (US), LOSHATCH (CN, expired), MOSCATCH (KR). Controls: crosshatch C 135, B 90, E 58 (same as the dossier).
`/tmview/api/general/globals`: numberOfTrademarks 143,032,652; 81 tmvisionOffices. Feed update dates (dd/mm/yyyy): GB, US, EM, WO, AU, KR, CH, DE, FR, ES, IT, MX 29/09/2026; JP 25/09/2026; CA 24/09/2026; CN 03/09/2026; BR 27/09/2026; IN 04/05/2026. Other stale feeds (May 2026): AL, BN, BZ, KH, LA, MY, PH, TN.
Per-office exact searches (first 100): MOSS GB 183 (Nufin `Moss` UK00003694023 classes 9/35/36/38/42; Polyarc UK00801402364 9/41), MOSS EM 122, MOSS WO 51 (Nufin WO 1601251 classes 9/35/36/38/42; Polyarc WO 1402364 9/28/41; Terra Vista WO 1565792 class 36); HATCH GB 90, EM 50, WO 32. Not in the dossier: pending HATCH by Hatch Ltd. (GB UK00004423741, EM 019402520, both 35/36/37/42/45, "Filed"); HatchaHome UK00004239596 (9/35/42/45, registered), Hatch Partnership LLP (35/36/45, expired), HATCH WO 1779930 and 1778177 (Hatch Ltd, 35/42), HATCH B.V. WO 1606852 (9/42). CROSSHATCH WO 1766322 Olympus Technologies Inc., class 42, Registered (GB: only BOI Trading CROSSHATCH marks, all 3/18/25 or 3/9/18/25).

### WIPO Global Brand Database (driven through the site's own UI form in headless Chromium, no response decoding by me)
https://branddb.wipo.int/en/quicksearch. Landing text: "Covering 76,822,006 records from 89 data sources". Results (all 2026-09-29): mosshatch Embedded/Simple: "No results found!" (twice); Exact: "No results found!"; Fuzzy: 172 results, top hits CROSSHATCH (UAE, Qatar, UK expired, Canada, USA); Stemming: "No results found!" (analyst could not obtain, 401 in their runs); "moss hatch" Exact: no results; "moss hatch" Simple: 3,985 results (matches either word: top hits HATCH, MOSS, MOSS & MOSS singles; nothing joined); crosshatch Simple: 155. Phonetic: my UI runs failed (flaky/401), so 36,517 is not re-checked.
The site fired 401s intermittently; the ones that succeeded came back HTTP 200 after reload.

### UK IPO
`https://trademarks.ipo.gov.uk/ipo-tmtext`: curl and Chromium both returned HTTP 403 "Service Captcha / Security check ... to keep our services safe from automated systems ... data mining". The challenge script host brunhild.challenges.cloudflare.com failed with ERR_TUNNEL_CONNECTION_FAILED and the proxy status recorded `connect_rejected` for it. Not worked around. GB coverage remains TMview GB (0) and WIPO GBD (which includes UK data; 0 for mosshatch).

## 4. Other claims

- crosshatch.io (https://crosshatch.io, HTTP 200): "Crosshatch was 'Plaid for Personalized AI.' ... We shut down July 2025." No mention of Olympus Technologies, Delaware or Inc. on the page; /terms, /privacy, /legal all 404. USPTO owner search "Olympus Technologies" returns only CROSSHATCH (Delaware) and a dead EZ HOE mark (Olympus Technologies Incorporated, Oregon).
- 15 U.S.C. 1127 (Cornell LII): "Nonuse for 3 consecutive years shall be prima facie evidence of abandonment." 15 U.S.C. 1052(d): "so resembles a mark registered in the Patent and Trademark Office ... as to be likely ... to cause confusion". Both verbatim.
- Package names: registry.npmjs.org/mosshatch 404; npm search total 0; @mosshatch/core 404; PyPI mosshatch and moss-hatch 404; crates.io "crate `mosshatch` does not exist"; RubyGems 404; NuGet BlobNotFound; Docker Hub user and org 404. Packagist, Homebrew, Open VSX, VS Marketplace not re-run. npm user endpoint 401 and npmjs.com/~mosshatch 403 (not verifiable).
- GitHub (search tool): users "mosshatch in:login" and "mosshatch": total_count 0; repositories "mosshatch": total_count 1, nsheinbe/MossHatch, private false, created 2026-09-29T18:55:04Z.
- Social: x.com/mosshatch HTTP 404 "User Profile Not Found - X | 404 Error"; youtube.com/@mosshatch 404; TikTok @mosshatch page data statusCode 10221; Bluesky getProfile mosshatch.bsky.social "Profile not found"; Instagram 429 (unverified).
- Stores: Google Play search "No results for mosshatch"; iTunes Search API term mosshatch returned 4 apps (The Mossy Oak Store, MoorMOSS, Bryophyte Lens, Moss - Plant Care & Rescue), none named Mosshatch.
- Company registers: UK Companies House search mosshatch "No results found". HN Algolia: one hit for "mosshatch", a false positive (URL contains "mosstache"); "moss hatch" phrase 0. SEC EDGAR: 403 "Undeclared Automated Tool", not re-verified. Wikipedia API: 429, not re-verified.
- Open web: WebSearch budget exhausted (200/200); Bing returned unrelated results; DuckDuckGo showed a human-verification challenge; Yandex a JS check; Brave 429 captcha; Marginalia bot-wait page. None bypassed. Open-web namesake coverage therefore not re-verifiable by me.
- Wiktionary: mosshatch 404; moss "Any of various small, green, seedless plants ..."; hatch "To emerge from an egg." and "To shade an area of (a drawing, diagram, etc.) with fine parallel lines, or with lines which cross each other (crosshatch)"; Moss (Norwegian) "town with bystatus/and/municipality ... Østfold, Norway".

## 5. Missed or under-stated by the analyst

1. HATCH LABS (Hatch Labs Holdings LLC), US applications in Class 45 (software licensing, patent licensing, product licensing) and Class 42 (SaaS for private marketplaces; software design and development). Closest HATCH mark to the Class 45 reseller activity, though still a different mark.
2. Hatch Ltd. pending HATCH applications in Class 42/45 at EUIPO (019402520) and UK IPO (UK00004423741): the "HATCH in Class 45 is only permitting" statement predates these.
3. Additional live Class 42 neighbours with HATCH or -WATCH tails: POPHATCH (US Reg 8372916, PopHatch Inc., filed 2025-04-14), COHATCH (COhatch LLC, 42/9/36/43), MODWATCH (Class 42). Also MOSHPIT (41/42) and MOSH JD (42) as MOSH-prefix neighbours.
4. CROSSHATCH WO 1766322 designates the EU (EUIPO shows "IR accepted"), so the EU is in play for Class 42, not only the US; designation list for other offices still unverified.
5. The dossier does not state that the WIPO "moss hatch" Simple strategy is an OR-token search (3,985 results are mostly single-word MOSS or HATCH marks), so it is not evidence of any joined mark either way.
6. Availability or pricing checks (reserved or premium lists) for the unregistered TLDs were not done; RDAP 404 is not proof of availability.
7. No check of prior ownership history for mosshatch.com (Wayback 429/reset, crt.sh unavailable): a dropped-name history remains possible.
