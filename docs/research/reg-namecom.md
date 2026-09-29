# Registrar dossier: Name.com (Name.com, Inc., IANA Registrar ID 625) - Core API v1

Prepared for the Mosshatch Phase 0 plan. Research date and access date for every source below: **2026-09-29**. All prices USD. Nothing here was answered from memory; where a fact could not be verified it is marked **unverified** and listed in section 12.

## TL;DR

1. **Resale: YES, conditional.** The Reseller Agreement (RSA) grants "a non-exclusive, fully-paid-up, royalty-free, terminable, non-transferable right and license to resell the Services worldwide", lets you "set Your own prices", and requires each end customer to explicitly accept Name.com's Registration Agreement (you keep the written record). The API Access Agreement separately forbids using the API for resale unless you are under the RSA.
2. **Onboarding is self-serve on paper** ("No fees, no application, no sales call") but the API Access Agreement says Name.com "permits a select number of Name.com customers" and can end access "at any time and for any reason". No minimum deposit or volume commitment is documented; default purchase limit is $2,500.
3. **No published wholesale price.** RSA: unless told otherwise in writing "You will be charged Name.com's standard retail price". Discounts only via the Reseller Pricing Program (Bronze needs $1,000 spend and 100 new registrations in 365 days; percentages not public) or a custom rate card.
4. **API is strong**: OpenAPI 3.1 (v1.34.0, 2026-09-10), sandbox, webhooks with HMAC, hosted DNS with per-record CRUD, `X-Idempotency-Key` on Create Domain. Gaps: restore/redemption is UI-only, renew has no documented idempotency key, no per-record upsert, no DNS/renewal-success webhooks.
5. **Limits are tight for a multi-tenant reseller**: 20 req/s and 3,000 req/hour per account; 50 names per availability call.
6. **Retail prices today (1y)**: .com 12.99 promo / 17.99 list, renew 19.99 (to 21.99 on 2026-10-31); .ai 199.98 for the mandatory 2 years, never refundable; .io 53.99 promo / 79.99, renew 79.99; .dev 14.99 / renew 22.99; .app 14.99 / renew 26.99; .studio 21.99 / renew 58.99 (to 74.99 on 2026-10-06).
7. **Red flags**: 96-minute API outage 2026-04-29; unilateral RSA changes, 30-day no-cause termination, chargeback asset seizure; domains vanish from the API 26 days after expiry; reseller-as-registrant puts legal notices on Mosshatch.
8. **Recommendation: FALLBACK.** Best-documented self-serve integration and safe to prototype against today, but the default cost basis is retail, so "wholesale + one flat fee" is not achievable at launch. Promote to primary only if reseller@name.com quotes a rate card materially below retail.

---

## 0. Evidence conventions and how sources were obtained

- Docs host `docs.name.com` (Mintlify) publishes every page as markdown (`https://docs.name.com/llms.txt` is the index) and the OpenAPI file `https://docs.name.com/api/v1/namecom.api.yaml` (info.version `1.34.0`). Local copies: `working-directory/research/namecom/` (`md/`, `openapi.yaml`).
- The legal pages on `www.name.com/policies/*` are client-rendered (empty HTML shell). Their text was read from the site's own JS bundles: RSA `https://www.name.com/_nuxt/DG18NICY.js`, API Access Agreement `.../DffIiKU_.js`, Reseller Pricing terms `.../BlG9FYeC.js`, Registration Agreement `.../Iz6hP86S.js`, Refund Policy `.../DG3_37Xa.js`, Subpoena Policy `.../C4MHhkR8.js`. Extracted text saved as `rsa_full.txt`, `apiaa_full.txt`, `resellerpricing_full.txt`, `pol_*.txt` in the folder above. Cloudflare returned challenge/429 pages on several name.com paths (for example `/abuse`) and I did not work around them; those pages are marked unverified.
- Public retail prices: the `/pricing` page fills its table from `https://www.name.com/ajax/pricing/?duration=N&tlds=...`, which needs the CSRF token embedded in the page itself (the same request the page's own JavaScript makes). Fetched 2026-09-29 ~19:20 UTC (`ajaxpricing.json`, `ajaxpricing_d2.json`).
- `WebSearch` budget for the session was exhausted mid-task, so third-party sentiment research is thin (section 9).

---

## 1. RESALE

**Verdict: conditional yes.** Reselling under your own brand, price and checkout, ordering through the API on customers' behalf, is expressly contemplated. Conditions are contractual (below).

### 1.1 Governing documents

| Document | URL | What it does |
|---|---|---|
| Name.com Reseller Agreement (RSA) | https://www.name.com/policies/api-reseller-agreement (accessed 2026-09-29) | Resale license, pricing, ICANN pass-through duties, termination |
| API Access Agreement | https://www.name.com/policies/api-access-agreement (2026-09-29) | Two tracks: "Reseller Terms" (resale governed by RSA) and "Non-Reseller Terms" (resale forbidden) |
| Reseller Pricing Program terms | https://www.name.com/policies/reseller-pricing (2026-09-29, "Last Updated: August 2024") | Bronze/Silver/Gold discount tiers |
| Domain Name Registration Agreement | https://www.name.com/policies/registration-agreement (2026-09-29) | What each end customer must accept |
| OpenAPI `termsOfService` | https://docs.name.com/api/v1/namecom.api.yaml | Points at the API Access Agreement |

### 1.2 Clauses that matter (verbatim quotes)

- **Right to resell** (RSA): "Name.com grants You a non-exclusive, fully-paid-up, royalty-free, terminable, non-transferable right and license to resell the Services worldwide."
- **Customer acceptance is the reseller's job** (RSA): "You and each of Your end customers ... purchasing such Services must explicitly agree to the Domain Name Registration Agreement ... and You must retain a written record of such explicit acceptance by Your Customers." Also: "You agree to indemnify and hold harmless Name.com for any failure by You to obtain the consent of any customer".
- **Own terms allowed, registrar terms win** (RSA): "You may enter into further terms with Your Customers ('Your Additional Terms'). Your Additional Terms must expressly state that in the event of a conflict between the Name.com Registration Agreement and Your Additional Terms, the Name.com Registration Agreement will control."
- **Own branding allowed, but disclose the sponsoring registrar** (RSA): "Your Additional Terms must also identify Name.com, Inc. as the sponsoring registrar or provide a means to Your Customers to identify the sponsoring registrar." And "You must not display the ICANN or ICANN-Accredited Registrar logo, or otherwise represent Yourself as accredited by ICANN".
- **Own prices** (RSA, Payment Terms): "You may set Your own prices to charge Your Customers for the Services. Unless otherwise communicated to You in writing by Name.com, You will be charged Name.com's standard retail price for the Services ordered through Your Account. You must publish on Your website all fees for domain name registrations, renewals, post-expiration renewal fees (if different), and also redemption/restore fees."
- **Sub-resellers allowed** (RSA): "You may elect to further resell the Services through resellers of your own (each, a 'Sub-Reseller')".
- **Resale via API needs the RSA** (API Access Agreement, "Reseller Terms"): "Your access to and use of the API for the purpose of reselling domain names ... is subject to the terms and conditions of the Name.com Reseller Agreement". Under "Non-Reseller Terms": "You are not permitted to access or use the API for the purpose of reselling domain names and/or related services made available by Name.com".
- **Support burden on you** (RSA, Support): "You are responsible for providing customer service, billing, and technical support to Your Customers on a consistent basis". "If Name.com determines that You are providing inadequate support to Your Customers (resulting in, for example, an excessive number of support calls directly from Your Customers), You will be in breach of this RSA and Name.com may terminate this RSA."
- **Record keeping** (RSA, Audit): keep registration contracts and customer payment/refund records for the term "and for seven (7) years thereafter"; "Upon request, You will provide any information ... to Name.com within two (2) business days".
- **Customer takeover on exit** (RSA): "If You stop using Your Account, become unavailable or unresponsive to Name.com, Your Customers, or this RSA is terminated by Name.com for any reason, Name.com may, but is not obligated to, directly engage with and provide services to any of Your Customers."
- **Drop-catching banned** (RSA and Create Domain doc): "using the Technology for drop catching is explicitly prohibited."

### 1.3 Is there a formal reseller program? What does it require?

| Item | Finding | Source |
|---|---|---|
| Formal program | Yes, two layers: (a) self-serve "Domain Reseller Program" / API; (b) Reseller Pricing Program (discount tiers). | https://www.name.com/nameapi ; https://www.name.com/policies/reseller-pricing |
| Application / approval | Marketing: "No fees, no application, no sales call." Contract: API Access Agreement says Name.com "permits a select number of Name.com customers to access and use the ... API" and "You must return a completed and signed copy of this Access Form". Blog (2024-01-10) describes click-through: "Click 'Create API Token' ... where you can explore the full name.com API Access Agreement and acknowledge the terms of use. Click 'I Agree'". RSA "will be effective upon Your acceptance of these Terms, as electronically recorded by Name.com." **Conflicting statements; practical flow appears self-serve.** Some endpoints are gated: Create Account (sub-accounts), Verify Contact, Download Premium Domain Lists, Create Internal Transfer In are "only available to approved reseller accounts". | https://www.name.com/nameapi ; API Access Agreement ; https://www.name.com/blog/how-to-resell-domains-via-an-api ; https://docs.name.com/api/v1/namecom.api.yaml |
| Contract | RSA (1-year auto-renewing term; "Upon at least thirty (30) days written notice, with email being sufficient, either party may terminate this RSA for any reason or no reason.") | RSA |
| Minimum deposit / prepaid balance | No fixed minimum published. RSA: "You are required to maintain a positive and sufficient account balance or set up a valid payment profile, such as a credit card". "Name.com may also demand reasonable assurance of payment, at Name.com's sole discretion." Account Credit via ACH (US, up to $20,000 per transaction) or wire. **Default purchase limit $2,500**: "To increase the default purchase limit above $2,500, contact reseller@name.com". | RSA ; https://docs.name.com/guides/funding-your-namecom-account |
| Volume commitments | None for API access. Discount program: Bronze "$1,000 and 100 domain registrations", Silver "$2,500 and 250", Gold "$10,000 and 1,000" (spend plus new registrations, trailing 365 days; account credit counts toward the spend figure; renewals and transfers excluded from the registration count). Discount percentages **not published (unverified)**. | https://www.name.com/policies/reseller-pricing |
| KYC | No reseller KYC form documented. RSA sanctions clause: Name.com may "freeze Your account and all associated funds, without notice, if we cannot confirm that You ... [are] not a Sanctioned Person". Registration Agreement: "We may, at any time and at our sole discretion, request additional information about you ... passport or identification documentation". | RSA ; Registration Agreement |
| Custom pricing | "Custom rate cards available for high-volume partnerships." "Work with us to create a custom pricing plan that is tailored to your existing portfolio, registration volume, and TLD preferences." Contact reseller@name.com. | https://www.name.com/nameapi ; https://www.name.com/nameapi/contact |
| Public reference customers | "Production-proven at Vercel, Netlify, Lovable, and Replit." | https://www.name.com/nameapi |

### 1.4 Registrant of record, notices, abuse, legal process

- **Who is the registrant?** Whoever you put in `contacts.registrant` at create time; if omitted, "the default contacts for your name.com account will be used" (Create Domain). Name.com's Reseller Quickstart recommends "set the **reseller (you)** as the domain contacts to move fast". Registrant Communications guide, "Key risk": "When the reseller is set as the registrant/admin contact, the reseller is the legal owner of the domain in ICANN and registry systems ... legal notices (e.g., cease-and-desist letters, takedown requests, and potential lawsuits) are served to the reseller, not the end customer." (https://docs.name.com/guides/registrant-communications). The Registration Agreement defines "you" as "the registrant listed in the WHOIS/Registration Data Directory Service ('RDDS') contact information". The `companyName` field is the legal owner marker: "If this field contains information, the listed organization is considered the legal 'Registered Name Holder' (domain owner)."
- **Who obtains acceptance of the registrar agreement?** The reseller (RSA quote above), with a written record kept 7 years.
- **Who sends ICANN-mandated notices?** Three documented routes (https://docs.name.com/guides/registrant-communications): (1) reseller as contact, so the reseller receives them; (2) "Name.com sends required emails on your behalf (whitelabeling available upon request)"; (3) "You send your own emails (requires an addendum assuming email responsibility, plus logging evidence)". For (3): logs kept "for the duration of the domain registration and for at least two (2) years thereafter"; sample logs and sample emails required before enablement (https://docs.name.com/guides/contact-verification). Duties cover verification (15 days), renewal notices (~30 and ~5 days before, and within 5 days after expiry), transfer FOA, change-of-registrant confirmations and annual WDRP.
- **Abuse reports**: Name.com is the sponsoring registrar; RDAP for a name.com-registered domain shows registrar "Name.com, Inc" IANA ID 625 and abuse contact `abuse@name.com` (https://namerdap.systems/domain/name.com ; https://rdap.verisign.com/com/v1/domain/name.com). Name.com applies locks itself ("ClientHold (Compliance/Abuse) ... DNS Abuse, CSAM, Fraud", https://docs.name.com/guides/domain-locks) and RSA lets it suspend for "abuse of the Services". RSA: "If Name.com receives communications from registrants or from third-parties regarding Services provided in Your Account, Name.com will, where appropriate, forward such communications to You at Name.com's discretion". The name.com `/abuse` page returned a Cloudflare challenge (403) so its intake process is **unverified**.
- **Legal process**: subpoenas go to Name.com's registered agent (Corporation Service Company, Carson City NV); "Name.com may promptly notify the customer whose information is sought" and may charge the customer's account an administration fee (https://www.name.com/policies/subpoena). Mosshatch is the "customer"; if Mosshatch is also registrant of record, third-party legal notices land on Mosshatch (quote above).
- **Registry-specific rules pass through**: RSA "ADDITIONAL REGISTRY REQUIREMENTS": "You shall include in Your agreement with Your Customers and Sub-Resellers all terms and conditions required by the registry operator".

### 1.5 Resale-relevant contract risks

- RSA changes: "Material modifications ... will become effective thirty (30) days after such modified version is posted ... or upon Your acceptance ... including by continuing Your performance"; ICANN/registry-driven changes "may become effective fewer than thirty (30) days after". "Your sole remedy is to terminate".
- Termination without cure: "Name.com specifically has the right to immediately terminate this RSA, without notice or right to cure" for violations of the ICANN-obligations and restrictions-on-use sections; and "immediately if Name.com determines, in its sole discretion, that You, Your Sub-Resellers or Your Customers have failed to comply with any term".
- Chargebacks: "$35.00 per incident", suspension, and Name.com "may assume all right, title, interest in, and use of any domain name registration(s)" and "sell, dispose of, or retain the Collateral"; reinstatement fee "currently set at US$200".
- Liability cap: 12 months of fees received; indemnity by reseller for customer claims; arbitration by JAMS in King County, Washington; Washington law.
- Access Agreement: "Name.com reserves the right to terminate this Access Form, or suspend or terminate Your access to and/or use of the API, at any time and for any reason." Modifications "effective 30 days after Name.com notifies You".
- The RSA also says Name.com may suspend API access "immediately and without notice" if your use "cause[s] or risk[s] causing a degradation of Name.com infrastructure".

---

## 2. API COVERAGE (one row per Mosshatch RegistrarAdapter method)

Base URLs: production `https://api.name.com`, sandbox `https://api.dev.name.com`; JSON over HTTPS; HTTP Basic (username + API token); path prefix `/core/v1`. Do not URL-encode the colon in `domains:checkAvailability`. Source for all rows: OpenAPI https://docs.name.com/api/v1/namecom.api.yaml (v1.34.0) plus the cited guide, accessed 2026-09-29.

| Adapter method | Support | Endpoint | Caveats / evidence |
|---|---|---|---|
| checkAvailability (bulk names x TLDs) | **yes** | `POST /core/v1/domains:checkAvailability` (also `POST /core/v1/domains:search`, `POST /core/v1/zonecheck`) | Body `domainNames[]` (max **50** per call, "up to 50 domain names"); you must expand names x TLDs yourself. Returns `purchasable`, `premium`, `purchaseType`, `purchasePrice`, `renewalPrice`, optional `reason`. Pass `purchaseType: "registration"` to exclude aftermarket/expiring/backorder inventory. `:search` takes a keyword plus `tldFilter` (max 50 TLDs). `zonecheck` takes up to 500 names but is cached zone-file data refreshed twice daily, no pricing, unsupported TLDs silently dropped. 422 if all TLDs unsupported. |
| quote (wholesale + renewal price, premium detection) | **partial** | `POST :checkAvailability` (`purchasePrice`, `renewalPrice`, `premium`); `GET /core/v1/domains/{domain}:getPricing?years=N` (`purchasePrice`, `renewalPrice`, `transferPrice`, `premium`, null = not sellable); `GET /core/v1/tldpricing` (per-TLD, account-level price plus retail and MSRP, max 25 TLDs/call) | "Wholesale" = the account-level price, which equals retail unless you have a program discount. Premium: `premium:true` with `purchaseType: registration` is a registry premium and `purchasePrice` becomes mandatory on create, must match "exactly to the cent" (`400 "Purchase price does not match"`). Do not use discovery `renewalPrice` for premium renewals; use getPricing. Premium lists downloadable only by approved resellers. |
| register (contacts, WHOIS-privacy flag, duplicate/retry) | **yes** | `POST /core/v1/domains` | Fields: `domain.domainName`, `years` (TLD minimum if omitted: 1, **2 for .ai**), `contacts` (registrant/admin/tech/billing; firstName, lastName, address1, city, state, zip, country, email, phone E.164 all required), `privacyEnabled` (free; only applied if TLD supports it; omitted = account default), `autorenewEnabled`, `locked`, `nameservers`, `purchasePrice`, `purchaseType`, `tldRequirements`, `claims`, `promoCode`. Header **`X-Idempotency-Key`**: replays return the original result with `X-Idempotent-Replay: 1`; cache is **1 hour**; same key with a different request gives `409`. Errors: 402 (insufficient credit), 422 (pricing unavailable), 429 (account limit, or per account-per-domain limit with `Retry-After`), 451 (legal restriction). Some registries finish asynchronously: webhook `domain.registry.rejection` reports later failure. |
| renew | **yes** | `POST /core/v1/domains/{domain}:renew` body `{years, purchasePrice?}` | `purchasePrice` only for premiums. **No `X-Idempotency-Key` in the OpenAPI for renew** although the renewals guide says "always pass idempotency keys" (conflict; see section 9). Only works while the domain is still in API inventory (about 25 days after expiry). "Domain renewals are non-refundable." |
| getDomain (status, expiry, lock, NS, registry status codes) | **partial** | `GET /core/v1/domains/{domain}`; `GET /core/v1/domains` (perPage default 250, max 1000; `includeRenewalPrice`) | Returns `createDate`, `expireDate`, `autorenewEnabled`, `locked` (transfer lock only), `locks[]` ("all registry locking statuses ... e.g. clientTransferProhibited, clientHold"), `transferLockExpiresAt`, `privacyEnabled`, `nameservers`, `contacts[].isVerified/verificationId`, `renewalPrice`. **No `redemptionPeriod`/`pendingDelete`**: after the renewal window the domain leaves the API ("Get/List no longer return it"), so 404 must be mapped using the `account.domain.removal` webhook. |
| setLock | **yes** | `PATCH /core/v1/domains/{domain}` body `{locked: bool}` (also `autorenewEnabled`, `privacyEnabled`) | Old `:lock`/`:unlock` are deprecated. New registrations, transfers-in and material registrant changes carry a mandatory lock: "blocks client unlock via the API until [`transferLockExpiresAt`]". `403` if expired; `409` when the registrar cannot lock. Customer "PrivacyLock" cannot be managed via the API. |
| listRecords | **yes** | `GET /core/v1/domains/{domain}/records` (perPage default 500) | DNS is hosted by Name.com (default account nameservers, e.g. `ns1.name.com`). Types **A, AAAA, ANAME, CNAME, MX, NS, SRV, TXT** (no CAA/TLSA/HTTPS/SVCB in the enum); min TTL 300. |
| upsertRecord | **partial** | `POST .../records` (create), `PUT .../records/{id}` (update) | Per-record CRUD by numeric id; no upsert-by-(host,type), no replace-all. `PUT` is "a full overwrite". Duplicate record returns `409`. Implement upsert as list, match, then create or PUT. No idempotency header on DNS calls. |
| deleteRecord | **yes** | `DELETE .../records/{id}` | By id only. |
| startTransferIn (auth code) | **yes** | `POST /core/v1/transfers` body `{domainName, authCode, privacyEnabled?, purchasePrice?}` | Fee charged at submission; `402` if credit insufficient; `409` if registered <60 days or already processing. `POST /core/v1/transfers/internal/in` is enterprise-allowlisted. `GET /core/v1/transfers/eligibility/{domain}` tells you if the name is already at name.com. |
| getTransfer (poll or webhook) | **yes** | `GET /core/v1/transfers/{domain}`, `GET /core/v1/transfers`; webhook `domain.transfer.status_change` | Statuses: completed, failed, canceled, canceled_pending_refund (terminal); pending, submitting_transfer, pending_new_auth_code, pending_unlock, pending_registry_unlock, pending_transfer, pending_insert, rejected. `POST /core/v1/transfers/{domain}:cancel` refunds "to account credit". |
| getAuthCode | **yes** | `GET /core/v1/domains/{domain}:getAuthCode` | Returns `authCode` in clear text; `406` "unable to retrieve an auth code". Whether it is issued during the 60-day lock: unverified. |
| startTransferOut (or how outbound approval works) | **no (by design)** | Unlock via `PATCH` `{locked:false}`, `GET :getAuthCode`, `POST /core/v1/transfers/external/out/{domain}:cancel`, webhook `domain.transfer_out.status_change` (`initiated`/`completed`/`canceled`) | "The name.com Core API does not initiate transfer-out requests; those are started by the gaining registrar". |
| (extra) setNameservers | yes | `POST /core/v1/domains/{domain}:setNameservers` `{nameservers[]}` | "some registries will verify before allowing the change"; `400` if status prohibits update. |
| (extra) setContacts | yes | `POST /core/v1/domains/{domain}:setContacts` | Replaces all four contacts; partial updates unsupported. Triggers verification and transfer lock (section 6). |
| (extra) restore / redemption | **no** | none | "Redeem / restore (Redemption Grace Period) | UI only" (https://docs.name.com/guides/domain-renewals-expiration). |
| (extra) refund in add-grace period | yes | `POST /core/v1/refund` (idempotent) | Registration and whois_privacy items only. |
| (extra) DNSSEC DS, vanity NS, email/URL forwarding | yes | `/domains/{d}/dnssec`, `/vanity_nameservers`, `/email/forwarding`, `/urlforwarding` | Not needed by the adapter. |

SDKs: `@namecom/core-api` on npm, version 1.34.0 (created 2026-08-03, modified 2026-09-16), MIT, Node >=18, no dependencies (`npm view`, 2026-09-29). Go and PHP SDKs exist; Python "Coming soon" (https://docs.name.com/sdks). The browser cannot call the API ("Browser requests are blocked due to CORS restrictions", https://docs.name.com/resources/faq); server-side only.

---

## 3. SANDBOX / OT&E

| Item | Finding (source) |
|---|---|
| Exists | **Yes.** `https://api.dev.name.com` (https://docs.name.com/guides/testing-environment). Also `https://mcp.dev.name.com` for the MCP server. |
| Credentials | Same account. Username with `-test` appended plus the token labelled "Development/Test Environment" from https://www.name.com/account/settings/api. "In rare cases, newly generated sandbox credentials can take up to 15 minutes to become active." Sandbox "is API-only - not accessible through the browser". |
| Credit | "Sandbox accounts are provisioned with $100,000 of account credit"; regularly reset to that amount. |
| Registrations / expiry | Behaviour "is driven by registry OT&E"; "you should expect domain state to follow the standard domain lifecycle (including expiration-related flows), but registry OT&E behavior can vary". Domains created or transferred "cannot be deleted" and there is no reset. |
| DNS | DNS and nameserver calls succeed and read back, "but the changes will not become publicly queryable via DNS". |
| Transfers | "Sandbox does not support deterministic 'force success/failure/auth error' transfer outcomes." |
| Webhooks | "In sandbox/OT&E webhooks are supported and intended to behave the same as production." |
| Differences | Availability, claims, pricing (including premium and account-level) differ and are "non-authoritative"; "Some TLDs [are] not being available in sandbox". Same endpoints, validation and rate limits. Which of the six launch TLDs exist in sandbox: **unverified** (needs credentials). |

---

## 4. RATE LIMITS AND OPERATIONAL CONSTRAINTS

- **Account-wide**: "20 requests per second" and "3,000 requests per hour"; exceeding returns `429 Too Many Requests` (https://docs.name.com/api/v1/overview). Same in sandbox. Shared by every Mosshatch customer if one Name.com account is used. 3,000/hour is about 0.83 requests/second sustained, so polling `GET /domains/{d}` for a large portfolio is not viable; use webhooks and `GET /domains?perPage=1000`.
- **Registration-specific limit**: on "selected registry connections" a separate limit per account-domain pair returns `429` with `Retry-After` ("intended to protect registry operations from abusive retry patterns"). The affected connections are not listed; "may expand over time" (changelog 1.29.2, 2026-07-06).
- **Batch limits**: 50 names per checkAvailability; 50 TLDs in `:search` filter; 25 TLDs per TLD Price List call; 500 names per zonecheck; list `perPage` max 1,000 (changelog 1.28.0). Renewal guide suggests batching "up to ~500 at a time".
- **Auth**: HTTP Basic, one username + token per environment; 2FA-enabled accounts must toggle "API Access" or requests fail with `Permission Denied`. No token scopes or read-only tokens are documented (**unverified that none exist**). Optional IP allow-listing: "At the bottom of the page, you can adjust API access by whitelisting specific IP addresses" (2024-01-10 blog; not mentioned in current docs, so treat as unverified for 2026). Recommendation for Mosshatch: because a token can spend account credit, keep credit low and enforce approvals in Mosshatch.
- **Formats**: JSON only; `Content-Type: application/json` required on every POST/PUT/PATCH "including body-less POST actions". Error body `{ "message": ..., "details": ... }`. Default-valued fields: overview says they "are omitted" while the migration guide/changelog (1.0.0) say they are now always included (conflict; parse defensively).
- **Error semantics**: 401 bad credentials, 402 insufficient credit, 403 permission or expired domain, 404 not in this environment, 409 conflict (idempotency reuse, transfer in progress, lock), 422 pricing unavailable or TLD unsupported, 429 rate limit, 451 legal, 502 "safe for immediate exponential backoff", 504 "should be preceded by a status /core/v1/hello check to avoid duplicate operations" (changelog 1.20.0), 503 scheduled maintenance (https://status.name.com).
- **Safe retryable register (derived from the above)**: (1) persist a UUID v4 per purchase intent before calling; send it as `X-Idempotency-Key`; (2) retry with the same key and identical body within 1 hour; (3) after a timeout/504 or after 1 hour, reconcile first with `GET /core/v1/domains/{name}` (404 = not registered in this environment) or `GET /core/v1/orders?domainName={name}&type=registration` before any new attempt; (4) honour `Retry-After` on 429; (5) do not treat create success as final for asynchronous registries until no `domain.registry.rejection` arrives; (6) never send `purchasePrice` for non-premium names.
- **Renew has no idempotency key**: reconcile by reading `expireDate` (and `GET /orders?type=renewal`) before retrying.
- **Maintenance windows** publish on the status page, e.g. Verisign ".COM & .NET" 2026-10-11 01:00-05:00 UTC: "Domain availability checks, Registrations, Renewals, and Management: Unavailable" (https://status.name.com).

---

## 5. WHOLESALE PRICES (USD)

**What is public**: only retail list prices. The TLD Price List endpoint (`GET /core/v1/tldpricing`) returns three tiers per TLD: account-level ("the price you pay"), retail (public site price incl. promotions), and MSRP; "If you do not have account level pricing, the retail price will always match your account level price." (https://docs.name.com/api/v1/reference/tld-pricing/tld-price-list). Combined with the RSA ("standard retail price"), a new API account pays retail. Discount tiers exist (Bronze/Silver/Gold, section 1.3) with **unpublished percentages**. The pricing page says: "For bulk prices contact accountservices@name.com." Prices are "for standard domains only ... prices vary by individual domain name."

Source for the table: https://www.name.com/pricing (data feed `https://www.name.com/ajax/pricing/?duration=1&tlds=com,ai,io,dev,app,studio`, fetched 2026-09-29 19:20 UTC). Cross-check: name.com CMS JSON-LD pricing for .com 17.99/19.99/17.99, .io 79.99 x3, .ai 99.99 x3 (updated 2026-06-03) at https://www.name.com/api/ssr/sanity-document?type=tldLandingPage&slug=com (and `ai`, `io`).

| TLD | Register 1y (promo / list) | Renew | Transfer-in | Restore (redemption) | Notes / gotchas |
|---|---|---|---|---|---|
| .com | **12.99** promo / 17.99 list | 19.99, **rising to 21.99 on 2026-10-31** (`future_renewal_price`) | 17.99 | 120.00 | Verisign registry. Promo applies to the registration year only. Whether public-site promos apply to API orders is unclear (see notes below). |
| .ai | **99.99 per year, mandatory 2-year minimum = 199.98** (same for promo/list) | 99.99 per year (2y: 199.98) | 99.99 per year (2y: 199.98) | 200.00 | "Note: .ai domains require a minimum two-year registration." API: `years` defaults to "usually 1; 2 for .ai". **Never refundable** (Refund Policy). Whether a 1-year renewal is allowed: unverified. Not on Name.com's "Quickstart TLD list" (extra requirements likely). |
| .dev | **14.99** promo / 19.99 list | 22.99 | 19.99 | 180.00 | Google Registry: ".dev ... is included on the HSTS preload list, making HTTPS required on all connections". |
| .io | **53.99** promo / 79.99 list | 79.99 | 79.99 | 120.00 | ccTLD; **never refundable**; see ccTLD notes. |
| .app | **14.99** promo / 22.99 list | 26.99 | 22.99 | 120.00 | HSTS preload, HTTPS required (Google Registry). |
| .studio | **21.99** promo / 41.99 list | 58.99, **rising to 74.99 on 2026-10-06** | 41.99 | 120.00 | Registry: Dog Beach, LLC c/o Identity Digital. |

Notes on the price data:
- The feed's multi-year figures for non-.ai TLDs look internally inconsistent (for example .studio 2y `registration_original_price` 41.99 equals the 1-year price), so only 1-year values are used above; .ai 2-year values (199.98) are consistent.
- Restore is UI-only (section 6) but priced above; "Domain Restoration Fee: Varies by TLD. Please contact support".
- "Advanced Security" / WHOIS privacy: "$0.00" on the pricing page; "WHOIS privacy is free for API users and does not add a fee" (Purchase Privacy endpoint).
- Conflicting docs on promotions: TLD Price List says "Promo codes are not supported through the API", while Create Domain gained an optional `promoCode` parameter in changelog 1.18.0 (2026-02-10). Whether the public promo price (e.g., .com 12.99) is charged on API orders: **unverified** until sandbox/production `tldpricing` is called with real credentials.
- Premium and reserved names: `premium:true` names have special pricing; "Refunds are not permitted with premium domain names" (Refund Policy); premium lists only for approved resellers.
- `dev`/`app` HSTS: the API exposes this as `tldInfo.hsts` ("only load on modern browsers if a valid SSL certificate has been configured"); read it from `GET /core/v1/domaininfo/requirements/{tld}` (needs credentials to confirm values).
- No VAT in `purchasePrice`; `totalPaid` includes VAT when applicable. Account credit is USD only; other currencies are settled in USD.

---

## 6. LIFECYCLE

| Topic | Finding | Source |
|---|---|---|
| Add grace period (AGP) | Registrar policy: "Most domain name purchases can be refunded within the first five (5) days"; API: "Add Grace Period (typically 5 days from registration, varies by TLD)"; refunds go to the original payment method, else account credit; ICANN AGP delete limits enforced (`409` threshold, `423` AGP expired). | https://www.name.com/policies/refund ; https://docs.name.com/guides/refunds-flow |
| Never refundable | Renewals ("never refundable"), premium domains, redemption fee, and registrations in .AI, .IO (plus .AM .AT .BE .CH .CZ .DE .DK .ES .EU .FM .FR .GS .IT .JP .NL .NZ .PL .RU .SE .SO). Refund Policy last updated April 1, 2026. Whether the refund API blocks .ai/.io: unverified. | Refund Policy |
| Auto-renew | Name.com auto-renews on your behalf if `autorenewEnabled`: "Timing is configurable to ~30 days before expiration or ~7 days before expiration", charged to account credit/payment profile; "for certain top-level-domain names, the automatic renewal option is not available". Settable per domain via PATCH. | https://docs.name.com/guides/domain-renewals-expiration ; Registration Agreement |
| Expiry stages (typical gTLD) | Day 0 expires (`domain.expiration` webhook); days 1-25 "Guaranteed Renewal Window" (standard price, API renew works; length = `expirationGracePeriod` per TLD, "Some TLDs are shorter"); days 26-43 domain **leaves API inventory**, renew only via web "Renewal Center", not guaranteed; days 44-74 redemption, **UI only**; days 75-79 pending delete; day 79+ released. Registration Agreement: post-expiry Name.com "may direct the domain name to nameservers ... that host a parking page", may change RDDS registrant, and "may auction off the rights to expired domain name services". | domain-renewals-expiration guide ; Registration Agreement |
| Redemption fee | Registry-specific; see restore column in section 5 (120-200). Non-refundable. | pricing feed ; Refund Policy |
| 60-day lock after registration | "new registrations are transfer-locked for 60 days by default, regardless"; `transferLockExpiresAt` returned; Create Transfer returns `409` for domains registered under 60 days (changelog 1.9.3). ICANN Transfer Policy: transfer may be denied if "requested within 60 days of the creation date" (https://www.icann.org/en/contracted-parties/accredited-registrars/transfer-policy-01-06-2016-en, the 2016 text; ICANN notes an updated version was published 2024-02-21 and I did not re-verify clause numbering). | Quickstart ; changelog |
| Lock after registrant change | Domain-locks guide: "TransferLock ... Triggered by new domain registrations, transfers into name.com, and specific contact updates (unless the registrant opts out of the 60-day lock)." `transferLockExpiresAt` covers "material registrant contact change". An API-level opt-out: **unverified**. Registration Agreement: "You explicitly authorize us to act as your 'Designated Agent' ... to approve each 'Change of Registrant'". | domain-locks guide ; Registration Agreement |
| Contact verification | ICANN 15-day verification after registration or registrant email/name/org change. Reseller domains unverified after 15 days: `VerificationHold` (small/medium resellers: redirected to a name.com landing page explaining the requirement) or `VerificationClientHold` (high-volume: removed from DNS). ccTLDs excluded: "This validation is required by ICANN for all TLDs except country-code TLDs". Unverified contacts appear in the API "up to ~10 minutes" after change. | domain-locks ; contact-verification ; setContacts |
| Auth code delivery | API `GET :getAuthCode` returns it inline; registrant can also get it in the account UI. | external-transfers-flow |
| Transfer-in duration and approval | Registration Agreement: "Transfer requests typically take five (5) business days to be processed"; "Only the registrant and the administrative contacts listed in the RDDS information may approve or deny a transfer request". Exact auto-approval timing per TLD: unverified. Transfer-in fee is charged up front and refunded to account credit on cancel; refundable "as long as the transfer has not completed". | Registration Agreement ; Refund Policy ; cancel-transfer |
| Outbound transfer handling and fees | Only gaining registrar initiates; API can unlock, hand over the auth code, and cancel a pending transfer-out. No transfer-out fee is documented (**unverified**). Losing-registrar FOA/notification emails are ICANN-required (sent by Name.com unless you took over notices). | external-transfers-flow ; registrant-communications |
| Registrant-change behaviour | `setContacts` replaces all four contacts at once, may trigger email verification (gTLDs) and the 60-day lock; ICANN confirmation emails to old and new registrant required. | setContacts ; registrant-communications |
| ccTLD differences (.ai, .io) | No contact verification; refunds never; .ai two-year minimum; Name.com "may, in our sole discretion, choose not to participate in the RGP process with respect to any or all of your ccTLD domain name registration services"; transfer/lock/RGP rules are registry-specific (details unverified). Registry facts: .ai delegated to Government of Anguilla (IANA record updated 2025-02-11, RDAP server `https://rdap.identitydigital.services/rdap/`); .io ccTLD manager Internet Computer Bureau (IANA record updated 2023-01-18). .io long-term risk: "After the transfer [of the Chagos Archipelago], current IANA rules may require the .io domain to be phased out, which would take at least 5 years" (Wikipedia, secondary source, https://en.wikipedia.org/wiki/.io). | IANA ; Wikipedia |

---

## 7. WHOIS PRIVACY AND RDAP REDACTION

- **Free**: "Whois Privacy is free and is included when `privacyEnabled` is true and the TLD supports it" (https://docs.name.com/guides/domain-pricing); "WHOIS privacy is free for API users and does not add a fee" (Purchase Privacy); pricing page "Advanced Security: $0.00". Product is now called Domain Safe (formerly Advanced Security).
- **Default**: if `privacyEnabled` is omitted "the account default from account settings is used" (Create Domain). The account default itself is not documented (**unverified**); set the flag explicitly.
- **API control**: yes, at create (`privacyEnabled`), by `PATCH /core/v1/domains/{d}` (`privacyEnabled`), `POST :purchasePrivacy` (`409` if already active; `422 "TLD does not support WhoIs Privacy"`), and per-TLD `supportsPrivacy` in TLD requirements. Create Domain honours an explicit `false` (changelog 1.8.2).
- **Contract**: to resell the privacy service "which lists proxy contact information in the RDDS database", both you and each customer must agree to the Whois Privacy Service Agreement (RSA).
- **What the public sees**: for a privacy-enabled name.com domain (name.com itself) RDAP shows registrant "Redacted For Privacy", org "Domain Protection Services, Inc.", and a contact-URI form at `https://www.name.com/contact-domain-whois/name.com` (https://namerdap.systems/domain/name.com). RDAP of the registry shows the registrar (IANA 625) and `abuse@name.com`. The output for a privacy-disabled domain: **unverified**. Policy context: ICANN Registration Data Policy, effective 21 August 2025, revised 12 May 2026: registrars "MUST apply the requirements of Section 9.2 in RDDS if redaction ... is required in order to comply with applicable law" and "MAY" otherwise with a commercially reasonable purpose (https://www.icann.org/en/contracted-parties/consensus-policies/registration-data-policy).
- **Also**: the docs note a customer-controlled "PrivacyLock" (a security lock, 2FA required) that "cannot be managed via the API" - distinct from WHOIS privacy.

---

## 8. NOTIFICATIONS

- **Webhooks** (https://docs.name.com/api/v1/reference/webhook-notifications/overview): `POST /core/v1/notifications` with `{eventName, url, active}`; one subscription per event name (`409` if duplicate). Events: `account.credit.balance_change`, `account.domain.removal` (reasons include expiration, agp_refund, administrative), `domain.lock.status_change` (with `registryStatuses`), `domain.transfer.status_change` (transfer-in), `domain.transfer_out.status_change`, `domain.transfer.internal_in`, `domain.transfer.internal_out`, `contact.verification.status_change`, `domain.registry.rejection`, `domain.registry.compliance_notice`, `domain.expiration`. Respond `2xx`. Works in sandbox.
- **Signature**: header `X-NAMECOM-SIGNATURE: sha256=<hex>,<timestamp>,<nonce>`; HMAC over `<full_webhook_url>|<sorted_json_payload>` keyed with **the account's earliest API token** (there is no separate webhook secret; rotating or deleting that token breaks verification) (https://docs.name.com/guides/hmac-examples; changelog 1.23.1).
- **Not available**: no events for registration success, renewal success/failure, auto-renew charge, or DNS changes. Delivery retry/backoff policy is **not documented** (unverified); "Webhook delivery failure does not fall back to email" for compliance notices.
- **Polling fallbacks**: `GET /core/v1/domains` (expireDate, locks), `GET /core/v1/transfers`, `GET /core/v1/orders`, `GET /core/v1/contacts/unverified`, `GET /core/v1/accountinfo/balance`.
- **Adapter implication**: reconcile daily with a paginated domain list; treat webhooks as hints.

---

## 9. RED FLAGS

1. **Outages** (https://status.name.com, `api/v2/incidents.json`, accessed 2026-09-29): 2026-04-29 API outage, postmortem: "The api.name.com endpoint was unreachable ... (~96 minutes)"; cause "unanticipated 50x surge in traffic to a specific, heavyweight API endpoint" saturating "the shared writer database"; mitigated with Cloudflare WAF rate limiting. 2025-11-18 "Website and API Outage" (restored ~14:22 UTC). 2026-07-24 short degradation (about 15 min, "service provider issues"). 2026-07-11 18-minute registration/renewal errors on Identity Digital TLDs. 2026-05-05 DENIC DNSSEC disruption (.de). Status page listed only 6 incidents in the last year.
2. **Pricing exposure**: default cost is retail; RSA has no price-lock; scheduled renewal increases already published (.com to 21.99 on 2026-10-31, .studio to 74.99 on 2026-10-06); Reseller Pricing Program "may modify or cancel the Program or any of the features of the Program without notice", "Name.com is the sole arbiter of eligibility", and tier can be adjusted "in its sole discretion at any time".
3. **Reseller-hostile terms**: 30-day no-cause termination; immediate termination without cure for several breach types; unilateral amendments (30 days); chargeback penalties and asset appropriation; Washington arbitration; liability capped at 12 months of fees; 7-year record retention with 2-business-day production duty; Name.com may contact your customers directly if you become "unavailable or unresponsive".
4. **Expiry exposure**: domains drop out of API inventory ~day 26 and restore is UI-only; Registration Agreement allows Name.com to change RDDS registrant, park, and auction expired names after the reactivation window; renewals are never refundable.
5. **Doc/contract inconsistencies**: (a) "no application" vs "select number of customers ... signed Access Form"; (b) renewals guide says pass idempotency keys on renew, OpenAPI lists none; (c) "default values are omitted" vs "always included"; (d) "Promo codes are not supported through the API" vs `promoCode` on Create Domain; (e) idempotency lifetime doc was wrong (12h then corrected to 1h on 2026-08-17); (f) `www.name.com/nameapi` claims "no fees" while default purchase limit and prepaid-balance rules apply.
6. **API churn**: v4 to Core migration ("Migrating from the v4 API to the name.com API (CORE) is a breaking change"); v4 "will sunset at a predetermined time in 2026" (no date given); Core went from 1.0.0 (2025-05-12) to 1.34.0 (2026-09-10), including behaviour changes (per-domain registration rate limit added 2026-07-06 without contract change; blocked all `.in` TLDs 2026-01-27). Deprecated: `:lock`, `:unlock`, `:enableAutorenew`, etc.; SearchStream removed.
7. **Vertical integration**: name.com is "a proud part of Identity Digital", which operates .studio, is the back end for .ai (RDAP) and owns Internet Computer Bureau (.io) per Wikipedia. Concentration risk and potential conflict, but no adverse behaviour was found.
8. **Bot-protection**: parts of www.name.com sit behind Cloudflare challenges (bursts of page requests returned HTTP 429 or 403 challenge pages, for example `/abuse`); relevant to human ops and scraping, not to the API host.
9. **Developer complaints**: none found in primary sources. Only anecdotal precedent: HN 2022 "Takingnames.io Beta" describes the same business model ("Domains are purchased on the home page through Stripe. Once payment is received, we then purchase the domain using the Name.com API", https://news.ycombinator.com/item?id=29815575). Systematic review of forums/GitHub issues not done (GitHub API returned 403; search budget exhausted).
10. **Not in the API**: DNS record types beyond the eight listed (no CAA); no restore; no webhook for DNS/renewal; single account-wide token with no documented scopes.

---

## 10. RECOMMENDATION

**Role: FALLBACK.** Name.com is the most transparent option to build against right now: a self-serve account and sandbox with $100,000 of test credit, an OpenAPI 3.1 spec and an MIT-licensed TypeScript SDK, an explicit RSA that allows resale under your own brand and prices, idempotent registration, hosted DNS with per-record CRUD, signed webhooks for transfers, locks, expiry and registry rejection, and named production platforms (Vercel, Netlify, Lovable, Replit). What keeps it from primary is economics and control: a new account pays Name.com's standard retail price, so a "wholesale plus one flat fee" promise would price Mosshatch above buying at name.com directly until Mosshatch reaches the Bronze tier ($1,000 spend and 100 new registrations in 365 days, discount percentage unpublished) or negotiates a rate card; renewals are already scheduled to rise (.com to 21.99, .studio to 74.99); 3,000 requests/hour per account is a hard ceiling for a shared platform account; restore and redemption exist only in the web UI and expired domains disappear from the API after about 25 days; renew lacks an idempotency key; and the RSA lets Name.com change terms in 30 days, end the relationship on 30 days' notice for no reason, and seize domains after a chargeback. Choose customers (not Mosshatch) as registrants of record only after arranging white-labelled ICANN emails or the email-responsibility addendum, otherwise default to Mosshatch as contact and accept the legal-notice exposure. Promote to primary only if reseller@name.com confirms in writing (a) a rate card or tier discount below retail with a price-change notice period, (b) higher rate limits or sub-accounts, and (c) how .ai/.io renewals and refunds behave.

---

## 11. Suggested first actions (not part of research scope, derived from findings)

1. Email reseller@name.com: rate card, notice period for price changes, rate-limit increase, sub-account access, whitelabel emails, .ai renewal term.
2. Create sandbox credentials and exercise: checkAvailability x 6 TLDs, register with idempotency replay, `GET tldpricing`, webhook subscription and HMAC verification, `GET /domaininfo/requirements/{tld}` for each of the six TLDs (values for `allowedRegistrationYears`, `expirationGracePeriod`, `supportsPrivacy`, `hsts`).
3. Decide the registrant model before writing terms of service (RSA requires customer acceptance records kept 7 years).

---

## 12. UNVERIFIED (could not be established from primary sources)

- Reseller Pricing Program discount percentages per tier; any negotiated wholesale price; whether an API account really has no application step.
- Whether public promo prices (.com 12.99, .io 53.99, .dev/.app 14.99, .studio 21.99) are charged on API orders.
- Per-TLD values behind authentication: `allowedRegistrationYears`, `expirationGracePeriod`, `supportsPrivacy`, `hsts`, required contact fields for .ai and .io; whether .ai renews in 1-year steps; whether the six TLDs exist in sandbox.
- Webhook retry policy; token scoping or read-only tokens; current status of the IP allow-list feature; how the "$2,500 default purchase limit" is applied (per order or total).
- Whether an API-level opt-out of the 60-day post-registrant-change lock exists; whether auth codes are issued during lock; exact transfer-in auto-approval periods for .ai/.io; any transfer-out fee.
- RDAP output for a privacy-disabled name.com domain; account default for privacy.
- Name.com abuse intake process (`/abuse` blocked by bot protection); the `name.dev` guides site (connection reset via proxy, not a policy rejection).
- Independent developer complaints (search budget exhausted; GitHub API 403).
- ICANN Transfer Policy current clause numbering (2016 text read; updated version published 2024-02-21 not re-read).

---

## 13. Source index (all accessed 2026-09-29)

| # | URL | Used for |
|---|---|---|
| 1 | https://docs.name.com/llms.txt and every `.md` page linked from it (local copies in `namecom/md/`) | API behaviour, guides |
| 2 | https://docs.name.com/api/v1/overview | Base URLs, auth, rate limits, error notes |
| 3 | https://docs.name.com/api/v1/namecom.api.yaml (v1.34.0) | Endpoint list, schemas, idempotency header coverage |
| 4 | https://docs.name.com/api/v1/changelog | Change history, 1.34.0 dated 2026-09-10 |
| 5 | https://docs.name.com/guides/testing-environment | Sandbox |
| 6 | https://docs.name.com/guides/quickstart ; /guides/domain-pricing ; /guides/getting-started ; /guides/authentication ; /guides/migration-guide ; /guides/quickstart-recommended-tlds | Reseller flow, pricing, auth |
| 7 | https://docs.name.com/guides/registrant-communications ; /guides/contact-verification ; /guides/domain-locks | ICANN duties, locks |
| 8 | https://docs.name.com/guides/domain-renewals-expiration ; /guides/external-transfers-flow ; /guides/refunds-flow | Lifecycle |
| 9 | https://docs.name.com/guides/funding-your-namecom-account ; /resources/faq ; /guides/hmac-examples ; /sdks | Funding, FAQ, webhooks, SDKs |
| 10 | https://www.name.com/policies/api-reseller-agreement | RSA (read from `_nuxt/DG18NICY.js`) |
| 11 | https://www.name.com/policies/api-access-agreement | API Access Agreement (`_nuxt/DffIiKU_.js`) |
| 12 | https://www.name.com/policies/reseller-pricing | Reseller Pricing Program (`_nuxt/BlG9FYeC.js`) |
| 13 | https://www.name.com/policies/registration-agreement | Registrant terms (`_nuxt/Iz6hP86S.js`) |
| 14 | https://www.name.com/policies/refund | Refund policy, last updated April 1, 2026 (`_nuxt/DG3_37Xa.js`) |
| 15 | https://www.name.com/policies/subpoena | Legal process (`_nuxt/C4MHhkR8.js`) |
| 16 | https://www.name.com/nameapi ; /nameapi/contact ; /support/articles/205934767-name-com-reseller-program | Program marketing, custom pricing |
| 17 | https://www.name.com/pricing and https://www.name.com/ajax/pricing/?duration=1&tlds=com,ai,io,dev,app,studio (and duration=2) | Retail prices |
| 18 | https://www.name.com/api/ssr/sanity-document?type=tldLandingPage&slug={ai,io,com,dev,app,studio} | CMS pricing cross-check, ".ai two-year minimum" |
| 19 | https://status.name.com and https://status.name.com/api/v2/incidents.json | Incidents, maintenance |
| 20 | https://www.name.com/blog/how-to-resell-domains-via-an-api (2024-01-10) | Self-serve token flow, IP whitelisting |
| 21 | https://www.name.com/domain-transfer | Transfer prerequisites |
| 22 | https://www.iana.org/domains/root/db/{io,ai,dev,app,studio,com}.html | Registry/ccTLD manager records |
| 23 | https://rdap.verisign.com/com/v1/domain/name.com ; https://namerdap.systems/domain/name.com | Registrar ID 625, abuse contact, privacy redaction example |
| 24 | https://www.registry.google/domains/dev/ ; https://www.registry.google/domains/app/ | HSTS preload |
| 25 | https://www.icann.org/en/contracted-parties/accredited-registrars/transfer-policy-01-06-2016-en ; https://www.icann.org/en/contracted-parties/consensus-policies/registration-data-policy | Transfer lock rules, redaction policy |
| 26 | `npm view @namecom/core-api` | SDK version and dates |
| 27 | https://en.wikipedia.org/wiki/.io (secondary) ; https://news.ycombinator.com/item?id=29815575 (anecdotal) | .io retirement risk; precedent |
