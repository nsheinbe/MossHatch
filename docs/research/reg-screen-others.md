# Registrar / reseller route screen: Spaceship, Cloudflare, GoDaddy, AWS Route 53, Vercel, Squarespace, Internet.bs, eNom/Hover, Epik

Prepared 2026-09-29 for the Mosshatch Phase 0 plan. Research only. Raw fetches are in `.../scratchpad/research/others/`.

## TL;DR

1. Best fit on paper (explicit resale + API + sandbox + all six starting TLDs): **eNom (Tucows)**. White-label reseller platform, test env at resellertest.enom.com, wholesale price table published (.com $14.50, .ai $111, .io $60, .dev $17, .app $21, .studio $42 at the entry tier), $195 (currently $50) enrollment fee. Catch: mandatory static-IP allow-list for API calls (Vercel Static IPs = $100/month/project).
2. **AWS Route 53 Domains** is self-serve (no sales gate) and its agreement explicitly blesses resale (DRA sec. 3.12, reseller flow-down duties). All six TLDs listed; no sandbox; default cap of 20 domains/account; list prices only (.ai $137, .io $71, .studio $44 since 2026-07-01).
3. **GoDaddy API Reseller** has a documented OTE sandbox, own-brand/own-price resale and a `X-Shopper-Id` reseller mode in the v3 API, but is sold to "select businesses", funded via Good as Gold, and its published wholesale table lists only .com among our six ($10.69). GoDaddy's legal pages (API Terms of Use, Reseller Agreement) were bot-blocked (HTTP 403), so the actual resale clauses are UNVERIFIED.
4. **Squarespace** runs a formal Domain Reseller Program (approval, negotiated wholesale, monthly remit) but API docs and terms are partner-gated (HTTP 401) and end customers manage the domain by logging in to Squarespace, which cuts against a fully own-brand experience.
5. **Not viable as a reseller source today:** Cloudflare (API is beta: no renewals/transfers/contact updates; DRA forces Cloudflare nameservers; Self-Serve Agreement bars selling access; a "registrar-as-a-service" reseller product was promised for "later this year" (2026) and had not shipped per docs updated 2026-09-16), Vercel (ToS bans resale/service-bureau use; it is itself a reseller of Name.com/Tucows), Hover (no public API; resell path is OpenSRS/eNom).
6. **Unverifiable from here:** Spaceship terms (Cloudflare challenge; challenge host blocked by egress policy), Internet.bs docs/terms (Cloudflare), Epik (Cloudflare; docs host blocked by egress policy). Internet.bs's live test API works and shows the lowest sampled prices (.io $49.98, .ai $92.40) but its test host errored on .dev/.app/.studio availability.
7. **Own ICANN accreditation** is a long-run option: US$3,500 non-refundable application + US$4,000/yr + variable/transaction fees, evidence of ~US$70,000 liquid working capital, RAA + data escrow + RDAP, then separate registry contracts and OT&E per TLD (Verisign for .com; Identity Digital for .ai and .studio; Google Registry for .dev/.app; .io path unverified). The RAA's US$500,000 insurance clause is waived since 2015-09-28.

## Method and access limits (read this before trusting a "blank")

- All fetches on 2026-09-29 (UTC) with the prescribed curl UA, plus headless Chromium where a page was JS-rendered or 403. TLS verification never disabled.
- WebSearch budget was exhausted mid-task (200/200 per-session), so several leads (eNom, Hover, Epik searches) were replaced by direct URL probing. Search snippets are used only as flagged leads and never as evidence.
- Access blocks (recorded, not worked around):
  - www.spaceship.com (every path incl. /legal/*): HTTP 403 Cloudflare managed challenge ("Just a moment..."); the challenge host `brunhild.challenges.cloudflare.com:443` is rejected by the egress proxy (connect_rejected 502), so treated as blocked by egress policy. `docs.spaceship.dev` was fetchable.
  - internetbs.net (all paths): HTTP 403 Cloudflare "Sorry, you have been blocked"; Chromium hit the same challenge. `testapi.internet.bs` and `api.internet.bs` were reachable.
  - epik.com, usersapiv2.epik.com, api.epik.com, registrar.epik.com: HTTP 403 Cloudflare. `docs.userapi.epik.com:443`: **blocked by egress policy** (connect_rejected).
  - godaddy.com/legal/*, /agreements/showdoc*, /reseller-program: HTTP 403 "Access Denied" (Akamai edge) for curl and Chromium. developer.godaddy.com, reseller.godaddy.com/docs and godaddy.com/help/* were fetchable.
  - reseller.squarespace.com/api-documentation, /legal/terms, /legal/retailprices: HTTP 401 (partner-gated). registry.google: Google sign-in wall.
  - web.archive.org: connection reset by peer (curl exit 35); no archived copies were available as a fallback.
  - community.cloudflare.com and domains.cloudflare.com/api/tlds via curl: 403 challenge; the TLD JSON was obtained by loading cloudflare.com/domains in Chromium (same page the site itself renders).
  - `rdap.nic.io` was rejected by the egress proxy (observed in proxy status), so .io registry data via RDAP was not fetched.

## Summary table (decision view)

| Route | Public API that REGISTERS? | Resale under own brand permitted? | Sandbox | 6 TLDs (.com .ai .dev .io .app .studio) | Reseller-hostile clause found | Deep dive? |
|---|---|---|---|---|---|---|
| Spaceship | Yes (`POST /v1/domains/{domain}`, key+secret, async) | Unclear (terms unreadable) | None documented | Not verifiable (pricing/TLD pages blocked) | Unknown | No (revisit if terms obtained) |
| Cloudflare Registrar | Yes, beta (search/check/register only) | No today (SSA 2.2.1(a); no reseller program yet) | None documented | Yes in dashboard (431 TLDs incl. all six); API: all dashboard TLDs except 8 others | Forced CF nameservers (DRA 6.1); no renew/transfer via API | No (watch RaaS launch) |
| GoDaddy | Yes (v3 PAT API; legacy v1/v2 key API; Reseller API) | Conditional (API Reseller plan, "select businesses") | Yes (OTE, api.ote-godaddy.com) | Partial evidence: .com/.io/.app/.ai seen in v3 pricing table; wholesale table lists only .com; .dev/.studio not shown | API Terms text unreadable (403) | Yes |
| AWS Route 53 Domains | Yes (`RegisterDomain`) | Yes (DRA 3.12) | None documented | Yes, all six listed | 20-domain default quota; no premium names | Yes |
| Vercel Domains | Yes (`POST /v1/registrar/domains/{domain}/buy`) | No (ToS 11(i),(iv)) | None documented | Yes (search returned prices for all six) | Explicit resale/service-bureau ban | No |
| Squarespace | Yes, Reseller API (gated) | Conditional (approved partners only) | Unclear (docs gated) | Yes on retail list; reseller list unverified | Customers manage domain at Squarespace | Yes (low priority) |
| Internet.bs | Yes (reseller/registrar API) | Unclear (terms unreadable) | Yes (testapi.internet.bs) | Price list has all six; test availability check failed for .dev/.app/.studio | Unknown | Yes |
| eNom (Tucows) | Yes (300+ commands) | Yes (Reseller Agreement license to resell; white-label) | Yes (resellertest.enom.com) | Yes, all six in reseller price table | Static IP allow-list; premium names only for ETP resellers; 5% Points card fee | Yes |
| Hover (Tucows) | No public API | No (consumer service; partner program is referral) | n/a | n/a | n/a | No |
| Epik | Unclear (docs unreachable) | Unclear | Unclear | Unverified | Unknown | No |

## Price comparison (USD per year unless noted; all fetched 2026-09-29)

Prices are not like-for-like: rows differ between wholesale (eNom, GoDaddy reseller table, Internet.bs price list), list price of a self-serve registrar (AWS) and consumer retail (Vercel, GoDaddy v3 discounts). Registry price rises and promotions apply.

| TLD | eNom reseller, Essential tier (Enterprise tier) | GoDaddy API Reseller wholesale | AWS Route 53 (effective 2026-07-01; prior) | Internet.bs price list on test host (reg / renew) | Vercel public search (retail; 1st-yr / renewal) | GoDaddy public v3 discounted (reg / auto-renew) |
|---|---|---|---|---|---|---|
| .com | $14.50 ($11.50) | $10.69 | $16 (was $15) | $11.30 / $11.59 | $11.25 / $11.25 | $10.49 / $14.99 |
| .ai | $111 ($99) | not listed | $137 (was $129) | $92.40 / $100.80 (period basis not verified; min term 2Y per check API) | $160 for 2 years / $160 | $169.98 per 2 yr / $239.98 per 2 yr |
| .dev | $17 regular; $10 shown as sale ($14 ent.) | not listed | $17 | $12.17 / $14.27 | $13 / $13 | not in table |
| .io | $60 regular; $34 shown as sale ($57 ent.) | not listed | $71 | $49.98 / $51.24 | $14.99 / $46 | $30.00 / $69.99 |
| .app | $21 regular; $14 shown as sale ($18 ent.) | not listed | $20 | $14.78 / $15.71 | $14.99 / $15 | $9.49 / $19.99 |
| .studio | $42 ($36) | not listed | $44 (was $13) | $31.42 / $34.67 | $21.99 / $36 | not in table |

Notes on the table: eNom two-price cells like "$10.00$17.00" are read as sale price and regular price (interpretation; the page shows both numbers with no legend in text). Cloudflare, Spaceship and Squarespace wholesale prices were not obtainable (Cloudflare charges "exactly what the registry charges" but its public pages give no per-TLD table; the API docs only show illustrative example responses of $8.57 .com, $10.11 .dev, $11.00 .app, which do not match the .com registry price and should not be relied on).

---

## 1. Spaceship (spaceship.com; API docs at docs.spaceship.dev)

**Registers domains via public API: YES.**
- Register endpoint: "Register the domain ... Register a specific domain." `POST /v1/domains/{domain}`, required permission `domains:billing`, "The limit to register domains is 30 requests per user, within 30 seconds." Body needs `autoRenew`, `years` (1-10), `privacyProtection`, `contacts` (contact IDs created earlier via `PUT /contacts`). Returns 202 with a `spaceship-async-operationid` header to poll. (https://docs.spaceship.dev/, accessed 2026-09-29)
- Auth: "Spaceship API uses a combination of API key and API secret for authentication" via `X-API-Key` / `X-API-Secret`; keys are created in the API Manager. Permissions list includes `domains:read`, `domains:write`, `domains:transfer`, `domains:billing`, `contacts:*`, `dnsrecords:*`, `sellerhub:*`. Base URL shown: `https://spaceship.dev/api`. (same page)
- Payment: with `autoRenew` true "the domain will be automatically renewed using the account's default payment method"; registration draws on the account, so a reseller model would hold all domains in one Spaceship account and pay from it. (same page)
- Availability endpoint (`POST /v1/domains/available`, 20 names per call) returns `result` and only `premiumPricing`; **no standard-price field is documented**, so price lists must come from elsewhere. (same page)
- Extras seen: SellerHub (aftermarket/marketplace), SafePay, Hyperlift (app hosting) endpoints in the same API.

**Resale under own brand: UNCLEAR.** The Universal Terms, Domain Registration Agreement and any reseller program text live on www.spaceship.com/legal/*, which returned Cloudflare challenge pages (403) and could not be read. A search-engine snippet suggested the Domain Registration Agreement contains language for people who "engage in the reselling of domain names" (flow-down of privacy notices); this is an unverified lead only. No public reseller/wholesale program page was found in the API docs.

**Sandbox: none documented** (the docs mention no test host, sandbox key or test mode).

**TLDs: unverified** (Spaceship TLD/pricing pages blocked; the API docs do not enumerate TLDs).

**Deep dive: NO for now.** Reason: real API, but resale permission is unprovable, no sandbox, no wholesale program, no API price data. Revisit by reading the Universal Terms manually in a normal browser or emailing Spaceship.

Sources: https://docs.spaceship.dev/ (2026-09-29); https://www.spaceship.com/terms-of-service/ and /legal/* (403 challenge, 2026-09-29).

---

## 2. Cloudflare Registrar

**Registers domains via public API: YES, but beta and narrow.**
- "Cloudflare Registrar API is now in beta" (blog post dated April 15, 2026; the changelog page header shows "Apr 15, 2025", an apparent typo since the URL slug is `2026-04-15`). Blog: "search for domains, check availability, and register them programmatically." (https://blog.cloudflare.com/registrar-api-beta/, https://developers.cloudflare.com/changelog/product/registrar/, accessed 2026-09-29)
- Endpoints (Cloudflare API v4): `GET /accounts/{id}/registrar/domain-search`, `POST .../registrar/domain-check` (up to 20 names), `POST .../registrar/registrations` (201 or 202), status polling. Register "only requires `domain_name`"; a per-registration `contacts.registrant` can be passed inline; "The account's default payment method is charged automatically"; "Registrations are non-refundable once they complete successfully"; `auto_renew` defaults to false. (https://developers.cloudflare.com/registrar/registrar-api/, "Last updated Sep 16, 2026")
- Beta limitations, verbatim: "Renewals are not yet available through the API." "Transfers are not yet available through the API." "Contact updates are not yet available through the API." "Only a subset of supported Cloudflare Registrar extensions are available through the API beta." (same page)
- Source conflict on TLD coverage: the guide says a subset; the API reference says "This API supports programmatic registration for all extensions supported by the dashboard experience, with the following exceptions: `giving`, `mom`, `inc`, `lol`, `sh`, `link`, `cc`, `new`." (https://developers.cloudflare.com/api/resources/registrar/, fetched as markdown 2026-09-29). Premium names: "premium registration is not currently supported by this API."

**Resale under own brand: NO today.**
- Domain Registration Agreement (Effective August 20, 2026) sec. 6.1: "Registrant agrees to use Cloudflare's nameservers. REGISTRANT ACKNOWLEDGES AND AGREES THAT IT MAY NOT CHANGE THE NAMESERVERS ON THE REGISTRAR SERVICES, AND THAT IT MUST TRANSFER TO A THIRD-PARTY REGISTRAR IF IT WISHES TO CHANGE NAMESERVERS." The FAQ confirms: "No, all domains on Cloudflare Registrar use Cloudflare nameservers". (https://www.cloudflare.com/domain-registration-agreement/, https://developers.cloudflare.com/registrar/faq/index.md)
- DRA 1.3 makes the account holder the holder of record liable for third-party licensees and requires a pass-through agreement; 1.4 says Cloudflare itself resells sponsoring-registrar services for TLDs where it is not the registrar.
- Self-Serve Subscription Agreement (Last Updated September 12, 2025) sec. 2.2.1(a): "Unless otherwise expressly permitted in writing by Cloudflare, you will not ... rent, lease, loan, export, or sell access to the Services to any third party, or sign up for the Services on behalf of a third party". (https://www.cloudflare.com/terms/)
- No reseller/partner registrar program exists yet. Cloudflare says the API "is the first step toward a broader registrar-as-a-service offering. Development of that service is underway now, and we're aiming to launch it later this year." (blog, April 15, 2026; also Domain Name Wire, https://domainnamewire.com/2026/04/15/cloudflare-launches-domain-registration-api/ calls it "aka a reseller platform"). As of the Registrar API doc dated Sep 16, 2026 that product had not been announced there.

**Sandbox: none documented.**

**TLDs:** `https://domains.cloudflare.com/api/tlds` (rendered by cloudflare.com/domains) returned 431 TLDs including `com`, `ai`, `dev`, `io`, `app`, `studio` (verified in the JSON). Site copy: "over 430 top-level domains ... like .ai, .app and .dev". None of our six is in the API exclusion list.

**Pricing:** "at cost" ("only pay what is charged by registries and ICANN"), no public per-TLD table in the pages fetched.

**Deep dive: NO** (track the registrar-as-a-service launch; revisit if it ships with a reseller agreement, custom nameservers and renew/transfer APIs).

Sources: https://developers.cloudflare.com/registrar/registrar-api/; https://developers.cloudflare.com/api/resources/registrar/; https://blog.cloudflare.com/registrar-api-beta/; https://www.cloudflare.com/domain-registration-agreement/; https://www.cloudflare.com/terms/; https://developers.cloudflare.com/registrar/faq/index.md; https://domains.cloudflare.com/api/tlds (via Chromium). All accessed 2026-09-29.

---

## 3. GoDaddy (Reseller program + Domains API)

**Registers domains via public API: YES, in three shapes.**
1. **API Reseller plan** (Reseller Control Center, "sso-key" style API keys, reseller docs at reseller.godaddy.com/docs). The plan "lets you sell our products and services with your existing Web store ... you can maintain your unique branding and set your own prices ... you must first pass a certification test." (https://www.godaddy.com/help/what-is-an-api-reseller-plan-5939)
2. **Domains v3 API** (Bearer PAT; `POST /v3/domains/registration-quotes` then `POST /v3/domains/registrations` with `Idempotency-Key`). Its OpenAPI spec (https://developer.godaddy.com/openapi/domains-v3.json, v3.1.0) states: "Reseller on-behalf-of. Resellers pass `X-Shopper-Id`; all operations are then scoped to that shopper." and "Launch Scope (v3.0): Standard TLDs only. TLDs with eligibility requirements (.us, .ca, .eu) return `UNSUPPORTED_TLD` until Phase 2." An `iscCode` parameter applies "the applicable reseller rates for this ISC".
3. Legacy v1/v2 with `sso-key` ("scheduled for deprecation in 2026" per https://developer.godaddy.com/en/docs/api-users/domains).
- Public (non-reseller) v3 limits that matter: "v3 does not accept inline payment or registrant contact overrides. The billing method and registrant contact are resolved from the account profile." (https://developer.godaddy.com/en/docs/api-users/domains/register); rate limit "600 per ~23-minute window" per credential (subject to change, https://developer.godaddy.com/en/docs/api-users/rate-limits); "Use of the Domains API and domain purchases are subject to GoDaddy's API Terms of Use and API Domain Purchase Agreement." (https://developer.godaddy.com/en/docs/api-users/domains/pricing)

**Resale under own brand: CONDITIONAL (via API Reseller plan).**
- Turnkey vs API comparison: API Reseller "Can use GoDaddy APIs for buying domains: Yes"; "Sell Web Hosting: No"; "E-commerce transaction processing: No, You must set up your own payment processing"; "Your customers pay you directly and we deduct a fixed rate from a Good as Gold account"; "End-user customer support: No, You support your customers"; "API Reseller plans are available to select businesses who wish to partner with GoDaddy on this enterprise-level solution." (https://www.godaddy.com/help/how-do-api-reseller-and-turnkey-reseller-plans-differ-7940)
- Funding: "A Good as Gold account is required to purchase any products, such as a domain. This is currently the only way to fund your account." Wire funding; "To fund more than $2,000, you must pass Identity Verification". (https://www.godaddy.com/help/set-up-my-api-reseller-account-40137; https://developer.godaddy.com/en/docs/api-users/payment-profile)
- Support statement: "While we ensure GoDaddy APIs are working properly server-side, they are available for self-service use only." Not supported for API Reseller: "Selling GoDaddy products other than domains", "Setting prices for the reseller's products", "Renewing domains through CRM". (https://www.godaddy.com/help/statement-of-support-api-platform-41068)
- **UNVERIFIED:** the GoDaddy API Terms of Use and Reseller Agreement (godaddy.com/legal/agreements/godaddy-api-terms-of-use and /reseller-agreement) returned HTTP 403 "Access Denied" (Akamai) to curl and Chromium. A search snippet (not evidence) suggested the API Terms forbid reselling/providing the API to third parties without written authorization; the reseller program is the authorization path. Read the actual text before committing.

**Sandbox: YES.** "Use your test API key whenever you want to verify your content against our OTE/test environment (using the base URL https://api.ote-godaddy.com) ... The OTE/testing environment is for testing purposes only. It's pre-funded ..., but isn't connected to the live/production environment." (reseller setup page above). The v3 spec lists `ote-godaddy` as a server variable; the v3 docs recommend `api.ote-godaddy.com` "for paid or destructive tests" (https://developer.godaddy.com/en/docs/api-users/testing-with-llms).

**Wholesale pricing (API Reseller), verbatim table:** .ca $11.04, .co $24.99, .co.in $5.16, .co.uk $7.49, **.com $10.69**, .eu $6.49, .in $6.63, .mx $31.99, .net $16.29, .org $11.99, .us $10.29 (https://www.godaddy.com/help/wholesale-rates-for-api-resellers-40891; no page date). None of .ai/.dev/.io/.app/.studio is in that table. The public v3 pricing page shows discounted retail-style rates incl. .io $30.00 reg, .app $9.49, .ai $169.98 per 2 years ("`.ai` requires a 2-year minimum term"), but not .dev or .studio.

**TLDs:** .com yes (both). .ai/.io/.app appear in the v3 pricing table. .dev and .studio: not evidenced anywhere fetched. Whether the API Reseller plan can sell the other five: UNVERIFIED.

**Deep dive: YES.** Reasons: documented OTE, own-brand pricing, shopper sub-account model built for resellers, prepaid Good as Gold funding fits a flat-fee model. Open questions: acceptance criteria and fees for the "select businesses" plan, wholesale for .ai/.io/.dev/.app/.studio, the actual API Terms text, whether v3 `X-Shopper-Id` is available to Mosshatch.

Sources: URLs inline above; all accessed 2026-09-29.

---

## 4. AWS Route 53 Domains

**Registers domains via public API: YES.** "RegisterDomain: This operation registers a domain. For some top-level domains (TLDs), this operation requires extra parameters." It also "Creates a Route 53 hosted zone", "Enables auto renew", optionally privacy, and "Charges your AWS account an amount based on the top-level domain." Contacts (registrant/admin/tech/billing, `PrivacyProtect*`, `ExtraParams`) are per call. Service endpoint `route53domains.us-east-1.amazonaws.com`. Companion actions: `CheckDomainAvailability`, `GetDomainSuggestions`, `ListPrices`, `RenewDomain`, `TransferDomain`, `UpdateDomainContact`, `UpdateDomainNameservers`, `RetrieveDomainAuthCode`, `PushDomain`, `TransferDomainToAnotherAwsAccount`. (https://docs.aws.amazon.com/Route53/latest/APIReference/API_domains_RegisterDomain.html; https://docs.aws.amazon.com/Route53/latest/APIReference/API_Operations_Amazon_Route_53_Domains.html)

**Resale under own brand: YES, expressly.** Route 53 Domain Name Registration End User Agreement (Last Updated: September 1, 2026) sec. 3.12: "If you register the Registered Name on behalf of a third party by providing AWS with a third party's DNRS Data for the Registered Name, or otherwise permit a third party to be listed as the registrant in the WHOIS records of a domain name in your account, then (A) you will be considered a reseller as defined in the ICANN Registrar Accreditation Agreement, (B) the third party will be considered your customer, and (C) you agree to following terms:" then flow-downs: do not display ICANN logos or claim ICANN accreditation (3.12.1); your registration agreement must include RAA-required provisions and "identify the sponsoring registrar or provide a means for identifying the sponsoring registrar" (3.12.2); identify sponsoring registrar on inquiry (3.12.3); link ICANN registrant educational info and the Registrants' Benefits and Responsibilities (3.12.5-3.12.6); customer-data consent (3.12.7). (https://aws.amazon.com/route53/domain-registration-agreement/) The customer never needs an AWS account.

**Constraints:**
- Quota: "Domains: 20* per AWS account ... The limit is 20 for new customers as of March 2021" with "Request a higher quota". (https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DNSLimitations.html)
- "TLD registries have assigned special or premium prices to some domain names. You can't use Route 53 to register a domain that has a special or premium price." (https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/registrar-tld-list.html)
- "We do not currently offer volume discount pricing for domain registrations"; promo credits cannot pay for domains (https://aws.amazon.com/route53/pricing/).
- Registering creates a hosted zone (normal Route 53 hosted-zone fee applies; $0.50/zone/month for the first 25 per the pricing page).

**Sandbox: none documented** (docs for RegisterDomain and the developer guide mention no test mode; testing means real charges).

**TLDs: all six.** gTLD list includes .app, .com, .dev, .io (also in the ccTLD list as British Indian Ocean Territory), .studio; ccTLD list includes .ai (Anguilla) and .io. (https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/registrar-tld-list.html)

**Pricing (official PDF, https://d32ze2gidvkk54.cloudfront.net/Amazon_Route_53_Domain_Registration_Pricing_20140731.pdf):** "Important: starting on July 1, 2026, we will update prices for new domain registrations, renewals, and transfers for the TLDs listed in 'Updated Pricing' table." Registration and renewal per year, new (prior): .com $16 ($15); .ai $137 ($129); .studio $44 ($13); .dev $17; .app $20; .io $71 (the last three are not in the Updated table so unchanged). Transfer: .ai $274 new ($258 prior, renewed for 2 years with transfer). Restoration prices differ ($240 for .ai, $133 .io, $71 .dev/.app, $57 .com/.studio in the "Current" table).

**Deep dive: YES.** Reasons: self-serve on day one with explicit reseller wording in the agreement (eNom is also self-serve but needs paid enrollment and a static IP), a documented full-lifecycle API, per-call registrant contacts and no approval gate. Costs: no wholesale discount, high .ai/.io, no sandbox, AWS quota raise needed.

Sources: as linked; accessed 2026-09-29.

---

## 5. Vercel Domains

**Registers domains via public API: YES.** "Programmatic Domain Management": search, pricing, purchase, renew, transfer, nameservers (https://vercel.com/docs/domains/registrar-api, "Last updated September 22, 2026"). `POST https://api.vercel.com/v1/registrar/domains/{domain}/buy` takes `autoRenew`, `years`, `expectedPrice`, and a per-call `contactInformation` object (https://vercel.com/docs/rest-api/domains-registrar/buy-a-domain). Search, TLD catalog and pricing endpoints are public: "You can search domains, check pricing and availability, and browse supported top-level domains (TLDs) without an account or access token."

**Live check (public `POST /v1/registrar/domains/search`, 2026-09-29 19:15 UTC):** all six TLDs returned `available: true` for a probe name with prices: .com 11.25/11.25; .ai 160 for `years: 2` (renewal 160); .dev 13/13; .io 14.99/46; .app 14.99/15; .studio 21.99/36. Raw JSON in `others/vc_search.json`.

**Resale under own brand: NO.** Vercel Terms of Service (Last Updated June 1, 2026), sec. 11 Usage Restrictions: "You will not, directly or indirectly: (i) sublicense, resell, rent, lease, transfer, assign, or otherwise commercially exploit or make the Services available to any third party; ... (iv) use the Services for timesharing or service bureau purposes or otherwise for the benefit of a third-party". (https://vercel.com/legal/terms) The Domain Name Registration and Services Terms (Last Updated September 17, 2025) say Vercel provides registration "through sponsoring registrars. Vercel currently provides Registration Services through Name.com, Inc and Tucows Domains Inc." (https://vercel.com/legal/domain-name-registration-and-services-terms) That means Vercel is itself a reseller; Mosshatch would be a reseller of a reseller. I found no Vercel domain partner/reseller program.

**Sandbox: none documented.** **Payment:** the team's payment method; "All fees are non-refundable".

**Practical note:** Vercel Static IPs ("available on Enterprise and Pro plans", "$100 /month per project, plus Private Data Transfer") matter for any registrar that requires an IP allow-list (eNom). (https://vercel.com/docs/networking/static-ips)

**Deep dive: NO.** Reason: explicit resale/service-bureau prohibition and no partner program; the same upstreams (Name.com, Tucows/OpenSRS) can be contracted directly.

Sources: as linked; accessed 2026-09-29.

---

## 6. Squarespace Domains (formerly Google Domains)

**Registers domains via public API: YES, gated.** The reseller FAQ: "The registration will be connected to SQSP Registrar via API and will happen in real time. No manual intervention is required." Squarespace's Developer Tools list (Last updated August 27, 2026) includes "Domains Search API", "Domains Management API" and "Reseller API", and notes "some are invite-only". (https://reseller.squarespace.com/faq; https://support.squarespace.com/hc/en-us/articles/41325887099533-Developer-Tools-APIs-at-Squarespace, rendered with Chromium). Actual API documentation, security questionnaire and technical implementation guide are behind a partner gate (`/api-documentation` returned HTTP 401; `/additional-documentation` lists "Reseller API Technical Overview", "SQSP Reseller Security Questionnaire", "Reseller Technical Implementation Guide").

**Resale under own brand: CONDITIONAL.** "Resellers must be approved through a formal partnership agreement with Squarespace. The partnership onboarding process includes thorough vetting for security and technical capabilities" (https://reseller.squarespace.com/). "Contact our team to apply ... you'll own the billing relationship with your customer for as long as the domain subscription remains active" (help center article "How can I become a reseller for Squarespace domains?", last updated July 29, 2025). Billing: "the Reseller partner will collect the price of the domain ... At the end of each month, both parties will review the total registered domains via the API, and the Reseller will remit payment to Squarespace for the negotiated wholesale rate per domain sold." Price control: "Set your own pricing"; bundling "still require[s] a negotiated wholesale price per domain."

**Structural friction:** "Upon completion of the transaction with the Reseller, the domain is officially registered. The customer is then directed to Squarespace to login and manage their domain on Squarespace." and "your customer can log into Squarespace to manage Whois privacy, DNS records, and other domain settings." (FAQ and help article). Customers can point the domain at any host. Whether Mosshatch can manage NS/DNS on the customer's behalf through the Domains Management API is unverified.

**Sandbox: unclear** (docs gated; a public "Reseller API Status" page exists at status-resellerapi.squarespace.com, not fetched).

**TLDs:** Reseller site: "over 400+ top-level domains". Consumer TLD list (Last updated July 30, 2026, https://support.squarespace.com/hc/articles/206541907-Domain-TLD-list) shows .ai (2 to 10 years; "The minimum duration for registration and renewals is 2 years. It's not currently possible to transfer .ai domains to Squarespace."), .app, .com, .dev, .io ("Premium domains are available for registration"), .studio (1 to 10). Reseller-specific TLD list (`/legal/retailprices`) was 401.

**Wholesale price:** not public ("negotiated").

**Deep dive: YES, low priority.** One sales contact settles gating, price and whether customers can be kept off the Squarespace login. Fit risk: management surface stays with Squarespace.

Sources: as linked; accessed 2026-09-29.

---

## 7. Internet.bs (InternetBS)

**Registers domains via public API: YES (reseller/registrar API).** The vendor's API documentation page (internetbs.net/ResellerRegistrarDomainNameAPI) and terms are Cloudflare-blocked from here. Evidence obtained: the vendor's test host answers live API calls: `https://testapi.internet.bs/Domain/Check?...` with the published test credentials returned `{"status":"AVAILABLE", "realtimeregistration":"YES", ...}` for .com/.ai/.io. WHMCS lists an Internet.bs registrar module with Register/Transfer/Renew/Nameserver/EPP/DNS ticked and "Test Mode ... simulate domain registration ... without incurring charges" (https://docs.whmcs.com/9-0/domains/domain-registrar-modules/internet-bs/, last modified 2026 August 4). The Domain/Create call itself was not exercised.

**Resale: UNCLEAR** (terms unreadable). The product is marketed as a "Reseller/Registrar Domain Name API" (per third-party listings; the vendor page was blocked). No reseller agreement text obtained.

**Sandbox: YES (verified live).** `https://testapi.internet.bs/` (production is `https://api.internet.bs/`), credentials `ApiKey=testapi`, `Password=testpass` were accepted 2026-09-29.

**TLDs (test host):**
- Availability check returned AVAILABLE for .com, .ai (`minregperiod` 2Y) and .io.
- For `.dev`, `.app`, `.studio` names the same call returned `{"status":"FAILURE","message":"Unexpected ERROR: Tech department has been notified!","code":107015}` on every attempt (10 calls across two different probe names). `example.dev` returned UNAVAILABLE with price detail. Cause unverified (sandbox limitation vs registry connectivity vs unsupported).
- The test host's `Account/PriceList/Get` (1,968 product lines) contains registration/renewal prices for all six (see price table): .com 11.30/11.59, .ai 92.40/100.80, .dev 12.17/14.27, .io 49.98/51.24, .app 14.78/15.71, .studio 31.42/34.67. Whether this is the public retail list or a reseller wholesale list is not stated.

**Deep dive: YES.** Reasons: only route with a working public sandbox I could exercise and the lowest sampled prices. Needs a manual read of the API docs and reseller/registration agreements, an answer on .dev/.app/.studio, and confirmation of IP-restriction rules.

Sources: https://testapi.internet.bs/ (live, 2026-09-29); https://docs.whmcs.com/9-0/domains/domain-registrar-modules/internet-bs/; internetbs.net pages (403, 2026-09-29).

---

## 8. eNom and Hover (Tucows)

### eNom
**Registers domains via public API: YES.** "Build what you want with 300+ commands" (https://www.enom.com/reseller/api/); developer hub https://api.enom.com/docs (llms.txt index). `Purchase` command: "purchase a domain name or premium domain in real time" with `UID`, API token, `SLD`, `TLD`, `EndUserIP` and per-call registrant details; `AddToCart`/`InsertNewOrder`, `Extend`, `SetHosts`, `ModifyNS`, `GetTLDDetails`, `SetResellerTLDPricing`, `CreateAccount`/sub-accounts all exist. (https://api.enom.com/docs/purchase.md; command list at https://api.enom.com/docs/api-test-account)

**Resale under own brand: YES.** Homepage: "Enom makes it easy to become a domain name reseller. With competitive pricing and a white-label platform, you can grow your business". Reseller Agreement: "Enom grants You a non-exclusive, non-transferable license to resell the Services worldwide."; you may authorize Sub-Resellers; "You are responsible for providing customer service, billing, and technical support to Your customers"; "You shall not branch or otherwise prepare derivatives of the API."; your registration agreement must "identify Enom as the sponsoring registrar or provide a means for identifying the sponsoring registrar" and authorize Enom as Designated Agent for Change of Registrant; publish your own pricing page. (https://www.enom.com/reseller/legal-policy-agreements/reseller-agreement/)

**Hostile or costly points:**
- "In order to use Enom's API, you must have your IP address authenticated for use." Static outbound IP required, live and test (https://api.enom.com/docs/live-api-access). On Vercel, that means Static IPs ($100/month/project) or a proxy.
- "convenience fee ... (currently set at 5%, subject to change ...)" on Points bought by card/PayPal; checks and wires have no extra charge (Reseller Agreement, "Points, Payments, and Commissions").
- "All resellers can sell domain names that are available at the Registry, but only our direct ETP (Enom Technology Partner) resellers can sell Premium Domains." (Purchase doc)
- Enrollment: "One-time enrollment fee $195 $50" (struck-through price shown; treat $50 as current promo), "You'll automatically be placed in the Essential tier"; tiers by annual spend: Advanced $2,000 / 100 regs, Premium $50,000 / 500, Enterprise $100,000 / 1,000. (https://www.enom.com/reseller/domain-name-reseller-pricing-plans/, rendered with Chromium)
- RSA term: one year, auto-renewing, terminable on 30 days notice; Enom "may terminate immediately" for non-compliance.
- Approval/vetting criteria for joining: not stated ("Join Today"); unverified.

**Sandbox: YES.** "You need an active Enom.com reseller account in order to create an API Test Account." Test URL https://resellertest.enom.com vs live https://reseller.enom.com; test balance can be reset to $5,000; "any domains registered or services purchased in your test account WILL NOT be automatically provisioned." (https://api.enom.com/docs/api-test-account)

**TLDs and wholesale (Essential tier / Enterprise tier), read from the reseller price table (585 TLDs):** .COM $14.50/$11.50; .AI $111/$99; .DEV $10.00 sale, $17.00 regular ($14.00 ent.); .IO $34.00 sale, $60.00 regular ($57.00 ent.); .APP $14.00 sale, $21.00 regular ($18.00 ent.); .STUDIO $42/$36. Site copy: "550+ TLDs". All six present.

**Deep dive: YES (lead candidate).**

### Hover
**Registers domains via public API: NO.** Hover is Tucows' consumer brand ("Hover is a service provided by Tucows", https://www.hover.com/tos). No Hover API documentation was found (hover.com/api is a 404). eNom's own homepage sends non-resellers to Hover: "You don't need to sign up as a reseller. Meet Hover, our domain registration platform for people like you."
**Hover Connect** is a co-branded landing-page/voucher referral program, not resale: "You provide Hover the DNS settings ... Hover will create a co-branded 'Your brand + Hover' landing page ... Hover will fully manage your customers' domains" (https://www.enom.com/hover-connect/). Hover's "Resell" page routes to OpenSRS Storefront/Control Panel: "Powered by Tucows, the world's largest wholesale domain registrar." (https://www.hover.com/resell-domains)
**Sandbox:** n/a. **Deep dive: NO** (use eNom or OpenSRS instead).

Sources: as linked; accessed 2026-09-29.

---

## 9. Epik

**Registers domains via public API: UNCLEAR.** Epik's API documentation host `docs.userapi.epik.com:443` is **blocked by the egress policy**, and epik.com (home, /reseller/, /api/, /terms-of-service) plus `usersapiv2.epik.com`, `api.epik.com` and `registrar.epik.com` returned HTTP 403 Cloudflare blocks. Third-party evidence only: the go-acme/lego project's Epik DNS provider calls `https://usersapiv2.epik.com/v2` using a "signature" credential and cites docs anchors for "DNS Host Records" (getDnsRecord/createHostRecord) (https://raw.githubusercontent.com/go-acme/lego/master/providers/dns/epik/internal/client.go). That shows a DNS-record API exists; it does not show registration.
**Resale: unclear. Sandbox: unclear. TLDs: unverified.**
**Deep dive: NO** (cannot be evaluated; only revisit with a browser session that can read the docs).

---

## 10. Own accreditation path (long-run alternative, not the launch plan)

**ICANN side (all from icann.org, accessed 2026-09-29).**
- Process page: apply via the Naming Services portal after submitting a Registrar Applicant Contact Credentialing form; "Applicants will receive a response from ICANN within thirty (30) days of receipt of the completed application form"; the applicant must give ICANN access to personnel/records "within fourteen (14) calendar days of ICANN's request"; "Applicants have one year from the date ICANN confirms receipt of the application to complete the ICANN application review process". (https://www.icann.org/en/contracted-parties/accredited-registrars/how-to-become-a-registrar/registrar-application; instructions at .../registrar-application-instructions)
- Fees: "US$3,500 application fee, which is non-refundable regardless of whether the application is approved, denied, or withdrawn"; "US$4,000 yearly accreditation fee due upon approval and each year thereafter"; a quarterly variable fee; a per-transaction gTLD fee on each new registration, renewal or transfer (amount not stated on the page; unverified). (https://www.icann.org/en/contracted-parties/accredited-registrars/registrar-accreditation-agreement/registrar-accreditation-financial-considerations-25-02-2012-en)
- Financial instruments: applicants must show "adequate working capital"; "liquid capital immediately available in the applicant's name ... in an amount of US$70,000 or more will be deemed adequate", evidenced by an externally verified document such as a guaranteed bank loan, credit line or letter of credit; lower amounts accepted with justification. An applicant with a business older than 24 months or converting a reseller business "must provide ... an independently verified financial statement". (same page)
- Insurance: RAA sec. 3.10 requires commercial general liability of at least US$500,000, but the RAA header notes it "was waived by the ICANN Board of Directors, effective 28 September 2015". (https://www.icann.org/en/system/files/files/registrar-accreditation-agreement-21jan24-en.htm)
- Post-approval steps: sign the RAA (2013 RAA as updated 21 January 2024; 2024 global amendment effective 5 April 2024), term "five (5) years"; sign a Registrar Data Escrow agreement (escrow agent at your own cost, RAA 3.6); prepare a compliant registration agreement; "work out the contract, financial, and technical details with the registry operators"; go live "after you pass the testing process". (https://www.icann.org/en/contracted-parties/accredited-registrars/how-to-become-a-registrar)
- Ongoing technical/compliance duties visible in the RAA: RDAP directory service, WHOIS/RDDS during the sunset period, abuse contact and duty to investigate, data retention (3.4), reseller flow-downs (3.12), website publication duties (3.16-3.18). Application questions probe security, business-continuity data transfer plan, escrow, staffing ("fewer than five employees may be adequate ...").
- Cash floor at ICANN alone: US$3,500 + US$4,000 = US$7,500 up front, plus variable/transaction fees, escrow agent, and the US$70,000 capital evidence.

**Registry side (per TLD, each a separate contract/OT&E; no primary source gives end-to-end duration, so calendar time is UNVERIFIED beyond ICANN's 30-day/1-year bounds).**
- **.com (Verisign):** Step 1 is "Obtain ICANN Accreditation"; then "Establish a Contractual Relationship", "Meet Technical Requirements", "Complete Financial Requirements". "Verisign requires registrars to establish a payment security based on expected monthly registration volume"; "Registrars must demonstrate full and correct operation of their systems within the Operational Test and Evaluation environment before connecting to Verisign's Shared Registration System." (https://www.verisign.com/resources/become-a-registrar/)
- **.studio (Dog Beach, LLC c/o Identity Digital) and .dev/.app (Charleston Road Registry / Google Registry):** IANA records confirm the operators (https://www.iana.org/domains/root/db/studio.html, .../dev.html, .../app.html). Identity Digital's site routes registrar enquiries to a contact form; Google Registry's registrar onboarding pages sit behind a Google sign-in (not readable). Terms and fees unverified.
- **.ai (ccTLD):** IANA manager is the Government of Anguilla; the operator site nic.ai (©2025 Identity Digital Inc.) says: "Become an .ai accredited registrar in 4 easy steps and go live. 01 Complete the onboarding documents 02 Receive an email with access instructions 03 Set up contacts for your account 04 Fund your account. Contact techsupport@identity.digital to get started." The page does not say ICANN accreditation is required (ccTLDs sit outside ICANN registrar contracts; Verisign says of its .cc ccTLD that it "does not require registrars to be ICANN-accredited"), but for .ai this is not stated. Fees/prefunding amounts unverified. (https://www.iana.org/domains/root/db/ai.html, https://www.nic.ai/)
- **.io (ccTLD):** IANA manager: Internet Computer Bureau Limited (record last updated 2023-01-18). nic.io shows "Registrar services powered by Name.com" and no accreditation instructions; the .io registrar route is UNVERIFIED (rdap.nic.io was blocked by egress; the .io delegation and UK/Chagos developments were not researched here).

**Bottom line for the plan:** accreditation is a five-figure-USD, months-long, compliance-heavy project (application + annual fees + capital evidence + escrow + RDAP + per-registry contracts and testing). It removes the reseller dependency but adds RAA duties and registry deposits, and .ai/.io need separate ccTLD agreements. Keep as a post-launch option once volume justifies it.

---

## Findings on "reseller-hostile" clauses (quote index)

| Provider | Clause | Effect on Mosshatch |
|---|---|---|
| Cloudflare | DRA 6.1 forced Cloudflare nameservers; SSA 2.2.1(a) no selling access / signing up on behalf of third party | Blocks resale and custom NS |
| Vercel | ToS 11(i) "resell ... or otherwise commercially exploit or make the Services available to any third party"; 11(iv) service-bureau | Blocks resale |
| GoDaddy | API Reseller sold to "select businesses"; API Terms text unread | Approval gate; unknown contents |
| GoDaddy v3 public | "does not accept inline payment or registrant contact overrides" | Cannot set per-customer registrant without reseller mode |
| Squarespace | Approval + gated docs; customer manages at Squarespace | Weak white-label |
| eNom | Static IP allow-list; 5% card fee on Points; premium names only for ETP | Operational friction, no prohibition |
| AWS | 20-domain quota; no premium; reseller flow-down duties | Manageable |
| Hover | No API; referral-only partner program | Not a supply route |

## UNVERIFIED (consolidated)

1. Spaceship: Universal Terms / Domain Registration Agreement text, any reseller program, TLD list and prices, sandbox (only "none documented").
2. GoDaddy: API Terms of Use and Reseller Agreement text (403); API Reseller acceptance criteria/fees; wholesale for .ai/.io/.dev/.app/.studio; whether v3 `X-Shopper-Id` is open to non-reseller accounts.
3. Squarespace: API docs, reseller agreement, wholesale prices, TLD list for resellers, sandbox, availability of Domains Management API for third-party NS/DNS control.
4. Internet.bs: official API docs, reseller terms, IP-restriction rules; cause of .dev/.app/.studio errors on the test host; whether the price list is wholesale or retail; .ai price period basis.
5. Epik: everything (API scope, terms, TLDs, sandbox).
6. Cloudflare: per-TLD at-cost prices; whether the registrar-as-a-service product launched after 2026-09-16 (search budget exhausted, no news check possible beyond the docs).
7. eNom: reseller approval/vetting criteria; whether the $50 enrollment price is a time-limited promo; any minimum spend rules outside the tier table.
8. ICANN: current per-transaction gTLD fee amount; end-to-end accreditation calendar time; registry fees and agreements for Identity Digital, Google Registry, .ai and .io registrar onboarding.
9. Vercel and AWS: absence of a sandbox is "none documented", not proof of none.

## Source list (all accessed 2026-09-29 unless noted)

- Spaceship API: https://docs.spaceship.dev/
- Cloudflare: https://developers.cloudflare.com/registrar/registrar-api/ ; https://developers.cloudflare.com/api/resources/registrar/ ; https://blog.cloudflare.com/registrar-api-beta/ ; https://www.cloudflare.com/domain-registration-agreement/ ; https://www.cloudflare.com/terms/ ; https://developers.cloudflare.com/registrar/faq/index.md ; https://www.cloudflare.com/domains/ (TLD JSON at https://domains.cloudflare.com/api/tlds)
- GoDaddy: https://developer.godaddy.com/en/docs/api-users/domains ; .../domains/register ; .../domains/pricing ; .../payment-profile ; .../rate-limits ; https://developer.godaddy.com/openapi/domains-v3.json ; https://www.godaddy.com/help/what-is-an-api-reseller-plan-5939 ; .../set-up-my-api-reseller-account-40137 ; .../wholesale-rates-for-api-resellers-40891 ; .../how-do-api-reseller-and-turnkey-reseller-plans-differ-7940 ; .../statement-of-support-api-platform-41068
- AWS: https://docs.aws.amazon.com/Route53/latest/APIReference/API_domains_RegisterDomain.html ; https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/registrar-tld-list.html ; https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DNSLimitations.html ; https://aws.amazon.com/route53/domain-registration-agreement/ ; https://aws.amazon.com/route53/pricing/ ; https://d32ze2gidvkk54.cloudfront.net/Amazon_Route_53_Domain_Registration_Pricing_20140731.pdf
- Vercel: https://vercel.com/docs/domains/registrar-api ; https://vercel.com/docs/rest-api/domains-registrar/buy-a-domain ; https://vercel.com/legal/terms ; https://vercel.com/legal/domain-name-registration-and-services-terms ; https://vercel.com/docs/networking/static-ips ; live POST https://api.vercel.com/v1/registrar/domains/search
- Squarespace: https://reseller.squarespace.com/ ; https://reseller.squarespace.com/faq ; https://reseller.squarespace.com/additional-documentation ; https://support.squarespace.com/hc/en-us/articles/29268011160205-How-can-I-become-a-reseller-for-Squarespace-domains ; https://support.squarespace.com/hc/en-us/articles/41325887099533-Developer-Tools-APIs-at-Squarespace ; https://support.squarespace.com/hc/articles/206541907-Domain-TLD-list
- Internet.bs: https://testapi.internet.bs/ (live calls) ; https://docs.whmcs.com/9-0/domains/domain-registrar-modules/internet-bs/
- eNom/Hover: https://www.enom.com/ ; https://www.enom.com/reseller/api/ ; https://api.enom.com/docs/api-test-account ; https://api.enom.com/docs/live-api-access ; https://api.enom.com/docs/purchase.md ; https://www.enom.com/reseller/domain-name-reseller-pricing-plans/ ; https://www.enom.com/reseller/legal-policy-agreements/reseller-agreement/ ; https://www.enom.com/hover-connect/ ; https://www.hover.com/resell-domains ; https://www.hover.com/tos
- Epik: https://raw.githubusercontent.com/go-acme/lego/master/providers/dns/epik/internal/client.go (third-party)
- ICANN / registries: https://www.icann.org/en/contracted-parties/accredited-registrars/how-to-become-a-registrar ; .../how-to-become-a-registrar/registrar-application ; .../registrar-application-instructions ; .../registrar-accreditation-agreement/registrar-accreditation-financial-considerations-25-02-2012-en ; https://www.icann.org/en/system/files/files/registrar-accreditation-agreement-21jan24-en.htm ; https://www.verisign.com/resources/become-a-registrar/ ; https://www.nic.ai/ ; https://nic.io/ ; https://www.iana.org/domains/root/db/{ai,io,dev,app,studio,com}.html
