# Registrar dossier: Dynadot (reseller channel: Global Domain Group LLC)

Prepared for the Mosshatch Phase 0 plan. Research date and access date for every source: **2026-09-29**. Raw captures (HTML, extracted text, the machine-readable API command feed, price extractions) are in `working-directory/research/dynadot/`.

Source IDs (S1, S2, ...) are defined in section 12 with full URL and access date. Quotes are verbatim from the fetched page.

## TL;DR

1. **Role: FALLBACK.** Resale is explicitly allowed through a free, application-gated Reseller Program; for reseller domains the sponsoring registrar is Global Domain Group LLC (IANA 3956), an affiliate of Dynadot Inc (IANA 472) (S4, S5, S9).
2. **Contract is one-sided:** GDG may amend without notice and "terminate this Agreement without notice, transfer any and all of Your customer accounts to Dynadot accounts" (S4). Dynadot ToU s3.1(b) and s13.1(b)(c) and GDG ToS s12.1(b)(c) conflict with white-label plus API-in-a-product and need written clarification.
3. **API (REST v2, Bearer key + HMAC X-Signature) covers 13 of 13 adapter methods fully or partly**, but the docs carry "Beta ... Avoid relying on it for critical production workflows" (S1); DNS has no record IDs (append / replace-all / delete-by-value); no raw EPP status codes; no idempotency key.
4. **Limits:** Regular tier is 1 thread and 60 req/min; `bulk_search` takes max 5 domains per request; 1,000 bulk searches/day; all orders draw on a prepaid balance (HTTP 402 when empty); auto top-up needs an account at least 1 year old (S1, S11, S24).
5. **Sandbox exists** (`api-sandbox.dynadot.com`, 10,000 test balance) but webhooks are not testable there and transfer/expiry/DNS simulation is undocumented (S1, S2).
6. **Prices (USD, public list, same for all spend levels since Jan 2025):** .com 10.88 reg/renew; .ai 85.60/yr with a 2-year minimum; .dev 8.00 promo then 12.50 renew; .io 28.89 promo then 53.50; .app 9.99 promo then 14.50; .studio 11.96 promo then 33.39. Public "Reseller" tab shows .dev 12.84 and .app 14.98 (unexplained) (S11, S12, S15).
7. **Lifecycle:** 5-day add grace (grace-delete capped at 10%, refunds are account credit, "New accounts cannot grace delete"), 30-day renewal grace, 30-day restore ($100.92 to $460.00), free full WHOIS privacy by default (S12, S13, S21).
8. **Gap:** .dev and .app are absent from Dynadot's own "Which TLDs does your API support?" list (updated 2026-01-13), although GDG's reseller TLD roster includes both; verify in the sandbox before committing (S19, S28).
9. **Notifications:** 11 signed webhook events, no documented retry policy; no public status page found (S1, S2, S29).
10. **To upgrade to primary:** get written answers to the open questions in section 11 (governing terms, .dev/.app API support, ICANN notice duties, real reseller price list).

---

## 0. Entities

| Entity | Role | Evidence |
|---|---|---|
| Dynadot Inc (IANA ID 472) | Retail registrar, runs the platform and API | IANA CSV row `472,Dynadot Inc,Accredited,https://rdap.dynadot.com/` (S9) |
| Global Domain Group LLC, "GDG" (IANA ID 3956) | Accredited registrar, "an affiliate of Dynadot Inc", counterparty of the Reseller Agreement, sponsoring registrar of reseller domains | IANA CSV row `3956,Global Domain Group LLC,Accredited,https://rdap.globaldomaingroup.com/` (S9); Reseller Agreement: "GDG is an affiliate of Dynadot Inc" (S4) |

Note: GDG's site footer says "Global Domain Group Inc." while the agreements say "Global Domain Group LLC" (S6, S5); the IANA record says LLC.

---

## 1. RESALE

### 1.1 Verdict: **conditional yes**

An independent company may resell to its own customers under its own brand and price, ordering through the API, **if it is approved into the Reseller Program (Dynadot) / GDG reseller channel and signs the reseller terms.** Evidence:

- Dynadot reseller page: "The Dynadot Reseller Program allows you to sell domain name registrations and domain management under your own brand using Dynadot's infrastructure." and "Complete Pricing Control: As the domain reseller, you'll have flexibility on domain registration, transfer, and renewal prices" (S7).
- GDG landing page: "Let your customers acquire domain names directly from your brand", "Expansive API", "A fully white-label solution, ensuring domains registered through GDG are not associated with a popular registrar." (S6).
- Reseller API surface exists: register/transfer_in accept `customer_id` - "The customer id field allows resellers to specify and label their own customer ID within the Dynadot system." (S2); legacy API has `set_customer_id` "(RESELLER ONLY)" and `list_domain` filter `customer_id` "(only resellers can use this parameter)" (S3).

Conditions and conflicts (must be resolved in writing before launch) are in 1.5.

### 1.2 Governing documents

| Document | Version / date | URL | What it governs |
|---|---|---|---|
| Dynadot Reseller Agreement (GDG and reseller) | Version date 2023-08-15 | https://www.dynadot.com/reseller-agreement | ICANN-driven reseller commitments, liability, termination (S4) |
| GDG Terms of Use / Service Agreement | Version date 2026-08-18 | https://www.globaldomaingroup.com/terms-of-service | Full reseller-oriented service agreement; Part I s3 "RESALE" (S5) |
| Dynadot Terms of Use / Service Agreement | Version date 2026-08-18 | https://www.dynadot.com/terms-of-use | Retail agreement; incorporated by the 2023 Reseller Agreement as "additional terms" (S8, S4) |
| ICANN 2013 RAA s3.7.7, s3.12, s3.18 | 2013-09-17 | https://www.icann.org/resources/pages/approved-with-specs-2013-09-17-en | What the registrar must flow down to resellers (S10) |

### 1.3 Load-bearing clauses (verbatim)

Reseller Agreement (S4, https://www.dynadot.com/reseller-agreement, accessed 2026-09-29):
- Parties: "This agreement ("Agreement") is between Global Domain Group LLC ("GDG"), a Californian limited liability company and you ("You"). WHEREAS, GDG is an affiliate of Dynadot Inc".
- Acceptance: "You agree to the additional terms and conditions in Dynadot's terms of use ... and amended by Dynadot from time to time without specific advance notice to You."
- Amendment: "This Agreement may be amended by GDG from time to time without specific advance notice to You."
- Registration agreement: "Every registration agreement used by You shall include all registration agreement provisions and notices required by the ICANN registrar accreditation agreement and all ICANN consensus policies, and shall identify GDG as the registrar or provide a means for identifying GDG as the sponsoring registrar, such as a link to the InterNIC Whois lookup service."
- Disclosure on request: "You shall identify GDG as the sponsoring registrar upon inquiry from Your customer."
- No ICANN logo: "You shall not display the ICANN or ICANN-accredited registrar logo, or otherwise represent Yourself as accredited by ICANN, unless You have written permission from ICANN to do so."
- Registrant education links: reseller must show the ICANN registrant-education link and the Registrants' Benefits and Responsibilities Specification.
- Privacy: "You shall provide notices and obtain consents equivalent to those enumerated under Part II (Privacy Policy) of Dynadot's Terms of Use from every one of Your customers whose personal data You supply to GDG and/or to Dynadot."
- Liability: "You shall remain liable for harm caused by the wrongful use of a domain name, unless You disclose the current contact information provided by Your customer and the identity of Your customer within seven (7) days to a party providing You with reasonable evidence of actionable harm."
- Termination / customer takeover: "GDG may, in its absolute and sole discretion, terminate this Agreement without notice, transfer any and all of Your customer accounts to Dynadot accounts and grant each customer independent control over the respective account and the respective domain name."
- Venue: California, San Mateo County; jury waiver; "Any cause of action related to this Agreement must be instituted within six months after the cause of action arose or be forever waived and barred."
- Not in the agreement: pricing, wholesale discounts, minimum deposit, volume commitments, SLA, price-change notice, data-processing terms.

GDG Terms of Use, Part I (S5, https://www.globaldomaingroup.com/terms-of-service, accessed 2026-09-29):
- s2.1: "You shall provide to GDG accurate and reliable contact details for every Registered Name Holder ("RNH") and correct and update them within seven (7) days of any change".
- s3 RESALE: s3.3 (registration agreement must include ICANN-required provisions "and shall identify GDG as the registrar"), s3.4, s3.6, s3.7 (same as above), s3.8 "You shall provide notices and obtain consents equivalent to those enumerated under Part II ... from every one of Your customers whose personal data You supply to GDG", s3.9 (7-day disclosure or remain liable).
- s4.2: "You shall pay all fees and assume all liabilities arising from the use of Your account, including but not limited to circumstances these where transactions and/or activities are caused, directly or indirectly, by unauthorized parties."
- s11.3: "You expressly appoint GDG as Your and Your customer's Designated Agent to approve any Change of Registrant request and to opt out of a 60-day lock."
- s7.3: GDG may "Delete, suspend, cancel, terminate, or otherwise interrupt any Service and/or Your account while investigating whether Your account is used in connection with any Objectionable Use Activity", in its "sole and absolute discretion".
- s1.4: "This Agreement may be amended by GDG from time to time without specific advance notice to You."
- s6.1: "GDG disclaims all warranties, express or implied, respecting the fee applicable to and the length of the renewal of any Service or portion thereof."
- s12.1 (API): reseller shall not "(b) distribute, transfer, grant sublicenses to, or otherwise make available the API (or any portion thereof, or any data derived out of its use) to third parties" or "(c) embed or incorporate in any manner the API (or any element thereof, or any data derived out of its use) into other applications or third parties". The same wording is s13.1 of the Dynadot ToU (S8).

Dynadot ToU (S8, https://www.dynadot.com/terms-of-use, accessed 2026-09-29), Part I s3.1 (aimed at ordinary account holders who resell a domain): "Prior to reselling a domain name to a third party: ... b) You shall notify that third party that You are neither a domain name registrar accredited by the Internet Corporation for Assigned Names and Numbers ("ICANN") nor an authorized reseller of Dynadot's Services; c) That third party shall furnish You with a written acceptance of this Agreement".

### 1.4 Is there a formal reseller program? What does it require?

| Item | Finding | Evidence |
|---|---|---|
| Formal program | Yes: "Reseller Program" page, Reseller Agreement, GDG reseller landing page, WHMCS module, dedicated account manager | S7, S4, S6, S26 |
| Application / approval | Yes. Dynadot: "You sign up by applying through Dynadot's reseller registration page, and your account must meet eligibility requirements such as having no existing domains or active orders. If your current account is not eligible, you can create a new, unused account to apply." and "Submit your application for review." GDG: "Just fill out the form at the top of this page and our team will assess and follow up with additional information." The GDG form asks classification (incl. SaaS Provider), position and expected domain portfolio size band. | S7, S6 |
| Cost to join | "Does it cost anything to join the reseller program? No, joining our reseller program is free!" | S6 |
| Contract | Reseller Agreement / GDG ToU (above); no negotiated MSA visible | S4, S5 |
| Minimum deposit / volume commitment | None published. Operationally every order is paid from prepaid balance: WHMCS listing "Sufficient account balance - all registrations, transfers, and renewals are billed against your Dynadot balance"; API returns 402 "Insufficient funds." Minimum prepay is "$5 USD"; prepay is "non-refundable". | S26, S2, S24 |
| Volume tiers | Since Jan 2025 "one-tier pricing": "Everyone is now receiving our previous Superbulk prices". Spend levels ($500/yr Bulk, $5,000/yr Super Bulk) now only change API concurrency/quotas and perks. | S15, S24, S1 |
| KYC | No program KYC published (unverified). `contact_kyc_status_changed` webhook and `create_cn_audit` relate to per-contact/per-TLD verification (e.g. .cn), with a failure code `reseller_set_failed` ("KYC status set to failed by reseller"). | S2 |
| TLD scope | Reseller page says "Various supported gTLD"; GDG roster lists 612 names including com, ai (CCTLD), dev, io (CCTLD), app, studio. | S7, S28 |

### 1.5 Who is responsible for what

| Question | Answer | Evidence |
|---|---|---|
| Registrant of record (Registered Name Holder) | The person whose data Mosshatch supplies as the registrant contact in `register`. The RAA requires "all Registered Name Holders to enter into ... registration agreement with Registrar" and the RNH "must be a person or legal entity other than the Registrar" (RAA 3.7.7). GDG ToU s2.1 speaks of "every Registered Name Holder" whose details the reseller supplies. Mosshatch stays liable for wrongful use unless it names the customer within 7 days (S4 "Reseller's customers" section, S5 s3.9). The reseller account is the party in contract privity with GDG; the domain sits in Mosshatch's Dynadot account. | S10, S5, S4 |
| Sponsoring registrar | GDG (IANA 3956) for reseller domains; RDAP at `https://rdap.globaldomaingroup.com/`. (Dynadot's FAQ text says "Dynadot acts as the accredited registrar"; the contracts and IANA say GDG - treat GDG as authoritative.) | S4, S9, S7 |
| Obtaining registrant acceptance of the registrar agreement | Mosshatch. Each Mosshatch registration agreement must "include all registration agreement provisions and notices required by the ICANN registrar accreditation agreement and all ICANN consensus policies, and shall identify GDG as the registrar". RAA 3.12: "Registrar must enter into written agreements with all of its Resellers"; 3.12.2 mirrors the same duty. | S4, S10 |
| Where Dynadot ToU s3.1(c) says the third party "shall furnish You with a written acceptance of this Agreement" | This retail clause conflicts with the reseller model (see below); the GDG ToU s3 replaces it with the flow-down clauses. | S8, S5 |
| ICANN-mandated notices Mosshatch must show | ICANN registrant-education link and Registrants' Benefits and Responsibilities Specification on any site "You operate for domain name registration or renewal"; RAA 3.7.5.4-3.7.5.6 also require deletion / auto-renew policy notice and RGP fee disclosure by the registrar's website - practically flowed down via the registration agreement. | S4, S10 |
| ICANN-mandated emails (expiry reminders, WHOIS accuracy verification, change-of-registrant, transfer confirmations) | **Unclear.** Dynadot help: "Dynadot will send all expiration notice emails to the address on file. You can also set up a separate renewal email". Webhook `whois_verification_required` field `verify_link`: "Not returned for reseller accounts." Whether Dynadot/GDG emails the end customer directly for reseller-account domains is unverified. Design so Mosshatch can send its own (webhooks `domain_expiring`, `whois_verification_required`). | S23, S2 |
| Change-of-registrant approvals | Reseller appoints GDG as designated agent for itself and its customers (s11.3). `set_contacts` returns 409 "Unable to create a new registrant change request because a pending request already exists. Please check your email for further instructions." | S5, S2 |
| Abuse reports | Public abuse intake is at the registrar: GDG form (https://www.globaldomaingroup.com/report-abuse: "we take all abuse complaints seriously"; "we may only reach out if we need more details"). Dynadot emails the account holder about complaints (copyright example: "we will send you an email notification of such receipt"). GDG/Dynadot can suspend in "sole and absolute discretion"; Mosshatch is told via webhook `domain_suspension_status_changed` (reasons include `abuse_report`, `whois_verification_failed`). Mosshatch needs its own abuse mailbox and the 7-day customer-disclosure process. RAA 3.18.1: "Registrar shall maintain an abuse contact". | S28, S30, S5, S2, S10 |
| Legal process (subpoena, court order, UDRP) | Lands at the registrar (GDG/Dynadot). Dynadot ToU Part II s7 gives a "registration data disclosure request" process to its DPO with 2-business-day acknowledgement and 30-day answer. Hand-off to resellers is undocumented (unverified). | S8 |

### 1.6 Conflicts and ambiguities to clear with Dynadot / GDG before launch

1. **Which terms govern** a reseller account created via dynadot.com (2023 Reseller Agreement + Dynadot ToU) versus via globaldomaingroup.com (GDG ToU 2026-08-18). Dynadot ToU s3.1(b) would force Mosshatch to tell customers it is "neither a domain name registrar accredited by ICANN nor an authorized reseller of Dynadot's Services", which contradicts the program.
2. **API clause s13.1(b)(c) / s12.1(b)(c)** ("make available the API ... or any data derived out of its use to third parties"; "embed or incorporate ... into other applications or third parties") read literally forbids showing API-derived availability/prices in a customer-facing product. Get a written statement that reseller use is permitted.
3. **Unilateral termination with customer-account transfer** (S4) and amendment without notice: ask for a notice period and a customer-migration path (transfer-out auth codes) on termination.
4. Does the program cover ccTLDs (.ai, .io) on the same terms? (Reseller page says "gTLD"; price tab and GDG roster list them.)

---

## 2. API coverage (one row per Mosshatch RegistrarAdapter method)

Base URL `https://api.dynadot.com/restful/v2/...` (sandbox `https://api-sandbox.dynadot.com/...`). Source for every row: S1 (overview) and S2 (machine-readable command feed behind the docs page: `https://www.dynadot.com/domain/api-document?getCommandInfoData=1&apiVersion=2.0.0`, 160 commands + 11 webhook events, saved locally as `cmdinfo-2.0.0.json`). The legacy query-string API (`https://api.dynadot.com/api3.json?key=...&command=...`, S3) is still documented and has the same commands.

The docs banner: "Beta Notice: This API documentation is Beta. Endpoints, fields, error codes, and behaviors may change without notice and backward compatibility is not guaranteed. Avoid relying on it for critical production workflows." (S1). The only changelog entry is v2.0.0 of October 9, 2025 (S1).

| # | Adapter method | Rating | Endpoint / command | Caveats |
|---|---|---|---|---|
| 1 | checkAvailability (bulk names x TLDs) | **partial** | `GET /domains/bulk_search` (`domain_name_list`, `show_price`, `currency`, `timeout` 1-60 s); single: `GET /domains/{domain}/search`. Legacy `search` (domain0..domain99). | Max per request: "Regular - 5, Bulk - 10, Super Bulk - 20" domains (legacy: 1 for regular, up to 100 for bulk/super bulk accounts). Daily bulk-search quota 1,000 (Regular) / 2,000 / 5,000 (S11). With `timeout`, each result carries `source` (registry or cache) and `confidence` (high or low) - i.e. results can be cached; final authority is `register` (409 "The domain is not available"). Per-item `details_error_message` such as "busy". 429 "Daily quota for the command has been reached." Changelog: "Search Access Restricted"; `power_search` "only available for specific accounts". Docs show a `requestBody` on GET; whether params go in query or body is unverified. |
| 2 | quote (wholesale + renewal price, premium detection) | **partial** | Same search/bulk_search with `show_price=true` -> `price_list[]` {currency, unit, `registration_price`, `renewal_price`, `transfer_price`, `restore_price`} and `premium` = yes / no / unknown. Catalogue: `GET /domains/get_tld_price` (`currency` required, `tlds`, `page`, `page_size`, `show_multi_year`) -> per-TLD 1-10 year register/renew prices, transfer, restore, grace fees, min/max duration, `price_level`. | Prices are for the calling account's `price_level`. Premium registration needs `register_premium: true` else 409 "This domain is a premium domain, please use register_premium option." Premium renewal pricing not documented. REST `renew` has no `price_check` (legacy `renew` does: `price_check` shows price without renewing). WHMCS review (Dec 2024): "Your module shows the registry premium domain as available" (S26). |
| 3 | register (contact, privacy flag, dup/retry behaviour) | **yes** | `POST /domains/{domain}/register` body `{domain:{duration, registrant_contact{...} or registrant_contact_id, admin/tech/billing equivalents, customer_id, name_server_list, privacy: off\|partial\|full (required)}, currency, register_premium, coupon_code}`. `X-Signature` required. | Response only `{domain_name, expiration_date}` (no order id). One domain per call ("bulk creations ... not supported"; legacy `bulk_register` takes 100). Paid from prepaid balance: 402 "Insufficient funds." Duplicate: 409 "The domain is already owned by your account and cannot be purchased again."; 409 "The domain is not available"; 409 "The domain is still active, please try again."; 500 "Domain requires further investigation: order created [order_id]." (indeterminate - poll); 503 "Registry connection busy/offline"; 502 downstream errors. .ai: 400 ".AI domains require a minimum registration period of 2 years for new registrations." 409 "The domain with trademark claims not supported by the api." No idempotency key (see 4.4). |
| 4 | renew | **yes** | `POST /domains/{domain}/renew` `{duration, year, currency, coupon, no_renew_if_late_renew_fee_needed}`; X-Signature required. | `year` (the current expiry year) is required and a mismatch returns 400 "Expiration year does not match." - a natural guard against double-renewal on retry. 409 "Order exists already." 400 "There is another command processing for {parameter}". 403 "This domain cant renew yet." 409 "The domain requires late renew fee, renew cancelled." when the flag is set. |
| 5 | getDomain (status, expiry, lock, NS, registry status codes) | **partial** | `GET /domains/{domain}` (X-Signature); `GET /domains/{domain}/nameservers`; list `GET /domains` (page, page_size, status filter). | Returns `expiration_date`/`registration_date` (ms epoch), `locked`, `disabled`, `udrp_locked`, `registrant_unverified`, `hold`, `privacy`, `renew_option`, `transfer_lock_end_date`, `glue_info` (nameservers + DNS), contact ids, and a Dynadot-vocabulary `status` ("active, deleted grace, transferaway, expired, moved (pull) ..."). **No EPP status-code array**: clientTransferProhibited must be inferred from `locked`, clientHold from `hold`; autoRenewPeriod vs redemptionPeriod vs pendingDelete are not distinguishable from `status`. |
| 6 | setLock | **yes** | `PUT /domains/{domain}/domain_lock` `{lock: bool}`; account-level `PUT /accounts/account_lock`. | Unlocking needs the "api skip lock agreement" switched on in the control panel: 409 "Unlock domain feature requires api skip lock agreement, you can enable or disable this in the control panel." Also 409 for auction lock ("usually 18 days"), buy lock ("about 30 days after the sale date"), installment lock, Afternic/Sedo holds. |
| 7 | listRecords | **partial** | `GET /domains/{domain}/records` (X-Signature) -> `glue_info.dns_main_list[]` / `dns_sub_list[]` {record_type, record_value1, record_value2, sub_host}, `ttl`. | **No record IDs**; one TTL for the whole domain (default 86400). If the domain is not on Dynadot DNS, `glue_type` shows the other mode (e.g. `name_servers`) and the DNS lists are absent. DNS is hosted by Dynadot (free "Advanced DNS Settings", S12). |
| 8 | upsertRecord | **partial** | `POST /domains/{domain}/records` `{dns_main_list (max 20), dns_sub_list (max 100), ttl, add_dns_to_current_setting}` | Default **replaces all** records; `add_dns_to_current_setting: true` appends. No in-place update: an "upsert" is delete-then-add (non-atomic) or a full replace with the whole desired set. Types: A, AAAA, CNAME, TXT, MX, CAA, plus SRV and NS (sub only), ANAME (main only), and Dynadot-only forward / stealth / email. Conflict rules per type (e.g. CNAME vs A). 409 "Cannot set DNS ... existing Email Settings"; 429 "The Dns Settings reached the upper limit." |
| 9 | deleteRecord | **partial** | `DELETE /domains/{domain}/records` body `{dns_main_list, dns_sub_list}` | Match by type + value(s), not by ID; returns `main_record_removed_count` / `sub_record_removed_count`. No X-Signature required for this call. |
| 10 | startTransferIn (auth code) | **yes** | `POST /domains/{domain}/transfer_in` `{domain:{duration:1, auth_code, contacts, privacy, name_server_list, customer_id}, transfer_premium, currency, coupon_code}` | 400 "The value for parameter duration can only be 1."; 409 "There is already a transfer request in progress for the domain [domain_name]."; 409 "Order exists already."; 409 premium needs `transfer_premium`. Fee paid from balance up front. REST response body is empty (legacy returns `OrderId`) - look up the order via `GET /orders` (`search_type=domain`). |
| 11 | getTransfer (poll or webhook) | **yes** | Poll `GET /domains/{domain}/transfer_status?transfer_type=transfer_in` -> `[{order_id, transfer_status, failed_reason, expiration_date, order_created_date, order_completed_date}]`; `GET /orders/{order_id}`; fix auth: `POST /orders/{order_id}/update_transfer_auth_code`; cancel: `POST /orders/{order_id}/cancel_transfer`. Webhooks: `order_completed`, `domain_status_changed` (`change_type` "domain transfer"). | Status vocabulary is undocumented in v2; legacy doc says `none`/`approved` can be cancelled, `waiting` = started, `auth code needed` = bad code. Webhooks cannot be tested in the sandbox. |
| 12 | getAuthCode | **yes** | `GET /domains/{domain}/transfer_auth_code?new_code=&unlock_domain_for_transfer=` (X-Signature) -> `{auth_code}` | Synchronous. 409 "The domain has the 60-day transfer lock." / "Domain expired or expiring, please renew the domain first." / UDRP-locked / in user auction; 404 "The domain is non-auth" for TLDs without auth codes. Legacy doc: "You must unlock your domain and account before requesting auth code." `unlock_domain_for_transfer` "Requires api skip lock agreement". |
| 13 | startTransferOut (or how outbound is approved) | **partial** | There is no "initiate" call (the gaining registrar initiates). Losing side: getAuthCode + setLock(false); when the gaining registrar submits, Dynadot creates a transfer-away order, emails the account holder ("a transfer away order will be created and the 'Transfer Away' email will be sent to you for confirmation") and fires webhook `domain_transfer_away` {domain, gaining_registrar, order_id}. Approve or deny with `POST /orders/{order_id}/authorize_transfer_away` `{domain_name, approve: bool}`. | If nobody acts, ICANN default applies: "Failure by the Registrar of Record to respond within five (5) calendar days ... will result in a default 'approval' of the transfer" (S25); Dynadot-specific timing unverified. No outbound transfer fee is stated anywhere in the sources. |

Other endpoints Mosshatch will need: `GET /accounts/info` (`account_balance`, `balance_list`, `price_level`, `total_spending`); `PUT /domains/{d}/privacy` (`privacy_level` off / partial / full); `PUT /domains/{d}/renew_option` (`reset` / `auto` / `donot`); `DELETE /domains/{d}/grace_delete`; `POST /domains/{d}/restore`; `PUT /domains/{d}/contacts`; `POST /contacts`; `PUT /domains/{d}/nameservers`; DNSSEC (`set_dnssec`, `get_dnssec`, `clear_dnssec`); `GET /orders` history (search by date_range, domain, order_id).

Reseller-only commands: the docs feed returns empty `resellerCommand` and `partnerCommand` arrays to anonymous viewers, so any reseller-specific REST commands are **unverified** (S2, and `api-document-v2.js` renders them only when present). One command family is explicitly closed to reseller accounts: `buy_expired_closeout_domain` returns 403 "The feature is currently not available to reseller accounts." and `place_auction_bid` "The auction type is not supported for the reseller program." (S2).

---

## 3. Sandbox / OTE

| Item | Finding | Evidence |
|---|---|---|
| Exists | **Yes** | S1 "Sandbox" section |
| URL | `https://api-sandbox.dynadot.com` (production `https://api.dynadot.com`); same paths, e.g. `.../restful/v2/domains/{domain}/search` and legacy `api3.json` | S1, S3 |
| Credentials | Dynadot account -> Tools -> API -> unlock account -> "Generate your API Sandbox Key and API Sandbox Secret Key ... please allow some time for the system to activate your sandbox keys and create your Sandbox account." Keys: "Production Key and Sandbox Key -> used for Legacy API and RESTful API. Secret Key and Sandbox Secret Key -> used for generating x-signature for RESTful API." | S1, S17 |
| Funding | "Your Sandbox account will be pre-funded with a balance of 10,000 in all supported currencies for testing purposes." | S1 |
| Coverage | Every command in the adapter table above is flagged `supportApiSandbox: true` in the feed. Not in sandbox: all 11 webhook events (`supportApiSandbox: "false"`), CNNIC privacy, aftermarket, site builder and email hosting commands. | S2 |
| Fidelity | "The API commands in the Sandbox environment are functionally the same as the production environment." but "Certain commands may differ from Production, and the Sandbox cannot fully simulate all possible complex scenarios found in the Production environment." Whether transfers complete, domains expire, or DNS resolves is **not documented (unverified)**. | S1 |
| Observed 2026-09-29 (unauthenticated probes, no account) | Both hosts answer. No Authorization header: HTTP **200** with `Content-Type: text/plain` and body `{"code":400,"message":"Bad Request","error":{"description":"The Authorization header not entered"}}`. Invalid bearer: HTTP 401 `application/json`. Missing signature on a sensitive call: HTTP 200 with body code 400 "This command requires X-Signature". Legacy bad key: `{"Response":{"ResponseCode":"-1","Error":"invalid key"}}`. | S27 |

---

## 4. Rate limits and operational constraints

### 4.1 Rate limits (S1, https://www.dynadot.com/domain/api-document, "Rate Limiting")
"Only 1 request can be processed at a time, so please wait for your current request to finish before sending another request."

| Price level | Thread count | Rate limit |
|---|---|---|
| Regular | 1 thread | 60/min (1/sec) |
| Bulk | 5 threads | 600/min (10/sec) |
| Super Bulk | 35 threads | 6000/min (100/sec) |

(The legacy page adds "premium bulk | 25 threads | 6000/min", S3.) Exceeding returns 429 "You have reached the maximum allowed requests within the concurrent limit of your account." / "Too many requests. Rate limit exceeded. Please try again after 60 seconds." Bulk = $500 spent in 365 days; Super Bulk = $5,000 ("prioritized API calls" is a Super Bulk perk) (S24). Domain Appraisal has separate daily caps (docs: 50/100/300 per day; price page: 10/100/1,000 - the two disagree; irrelevant to Mosshatch). Whether a reseller account gets a different level is unverified.

### 4.2 Authentication and security
- REST: `Authorization: Bearer <API key>`; `Content-Type: application/json` is "the only acceptable value"; `Accept` JSON or XML (S1).
- `X-Signature` (mandatory for "transactional requests" - register, renew, transfer_in, restore, domain_info, get_dns, set_dns, transfer_auth_code, locks, privacy, contacts, orders, get_info): Base64(HMAC-SHA256(secret, apiKey + "\n" + fullPathAndQuery + "\n" + xRequestId + "\n" + body)). Not required for `search`, `bulk_search`, `get_tld_price`, `get_nameserver`, `get_transfer_status`, `remove_dns` (S1, S2). The signed string has **no timestamp**, so signatures are replayable by anyone who captures a request; rely on TLS and IP allow-listing.
- `X-Request-ID` (UUID) is optional: "helps track and correlate requests across systems and logs" - it is **not** documented as an idempotency key (S1).
- Legacy API sends the key in the URL query string (`?key=[API Key]`), which leaks into logs (S3).
- IP allow-listing: single IPs and CIDR ranges are supported in the API settings page ("Only API requests originating within the specified CIDR range will be accepted."); "Please allow at least 10 minutes for your changes to be uploaded to the API server." (S17). Blocked callers get 403 "The request is not allowed from the current IP address. Please contact our support." (S2). Changelog Oct 9, 2025: "Reseller account no longer required to enter at least 1 IP to use API (RESTful API only)" (S1) - implying non-reseller accounts must. Vercel functions have no fixed egress IP by default, so a reseller account without an allow-list is the practical path.
- API keys are visible only after unlocking the account in the web UI (S17); webhook key and secret are generated on the same page (S18).

### 4.3 Formats, errors, batching
- Response envelope `{"code":200,"message":"Success","data":{}}` (JSON or XML). Documented codes: 200, 201, 202, 400, 401, 402, 403, 404, 409, 429, 500-504 (S1).
- **Inspect the body `code`, not just the HTTP status** (observed HTTP 200 with body code 400 above, S27).
- Timestamps are epoch milliseconds; contact phone needs country code (`phone_cc`) and number.
- Batching: "The bulk creations, updates, deletes are not supported, and each of those request type is limited to one object or action." (S1). Exceptions: `bulk_search` (5/10/20), DNS set (20 main + 100 sub records), legacy `bulk_register` (100 domains), legacy set_whois / set_privacy / set_dns2 accept up to 100 domains.
- Payment: only from prepaid account balance in the REST/API path ("Note: make sure you have enough account balance", S3-landing / WHMCS S26). Auto top-up "will only be available when your Dynadot account is at least one year old and has an order history" (S24). Webhook `account_balance_reminder` warns of low balance (S2).

### 4.4 Making `register` safely retryable (design guidance derived from documented error semantics; there is **no** idempotency key)
1. Persist an intent row (`order_id`, domain, years, customer) before calling; never call from a non-persisted state.
2. Serialize per domain and stay inside one in-flight request (the account is single-threaded at Regular level; the server documents 400 "There is another command processing for {parameter}" on renew).
3. On timeout, 5xx, 502/503 or the 500 "Domain requires further investigation: order created [order_id]." do **not** blindly re-send. First `GET /domains/{domain}` (404 "Can not find the domain in the account." = not registered) and `GET /orders?search_type=domain&domain_name_list=...` to find an order; treat "exists" as success.
4. If you do re-send and it already succeeded, the server answers 409 "The domain is already owned by your account and cannot be purchased again." - map that to success only after confirming ownership by `GET /domains/{domain}`.
5. Send a fresh UUID `X-Request-ID` per attempt and log it (correlation only).
6. For renew, pass `year` = the expiry year you last read; a second renew then fails with "Expiration year does not match." instead of double-charging.
7. Treat every payment as prepaid-balance debit: reconcile `GET /accounts/info` balance against your ledger daily and alert on the `account_balance_reminder` webhook.

---

## 5. Wholesale prices (USD)

**What is public:** Dynadot publishes one price list with two tabs, "There are two tabs: one for regular and one for reseller accounts." (S11 FAQ). Since January 2025 there is no volume discount ladder: "Everyone is now receiving our previous Superbulk prices" and "regardless of whether you have a regular, Bulk, or Superbulk account level, you'll receive the same straightforward and competitive domain pricing" (S15). Bulk/Super Bulk change only quotas and perks. The actual per-account price is returned by `GET /domains/get_tld_price` (`price_level`); a live call was not possible without an account, so the numbers below are the public list. Prices "may vary based on fluctuations in currency exchange rates" (S11). Data captured 2026-09-29 from the price table (headless render, USD view) and the individual TLD pages (S11, S12).

| TLD | Register 1 yr (Regular tab / TLD page) | Register 1 yr ("Reseller" tab) | Renew 1 yr | Transfer-in | Restore (redemption) | Grace-delete fee (S13) | Source URLs |
|---|---|---|---|---|---|---|---|
| .com | 10.88 | 10.88 | 10.88 | 10.88 | 100.92 | 3.00 | https://www.dynadot.com/domain/com ; https://www.dynadot.com/domain/prices |
| .ai | 85.60 per year; **2-year minimum**, so 171.20 due at registration | 85.60 | 85.60 per year; **2-year minimum renewal** per TLD page, so 171.20 | 171.20 (includes 2 years) | 460.00 | 3.75 | https://www.dynadot.com/domain/ai |
| .dev | 8.00 promo (12.00 struck-through on TLD page) | 12.84 | 12.50 | 11.99 | 124.40 | 0.80 | https://www.dynadot.com/domain/dev |
| .io | 28.89 promo (53.50 standard) | 28.89 | 53.50 | 53.50 | 170.00 | 2.89 | https://www.dynadot.com/domain/io |
| .app | 9.99 promo (14.00 struck-through) | 14.98 | 14.50 | 13.99 | 128.36 | 1.00 | https://www.dynadot.com/domain/app |
| .studio | 11.96 promo (33.39 standard) | 11.96 | 33.39 | 33.39 | 142.40 | 1.20 | https://www.dynadot.com/domain/studio |

Quotes: the .ai TLD page states ".AI domains require a minimum registration or renewal term of 2 years." and lists Registration $85.60, Renew $85.60, Transfer $171.20, Restore Price $460.00 (S12 ai); the price-table row reads `.ai $85.60 $85.60 $171.20 Yes 30 5 $460.00 No` (S11; columns Register, Renew, Transfer, Privacy, Renew-grace days, Delete-grace days, Restore, IDN).

Promo vs regular:
- Registration sale end dates on the sales page: .io, .app, .dev "2026/12/31 23:59 UTC" (S14; displayed in EUR that day, ratios match the USD table). .studio shows a struck-through 33.39 -> 11.96 on its page; end date not seen. Promotions are 1-year only or multi-year depending on offer: "Some sales apply only to the first year of registration, while others may apply to multiple years" (S11 FAQ).
- **Unexplained:** the "Reseller" tab lists .dev at 12.84 and .app at 14.98 for registration, higher than both the Regular-tab promo (8.00 / 9.99) and the TLD-page struck-through prices (12.00 / 14.00). Other TLDs are identical across tabs. Treat reseller registration cost for .dev/.app as **at least** the reseller-tab figure until `get_tld_price` in the sandbox/production says otherwise.
- Renewals are the standard price regardless of promo (renewal for .io is 1.85x the promo registration price; .studio 2.8x). Price-change practice: notice of 2025-09-03 for changes effective 2025-10-06 17:00 UTC on 233 TLDs "due to adjustments from the central registry" (S16); "Registration prices are locked in for the purchased term, but future renewals may change if registry or registrar pricing is updated." (S11).

Premium / reserved names: every TLD page states "This TLD supports premium domains. Please note that premium domains have different pricing." (S12). Search returns `premium: yes|no|unknown`; registration requires `register_premium: true`.

Per-TLD gotchas:
- **.ai:** 2-year minimum on registration (API error text says "new registrations") and on renewal (TLD page says "registration or renewal"); transfer-in adds 2 years; no IDN; restore 460.00; ccTLD administered by the Government of Anguilla (S12). Higher grace-delete fee.
- **.dev / .app (Google Registry):** HSTS preload. .app page: "The .APP TLD is on the HSTS preload list, meaning all .APP websites must use HTTPS." (S12 app). .dev page: "Built with HTTPS encryption by default". Consequence (inference): do not point these at Dynadot's default parking or plain-HTTP forwarding. Price table restriction column for .app: "SSL for Website". **Both are missing from Dynadot's API-supported TLD list** (S19).
- **.io:** promo registration then 53.50 renewal; ccTLD. Dynadot's page lists the registry as "Donuts Inc."; IANA's delegation record lists nic.io / icb.co.uk contacts (S33) - the label on Dynadot's page may be stale.
- **.studio:** biggest renewal jump (11.96 -> 33.39).
- **.com:** no restrictions; grace-delete fee 3.00.

---

## 6. Lifecycle

| Stage / rule | Dynadot behaviour | Evidence |
|---|---|---|
| Add grace period (AGP) and refund | TLD pages: "Deletion Grace Period 5 Days"; grace-deletion page: 118 hours for all six TLDs; "Most domains can be grace deleted within 5 days of registration." Refund is **account credit** less the deletion fee ("If a domain has a grace deletion fee it will be taken out when we credit your account"); card refund only on request within 60 days of payment. Rate-capped: "Max Rate 10%"; "the success of grace deletion is not guaranteed and depends on the Registry"; API: 409 "New accounts cannot grace delete", "The deletion limit quota has been reached.", "The domain was renewed, can not been grace deleted anymore." ToU s10: refund "in its absolute and sole discretion". Renewed domains cannot be deleted (legacy `delete`). | S12, S13, S2, S8, S3 |
| Renewal / auto-renew grace | 30 days for all six TLDs ("Renewal Grace Period 30 Days"), renewal at normal price; a late-renew fee can apply (API flag `no_renew_if_late_renew_fee_needed`). | S12, S2, S23 |
| Provider auto-renew | **Opt-in**, per domain (`renew_option`: `reset` / `auto` / `donot`): "our system will take care of the renewal for you 15 days before the domain's expiration date"; on failure "we will make another attempt every day". ToU s6.3: "If You opt-in for automatic renewal ... but Dynadot is unable to process a transaction, then the automatic renewal shall not occur." Default per new registration is unverified. During the post-expiry period Dynadot "shall provisionally renew the domain name registration on Your behalf" (ToU s8.1(e)). | S23, S8, S5 |
| Redemption period and fee | TLD pages: "Restore Period 30 Days"; restore fees .com 100.92, .ai 460.00, .dev 124.40, .io 170.00, .app 128.36, .studio 142.40; `POST /domains/{d}/restore` returns 409 "Item already existed." on a duplicate submit. Conflicting descriptions: help article example shows 30-day renewal grace then a 40-day "Redemption Period (restore fee)" then 5 days pending delete; ToU s8: 40-day Post-Expiration Period (Hold status, nameservers changed) then a 30-day Deletion Period; "A restoration fee shall apply to any domain name renewal submitted in the last 10 calendar days of the Post-Expiration Period." Registry rules override (ToU s8.12). | S12, S23, S8, S2 |
| Auction of expired names | ToU s8.4: Dynadot "may auction for sale any domain name that is not renewed within the lesser of the first 30 calendar days of the Post-Expiration Period" and may transfer it to another registrant afterwards (s8.5). Applicability to reseller accounts is unverified; renew customer domains before expiry. | S8, S5 |
| Expiry notices | "Dynadot will send all expiration notice emails to the address on file. You can also set up a separate renewal email"; webhook `domain_expiring` (30 / 10 / 3 / 0 days and redemption lists). | S23, S2 |
| 60-day lock after registration / transfer | Enforced; API returns 409 "The domain has the 60-day transfer lock." and `domain_info.transfer_lock_end_date` exposes the end. ICANN: transfer denial allowed if "requested within 60 days of the creation date". Also 60 days after a restore (ToU s8.10). | S2, S25, S8 |
| 60-day lock after registrant change | Applies to Name / Organization / Email changes unless opted out. Dynadot: "We have opted you out of this transfer lock by default ... The opt-out option applies only to contact information changes and does not override the mandatory 60-day transfer lock following a new domain registration or a completed domain transfer." Designated-agent clause (GDG ToU s11.3) covers approvals; "ICANN is also requiring us to send two notification emails" even with a designated agent. | S22, S5 |
| Auth code delivery | Synchronous via `GET .../transfer_auth_code`; needs the domain unlocked and the account unlocked; `unlock_domain_for_transfer` "Requires api skip lock agreement"; refused while the 60-day lock applies or the domain is expired/expiring. | S2, S3, S20 |
| Transfer-in duration and approval | "Transfers can take anywhere from 1-15 days, depending on how fast each step can be completed." "In most cases, transferring a domain will automatically extend its expiration date by one year" (.ai: "Renewal Upon Transfer 2 Year"). Losing registrar default-approves after 5 calendar days (ICANN Transfer Policy 3.5). Dynadot rule: "Every domain name that is transferred within 45 calendar days of its expiration date shall have its new expiration date reduced by 1 calendar year" (ToU s8.11). Only 1 year can be bought on transfer (`duration` must be 1). | S20, S12, S25, S8, S2 |
| Outbound transfer | Customer/reseller unlocks, gets auth code, gaining registrar submits; Dynadot creates a "transfer away" order + email; approve/deny via API. No fee stated. Blocked when "the domain name has the Hold status or is locked", during a dispute, when "You are in default of any obligation towards Dynadot" (ToU s11.4), and in the last 10 days of the Post-Expiration Period (s8.6). ICANN 5-day rule for auth-code release (Transfer Policy 5.2). | S20, S8, S25 |
| Registrant change | `PUT /domains/{d}/contacts` requires all four contact ids; may open a change-of-registrant request with approval emails; 409 if one is already pending. Dynadot is designated agent by default. | S2, S22 |
| ccTLD differences | .ai: 2-year minimum register and renew, transfer adds 2 years, no IDN, restore 460.00. .io: standard 1-year rules. Dynadot lists the same 30 / 5 / 30 day windows for .ai and .io as for gTLDs, but ToU s8.12 and s15.1 say registry policy overrides; whether each ccTLD actually has a redemption period is **unverified** (registry documents not consulted). Other ccTLDs (.UK, .RO, .BE) have different transfer procedures per Dynadot (S20 transfer-away). | S12, S8, S20 |

---

## 7. WHOIS privacy and RDAP redaction

| Question | Answer | Evidence |
|---|---|---|
| Free? | Yes. Price page: "All domains include: Free Website Builder, Free Custom Email Address, Free Domain Privacy". Each of the six TLD pages: "Privacy Allowed Yes". | S11, S12 |
| Default on? | Yes, full: "Unless otherwise specified, new domain registrations are already set to default to full privacy." Full hides the name too ("REDACTED FOR PRIVACY"); partial shows the name and the organization "Dynadot Privacy Services". | S21 |
| Controllable via API? | Yes. `privacy` (off / partial / full) is a **required** field on `register` and `transfer_in`; `PUT /domains/{d}/privacy` `{privacy_level}` later. Errors: 403 "The [domain_name] is not allowed to set full privacy." for some names; 500 "Please check that the Registrant for the domain has Dynadot as the Designated Agent and the Opt Out of 60 Day Transfer Lock is checked." The account-wide default level is a control-panel setting ("Domain Defaults"); no REST endpoint for it was found in the command feed. | S2, S21 |
| RDAP | Reseller domains use GDG's RDAP server `https://rdap.globaldomaingroup.com/`; its conformance list includes `icann_rdap_response_profile_1` and `redacted`. (Dynadot's own is `https://rdap.dynadot.com/`.) | S9, S32 |
| Mail relay | With privacy on, third-party mail (e.g. gaining-registrar transfer confirmation) is relayed to the **account** email: "If you are using our privacy service, we will forward the email to your account email." For a reseller that is Mosshatch's address, not the end customer's. | S20 |
| Disclosure | Privacy Policy s3.3 lists "disclosure of non-public RDDS/WHOIS/RDAP to third parties" and s7 sets a disclosure-request process (2 business days to acknowledge, 30 days to answer). | S8 |

---

## 8. Notifications

- **Webhooks exist** (help: "Dynadot now supports Webhooks"). Configure a URL and generate a webhook key + secret on the API settings page; "Please wait for at least 10 minutes" for propagation (S18). Delivery is `POST` JSON `{event, event_id, timestamp, data}` with `Authorization: Bearer WEBHOOK_KEY` and `X-Signature` = Base64(HMAC-SHA256(webhook secret, webhookKey + "\n" + path + "\n" + requestId + "\n" + body)); the receiver answers `{"Status":"200"}` (S1). No timestamp in the signed string, and **no documented retry, backoff, ordering or timeout** (unverified); dedupe on `event_id`.
- **Events (all 11 flagged not-in-sandbox):** `order_completed`; `order_payment_required`; `domain_status_changed` (`change_type`: domain registration / renewal / transfer / restore / account push ...; `status` from the Dynadot status list); `domain_transfer_away` {domain, gaining_registrar, order_id}; `domain_expiring` (lists for 30 / 10 / 3 days, today, redemption); `account_balance_reminder`; `whois_verification_required` (`verify_link` "Not returned for reseller accounts."); `whois_verification_notification`; `domain_suspension_status_changed` (`suspension_type` disabled / client_hold / server_hold; `reason` whois_verification_failed / whois_verified / abuse_report / abuse_cleared / manual_restore / unknown); `maintenance_notice` (registry, affected TLDs, window); `contact_kyc_status_changed` (S2).
- **Not covered by webhooks:** DNS changes (API-driven anyway), lock changes, inbound-transfer intermediate steps (only completion via `order_completed` / `domain_status_changed`), nameserver changes. Poll for those: `transfer_status`, `orders/{id}`, `GET /domains/{d}`, `GET /domains` (paged).
- Emails still go to humans on the account (order received, transfer initiated / complete, transfer away).

---

## 9. Red flags and findings

| # | Severity | Finding | Evidence | Mitigation for Mosshatch |
|---|---|---|---|---|
| 1 | High | Reseller Agreement lets GDG "terminate this Agreement without notice, transfer any and all of Your customer accounts to Dynadot accounts and grant each customer independent control"; amendments and suspension "in its absolute and sole discretion" with no notice period | S4, S5 (s1.4, s7.3) | Negotiate notice/cure; keep off-platform customer records; be able to export customers' auth codes |
| 2 | High | API terms (Dynadot ToU s13.1(b)(c); GDG ToU s12.1(b)(c)) forbid making the API "or any data derived out of its use" available to third parties / embedding it in "other applications or third parties" | S8, S5 | Written waiver/clarification before launch |
| 3 | High | REST v2 docs are labelled Beta: "Avoid relying on it for critical production workflows"; only one changelog entry (2025-10-09) | S1 | Contract-test in sandbox nightly; consider the legacy API as the stable alternative (but its key travels in the URL) |
| 4 | High | .dev and .app missing from Dynadot's API-supported TLD list (updated 2026-01-13; "this list may not be accurate"); register/transfer can also fail with "The domain is not supported by your account type." | S19, S2 | Test register of .dev/.app in sandbox with a reseller account; get written confirmation; fallback provider for Google TLDs |
| 5 | Medium | Regular tier is 1 thread / 60 req/min; `bulk_search` 5 domains per call; 1,000 bulk searches/day; search results may be cache-sourced | S1, S2, S11 | Own availability cache, per-name batching, DNS/RDAP pre-check; upgrade needs $500/yr spend |
| 6 | Medium | No idempotency key; `register` response lacks an order id; indeterminate 500 "Domain requires further investigation" | S2 | Section 4.4 protocol |
| 7 | Medium | Prepaid-balance-only funding: 402 when empty; auto top-up needs a >=1-year-old account; prepay non-refundable ("any money you add ... will be non-refundable") | S24, S2 | Treasury monitoring, manual pre-funding, buffer for renewals |
| 8 | Medium | Grace-delete is capped, discretionary and unavailable to new accounts | S13, S2, S8 | Do not promise instant refunds; hold funds/pre-auth in Stripe until AGP risk ends or price it in |
| 9 | Medium | DNS: no record IDs, single TTL, replace-all default, upsert not atomic | S2 | Model DNS as full desired state per domain and diff |
| 10 | Medium | Error semantics: missing Authorization header returns HTTP 200 + text/plain + body code 400 | S27 | Always parse body `code` |
| 11 | Medium | Renewal price risk: ToU/GDG s6.1 disclaims "the fee applicable to and the length of the renewal"; 233-TLD registry-driven increase announced 2025-09-03 for 2025-10-06 (33 days' notice) | S5, S16 | Re-quote renewals from `get_tld_price` daily; show renewal price at checkout |
| 12 | Medium | Liability shifted to reseller: "assume all liabilities arising from the use of Your account ... caused ... by unauthorized parties"; 6-month limitation period; California venue; jury waiver | S5 | Insurance / entity structure; tight token scoping |
| 13 | Low-Med | WHMCS module (official, updated 2026-09-09): 13 reviews, 7 one-star, regressions across versions (e.g. v2.0.0 review of 2026-07-28: "Error: Dynadot Error Invalid JSON format"; Aug 2023 fatal error "Undefined class constant 'COMMAND_GET_NS'"; Sep 2024 "TLD Import & Pricing Sync is not working") - Dynadot replies "we cannot process problems through WHMCS Reviews" | S26 | Signals QA quality of Dynadot's own integrations |
| 14 | Low-Med | No public status page: `status.dynadot.com` answers HTTP 200 with an empty body; outage history not found (search budget exhausted, see section 11) | S29 | Own synthetic checks against sandbox and production |
| 15 | Low | Contradictory documentation: restore period 30 days (TLD pages) vs 40 + 30 days (ToU) vs 40 days (help example); appraisal quotas differ between docs and price page; API landing page says "Registrer" (typo) | S12, S8, S23, S1, S11, S31 | Verify in sandbox; do not encode durations, read from `get_tld_price` |
| 16 | Low | Cloudflare bot protection returns 403 / challenge on some web pages (`/report-abuse`, `/prepay`) - irrelevant to API but affects automated doc checks | (fetch attempts) | None |

Developer channels: docs link a Discord community and 24/7 chat/email support (S31); GDG promises to "respond to all customer contacts and service complaints within 3 business days" (S6).

---

## 10. Recommendation

**FALLBACK.** Dynadot clears the legal gate that matters most: it has a formal, free, application-gated Reseller Program with a written agreement that expressly contemplates white-label resale, names an ICANN-accredited sponsoring registrar (Global Domain Group LLC, IANA 3956), flows down the RAA reseller duties, and publishes a price list that is identical for every spend level (.com 10.88 / .ai 85.60 x 2 / .dev 12.50 renew / .io 53.50 renew / .app 14.50 renew / .studio 33.39 renew) with a real sandbox and signed webhooks. It falls short of primary because (a) two contract clauses (API "make available ... to third parties" and, on the Dynadot paper, "you are not an authorized reseller") read against Mosshatch's model and the agreement can be amended or terminated without notice with customer accounts pulled to Dynadot; (b) the REST v2 documentation is self-labelled Beta, the Regular tier is one request at a time at 60/min with 5-name bulk search and a 1,000/day cap, there is no idempotency key, DNS has no record IDs and domain status is not exposed as EPP codes; (c) .dev and .app are not on Dynadot's own API-supported TLD list and the reseller-tab price for them (12.84 / 14.98) is unexplained; and (d) key ICANN-notice duties for reseller-account domains are undocumented. It is a credible second registrar (especially for .com, .ai, .io, .studio) behind a provider with idempotent orders and a clean wholesale contract. **Upgrade to primary only if Dynadot/GDG confirm in writing:** which terms govern and that API-driven resale is permitted, .dev/.app registration via API for a reseller account (and sandbox-verify it), the real reseller price list from `get_tld_price`, who sends expiry / WHOIS-verification / change-of-registrant emails for reseller domains, and a termination notice/migration path.

---

## 11. Unverified (and why)

1. Real reseller-account price list: no account; public "Reseller" tab differs from "Regular" for .dev (12.84 vs 8.00) and .app (14.98 vs 9.99). `get_tld_price` not called.
2. Reseller application criteria, approval time, any deposit / volume / KYC requirement: forms are behind login or submission; only public statements read.
3. Whether reseller accounts can register .dev and .app through the API (absent from API-supported list; present on GDG roster and public price list).
4. Which terms govern a reseller account (2023 Reseller Agreement + Dynadot ToU vs GDG ToU 2026-08-18) and how ToU s3.1 and s13.1 apply.
5. Sandbox fidelity for transfers, expiry, DNS resolution; whether sandbox needs a reseller account; webhook behaviour (not in sandbox).
6. Webhook retry / backoff / ordering / timeout policy.
7. Who sends ICANN-required emails (expiry reminders, WHOIS verification, change of registrant, transfer confirmations) for reseller-account domains; `verify_link` "Not returned for reseller accounts".
8. Reseller-only REST commands (feed returns empty `resellerCommand` / `partnerCommand` for anonymous viewers).
9. Whether GET endpoints take parameters in body or query (docs show a `requestBody` on GET).
10. Whether `set_dns` switches a domain to Dynadot's nameservers automatically; which nameserver hostnames serve hosted DNS (only `ns1.dyna-ns.net` / `ns2.dyna-ns.net` appear, "can only be used with Dynadot services such as parking or forwarding").
11. Exact restore-period length (30 vs 40 days) and late-renewal fee amounts; whether .ai / .io have a redemption period at registry level; long-term .io continuity.
12. Default `renew_option` for new API registrations; default lock state after registration.
13. Whether expired reseller-account domains enter Dynadot's expired-domain auctions.
14. Outage history, incident frequency, SLA: `status.dynadot.com` returns an empty page; the WebSearch budget was exhausted (200/200) before third-party outage / developer-complaint searches could run; only the WHMCS marketplace reviews were read.
15. Dynadot `/report-abuse` page and abuse mailbox: blocked by a Cloudflare challenge to automated fetches; GDG's abuse form was read instead. How GDG forwards law-enforcement / court requests to resellers.
16. Comparison of Dynadot's price to registry cost (e.g. Verisign .com fee): not fetched.
17. Current status of ICANN's Transfer Policy revision (TAC / FOA changes): only the 2016 policy page (with a 2024-02-21 update notice) was read.
18. How the "1,000 bulk searches daily" quota is counted (per domain vs per request) and whether reseller accounts have it.

---

## 12. Sources (all accessed 2026-09-29)

| ID | URL | What |
|---|---|---|
| S1 | https://www.dynadot.com/domain/api-document | RESTful API docs: overview, auth, X-Signature, errors, webhook format, rate limiting, sandbox, changelog, Beta notice |
| S2 | https://www.dynadot.com/domain/api-document?getCommandInfoData=1&apiVersion=2.0.0 (loader script https://www.dynadot.com/domain/api-document-v2.js) | Machine-readable command feed used by S1: 160 commands, 11 webhook events, per-command errors, sandbox and signature flags |
| S3 | https://www.dynadot.com/domain/api-commands (redirect target of /domain/api3.html) | Legacy API3 docs |
| S4 | https://www.dynadot.com/reseller-agreement | Dynadot Reseller Agreement, version date 2023-08-15 |
| S5 | https://www.globaldomaingroup.com/terms-of-service | GDG Terms of Use, version date 2026-08-18 |
| S6 | https://www.globaldomaingroup.com/ | GDG reseller landing page and FAQ |
| S7 | https://www.dynadot.com/domain/reseller-program | Dynadot Reseller Program page and FAQ |
| S8 | https://www.dynadot.com/terms-of-use | Dynadot Terms of Use, version date 2026-08-18 |
| S9 | https://www.iana.org/assignments/registrar-ids/registrar-ids-1.csv | IANA registrar IDs (472 Dynadot Inc; 3956 Global Domain Group LLC) |
| S10 | https://www.icann.org/resources/pages/approved-with-specs-2013-09-17-en (resolves to .../2013-registrar-accreditation-agreement-17-09-2013-en) | RAA 3.7.5, 3.7.7, 3.7.8, 3.12, 3.18 |
| S11 | https://www.dynadot.com/domain/prices | Price table (Regular / Reseller tabs), FAQ, spend-level benefits |
| S12 | https://www.dynadot.com/domain/com , /ai , /dev , /io , /app , /studio | Per-TLD prices, grace and restore windows, restrictions |
| S13 | https://www.dynadot.com/domain/grace-deletion | Grace-deletion windows, fees, rate caps, refund handling |
| S14 | https://www.dynadot.com/domain/sales | Registration sale end dates |
| S15 | https://www.dynadot.com/blog/new-one-tier-pricing-update | One-tier pricing (2025-01-22) |
| S16 | https://www.dynadot.com/blog/domain-price-changes-for-over-200-tlds | 233-TLD price change notice (2025-09-03) |
| S17 | https://www.dynadot.com/help/question/find-API-settings | API keys, sandbox keys, IP allow-list / CIDR |
| S18 | https://www.dynadot.com/help/question/webhooks | Webhook setup |
| S19 | https://www.dynadot.com/help/question/API-supported | "Which TLDs does your API support?" (updated 2026/01/13) |
| S20 | https://www.dynadot.com/help/question/steps-to-transfer ; /transfer-domain-to-dynadot ; /transfer-away ; /what-is-auth-code | Transfer procedures |
| S21 | https://www.dynadot.com/help/question/set-default-privacy ; /full-partial-domain-privacy | Privacy defaults and levels |
| S22 | https://www.dynadot.com/community/help/question/opt-out-lock ; /dynadot-designated-agent | 60-day lock opt-out; designated agent |
| S23 | https://www.dynadot.com/help/question/renew-domain ; /set-auto-renew ; /renewal-grace-period | Renewal, auto-renew, grace lifecycle |
| S24 | https://www.dynadot.com/community/help/question/add-account-credit ; https://www.dynadot.com/help/question/auto-prepay ; /bulk-pricing ; /reach-next-price-level | Prepay, auto-prepay, spend levels |
| S25 | https://www.icann.org/resources/pages/transfer-policy-2016-06-01-en (resolves to .../transfer-policy-01-06-2016-en) | ICANN Transfer Policy: 5-day default approval, 60-day rules, AuthInfo |
| S26 | https://marketplace.whmcs.com/product/6353-dynadot-reseller-api-module | Official WHMCS module: requirements, features, reviews |
| S27 | Direct probes of https://api-sandbox.dynadot.com and https://api.dynadot.com on 2026-09-29 (no credentials) | Observed error semantics |
| S28 | https://www.globaldomaingroup.com/reseller-tlds ; https://www.globaldomaingroup.com/report-abuse | GDG TLD roster (612 names incl. com, ai, dev, io, app, studio); abuse intake |
| S29 | https://status.dynadot.com | Responds 200 with empty body |
| S30 | https://www.dynadot.com/community/help/question/fake-Whois-complaint ; /dispute-copyright | Complaint handling |
| S31 | https://www.dynadot.com/domain/api | API landing page and FAQ |
| S32 | https://rdap.globaldomaingroup.com/help | GDG RDAP conformance |
| S33 | https://www.iana.org/domains/root/db/io.html ; /ai.html | IANA delegation records |
