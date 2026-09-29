# Registrar dossier: Porkbun (Porkbun LLC, ICANN IANA ID 1861)

Prepared for the Mosshatch Phase 0 plan. Research date and access date for every source below: 2026-09-29. Porkbun API version at time of research: 3.44 (header `X-API-Version: 3.44`).

## TL;DR

1. Recommendation: FALLBACK, not primary. Best-in-class API ergonomics (idempotency keys, `dryRun`, free sandbox, signed webhooks, 25-name bulk check, DNS restore points) at near-cost list prices, but there is no reseller program and Porkbun's own API doc says the API "does not establish a reseller relationship".
2. Resale verdict: CONDITIONAL. Not prohibited anywhere I found, and the Domain Name Registration Agreement (eff. 2025-03-17) contemplates buying "on behalf of a third party" and "reselling", but every duty (customer acceptance evidence kept 3+ years, data-use notices) lands on Mosshatch and Porkbun can suspend at any time.
3. Adapter gaps (web UI only, no API): setLock, getAuthCode, startTransferOut, add-grace refund, redemption restore. No registry/EPP status codes in the public API. No webhook for expiry, deletion or transfer-out.
4. Money: API purchases spend prepaid account credit only (never a card per call). Hard caps: $100 per registration order (`ORDER_TOO_LARGE`), premium names not API-registerable/renewable, `.ai` has a 2-year minimum (about $165) which probably trips the $100 cap (unverified).
5. List prices 2026-09-29 (USD): .com 11.08; .ai 82.70/yr (2-yr min); .dev 8.75 promo then 12.87; .io 28.12 promo then 51.80; .app 8.75 promo then 14.93; .studio 11.84 promo then 32.44; restore fee +$200. Announced: .studio about $43 on 2026-10-06, .com about $11.81 on 2026-11-01, .io about $60 on 2027-01-19.
6. Lifecycle risk: auto-renew is on by default, but expired names can be parked, queued for third-party auction (about day 21) and removed from the account by day 35-45. Porkbun can also block orders (`ORDERS_BLOCKED`) or suspend "any and all Accounts".
7. Sandbox exists and is free (`pk1_sb_` keys, fake credit, webhooks delivered), but needs a Porkbun account, so per-TLD `apiRegisterable` for the six starter TLDs could not be confirmed here.
8. Limits: 1 create/renew attempt per second, 1000 successes per 24 h per account; bulk check 25 names per call, 200 names per 60 s.

Method note: the WebSearch budget for this session was exhausted (200 of 200) before this task began, so all discovery was by fetching primary URLs directly (Porkbun API spec and docs, legal pages, knowledge base, IANA, ICANN). GitHub search API, Reddit and Trustpilot were not reachable (403 or bot protection); see Unverified.

---

## 1. RESALE

### 1.1 Verdict: conditional

| Question | Finding | Evidence |
|---|---|---|
| Is there a formal reseller program? | No. No reseller, partner or wholesale page exists (probed `/reseller`, `/resellers`, `/partners`, `/partner`, `/wholesale`, `/enterprise`, `/business`, `/reseller-program`: all HTTP 404). The affiliate program is discontinued. The Privacy Policy mentions past "affiliate, reseller, or referral programs" only as a data-collection note. | `https://porkbun.com/affiliate` (accessed 2026-09-29): "The affiliate program has been discontinued." `https://porkbun.com/legal/agreement/privacy_policy` (accessed 2026-09-29): "If in the past you have joined one of our affiliate, reseller, or referral programs to earn commission..." |
| Does Porkbun say the API is a reseller channel? | It says the opposite. | API spec `info.description`, section "Intended use", `https://porkbun.com/api/json/v3/spec` and `https://porkbun.com/llms-full.txt` (accessed 2026-09-29): "The Porkbun API is not a reseller service as defined under ICANN's Registrar Accreditation Agreement (RAA). All domain registrations are processed directly by Porkbun as the registrar of record. The API is intended for managing domains within your own account or on behalf of clients, and does not establish a reseller relationship." |
| Does any contract forbid resale of domains? | Not found. The only resale prohibition in the Product Terms of Service is for the Email Service. | `https://porkbun.com/legal/agreement/product_terms_of_service` (eff. 2021-02-01; accessed 2026-09-29): "Any unauthorized resale of the Email Service provided is expressly prohibited." Nothing equivalent for domains in `https://porkbun.com/legal/agreement/domain_name_registration_agreement`. |
| Does any contract contemplate resale or purchase for third parties? | Yes, in the Domain Name Registration Agreement (DNRA, "effective March 17, 2025"), and it puts the compliance burden on the account holder. | Quotes in 1.2. |
| Is there an API terms-of-use document? | None found. The API is governed by the DNRA, Product ToS, the "Intended use" paragraph above, and registry conditions. | `https://porkbun.com/legal` index (accessed 2026-09-29) lists no API terms. |
| Wholesale tier? | No public wholesale tier. API quotes are retail list prices ("Porkbun sells most domains at cost"); only discount is the "ACH Only" reduced price list (about 3% lower). See section 5. | KB 266 and KB 181 (URLs in Sources). |
| Undocumented partner surface? | The OpenAPI spec says "All v3 POST endpoints (excluding partner-only routes)...". The public `/mock` index lists 9 routes absent from the spec: `/auth/login`, `/auth/getToken`, `/abuse/test`, `/abuse/getRegistrantDetails/{email}`, `/abuse/getDomainDetails/{domain}`, `/abuse/setDomainStatus`, `/abuse/sinkholeDomain`, `/abuse/enableAccount/{email}`, `/abuse/disableAccount/{email}`. These are trust-and-safety routes, not reseller routes. Availability to ordinary customers is unknown. | `https://api.porkbun.com/api/json/v3/mock` (accessed 2026-09-29) vs `https://porkbun.com/api/json/v3/spec`. |

### 1.2 Governing clauses (DNRA, `https://porkbun.com/legal/agreement/domain_name_registration_agreement`, accessed 2026-09-29)

- Purchase on behalf of third parties, customer acceptance, evidence retention: "In the event You are purchasing a domain name on behalf of a third party, You agree not to represent that You are an ICANN-accredited registrar, unless you have written permission from ICANN to do so, or that You are in any way providing superior access to the ICANN Domain Name Registry. ... You agree to obtain each of your customers' acceptances to the then current version of this Agreement, and to retain evidence of their acceptance for a period of not less than three (3) years. Should you require that your customers accept additional terms and conditions that are not required by Porkbun, You agree that such additional terms and conditions shall not conflict with this Agreement and the policies and procedures adopted by ICANN."
- Reselling and personal data notices: "If You engage in the reselling of domain names You agree to provide any individuals whose personal information You have obtained, information about the possible uses of their personal information pursuant to ICANN policy. You also agree to obtain consent, and evidence of consent, from those individuals for such use of the personal information they provide."
- Licensee model (account holder stays registrant): "If You intend to license use of a domain name to a third party, You shall nonetheless be the registered name holder of record and shall be responsible for providing Your full contact information ... You shall accept liability for any harm caused by wrongful use of the registered name, unless You disclose the current accurate contact information provided by the licensee and the identity of the licensee within seven (7) days to a party providing You reasonable evidence of actionable harm."
- Third-party data: "If, in obtaining Services, You provide information about or on behalf of a third party, You represent and warrant that You have (a) provided notice to that third party ... and (b) obtained the third party's express written consent".
- Agent for registrant changes: "You agree that Porkbun has the authority to act as your Designated Agent as defined in ICANN's Transfer Policy."
- Suspension and termination at will: "Porkbun may terminate or suspend this Agreement or any part of its Services at any time, and without notice to You, in the event of a breach of this Agreement or if termination or suspension is or becomes required by any policy of ICANN, and applicable law, or by any governmental authority." Also: "Porkbun, in its sole discretion and without liability to You ... may take immediate corrective action, including ... deletion, suspension, cancellation, termination ... of Your Account ... if Porkbun determines that ... (ii) Your conduct may harm Porkbun or others ... or (iv) for any other lawful reason".
- Chargeback blast radius: "In the event of a charge back by a credit card company ... We may suspend access to any and all Accounts You have with Us, and all interests in and use of any Services, including without limitation domain name registration services".
- Unilateral fee changes: "You agree to pay ... the applicable Service fees set forth on the Pricing Page, as may be amended from time to time". Renewal price: "the then-current renewal price may be higher or lower than the price You paid".
- Liability cap: "IN NO EVENT SHALL PORKBUN'S AND/OR ANY REGISTRY OPERATOR'S MAXIMUM AGGREGATE LIABILITY EXCEED THE TOTAL AMOUNT PAID BY YOU FOR THE SERVICES, BUT IN NO EVENT GREATER THAN FIVE HUNDRED DOLLARS ($500.00)."
- Indemnity: the account holder indemnifies Porkbun, ICANN and registry operators for "Your use of any domain name registered in Your name", third-party IP disputes, and registrant transfers processed under the agreement.
- Amendments: material changes bind 30 days after email notice, or immediately if driven by ICANN policy or law; "Your continued use of the Services following notification of a change ... indicates Your consent".

### 1.3 Who is the registrant of record, and who owes what

- The public API `POST /domain/create` has no contact fields (request body is `cost`, `agreeToTerms`, optional `whoisPrivacy`, `dryRun`; `https://porkbun.com/api/json/v3/spec`). By inference (not stated in one place), the new domain takes the account's "Registration Defaults" contact: KB 79 refers to "the default registrant contact information on your Porkbun account" for the transfer/registry contact creation step (`https://kb.porkbun.com/article/79-what-do-transfer-statuses-mean`, updated 2026-07-23). Unverified for `create` specifically.
- The registrant can then be changed with `GET /domain/getContacts/{domain}` and `POST /domain/updateContacts/{domain}`. Registration and contact change are two non-atomic calls. A registrant change "triggers the same material-change record and new-owner notice/verification email (no 60-day transfer lock is imposed)" (`https://porkbun.com/llms/domain`, `updateContacts`). So Porkbun emails the new registrant directly under Porkbun branding.
- Two possible models, both contemplated by the DNRA: (a) Mosshatch stays registered name holder and licenses use to the customer (DNRA "Agents and Licensees" clause; Mosshatch carries liability for wrongful use and must disclose the licensee within 7 days of an evidenced harm report); (b) customer becomes registrant, Mosshatch buys "on behalf of a third party" and must capture and retain (3+ years) the customer's acceptance of the then-current DNRA and registry conditions.
- ICANN-mandated notices: Porkbun itself sends renewal-reminder notices to "the registered name holder's primary email address" (about 1 month and 1 week before expiry, and 5 days after: DNRA "Domain renewal notification policy") and the contact-verification and change-of-registrant emails. Mosshatch must supply the RAA 3.7.7.4-style data-use notice and consent for individuals (DNRA clause above), show the ICANN registrant rights link that the DNRA references, and present the Additional Registration Requirements by TLD (`https://porkbun.com/legal/agreement/registry_conditions`).
- ICANN framing (analysis, not a Porkbun statement): RAA 1.24 defines a Reseller as an entity that "participates in Registrar's distribution channel ... (b) with Registrar's actual knowledge, provides some or all Registrar Services, including collecting registration data about Registered Name Holders, submitting that data to Registrar, or facilitating the entry of the registration agreement". RAA 3.12 then requires the registrar to "enter into written agreements with all of its Resellers". Mosshatch fits the definition; Porkbun's public position is that it has no reseller relationship. Practical consequence: Mosshatch should self-comply with RAA 3.12.1-3.12.7 (no ICANN logo, registration agreement containing the required notices, identify the sponsoring registrar, link to registrant education and the Registrants' Benefits and Responsibilities). Source: `https://www.icann.org/resources/pages/approved-with-specs-2013-09-17-en` (accessed 2026-09-29).

### 1.4 Abuse reports and legal process

- Abuse reports go to Porkbun (registrar of record) through a web form only: "All reports of abuse ... must be submitted through our Abuse Reporting Form ... we cannot accept any abuse reports via email"; "Porkbun only addresses DNS-related abuse in alignment with our ICANN contract. We cannot arbitrate content disputes or trademark issues." (`https://porkbun.com/legal/agreement/customer_service_abuse_policy`). "All well-founded reports of Illegal Use submitted to these contacts will be reviewed within 24 hours" (DNRA).
- Legal process and disclosure: `legal@porkbun.com`; "Porkbun will disclose registration data in response to a valid subpoena or court order issued by a court with jurisdiction over Sherwood, Oregon, USA"; response "within thirty (30) calendar days" (`https://porkbun.com/legal/agreement/data_disclosure_policy`). Third parties can message the registrant through a relay form (`https://kb.porkbun.com/article/154-how-to-contact-a-porkbun-registrant`), which forwards to the registrant email on file.
- Court orders and complaints: DNRA "If You or Your domain name is the subject of litigation, We may suspend your ability to use, update and/or transfer your domain name registrations, and/or we may deposit control of Your domain name record into the registry of the judicial body". Actions are taken against the account holder's domains without a reseller-specific escalation path.
- Blast radius: all customer domains sit in Mosshatch's single Porkbun account. One customer's abuse case can lead to account-level action (the hidden `/abuse/disableAccount/{email}` and `/abuse/setDomainStatus` routes suggest this is an operational tool; existence only, behaviour unverified).

### 1.5 Program requirements (what Porkbun does require of an API customer)

- No application, contract, minimum deposit or volume commitment. Requirements are: a Porkbun account with verified email and phone (`https://porkbun.com/api/json/v3/spec`, `/domain/create`: "Account email and phone must be verified"); possibly photo ID for a subset of new accounts (KB 225, `https://kb.porkbun.com/article/225-why-porkbun-id-verification`, updated 2026-06-19: "we have made the decision to require photo ID verification for a subset of new Porkbun accounts", via Veriff, submissions retained 15 days); prepaid credit in the account; per-domain or account-wide API opt-in ("By default each domain must be opted in to API access individually ... turn on Opt In All Domains", `https://porkbun.com/llms/guides/getting-started`).
- Discount/ACH: converting an account to "ACH Only" requires an email request and "as part of the process we will have you complete an ID verification" and a US bank (KB 181, updated 2025-09-03).
- A documented, sanctioned alternative integration: users bring their own Porkbun account and grant scoped keys (`POST /apikey/request` with PKCE; `POST /account/invite`; guide `https://porkbun.com/llms/guides/onboard-a-mobile-app-user`). That makes the customer Porkbun's direct customer, which conflicts with Mosshatch being the seller of record with its own Stripe checkout.

---

## 2. API COVERAGE (RegistrarAdapter)

Base URL `https://api.porkbun.com/api/json/v3` (IPv4-only alternative `https://api-ipv4.porkbun.com/api/json/v3`). Spec: `https://porkbun.com/api/json/v3/spec` (OpenAPI 3.0, 119 operations). All endpoint facts below are from that spec and `https://porkbun.com/llms-full.txt` unless noted.

| Adapter method | Support | Endpoint(s) | Caveats |
|---|---|---|---|
| checkAvailability (bulk names x TLDs) | yes | `POST /domain/checkDomain` with `{"domains":[...]}` (max 25); `POST /domain/checkDomain/{domain}` single | Expand names x TLDs client-side, chunk to 25. Budget 200 domains per 60 s per account (counted per domain) for bulk; single form 10 checks per 10 s. Response has three lists: `domains` (answered), `invalid`, `unresolved` ("neither available nor taken. Retry them"). `BULK_CHECK_TOO_MANY` >25; `BULK_CHECK_TOO_SLOW` for registry-heavy mixes (.de is one per command). Each answer carries price data. |
| quote (wholesale, renewal, premium detection) | yes (partial for restore) | Answers of `checkDomain`: `avail`, `price`, `regularPrice`, `firstYearPromo`, `premium`, `minDuration`, `additional.renewal`, `additional.transfer`. Public `GET /pricing/get?tlds=com,ai,dev,io,app,studio` (no auth). Binding quote: `dryRun:true` with `cost:0` on `/domain/create`, `/domain/renew`, `/domain/transfer` | `cost` in cents must equal the current price exactly (`COST_MISMATCH` names the expected value). `pricing/get` shows the current registration price (a promo price where a promo runs) and the regular renewal; use `checkDomain` `regularPrice`/`firstYearPromo` to distinguish. Premium is flagged but cannot be registered, renewed or transferred through the API. No restore/redemption price in the API. |
| register | partial | `POST /domain/create/{domain}` body `cost` (cents), `agreeToTerms:"yes"`, optional `whoisPrivacy` (boolean), optional `dryRun`; header `Idempotency-Key` | No inline contact (account default contact, then `updateContacts`). Premium not supported; "a single order cannot exceed $100 (`ORDER_TOO_LARGE`)"; funds = prepaid credit only. Registry-minimum term only (usually 1 year; .ai 2 years). Website-only TLDs (e.g. .us, .ca, .eu, .au) return `apiRegisterable:false` from `GET /domain/getRegistrationRequirements/{tld}`. Duplicate/retry: same key and same body within 24 h returns the original response with header `Idempotent-Replayed: true`; same key different body: 409 `IDEMPOTENCY_KEY_MISMATCH`; in flight: 409 `IDEMPOTENCY_KEY_IN_USE`. Without a key, retry behaviour is undocumented: reconcile with `GET /domain/get/{domain}` before re-sending. Success returns `orderId`, `balance`, `limits`. |
| renew | partial | `POST /domain/renew/{domain}` body `cost`, `dryRun`; `POST /domain/updateAutoRenew/{domain}` (accepts `domains[]`) | Preconditions: "Domain must be opted in to API access"; "registered more than 30 days ago"; "not ... successfully renewed within the last 30 days"; "Premium renewals are not currently supported via API"; always registry-minimum duration (no multi-year via API). |
| getDomain | partial | `GET /domain/get/{domain}`; `POST|GET /domain/listAll` (1000 per page, filters incl. `expiringWithinDays`, `autoRenew`, `apiAccess`); `GET|POST /domain/getNs/{domain}`; `GET /domain/getContacts/{domain}` | Fields: `domain`, `status` (documented value "ACTIVE"), `tld`, `createDate`, `expireDate`, `securityLock`, `whoisPrivacy`, `autoRenew`, `apiAccess`, `notLocal` (all flags integers since v3.31). No registry/EPP status codes (no `clientTransferProhibited`, `redemptionPeriod`, `pendingDelete`) in the public API. Nameservers are read live from the registry and are an unordered set. Domains past the renewal grace are "removed from your account" (KB 37), so expect `DOMAIN_NOT_FOUND` (inferred). Use public RDAP for registry statuses. |
| setLock | no | none | `securityLock` is a read-only flag (1 = transfer lock on). Lock/unlock is web UI only (green lock icon, KB 27). Since v3.23 new registrations are created locked (`clientTransferProhibited`): "A domain registered through `/domain/create` now comes back with the registrar lock applied". |
| listRecords | yes | `GET|POST /dns/retrieve/{domain}`; `/dns/retrieve/{domain}/{id}`; `/dns/retrieveByNameType/{domain}/{type}/{subdomain}` | DNS is hosted by Porkbun (section 7 / DNS note). |
| upsertRecord | partial | `POST /dns/create/{domain}`; `/dns/edit/{domain}/{id}`; `/dns/editByNameType/{domain}/{type}/{subdomain}`; bulk `POST /dns/import/{domain}` (max 500) | No native upsert. Create returns `DUPLICATE_RECORD` with `existingId` (adopt it); `RECORD_CONFLICT` for CNAME exclusivity; `SPF_CONFLICT` for a second apex SPF; `ZONE_RECORD_LIMIT` at 2,500. `editByNameType` "Replace[s] the content of all records matching the given subdomain and type"; SOA/NS excluded. A no-op edit now succeeds (v3.20) so converge loops work. TTL minimum "typically 600". `dryRun` supported on writes. Restore points: `GET /dns/history/{domain}`, `/dns/diff/...`, `POST /dns/restore/{domain}`. |
| deleteRecord | yes | `POST /dns/delete/{domain}/{id}`; `/dns/deleteByNameType/{domain}/{type}/{subdomain}` | By-name-type deletes all matching records. `dryRun` supported. |
| startTransferIn | yes | `POST /domain/transfer/{domain}` body `authCode`, `cost`, `dryRun`, optional `holdForDnsSetup`; hold flow `GET /domain/getTransferSetup`, `POST /domain/prepareTransfer`, `/dns/import`, `POST /domain/startTransfer`; `POST /domain/cancelTransfer` (refunds); `POST /domain/updateTransferAuthCode` | `.uk`, manage-only TLDs and premium not supported; typically "5-7 days". `TRANSFER_INIT_FAILED` refunds automatically. `/dns/scan` + `/dns/import` protect DNS during transfer. |
| getTransfer | yes | `GET /domain/getTransfer/{domain}`; `GET /domain/listTransfers`; webhook `domain.transfer.completed` | `status` enum NEW, PENDINGAUTH, PENDINGSUBMIT, PENDINGTRANSFER, DONE, CANCELED, INIT (PENDINGDNS in the hold flow). No failure/rejection webhook: poll. |
| getAuthCode | no | none | Web UI only: Domain Management, Details, "Get Authorization Code" (KB 27). Only the account owner can do it: "Unlock domains/Transfer domains/Generate authorization codes" is not available to subaccounts or authorized users (KB 242). |
| startTransferOut | no | none | Outbound transfer is started at the gaining registrar with the code from the web UI. The losing side can expedite only in the web UI ("Approve Transfer Out", KB 139); otherwise it completes by default after about 5 days. No API, no webhook. |

Other endpoints present (useful for Mosshatch): `GET /account/balance`, `GET /account/apiSettings`, `GET|POST /account/autoTopup`, `POST /account/topup`, `POST /domain/updateNs/{domain}` (`dryRun`), glue CRUD, DNSSEC DS CRUD, URL forwarding, `POST /ssl/retrieve/{domain}`, webhook management, `GET /domain/getRegistrationRequirements/{tld}`, `GET /dns/preflight/{domain}`. Not present: refund/delete-in-grace, redemption restore, lock setter, auth code getter, WHOIS-privacy setter after registration.

Auth and security: `apikey` + `secretapikey` in the JSON body, or `X-API-Key` / `X-Secret-API-Key` headers ("Header auth takes effect only when no body credentials are present"). Keys work with 2FA on. Per-key optional source-IP allowlist (CIDR, IPv4/IPv6; `IP_NOT_ALLOWED` 403) and per-key target-domain allowlist (exact match; `DOMAIN_NOT_ALLOWED` 403). A monthly API spend limit and low-balance alerts are set by the account holder on the website; `GET /account/apiSettings` reads them. HTTPS only (`INVALID_PROTOCOL`).

---

## 3. SANDBOX / OTE

- Exists: yes. A sandbox key is public `pk1_sb_...` / secret `sk1_sb_...`, created at `https://porkbun.com/account/api` (needs a Porkbun account; documentation page `https://porkbun.com/api/json/v3/documentation`, spec `info.description`). Same base URL: swap the key. Responses carry `"sandbox": true` and header `X-Porkbun-Sandbox: true`.
- Quote (spec): "Registrations, renewals, transfers, DNS, contacts, nameservers, glue, and DNSSEC are simulated against an isolated datastore; your account starts with fake credit (top up/reset via `/sandbox/topup` and `/sandbox/reset`). Availability and pricing reflect the real catalog so quotes match production."
- Helpers: `POST /sandbox/topup` (default 100000 cents = $1000, max 1,000,000), `POST /sandbox/reset` (wipes domains, DNS, orders, credit; re-grants $1000), `POST /sandbox/triggerWebhook` (fires any event type, including `domain.expiring`). Webhooks are delivered in the sandbox. `POST /account/topup` grants simulated credit in sandbox.
- Not simulated: hosting, email and closeouts return `SANDBOX_UNSUPPORTED`.
- No-credential option: `GET|POST /mock/<path>` returns schema-shaped examples (header `X-Porkbun-Mock: true`). The mock for `getRegistrationRequirements` returns a fixed `.us` example regardless of the TLD asked, so it cannot answer per-TLD questions.
- Unverified: whether simulated inbound transfers complete on a timer or stay pending; whether expiry/renewal-window behaviour can be time-shifted (only `triggerWebhook` is documented); whether sandbox enforces the $100 cap, the .ai 2-year term and the 30-day renewal rule.

---

## 4. RATE LIMITS AND OPERATIONAL CONSTRAINTS

| Item | Value | Source quote |
|---|---|---|
| Register / renew attempts | 1 per second per account (configurable per key) | "Attempt limit (default: 1 attempt per second per account)" (`/domain/create`); v3.30 "Corrected the documented attempt limit ... it is 1 per second, not 1 per 10 seconds". |
| Register / renew / transfer successes | 1000 per 86,400 s per account (configurable per key) | "Success limit (default: 1000 successful registrations per 86400 seconds per account)"; v3.28 "raised from 50 to 1000 per 24 hours". The spec's `x-ratelimit` note still says 50: stale. |
| Single availability check | 10 per 10 s per account | `/domain/checkDomain/{domain}` |
| Bulk availability check | 25 domains per call; 200 domains per 60 s per account | `/domain/checkDomain` |
| General per-key budget | "currently 20 requests per 2 seconds"; per-account budget on top | v3.28: "These are not being enforced yet ... responses carry `X-RateLimit-Mode: observe`". Enforcement status today unverified. |
| Other caps | `dns/import` 500 records per call; zone 2,500 records; `listAll` 1000 per page; `cloudflare/connect` 500 domains; API key request 20/h per IP; hosting 10 provisions/h | spec |
| Rate-limit signalling | HTTP 429, `code: RATE_LIMIT_EXCEEDED`, `Retry-After` (whole seconds), `X-RateLimit-Limit/Remaining/Reset/Window` | spec "Rate limiting" and "Guarantees" |
| Credit funding | API purchases use prepaid credit only. Auto top-up and `POST /account/topup` charge a saved card (card must be saved on the website): 5 per day, 20 per month, amount 500-50000 cents (set through the API max $500), counted against the monthly spend limit; with no limit set the ceiling is $100 per month for top-ups | spec `INSUFFICIENT_FUNDS`, `TOPUP_LIMIT_EXCEEDED`; `https://porkbun.com/llms/account`; KB 306 |
| Order size | Single API registration capped at $100 (`ORDER_TOO_LARGE`) | spec |
| Formats | JSON only; reads accept GET, writes POST with JSON; every response has `status`, `requestId` (UUIDv7), `X-Request-Id`, `X-API-Version`; `Link: rel="describedby"` to spec | spec |
| Errors | HTTP 400 with `status:"ERROR"`, `code`, `message`, `next_action{type,hint,retryable,url}`; 403 auth/allowlist; 404 `DOMAIN_NOT_FOUND`; 409 idempotency; 429 rate limit. "Branch on `code` / `type` / `retryable`, never on `message`." | spec "Guarantees" |
| Safe retries | Send `Idempotency-Key` (any string up to 255 chars) on every POST; stored 24 h. After 24 h reconcile by reading state (`domain/get`, `listAll`, `getTransfer`). Use `dryRun:true` before any billable call. | spec "Idempotency" |
| Stability policy | Path stays `/v3`; minor bumps "strictly additive"; changelog runs 3.1 to 3.44 with no removals listed | spec "Guarantees" and "Changelog" |
| Support path for higher limits | No public request path found; limits are "configurable per API key". The only support contact found is `support@porkbun.com`. | spec; `https://porkbun.com/contact` |

Design note (not verified against Vercel): the optional IP allowlist needs stable egress IPs; if Vercel functions have dynamic egress, rely on the domain allowlist and spend limit instead.

---

## 5. WHOLESALE PRICES (USD)

Basis: Porkbun publishes only retail list prices. `pricing/get` is described as "default domain pricing" and API orders must match the `checkDomain` quote exactly; no account-specific reseller or volume tier is documented (whether ACH-only prices flow into API quotes is unverified). Porkbun states "Our strategy is marking up $1 or less on all standard domain names, but Porkbun sells most domains at cost" and breaks .com down as wholesale $10.26 + ICANN fee $0.20 + credit card fees $0.62 = $11.08 (KB 266, `https://kb.porkbun.com/article/266-how-does-domain-pricing-work`, updated 2026-05-11 / "Updated October 10, 2025"). The only discount program is "ACH Only" pricing (US bank, ID verification, whole account or a subaccount). Live values below were fetched from `GET https://api.porkbun.com/api/json/v3/pricing/get?tlds=com,ai,dev,io,app,studio` on 2026-09-29 (response `coupons:[]` for all six) and match the HTML pricing page `https://porkbun.com/products/domains`.

| TLD | Register 1 y | Renew | Transfer in | Restore (redemption) | Promo vs regular and gotchas |
|---|---|---|---|---|---|
| .com | 11.08 | 11.08 | 11.08 | $200 + normal renewal | No promo. Announced increase 2026-11-01 04:00 UTC to about $11.81 (KB 201, updated 2026-05-27; blog table est. $11.81). ACH-only price 10.54. |
| .ai | 82.70 per year | 82.70 per year | 165.09 (includes a 2-year renewal) | $200 + normal renewal (per-TLD applicability unverified) | Porkbun: ".AI Domains require a minimum term of 2 years for registration and renewals. .AI transfers include a 2 year renewal." A 2-year registration is therefore about $165.40 (my arithmetic), which exceeds the API's $100 registration cap: likely blocked or website-only. Unverified. Blog table listed est. $84/$84/$167 from 2026-03-05, but the live price is still 82.70: blog figures are "estimated projections". ACH-only 80.65 / 161.29 transfer. ccTLD: no ICANN fee. |
| .dev | 8.75 (first-year sale) | 12.87 | 12.87 | $200 + renewal | Regular registration 12.87. HSTS preload (Google Registry): HTTPS only. ACH-only 8.27 / 12.30. |
| .io | 28.12 (first-year sale) | 51.80 | 51.80 | $200 + renewal (unverified for ccTLD) | Regular registration 51.80. Blog table: est. $60.00 from 2027-01-19. ccTLD (Internet Computer Bureau). ACH-only 28.12 / 50.40. |
| .app | 8.75 (first-year sale) | 14.93 | 14.93 | $200 + renewal | Regular registration 14.93. HSTS preload: HTTPS only. ACH-only 8.27 / 14.31. |
| .studio | 11.84 (first-year sale) | 32.44 | 32.44 | $200 + renewal | Regular registration 32.44. Blog table: est. $43.00 from 2026-10-06 (7 days after research date; about +33% on renewal). ACH-only 11.84 / 31.45. |

Source URLs: live API `https://api.porkbun.com/api/json/v3/pricing/get?tlds=com,ai,dev,io,app,studio`; list page `https://porkbun.com/products/domains`; per-TLD pages `https://porkbun.com/tld/{com,ai,dev,io,app,studio}`; ACH list `https://porkbun.com/products/domains_ach`; scheduled changes `https://porkbun.com/blog/upcoming-price-increases/` ("Prices shown are estimated projections. The final retail price may be slightly higher or lower."); restore fee on the pricing page footer: "Names recovered via the Redemption Grace Period will be assessed a domain restoration fee of $200 in addition to the normal renewal price."

Other price notes:
- Premium/reserved names: KB 41 says the registry premium price applies to "register, transfer, or renew"; the API does not register, renew or transfer premium names at all.
- Promo prices apply through the API (`firstYearPromo`, `regularPrice` fields in `checkDomain`); how long each promo runs is not published.
- Multi-year price lock: Porkbun suggests renewing up to 10 years to lock a price (KB 201, blog), but the API renews the registry-minimum term only.
- Card fees: the $0.62 card fee is embedded in list price; ACH-funded accounts get the reduced list.

---

## 6. LIFECYCLE

| Topic | Porkbun behaviour | Source |
|---|---|---|
| Add-grace period and refund | Website only (Details, "Refund Registration"; no API). KB: "we offer a four day (96 hour) grace period, where eligible domains can be deleted and refunded from within your account"; "a refund fee of 5%"; "Some TLDs do not qualify for refunds". DNRA gives a different frame: refund or credit within "the first five (5) days" at Porkbun's "sole discretion ... less the applicable deletion Fee". Conflict: 96 hours vs 5 days; plan on 96 hours. "All Fees are non-refundable" otherwise. | KB 293 (updated 2026-09-04); DNRA |
| Auto-renew | On by default: "When you register a domain at Porkbun, the automatic renewal setting will be enabled by default." Toggle via API `updateAutoRenew`. DNRA: auto-renewals take payment "from the payment method associated with Your account, or account credit if no payment method is specified"; "domain name renewal transactions are final, irreversible, non-refundable". The API doc says API purchases never charge a card, but that does not describe Porkbun's own auto-renew charge path: unverified which source Porkbun's auto-renew uses when both a card and credit exist. | KB 70; DNRA |
| Renewal grace after expiry | Renewable at the normal price with no fee from the expiry day. First 10 days: domain "should continue to function as normal". After day 10: Porkbun nameservers with an expiry notice, or `clientHold`, or a monetized parking page. About day 21: "may be submitted to third-party auction services". Days 26-37: may be at auction; "Once a bid is placed on a domain at auction it is removed from your account." Day 35-45 (typically 37-38): "the Renewal Grace Period ends and the domain is removed from your account". | KB 37 (updated 2026-03-20) |
| Redemption | After deletion, 30-day Redemption Grace Period via Porkbun Support only ("Please contact Porkbun Support"), normal renewal plus a restoration fee ($200 per pricing page; KB says the fee "varies by the registry"). Days 31-35: pending delete. DNRA also allows Porkbun to keep a lapsed name (extended redemption grace, 120 days) and to auction it. No restore endpoint in the API. | KB 37; pricing page; DNRA |
| Does Porkbun auto-renew on its own? | Yes (default flag, section above). | KB 70 |
| 60-day transfer lock after registration | Yes: DNRA "You agree that You may not transfer Your domain name registration to another domain name registrar during the first sixty (60) days from the effective date of Your initial domain name registration with Porkbun." ICANN Transfer Policy 3.7.5 allows denial when "requested within 60 days of the creation date". New API registrations start locked (v3.23). | DNRA; `https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers/policy` (updated 21 Feb 2024, implement by 21 Aug 2025) |
| 60-day lock after registrant change | Not imposed: DNRA "You also expressly agree to opt out of the 60 day inter-registrar transfer lock following any Material Change of registrant information or domain ownership" (except marketplace purchases). API `updateContacts`: "no 60-day transfer lock is imposed". Porkbun acts as Designated Agent. | DNRA; `https://porkbun.com/llms/domain` |
| Auth code delivery | Web UI only, account owner only (KB 27, KB 242). ICANN Transfer Policy 5.2 still requires the registrar to give the registered name holder the AuthInfo code "within five (5) calendar days of the Registered Name Holder's initial request" if no self-service exists: with the customer as registrant and no API, Mosshatch needs a manual or human-operated process inside that window. | KB 27; ICANN policy 5.2 |
| Transfer-in duration | API: "typically takes 5-7 days"; KB 56: "5 to 7 business days". ICANN: losing registrar silence for 5 calendar days is default approval (3.5); registry completes unless NACK within 5 calendar days (6.2). Losing-registrar email approvals go to the registrant contact (status `pending owner confirmation`). Bad auth code, locked domain, or under-60-day domain leaves statuses like "bad authcode, pending submit" / "domain status does not allow transfer". | spec; KB 56, KB 79; ICANN policy |
| Outbound transfer | Unlock and auth code in web UI; transfer completes about 5 days after the gaining registrar confirms, or immediately via "Approve Transfer Out". No outbound fee is stated in the DNRA or KB 27. DNRA: "a transfer reversal Fee of $120.00" for transfers of domains you do not validly own. | KB 27, KB 139, DNRA |
| Registrant change | Via API `updateContacts` (or web). Sends new-owner notice and verification email; `REGISTRANT_CHANGE_NOT_SUPPORTED` for .au name changes; address-validation flow for .de/.uk/.us/.ca/.eu/.in/.nz families. | `https://porkbun.com/llms/domain` |
| ccTLD differences (.ai, .io) | .ai: 2-year minimum on registration and renewal; ICANN fee not charged on ccTLDs; Porkbun warns that "Some country code TLDs may have drastically different expiration and deletion cycles" and "Some registries, such as the .ai registry, may auction off the domain to the highest bidder before releasing it". Registrant must obey registry terms (`nic.ai` for Government of Anguilla; ICB policies for .io). ICANN consensus policies (ERRP, RGP, Transfer Policy, UDRP) are gTLD contract policies; the ccTLD-specific grace, redemption and transfer rules for .ai and .io were not found in a primary registry document and are unverified. | KB 37; KB 266; `https://porkbun.com/legal/agreement/registry_conditions`; IANA `https://www.iana.org/domains/root/db/ai.html` and `.../io.html` |

---

## 7. WHOIS PRIVACY / RDAP REDACTION (and DNS hosting note)

- Free: yes. "Free WHOIS Privacy" is listed as included with every domain on the pricing and TLD pages.
- Default: on. KB 97: "WHOIS Privacy is enabled by default, meaning that if you register a domain and someone queries our WHOIS server, we won't show your actual contact info, nor will we send it to the registry". API: "WHOIS privacy is automatically enabled on new registrations (when the TLD supports it)". Some TLDs (e.g. .us) do not allow it. Modes in the UI: use privacy service, redact, make public.
- API control: set at registration only (`whoisPrivacy` boolean on `/domain/create`; account-level default in Account Security Settings on the website); read as `whoisPrivacy` flag in `domain/get`. No API setter afterwards.
- RDAP evidence: Porkbun's registrar RDAP server (IANA registrar ID 1861, "Accredited", `rdapurl` `https://cart-before.porkbun.horse/rdap/`, from `https://www.iana.org/assignments/registrar-ids/registrar-ids.xml`) returns entity fields as "REDACTED FOR PRIVACY" and an `email` that is a web contact-form URL (`https://cart-before.porkbun.horse/rdap/domain/PORKBUN.COM`, accessed 2026-09-29; this is Porkbun's own domain, used only to see the output format).
- Consequence: registry-visible registrant data is a proxy, so third parties reach the real registrant only through Porkbun's relay form or legal process.
- DNS hosting: Porkbun hosts DNS (nameservers `curitiba.ns.porkbun.com`, `fortaleza.ns.porkbun.com`, `maceio.ns.porkbun.com`, `salvador.ns.porkbun.com`, KB 63); the status page says "We use Cloudflare for DNS hosting". Record types include A, AAAA, CNAME, MX, TXT, SRV, CAA, ALIAS, HTTPS, SVCB, SSHFP; DNSSEC DS records; per-record CRUD (not replace-all); zone snapshots hourly on first write.

---

## 8. NOTIFICATIONS

- Webhooks exist (v3.3+): `POST /webhook/create` with `https://` on port 443, public hostname only; HMAC-SHA256 signature `X-Porkbun-Signature: sha256=` over `"{timestamp}.{rawBody}"` with `X-Porkbun-Webhook-Timestamp`; dedupe on `X-Porkbun-Webhook-Id` (UUIDv7).
- Event catalog: `domain.registered`, `domain.renewed`, `domain.transfer.completed`, `domain.expiring` ("fires at 60/30/5 days before expiry"), `dns.record.created`, `dns.record.updated`, `dns.record.deleted`, `cloudflare.connect.completed`, `cloudflare.connect.failed`.
- Delivery: at-least-once, "ordering is not guaranteed"; retries about 1m/5m/30m/2h/6h (6 attempts); 20 consecutive failures auto-disables the endpoint and emails the owner; delivery log retained about 30 days; `POST /webhook/resend`.
- Gaps: no events for transfer-out requested or completed, transfer failure or rejection, domain expired/deleted/entered redemption, lock or registrant or privacy change, credit low. Poll `listAll`/`get`, `listTransfers`, `account/balance`, and public RDAP. Whether `domain.transfer.completed` fires for outbound transfers is unverified.
- Email: Porkbun emails the registrant contact (renewal notices, verification, change-of-registrant, top-up receipts to the account holder).

---

## 9. RED FLAGS

1. Formal disclaimer of resale: "does not establish a reseller relationship" (spec). No agreement to sign, no partner contact, no SLA, no escalation path. Undefined status under RAA 3.12 for a channel that RAA 1.24 would call a Reseller.
2. Account-level single point of failure: `ORDERS_BLOCKED` ("This account cannot place new orders"), suspension "at any time, and without notice", chargeback suspension of "any and all Accounts", fees "amended from time to time", liability capped at $500.
3. Adapter-breaking gaps: no lock setter, auth-code getter, outbound-transfer, refund, or restore API; the ICANN 5-day auth-code duty becomes manual dashboard work by the account owner (who needs the Porkbun login and 2FA).
4. Expiry handling is aggressive for a consumer promise: third-party auction queueing from about day 21, removal from the account at day 35-45, parking/nameserver changes after day 10, and `apiAccess` opt-in needed for renewal. If Mosshatch credit runs dry, customer domains are at risk. Webhook `domain.expiring` at 60/30/5 days is the only proactive signal.
5. Funding friction: prepaid credit only; card top-up capped at 5 per day / 20 per month / $500 each and by the monthly spend limit; credit purchases must be done on the website for larger amounts; $100 per-order API cap; renewals refused within 30 days of registration.
6. Price volatility: announced .studio jump (about $32.44 to about $43 on 2026-10-06), .com to about $11.81 on 2026-11-01, .io to about $60 on 2027-01-19; promos (.dev/.app/.io/.studio) end without a published date. A flat Mosshatch fee must absorb these.
7. Strategic overlap: Porkbun markets an official MCP server, "For AI agents" page, per-key domain scoping, spend limits and dry runs (`https://porkbun.com/ai-agents`, `https://porkbun.com/mcp`, npm `@porkbunllc/mcp-server` 0.38.1 published 2026-09-25). This is close to Mosshatch's agent-with-approval value proposition; Porkbun could compete directly or tighten terms.
8. ID verification: a subset of new accounts must pass photo ID (Veriff); account push requires ID verification too. This is a KYC step for Mosshatch's own account, not for customers.
9. Undocumented `/abuse/*` and `/auth/*` routes exist (mock index only); rate-limit enforcement mode may change ("will be announced before it is switched on").
10. Developer sentiment is thin and old: Hacker News comments include "Porkbun api is pretty bad" (2023-06-18, `https://news.ycombinator.com/item?id=36380334`) and "Both have great API and fair pricing" (2024-04-28, `https://news.ycombinator.com/item?id=40188503`); the API has changed a lot since (v3.1 to v3.44). Treat as weak evidence.
11. Uptime evidence is limited: `https://status.porkbun.com/history` (7-day window 2026-09-22 to 2026-09-29) shows the Porkbun API component with 0 outages and 100% uptime; only cPanel Hosting 2 had outages. No longer history was retrievable.
12. Deprecations: none found. Changelog policy is additive-only within `/v3`.
13. Chosen-TLD risk not researched here: .io registry future (delegation record last updated 2023-01-18 per IANA) and .ai auction-before-release behaviour.

---

## 10. RECOMMENDATION

Role: FALLBACK. Porkbun has the most agent-friendly registrar API I found in this pass (spec v3.44 with idempotency keys, `dryRun` quotes, a free sandbox with signed webhooks, 25-name bulk checks, per-key domain/IP scoping, DNS restore points, and near-cost prices such as .com at $11.08), and the DNRA does not forbid resale and even tells an account holder how to buy "on behalf of a third party", so a low-volume Phase 0 build against the sandbox and a small live account is feasible. But it should not be the primary production registrar for a reseller: the API doc explicitly says it "does not establish a reseller relationship", there is no reseller agreement, wholesale tier, SLA or escalation contact, and the account holder alone carries the customer-acceptance record (3+ years), data-notice duties and liability, while Porkbun keeps rights to suspend or block orders at will. The RegistrarAdapter cannot be implemented in full: `setLock`, `getAuthCode` and `startTransferOut` (and add-grace refunds and redemption restores) exist only in the web UI, which turns ICANN's five-day auth-code duty into manual work, and expired names can be auctioned or removed from the account within 35-45 days. Registration is also constrained by prepaid credit, a $100 order cap (which the .ai 2-year minimum of about $165 likely breaks) and no premium support. Promote to primary only if Porkbun confirms in writing that white-label API resale is permitted, states how ICANN reseller duties are met, and lifts or works around the cap for .ai; otherwise keep it as the fallback and as the reference sandbox for the adapter tests.

---

## UNVERIFIED (could not be established from primary sources)

- Whether .com, .ai, .dev, .io, .app and .studio all return `apiRegisterable:true` and what `registrationDurationYears` is for each: `GET /domain/getRegistrationRequirements/{tld}` needs an authenticated call (returns `API_KEY_REQUIRED` without keys) and creating a sandbox key needs a Porkbun account, which this research did not have. The mock endpoint returns a fixed .us example.
- The exact `cost` and whether $82.70 for .ai is per year or per 2-year term in API quotes; whether a 2-year .ai order trips `ORDER_TOO_LARGE`; whether .ai/.io renewals and transfers are subject to the same $100 cap (the cap is documented for registrations).
- Whether domains created via API are automatically opted in to API access, or only when "Opt In All Domains" is on.
- Which contact a `/domain/create` call uses (inferred: account Registration Defaults).
- Sandbox behaviours: transfer completion timing, expiry simulation, and whether caps and minimum terms are enforced.
- Whether any discount, higher rate limit or reseller terms can be obtained by asking Porkbun (no public contact path beyond `support@porkbun.com`); whether ACH-only prices apply to API quotes.
- Whether the general per-key rate limit (20 requests per 2 s) is now enforced.
- Behaviour of a repeated `/domain/create` without an `Idempotency-Key` (undocumented).
- Whether `domain.transfer.completed` fires for outbound transfers; no event exists for expiry, deletion or transfer-out.
- Add-grace details per TLD (96 h with 5% fee per KB vs 5 days per DNRA; .ai/.io eligibility) and whether the $200 restore fee applies to ccTLDs.
- ccTLD (.ai, .io) registry grace, redemption and transfer rules; .io long-term registry status.
- Any ICANN Transfer Policy changes after the 2024-02-21 version (the ICANN page said contracted parties must implement by 2025-08-21; later GNSO changes not checked).
- Which payment source Porkbun uses for its own auto-renewals when both a card and credit exist.
- Historical outage record and developer complaints: WebSearch budget exhausted; GitHub search API path blocked ("sessions are bound to their configured repositories"), Reddit and Trustpilot returned 403/bot pages. Status history covers only 7 days.
- Purpose and availability of the hidden `/abuse/*` and `/auth/*` routes.

---

## SOURCES (all accessed 2026-09-29)

API and docs
- https://porkbun.com/api/json/v3/documentation (docs landing page, v3.44 features)
- https://porkbun.com/api/json/v3/spec (OpenAPI 3.0, v3.44; "Intended use", rate limits, idempotency, webhooks, changelog, error codes)
- https://porkbun.com/llms-full.txt, https://porkbun.com/llms/domain, /llms/dns, /llms/webhooks, /llms/sandbox, /llms/account (same content as flat markdown)
- https://porkbun.com/llms/guides/getting-started, /register-a-domain, /verify-a-webhook, /onboard-a-mobile-app-user
- https://api.porkbun.com/api/json/v3/pricing/get?tlds=com,ai,dev,io,app,studio (live pricing)
- https://api.porkbun.com/api/json/v3/mock and /mock/... (credential-free examples; route index)
- https://porkbun.com/mcp, https://porkbun.com/ai-agents; npm registry `@porkbunllc/mcp-server` 0.38.1 (modified 2026-09-25); https://raw.githubusercontent.com/oborseth/Porkbun-MCP/main/README.md

Legal and policy
- https://porkbun.com/legal (index)
- https://porkbun.com/legal/agreement/domain_name_registration_agreement (effective March 17, 2025)
- https://porkbun.com/legal/agreement/product_terms_of_service (effective February 1, 2021)
- https://porkbun.com/legal/agreement/registry_conditions
- https://porkbun.com/legal/agreement/customer_service_abuse_policy
- https://porkbun.com/legal/agreement/data_disclosure_policy
- https://porkbun.com/legal/agreement/privacy_policy
- https://porkbun.com/legal/agreement/ownership_officers (Porkbun LLC is a fully owned subsidiary of Top Level Design LLC)
- https://porkbun.com/affiliate ("The affiliate program has been discontinued.")

Pricing
- https://porkbun.com/products/domains, https://porkbun.com/products/domains_ach, https://porkbun.com/tld/{com,ai,dev,io,app,studio}
- https://porkbun.com/blog/upcoming-price-increases/

Knowledge base (https://kb.porkbun.com/article/...)
- 307-getting-started-porkbun-api, 308-ai-agent-safety, 306-ai-assistant-purchases-credit, 225-why-porkbun-id-verification, 266-how-does-domain-pricing-work, 201-why-did-com-prices-go-up-and-how-high-will-they-go, 156-why-does-my-domain-name-price-increase-after-1-year, 41-what-is-a-premium-domain, 181-how-save-even-more-by-paying-with-ach-bank-transfers, 27-how-to-transfer-domain-from-porkbun-to-another-registrar, 139-how-to-approve-an-outbound-transfer-from-porkbun, 56-how-to-transfer-a-domain-to-porkbun, 79-what-do-transfer-statuses-mean, 37-what-happens-after-a-domain-expires, 293-can-domain-names-be-changed-or-refunded, 70-how-to-turn-off-auto-renew, 97-how-to-configure-whois-privacy-service-porkbun, 63-how-to-switch-to-porkbuns-nameservers, 154-how-to-contact-a-porkbun-registrant, 72-how-to-push-a-domain-into-another-account, 242-subaccounts-vs-authorized-users

Standards, registries, status
- https://www.icann.org/resources/pages/approved-with-specs-2013-09-17-en (2013 RAA: 1.24, 3.7.7, 3.12)
- https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers/policy and https://www.icann.org/resources/pages/transfer-policy-2024-02-21-en (Transfer Policy: 3.5, 3.7.5, 5.2, 6.2)
- https://www.iana.org/assignments/registrar-ids/registrar-ids.xml (Porkbun LLC 1861 Accredited; RDAP `https://cart-before.porkbun.horse/rdap/`)
- https://www.iana.org/domains/root/db/ai.html, https://www.iana.org/domains/root/db/io.html
- https://rdap.verisign.com/com/v1/domain/porkbun.com and https://cart-before.porkbun.horse/rdap/domain/PORKBUN.COM (RDAP redaction format)
- https://status.porkbun.com/ and https://status.porkbun.com/history (rendered with headless Chromium)
- https://news.ycombinator.com/item?id=36380334, https://news.ycombinator.com/item?id=40188503 (developer sentiment, weak)
