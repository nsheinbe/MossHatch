# Verification notes: reg-namecom, TECH / PRICING lens

Verifier run: 2026-09-29, about 20:10-20:35 UTC. Raw re-fetches in:
working-directory/research/nc-vt2/
Dossier under test: working-directory/research/reg-namecom.md

## Method (independent of the analyst's saved files)

- I did not open the analyst's `namecom/` working folder. Everything below was re-fetched by me with curl (browser UA, pre-configured proxy, no TLS bypass).
- OpenAPI: https://docs.name.com/api/v1/namecom.api.yaml (741,194 bytes, `info.version: 1.34.0`), parsed with PyYAML so I could enumerate operations, response codes, headers and schemas rather than rely on prose.
- Docs pages: https://docs.name.com/llms.txt index, then each guide/reference as `.md`: api/v1/overview, api/v1/changelog, guides/{testing-environment, getting-started, authentication, quickstart, domain-pricing, domain-renewals-expiration, external-transfers-flow, domain-locks, funding-your-namecom-account, hmac-examples, migration-guide, quickstart-recommended-tlds}, resources/faq, and reference pages for create-domain, get-domain, update-a-domain, get-auth-code, renew-domain, create-transfer, get-transfer, cancel-external-transfer-out, dns/*, tld-price-list, webhook overview.
- Prices: https://www.name.com/pricing page fetched (cookie jar) and its XHR feed https://www.name.com/ajax/pricing/?duration={1,2}&tlds=com,ai,io,dev,app,studio re-fetched at 2026-09-29 20:16 UTC. The feed returns HTTP 400 "error authorizing your request" without the page's `csrf-token` meta value sent as header `x-csrf-token-auth` plus the session cookie; with both it returns 200. Cross-check: CMS JSON https://www.name.com/api/ssr/sanity-document?type=tldLandingPage&slug={com,ai,io,dev,app,studio}.
- Contract text (only what I needed for price basis): https://www.name.com/_nuxt/DG18NICY.js (RSA), https://www.name.com/_nuxt/BlG9FYeC.js (Reseller Pricing Program), https://www.name.com/_nuxt/DffIiKU_.js (API Access Agreement), https://www.name.com/_nuxt/DG3_37Xa.js (Refund Policy).
- Live host checks: `curl https://api.dev.name.com/core/v1/hello` and `https://api.name.com/core/v1/hello` (no credentials): both HTTP/2 401 `{"message":"Unauthorized"}` with header `api-version: Reseller-1.34.0:...`.
- Status: https://status.name.com/api/v2/incidents.json and /scheduled-maintenances/upcoming.json.
- SDK: `npm view @namecom/core-api`.
- Limits of this run: no Name.com credentials, so nothing behind authentication (per-TLD `allowedRegistrationYears`, `expirationGracePeriod`, `supportsPrivacy`, real `tldpricing` account-level numbers, sandbox TLD list) could be checked. WebSearch budget for the session is exhausted (200/200), so no third-party sources. The Cloudflare-protected pages were not worked around (none needed).

## Headline

The analyst's API coverage table is accurate against the OpenAPI and docs. I found no outright refutation of a load-bearing coverage claim. I found five items to correct or tighten:

1. DNS "duplicates return 409" is only supported for Update (changelog 1.6.0); the OpenAPI lists no 409 on Create Record or Update Record, and create-duplicate behaviour is undocumented.
2. Transfer-in "refundable until completed" is the Refund Policy wording; the API cancel endpoint is narrower: cancelable only in `pending`, `submitting_transfer`, `pending_new_auth_code`, `pending_unlock`, `pending_registry_unlock`, `rejected`; NOT cancelable in `pending_transfer`, `pending_insert`, `completed`, `failed`, `canceled`, `canceled_pending_refund`. Also the "409 under 60 days" is from changelog 1.9.3, not the OpenAPI (whose 409 text is generic).
3. Reseller Pricing Program: the analyst missed that the enrolment "Qualifying Total" is trailing-365-day spend PLUS account credit balance at enrolment, that threshold changes carry 30 days notice (only "other terms" change without notice), and that the terms say a member gets "the lower of promotional pricing or Program Discounts".
4. The "multi-year feed values look inconsistent" note is mostly wrong: 2-year totals are exactly promo year 1 + list year 2 for .com/.io/.dev/.app/.studio.
5. The promo-price question is narrower than "unverified": the TLD Price List doc defines account-level price to include "rebates, promotions" and retail price to include "public rebates or promotions"; "promo codes" (a different thing) are excluded. So the docs imply an API account without account-level pricing is quoted the promo price (e.g. .com 12.99). Whether the order is actually charged that is still unverifiable without credentials.

## A. API coverage rows

A1. startTransferIn. CORRECTED (partly).
- Confirmed: `POST /core/v1/transfers`, body `domainName` + `authCode` required, `privacyEnabled`, `purchasePrice` optional (OpenAPI CreateTransferRequest). 402 "insufficient account credit" documented. Premium: `purchasePrice` must equal Get Pricing `transferPrice` or 400 "Invalid Price" (domain-pricing guide). `GET /core/v1/transfers/eligibility/{domainName}` exists (changelog 1.27.0). `POST /core/v1/transfers/internal/in` restricted to "approved enterprise resellers" (changelog 1.24.0).
- 409 for domains registered under 60 days: the OpenAPI 409 text is only "The status of the domain indicates that we are unable to process a transfer for it." The 60-day statement is changelog 1.9.3 (2025-10-27) "Block transfers for domains registered less than 60 days; returns 409" and 1.0.1 "A transfer is already processing for this domain". Supported, but from the changelog.
- "Fee charged at submission": not stated in the endpoint text. It is inferred from the 402-at-create and the cancel text "The price of the transfer will refund the amount to account credit".
- Correction: Cancel External Transfer In (`POST /core/v1/transfers/{domainName}:cancel`) is only possible in pending, submitting_transfer, pending_new_auth_code, pending_unlock, pending_registry_unlock, rejected. Non-cancelable: pending_transfer, pending_insert, completed, failed, canceled, canceled_pending_refund. The dossier's lifecycle line that transfers are "refundable as long as the transfer has not completed" is the Refund Policy sentence (verified in DG3_37Xa.js: "Transfers are refundable as long as the transfer has not completed"), but the API cannot cancel once the transfer is pending at the registry.

A2. getTransfer. CONFIRMED.
- `GET /core/v1/transfers/{domainName}` and `GET /core/v1/transfers`. OpenAPI `TransferStatus` enum has exactly 12 values: canceled, canceled_pending_refund, completed, failed, pending, pending_insert, pending_new_auth_code, pending_registry_unlock, pending_transfer, pending_unlock, rejected, submitting_transfer. Terminal set in the description: completed, failed, canceled, canceled_pending_refund; `rejected` listed non-terminal. Changelog 1.16.1: `failed` and `rejected` "will not be retried"; rejected transfer-ins can now be cancelled. Webhook `domain.transfer.status_change` exists (transfer IN only).

A3. getAuthCode. CONFIRMED, and one "unverified" item is partly resolved.
- `GET /core/v1/domains/{domainName}:getAuthCode`; 406 "We were unable to retrieve an auth code for the domain". Returned in the response body.
- The endpoint description says: "Locks may exist on a domain that can prevent the initiation of a transfer request, despite an auth code being returned by the API." So the docs indicate a code can be returned while locked; the lock blocks the gaining registrar's request. Whether it is returned specifically during the 60-day lock is still not stated by name.

A4. startTransferOut. CONFIRMED (no initiate endpoint).
- External Transfers Flow: "The name.com Core API does not initiate transfer-out requests; those are started by the gaining registrar". API offers unlock (PATCH locked:false), getAuthCode, `POST /core/v1/transfers/external/out/{domainName}:cancel` (changelog 1.22.0), webhook `domain.transfer_out.status_change` with `initiated|completed|canceled` (OpenAPI enum). Cancel responses: 409 not pending-out, 422 TLD does not support cancelling via EPP reject ("Pending outbound transfers expire if they are not completed within the registry policy timeframe"), 502 registry rejected the cancel. The 422 case is not in the dossier.

A5. setLock. CONFIRMED.
- `PATCH /core/v1/domains/{domainName}` body must contain at least one of `autorenewEnabled`, `privacyEnabled`, `locked`. 403 "domain ... has expired"; 409 "not all domains can be locked by the registrar" or no WHOIS privacy available. `:lock`/`:unlock` marked deprecated ("will be removed in a future release"). `transferLockExpiresAt` (changelog 1.29.0) "blocks client unlock via the API until this time". PrivacyLock: "cannot be managed via the API" (domain-locks guide). TLD field `supportsTransferLock` exists in `ResellerTldInfo`.
- Not documented: which status code/message an unlock attempt gets while `transferLockExpiresAt` is in the future (only the generic 409).

A6. DNS record CRUD. CORRECTED (one detail).
- Confirmed: Record.type "A, AAAA, ANAME, CNAME, MX, NS, SRV, or TXT" (no CAA); "name.com allows a minimum TTL of 300"; List Records perPage default 500; PUT "is a full overwrite - all required fields (host, type, answer, ttl) must be included"; DELETE by numeric id returns 204; no idempotency header on any DNS op; no upsert/replace-all endpoint.
- Not confirmed as stated: "duplicates return 409". Changelog 1.6.0 (2025-09-24): "DNS Record Update: Duplicate record DB errors now return 409 Conflict". The OpenAPI response lists for `POST .../records` and `PUT .../records/{id}` contain no 409 at all (400, 401, 403, 404, 405, 415, 429, 5xx). So: 409 on update-duplicate is changelog-only; create-duplicate is undocumented.
- Extra detail: SRV answer format is "{weight} {port} {target}" with `priority` separate; apex host is "" or "@".

A7. getDomain (registry status codes). CONFIRMED as "partial", with a vocabulary caveat the analyst missed.
- Domain object has `locked` (transfer lock only), `locks[]`, `transferLockExpiresAt`, `privacyEnabled`, `nameservers`, `autorenewEnabled`, `expireDate`, `renewalPrice`, `contacts`. There is no status/redemptionPeriod/pendingDelete field anywhere in the schema (grep for redemption|pendingDelete in the 741 KB spec: zero hits). The only "redemption" text in the docs is the renewals guide (UI only).
- Caveat: the `locks[]` vocabulary is inconsistent across the docs. OpenAPI example: `["clientTransferProhibited","clientHold"]` (EPP style). Changelog 1.20.0: "lock types ... (e.g. RegistrarLock, ClientHold, ExpirationClientHold)". Webhook `domain.lock.status_change` has both `lockType` (RegistrarLock, TransferLock, AccountLock, ClientHold, VerificationClientHold, VerificationHold, PrivacyLock, ExpirationClientHold) and `registryStatuses` (EPP style). So the adapter cannot assume `locks[]` is a clean EPP status list without checking a live response.

A8. register (idempotency / duplicate handling). CONFIRMED for idempotency; duplicate handling is a documentation gap.
- `X-Idempotency-Key` header on CreateDomain (OpenAPI); response header `X-Idempotent-Replay` "Caches are cleared after 1 hour"; 409 "Idempotency key has been reused for a different request". Changelog 1.3.0 (2025-08-07) added it to Create Domain and Purchase Privacy; 1.33.2 (2026-08-17) corrected 12h to 1h. Status codes documented for create: 400 (premium price required / price mismatch / invalid years), 402, 403, 404, 409 (idempotency only), 415, 422, 429, 451, 5xx.
- Gap the dossier does not flag: there is NO documented status code or message for "domain already registered / not purchasable" on `POST /core/v1/domains` (the 409 is documented only for idempotency; the generic `GenericConflict409` schema says "Object already exists"). Docs rely on pre-checking with Check Availability. Integrators must handle an undocumented failure for races.
- Minor: `contacts` are optional on create ("If no contacts are passed in this request, the default contacts for your name.com account will be used"). The dossier's "all core fields required" is true only when contacts are supplied.
- `years`: "Defaults to each TLD's minimum if omitted (usually 1; 2 for .ai)", "commonly 1-10 years". `promoCode` optional (changelog 1.18.0).

A9. renew idempotency. CONFIRMED.
- Parsing every operation in the OpenAPI: `X-Idempotency-Key` appears only on CreateDomain, PurchasePrivacy, ProcessRefund, VerifyContact, ResendContactVerificationEmail. RenewDomain has only the `domainName` path parameter. The renewals guide says "always pass idempotency keys": conflict confirmed. Also: RenewDomain documents no 402 and no 409 (400 invalid price, 403, 404, 422, 429, 5xx).

A10. Other coverage rows. CONFIRMED: checkAvailability 50 names (schema maxItems 50); zonecheck maxItems 500, cached twice daily; search `tldFilter` maxItems 50; tldpricing tlds maxItems 25; perPage defaults per changelog 1.28.0; getPricing `years` 1-10; `tldInfo` fields list matches. `POST /core/v1/accounts` (CreateAccount, sub-accounts) exists but "only available to approved reseller accounts".

## B. Sandbox and credentials

B1. Sandbox exists. CONFIRMED. https://docs.name.com/guides/testing-environment.md: base `https://api.dev.name.com`; `-test` username; token labelled "Development/Test Environment" from https://www.name.com/account/settings/api; "up to 15 minutes" activation; "$100,000 of account credit", "regularly reset"; DNS "will not become publicly queryable"; transfers non-deterministic; domains "cannot be deleted"; some TLDs unavailable; same rate limits; webhooks supported. Live check: `https://api.dev.name.com/core/v1/hello` answers 401 with `api-version: Reseller-1.34.0` (same as production), so the sandbox host is real and on the same version.
B2. Which launch TLDs exist in sandbox: UNVERIFIABLE (needs credentials); docs only say some TLDs are missing.
B3. How credentials are obtained. CONFIRMED with the known conflict. Getting Started: create a name.com account (avoid SSO), then Account Settings > Security > API Tokens, issue dev and production tokens; no approval step. Blog (2024-01-10, fetched): "Click 'I Agree', then name your token"; also "whitelisting specific IP addresses". But the API Access Agreement chunk says Name.com "permits a select number of Name.com customers" and "You must return a completed and signed copy of this Access Form", and Name.com may suspend "at any time and for any reason". Marketing (/nameapi): "No fees, no application, no sales call." Sub-accounts, Verify Contact, premium lists and internal transfer-in are "available upon request/approved".
B4. Doc conflict the analyst missed: API Overview page says "2FA-enabled accounts are not supported. Disable Two-Factor Authentication", while Getting Started, Authentication and FAQ say keep 2FA and toggle "API Access" on.

## C. Rate limits

C1. CONFIRMED. API Overview: "20 requests per second", "3,000 requests per hour", exceeding "the account-wide rate limit" returns 429. Changelog 1.29.2 repeats "(20 req/s, 3,000 req/hour)". OpenAPI `info.description`: "rate-limited to 20 requests/second". Sandbox: "Same rate limits". Per account-per-domain registration limit for "selected registry connections", 429 with `Retry-After`, "may expand over time": confirmed (overview + 1.29.2). Sub-account rate-limit accounting: not documented.
C2. Missed detail: the OpenAPI documents the 429 header as `x-ratelimit-reset` ("Unix timestamp for the time at which the current rate limit will reset") on every operation (143 occurrences) and never mentions `Retry-After`; `Retry-After` appears only in the overview prose and changelog for the per-domain limit. Client should honour both. No rate-limit headers appeared on a 401 from either host.

## D. Prices (fetched 2026-09-29 20:16 UTC, 1-year unless noted; USD)

Source of every number: https://www.name.com/ajax/pricing/?duration=1&tlds=com,ai,io,dev,app,studio (needs csrf meta token + cookie). Fields: `*_price` = shown to the visitor (after public promo), `*_original_price` = MSRP, `*_retail_price` = public retail incl. promo.

| TLD | Register (price / original) | Renew | Transfer-in | Restore | Analyst | Verdict |
|---|---|---|---|---|---|---|
| .com | 12.99 / 17.99 | 19.99 (future 21.99 from 2026-10-31) | 17.99 | 120.00 | 12.99 promo, 17.99 list, 19.99->21.99, 17.99, 120 | CONFIRMED |
| .ai | 99.99 / 99.99 | 99.99 | 99.99 | 200.00 | 99.99/yr, 2y = 199.98 | CONFIRMED (duration=2: reg 199.98, renew 199.98, transfer 199.98) |
| .io | 53.99 / 79.99 | 79.99 | 79.99 | 120.00 | 53.99 promo, 79.99 | CONFIRMED |
| .dev | 14.99 / 19.99 | 22.99 | 19.99 | 180.00 | same | CONFIRMED |
| .app | 14.99 / 22.99 | 26.99 | 22.99 | 120.00 | same | CONFIRMED |
| .studio | 21.99 / 41.99 | 58.99 (future 74.99 from 2026-10-06) | 41.99 | 120.00 | same | CONFIRMED |

- Cross-check: CMS `staticSchemaPricing` (page `_updatedAt` 2026-06-03 for com/ai/io): .com 17.99/19.99/17.99; .ai 99.99 x3 (registration string has a leading space " 99.99"); .io 79.99 x3. These are list prices; they do not carry the promo.
- The public pricing page's featured strip shows ".io $53.99 (was $79.99)" and ".com $12.99 (was $17.99)"; page text: "This page displays the standard price for each TLD, but prices vary by individual domain name", "Prices listed are for standard domains only", "For bulk prices contact accountservices@name.com", "Domain Restoration Fee: Varies by TLD. Please contact support".
- Multi-year (duration=2) feed: .com reg 30.98 = 12.99 + 17.99; .io 133.98 = 53.99 + 79.99; .dev 34.98 = 14.99 + 19.99; .app 37.98 = 14.99 + 22.99; .studio 63.98 = 21.99 + 41.99. i.e. promo applies to year 1 only. The dossier says these "look internally inconsistent"; they are consistent. The only odd values are .studio `registration_original_price` 41.99 at 2 years (should be 83.98) and the 2-year .com renewal (39.98 = 2 x 19.99) ignoring the scheduled 21.99 bump. So the analyst's "only 1-year figures used" is safe but the reason given is overstated.
- .ai transfer: the feed gives 199.98 at duration=2, but the Get Pricing/Create Transfer docs say `transferPrice` "is not affected by the `years` query parameter". Unresolved without credentials; keep 99.99 vs 199.98 as an open item for .ai transfers.

D-basis. Are these what a reseller/API customer pays? PARTLY CONFIRMED.
- RSA payment terms (DG18NICY.js, re-read): "You may set Your own prices to charge Your Customers for the Services. Unless otherwise communicated to You in writing by Name.com, You will be charged Name.com's standard retail price for the Services ordered through Your Account." Ambiguity: "standard retail price" could mean list (17.99) rather than the promo (12.99).
- TLD Price List doc (OpenAPI `/core/v1/tldpricing`): account-level = "Your price, including any applicable rebates, promotions, or account-level discounts"; retail = "current public retail price on name.com, including any public rebates or promotions, but before any account-level discounts"; original = MSRP; "If you do not have account level pricing, the retail price will always match your account level price"; "Promo codes are not supported through the API, and therefore are not reflected in any pricing values returned." So by the docs an account with no discount is quoted the retail (promo-inclusive) price. Actual charge at order time: UNVERIFIABLE without credentials.
- `SearchResult.purchasePrice` is described as "the minimum-term list or flat acquisition price from discovery" (word "list"), a further hint the discovery price may be list rather than promo. Unverified.
- No wholesale/cost-plus rate is published anywhere I could reach (pricing page, /nameapi, /resellersolutions which redirects to /nameapi, docs). "Custom rate cards available for high-volume partnerships" is the only statement.

D-program. Reseller Pricing Program (BlG9FYeC.js, "Last Updated: August 2024"). CORRECTED.
- Confirmed thresholds: Bronze $1,000 and 100; Silver $2,500 and 250; Gold $10,000 and 1,000 registrations (new registrations only, excluding renewals and transfers); one-year term from enrolment ("Anniversary Date"); annual review; discounts unpublished.
- Missed: "Qualifying Total" at enrolment = (i) spend on Qualifying Products in the last 365 days PLUS (ii) "your Account credit" at enrolment. So prefunding credit counts toward the spend test at enrolment; the 100/250/1,000 registrations test still needs real new registrations in the prior 365 days. Eligibility is per Account, no aggregation across accounts. Enrol at name.com/resellersolutions (redirects to /nameapi).
- Missed: "You may continue to benefit from promotional pricing ... At any given time, you may receive the lower of promotional pricing or Program Discounts."
- Correction to "may modify or cancel without notice": minimum spend/registration changes need "at least 30 days' notice" (existing tier kept until anniversary + 30 days). "Other Program Terms are subject to change at Name.com's sole discretion and without notice", and Name.com is "sole arbiter of eligibility" and may "adjust your tier in its sole discretion at any time".
- "Qualifying Products" is not enumerated in the terms.

## E. Changelog and deprecations

- Latest entry Core 1.34.0 (2026-09-10); first Core 1.0.0 (2025-05-12). CONFIRMED. (The API Overview says "released June 2025": a small doc inconsistency.)
- v4: overview says v4 "is still supported and will sunset at a predetermined time in 2026"; the migration guide has no date. CONFIRMED no date.
- Deprecated endpoints in the OpenAPI (`deprecated: true`): `:lock`, `:unlock`, `:enableAutorenew`, `:disableAutorenew`, `:enableWhoisPrivacy`, `:disableWhoisPrivacy`, plus host-based URL forwarding list/get/update/delete. All "will be removed in a future release", no date. Analyst listed only `:lock`/`:unlock`.
- Items the analyst did not surface: 1.12.0 (2025-11-18) and 1.20.0 `ExpirationClientHold` "applied to expired domains of configured API Reseller accounts" (domain-locks guide: removes the domain from DNS so site and email stop at expiry, day 0, for some reseller accounts); 1.23.2 `locks[]` now includes `clientHold`; 1.31.2 `canceled` transfer-out status semantic change; 1.19.0/1.30.0 internal transfer webhooks; 1.33.0 503 for maintenance on all endpoints; 1.0.0 removed SearchStream.
- Confirmed analyst items: 1.29.2 per-domain limit (2026-07-06), 1.17.0 `.in` blocked (2026-01-27), 1.33.2 idempotency lifetime 1h (2026-08-17), 1.18.0 `promoCode`, 1.9.3 60-day block, 1.15.0 refunds endpoint, 1.23.0 registry rejection webhook.

## F. Status and reliability

- CONFIRMED: incident "API outage" created 2026-04-29 15:03Z, resolved 16:32Z (impact critical); postmortem (2026-05-08): "Duration: 14:33 UTC - 16:09 UTC (~96 minutes)", api.name.com unreachable, cause "unanticipated 50x surge in traffic to a specific, heavyweight API endpoint" saturating the shared writer database; mitigation Cloudflare WAF rate-limiting. Also 2025-11-18 "Website and API Outage", 2026-07-24 degradation (5 min), 2026-07-11 "Identity Digital - Domain Create and Renewal Errors", 2026-05-05 DENIC .DE DNSSEC outage.
- Upcoming maintenance: 2026-10-11 01:00-05:00 UTC Verisign (.COM & .NET): "Domain availability checks, Registrations, Renewals, and Management: Unavailable" CONFIRMED. Analyst missed: 2026-10-06 21:00-01:00 UTC Verisign cTLD maintenance (cc, name, IDN .com/.net variants: not launch TLDs) and 2026-09-30 08:30-13:30 UTC .nrw/.bayern.

## G. Other claims

- SDK: `npm view @namecom/core-api` -> version 1.34.0, created 2026-08-03T17:45Z, modified 2026-09-16T23:27Z, MIT, node >=18, no dependencies. CONFIRMED.
- Webhooks: the Subscribe endpoint lists exactly 11 events, matching the analyst's list; no registration-success, renewal, auto-renew or DNS event. (The endpoint blurb says "e.g. transfer completions, renewals" but no renewal event exists.) HMAC: header `X-NAMECOM-SIGNATURE: sha256=...,timestamp,nonce`, keyed with "your API token (earliest if multiple exist)" (changelog 1.23.1: "the token with the lowest id"). CONFIRMED. Retry policy: not documented anywhere in the pages I read (unverified remains).
- Post-expiry lifecycle days 0 / 1-25 / 26-43 / 44-74 / 75-79 / 79+, restore UI-only, `expirationGracePeriod` per TLD, "Some TLDs have a shorter Guaranteed Renewal Window": CONFIRMED verbatim in domain-renewals-expiration.
- Refund Policy "LAST UPDATED: April 1, 2026": 5 days; renewals never refundable; ".AI ... .IO" in the never-refundable list: CONFIRMED.
- `.ai` not in the Quickstart TLD list: CONFIRMED (com, io, dev, app, studio all listed; ai is not).
- Funding: "To increase the default purchase limit above $2,500, contact reseller@name.com"; ACH "up to $20,000 per transaction", "ACH must be enabled ... Contact reseller@name.com": CONFIRMED. Per-order vs cumulative meaning: not stated (unverifiable).
- No token scopes: OpenAPI `securitySchemes` is just BasicAuth; no scope text anywhere. IP allow-listing appears only in the 2024 blog. Consistent with the dossier.
- "ns1.name.com" as the example default nameserver in the DNS row: I could not find it in the docs (docs say only "defaults to the account's default nameservers"). Minor unsourced example.

## H. Items the analyst listed as unverified that I could narrow

- Auth code during the lock: docs say a code can be returned despite locks (A3).
- API opt-out of the post-registrant-change 60-day lock: `SetContactsRequest` contains only `contacts`; no opt-out parameter exists in the OpenAPI. The domain-locks guide's "unless the registrant opts out" appears to be an account/registrant-side setting, not an API field.
- Public promo on API orders: docs lean yes (D-basis) but remain unproven.
- v4 sunset date: still none.
- Everything behind credentials: still unverified (sandbox TLD list, `allowedRegistrationYears` for .ai, `expirationGracePeriod`, `supportsPrivacy`, real account-level `tldpricing`).
