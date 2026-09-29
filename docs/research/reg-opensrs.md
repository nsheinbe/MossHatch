# Dossier: Tucows OpenSRS (wholesale reseller platform) for Mosshatch Phase 0

Prepared 2026-09-29. Every fact was fetched on that date ("acc. 2026-09-29"). Source IDs (S#, K#, T#) resolve to URLs in the Source registry at the end of this file. Raw fetches are kept under `working-directory/research/opensrs/` (rendered price tables, API guide markdown, KB articles, TLD chart CSVs).

## TL;DR

1. RESALE: YES. The OpenSRS Master Services Agreement (MSA) is written for resale: the customer "wishes to use, resell and/or provision the Tucows Services for itself and the benefit its own Users"; reseller sets retail price; end customer is the registrant of record; Tucows Domains Inc. is the sponsoring registrar, so Mosshatch needs no ICANN accreditation (S1, S2).
2. PROGRAM: self-serve signup, $95 one-time non-refundable activation fee converted to account credits, prepaid USD balance, no monthly fee, no minimums; 4 public price tiers (Essential default) (S4, S5, K8).
3. API: XML-over-HTTPS only (port 55443), MD5 double-hash signature, one reseller-wide key, live calls need an allow-listed IP (max 5 rules, /25 to /32). All 13 adapter methods map except: no bulk availability call, no per-record DNS CRUD (replace-all `set_dns_zone` only; no CAA/TTL), no API to start/approve an outbound transfer (S9, K1).
4. SANDBOX: Horizon (`horizon.opensrs.net:55443`), $5,000 test credit, no IP allow-listing; cannot simulate transfers or redemption, `.ai` is not in it (K2, S20, S23, T1).
5. PRICES (Essential, USD, acc. 2026-09-29): .com 14.50 (15.25 from 2026-11-01); .ai 111 with 2-year minimum term; .dev 17 (promo 10); .io 60 (promo 34); .app 21 (promo 14); .studio 42 (51 from 2026-10-06). Restore 80/200/150/250/150/80 (S6, S7).
6. GOTCHAS: WHOIS privacy is $3/yr (not free) and unavailable for .ai and .io; .io auth codes are set by OpenSRS support; API redemption list omits .ai/.io/.app; `sw_register` defaults `period` to 2; no idempotency key (reconcile with `get_orders_by_domain`); Tucows may auction unrenewed names at day 41-45 (T1, K6, K8, S15).
7. RISK: broad unilateral suspension/termination/price-change clauses, unpublished lookup rate limit with a "fee", API outages 2025-12-02, 2026-01-29, 2026-02-03, 2026-08-05 (.ai/.io registry link) and a 2-hour full API maintenance outage 2026-09-28 (S1, ST).
8. RECOMMENDATION: PRIMARY candidate, conditional on written confirmation of lookup limits/fees and a static-egress plan (Vercel Static IPs need Pro/Enterprise). Keep a second adapter warm.

---

## 1. Resale rights, contract, program, roles

### 1.1 Governing documents (all fetched 2026-09-29)

| Doc | URL | Version evidence |
|---|---|---|
| Master Services Agreement (MSA) incl. Appendix A fee schedule and Appendix B registration agreement (S1) | https://assets.opensrs.com/Uploads/Master-Services-Agreement.pdf ; same text at https://opensrs.com/legal/contract | HTTP Last-Modified 2026-07-22; PDF creation 2026-06-04; no printed effective date |
| Master Domain Registration Agreement, "Exhibit A" (current web copy) (S2) | https://assets.opensrs.com/Uploads/Master_Domain_Registration_Agreement.html | HTTP Last-Modified 2026-07-22 |
| TLD-specific terms (S3) | https://assets.opensrs.com/Uploads/TLD_clauses.html | Header says "2022-05-31 TLD Clauses"; no `.ai`, `.io`, `.dev`, `.app` sections found |
| Payment terms (S5) | https://opensrs.com/payment-terms | live page |
| Data Processing Addendum | https://assets.opensrs.com/Uploads/OpenSRS_Data_Processing_Addendum.pdf | Customer = controller, Tucows = processor |

### 1.2 Does the contract allow Mosshatch's model? Yes, with conditions

Load-bearing clauses (S1, MSA, acc. 2026-09-29):
- Purpose: "Customer ... wishes to use, resell and/or provision the Tucows Services for itself and the benefit its own Users".
- 3.1 "Customer may choose to offer its Users Domain Name Registrations". 2.3 "Tucows shall provide Customer with the API which will enable Customer to develop its own systems to register those domain names". 16.1 grants "a non-exclusive, non-transferable, limited license to use the API".
- Own price and checkout: 12.5/12.4 (Storefront) "The Storefront Customer sets the retail selling price that their User pays"; API customers pay wholesale from a prepaid balance (12.7) and bill their users themselves (18.2 "Customer shall bear sole responsibility for providing support to Users ... including ... all billing and technical support").
- Independent contractor: 24(c) "the relationship of independent contractors".
- Own brand: OpenSRS markets the API path as "White-label end-user messaging ... Customers register and manage from your sign-up flow and UI" (https://opensrs.com/ and https://opensrs.com/campaigns/become-a-domain-reseller) and "Your product. Your checkout. Your customer." (https://opensrs.com/api/overview). Conditions: 3.18 "Customer understands and agrees to identify themselves as a reseller of Tucows Services on their website"; 3.8 "Customer shall identify Tucows as the sponsoring registrar upon inquiry from a User"; 3.7 no ICANN or ICANN-accredited-registrar logo.
- Flow-downs the reseller must implement: 3.3 "each User must agree to be bound by the terms and conditions of the Tucows User Registration Agreement for each Selected TLD"; 3.11 any registration agreement "shall include all registrant registration agreement provisions and notices required by Tucows' 'Appendix B' agreement"; 3.12 conspicuous links to ICANN registrant education and Registrant Rights and Benefits pages; 3.17 "passthrough any TLD rules, policies, and requirements"; 3.19 "publish fees for domain renewals, including post-expiration renewal fees (if different) and also redemption/restore fees on their website"; 3.20 list "the day 30, day 5 and day 3 notices are sent via email" on site and in ToS; 3.9 keep registration records/IP/timestamps and payment records (3-year retention) and answer Tucows "within two (2) business days".
- Proxy/privacy restriction: 3.10 "Customer agrees not to register names using any proxy contact information or privacy services unless customer uses Tucows' WHOIS Privacy service OR customer displays a conspicuous notice ... that their data is not being escrowed", plus indemnity. Implication: Mosshatch must not register names in its own name on behalf of customers; the customer must be the registrant.
- ICANN backstop: RAA 3.12 (I1) "Registrar must enter into written agreements with all of its Resellers"; 3.12.2 reseller registration agreement must include required provisions and "identify the sponsoring registrar"; 3.12.1 no ICANN logo.

### 1.3 Program requirements

| Item | Evidence |
|---|---|
| Formal program | Yes: "Join the world's largest domain reseller platform ... Scalable. White-label. No monthly fees." (S4 https://opensrs.com/join) |
| Application | Self-serve: "STEP 1 Sign up. Verify your email and fill out a quick form." (S4). No manual-approval step or KYC is documented for API resellers (unverified whether one happens in practice). The API overview page ends "Speak with our sales team to get started" and the onboarding page offers "Dedicated integration support" |
| Contract | MSA; click-through: 1.14 "if the Agreement is executed by electronic means, the first date on which Customer agreed to these terms or began using the Tucows Services" |
| Deposit / fee | "A one-time fee of $95 (plus GST or HST where applicable) is required at the time of application ... non-refundable and will be converted into account credits ... no additional yearly fees." (S5). MSA 12.7 "API Customers shall forward a sum agreed by the parties to Tucows to be held on account" |
| Minimums | Marketing: "no monthly fees or minimum purchase requirements" (S4). But MSA 12.8: "Tucows reserves the right to require minimum order levels and to modify those minimums from time to time" |
| Prepaid balance rules | 12.1 "if at any time, its balance drops below zero that will be considered a material breach". USD only. Card/PayPal top-ups carry a 3% fee; ACH only US/Canada and needs approval ("up to five business days"); deposits "can take up to two business days to apply" (S5, K16, K17) |
| Volume commitments | None. Tiering by annual spend + registrations/transfers: Advanced $2,000 and 100; Premium $50,000 and 500; Enterprise $100,000 and 1,000; reviewed each January, change effective April 1 with 30 days' notice (K8) |
| Account closure | Funds "are non-refundable and cannot be withdrawn or returned when the account closes"; domains must be transferred away or expire first (K15, K16). Conflicts with MSA 21.6 "the return of any unused deposit" |

### 1.4 Who is who

| Question | Answer and evidence |
|---|---|
| Registrant of record | The end customer named in the owner contact. MDRA (S2): "The person named as Registrant on record with Tucows shall be the 'Registered Name Holder.'" The registrar party is "Tucows Domains Inc." (S2); the MSA counterparty is "Tucows.com Co." (S1) |
| Who gets the registrant's acceptance | Mosshatch: MSA 3.3/3.11 (above); RAA 3.12.2. The MDRA is a template "as offered through ____, the Reseller participating in Tucows' distribution channel" (S2) |
| ICANN-mandated notices | Sent by the OpenSRS messaging platform in the reseller's branding: "The OpenSRS messaging platform sends notifications to your users ... including renewal and transfer notices, registrant verification emails ... some are mandatory" (K17). gTLD 30-day, 5-day and 3-day-after expiry reminders are mandatory; 90/60/10-day ones optional (K7). Mosshatch must still publish the notice schedule (MSA 3.20), keep registrant emails valid, and surface verification deadlines (S31 `verification_deadline`, `days_to_suspend`) |
| Abuse reports | Tucows as registrar: https://tucowsdomains.com/report-abuse/ ("The Tucows Family of Registrars (Ascio, Enom, EPAG, and OpenSRS)"); Tucows "may need to disclose your email address ... to the registrant, reseller, or a trusted third-party". Reseller must "provide all reasonable assistance" (MSA 3.15) and give users first-line support (18.2). Privacy-service abuse contact: the older PDF Appendix B names `legal@tucows.com`; the current HTML MDRA shows an obfuscated address |
| Legal process | Tucows may suspend/cancel, lock modifications, or deposit control with a court (S2 "Dispute resolution", "Suspension and cancellation"; MSA 3.16 "Tucows reserves the right to revoke Customer's access to modify User domain names at any time"). Reseller indemnifies (MSA 22.1). Governing law Ontario, venue Toronto (MSA 23.1) |
| eNom | Only appears on the Tucows abuse page as a sibling registrar. No OpenSRS doc fetched points resellers to eNom, so it is out of scope here |

---

## 2. API coverage (RegistrarAdapter)

Transport (S9, S10, K18): `POST https://rr-n1-tor.opensrs.net:55443` (live) / `https://horizon.opensrs.net:55443` (test). Body = OPS XML envelope (`protocol=XCP`, `action`, `object`, `attributes`). Headers `Content-Type: text/xml`, `X-Username: <reseller>`, `X-Signature: md5(md5(xml + api_key) + api_key)`. Domains/TLS API is XML only ("The Domains and Certificates API is XML-based; the Email API is JSON-based", opensrs.com/api/overview FAQ). Guide: https://domains.opensrs.guide (each page also available as `.md`; index at /llms.txt).

| Adapter method | Verdict | Command (action/object) | Caveats (with evidence) |
|---|---|---|---|
| checkAvailability (bulk names x TLDs) | partial | `LOOKUP DOMAIN` (one `domain` per call); `NAME_SUGGEST DOMAIN` (one `searchstring` x `tlds[]`); `SUBMIT BULK_CHANGE` `change_type=availability_check` (up to 10,000 domains, must go to `batch.opensrs.net`, result is a CSV **emailed**) | `LOOKUP` reads the "local OpenSRS cache" unless `no_cache=1` (slower). Taken domain returns `response_code=211` with `is_success=1` ("be sure to check the response_code"). Premium names look **taken** unless the registry-premium tier is enabled in the account. `NAME_SUGGEST` is not available in Horizon; suggestions only for .com/.net/.org/.info/.biz/.us/.mobi but lookups for all TLDs. MSA 3.2/12.11: lookup "may be rate-limited ... excessive use may result in a fee. Customer explicitly agrees to pay this fee" (fee unquantified). (S12, S13, S28, S1) |
| quote (wholesale + renewal, premium detection) | yes | `GET_PRICE DOMAIN` with `reg_type=new or renewal or transfer or trade`, `period`, `all_periods=1` | "This value includes the OpenSRS price and the ICANN fee." Returns `is_registry_premium` + `registry_premium_group` only if that premium tier is enabled, but "The accurate price for the domain will always be returned". No `restore` reg_type: restore fee comes only from the public rate card. Premium purchases must echo the quoted price in `premium_price_to_verify`. (S14, S15) |
| register | yes | `SW_REGISTER DOMAIN` `reg_type=new` | Needs `contact_set`, `period` (**"The default is 2"** if omitted), `custom_nameservers`, `custom_tech_contact`, `reg_username` (3-20) + `reg_password` (10-20) that create the registrant profile, `f_whois_privacy=0 or 1`, `f_lock_domain`, `auto_renew`, `handle=save or process` (if absent "see reseller setting for default": always send it). Sync for all six target TLDs (T1 "Synchronous: Y"). No idempotency key: see section 4. Insufficient funds or already-taken orders are "forced to the pending queue" (`forced_pending`). (S15) |
| renew | yes | `RENEW DOMAIN` | Requires `currentexpirationyear` (must match registry) + `period` 1-10 + `handle`. A retry after success fails with 555/465 "Domain has already been successfully renewed" or 541 (year mismatch): a natural idempotency guard. Renewals are final: "A renewal transaction is final and cannot be cancelled under any circumstances" (K7). Failed renewals (usually low funds) become a **draft** that must be deleted before retry (K7 "Fixing a Domain Renewal in Draft"); `CANCEL_PENDING_ORDERS` may cover this (unverified). (S16) |
| getDomain (status, expiry, lock, NS, registry codes) | partial | `GET DOMAIN` `type=all_info` (contacts, `nameserver_list`, `expiredate`, `registry_createdate/expiredate/updatedate`, `auto_renew`, `let_expire`) + separate `type=status` (`lock_state`, `can_modify`, `domain_supports`, `transfer_away_in_progress`, `auctionescrow`) + `type=whois_privacy_state` + `GET_REGISTRANT_VERIFICATION_STATUS` | No raw EPP status codes (no clientTransferProhibited/redemptionPeriod/serverHold strings in any fetched API doc). `all_info` example has no `lock_state`, so two calls are needed. `GET` "will not return results once a domain is deleted during and after the redemption period"; use `GET_DELETED_DOMAINS` or the `DELETED` event (has `redemption_grace_period_end_date`). (S17, S31, K19) |
| setLock | yes | `MODIFY DOMAIN` `data=status`, `lock_state=0 or 1` | Registration-time `f_lock_domain` doc: "Even if submitted, this setting is not applied to TLDs where locking is not supported such as .DE, .UK, .CH, .NL, .FR, IT, BE, and AT" (S15); all six target TLDs show "Domain locking available: Y" (T1). `can_modify=0` if OpenSRS holds an internal lock (S17). Separate `MODIFY_TRADE_LOCK_SETTING` controls the 60-day post-registrant-change lock. (S15, S17, S18, S29) |
| listRecords | partial | `GET_DNS_ZONE DOMAIN` | Only works when nameservers are SystemDNS (`nameservers_ok`). Record types A, AAAA, CNAME, MX, SRV, TXT. No TTL or CAA field in any fetched DNS doc (S19). |
| upsertRecord | partial (no native per-record op; emulate with replace-all) | `SET_DNS_ZONE DOMAIN` replaces the whole record set; `CREATE_DNS_ZONE` first (+ `FORCE_DNS_NAMESERVERS` to `ns1/ns2/ns3.systemdns.com`) | Adapter must read-modify-write with its own per-domain lock. A separate JSON "Storefront API" has per-record CRUD with TTL and NS/DS but only for Storefront-managed domains on Shopco nameservers, needs a Storefront, and has no register/renew endpoints (K21, K22): not usable for API-registered domains. (S19) |
| deleteRecord | partial (no native per-record op; emulate with replace-all) | same as above; `DELETE_DNS_ZONE` deletes the entire zone | Same as upsert. |
| startTransferIn | yes | `SW_REGISTER DOMAIN` `reg_type=transfer`, `auth_info`, contacts | Pre-check `CHECK_TRANSFER`. With valid `auth_info` "the transfer will not send an approval email to the owner"; without it the registrant must approve by emailed link. Funds for the +1 year renewal are held (.ai adds 2 years). Not testable in Horizon. (S15, S20, K5, K12) |
| getTransfer | yes | `CHECK_TRANSFER` with `check_status=1`; `GET_TRANSFERS_IN`; event `transfer.status_change` | Status values `pending_owner`, `pending_admin`, `pending_registry`, `completed`, `cancelled`, `undef`. Resellers can only see transfers they initiated. Calling with `check_status=1` in `pending_registry` "expedites the process ... within 5 minutes". (S20, S26) |
| getAuthCode | yes (partial for .io) | `GET DOMAIN` `type=domain_auth_info` (returns code); `SEND_AUTHCODE` (emails admin contact); `MODIFY DOMAIN data=domain_auth_info` (set) | Certain TLDs "require the OpenSRS support team to set the auth code at the registry": list includes **.IO** (K6). Whether `domain_auth_info` returns a usable code for .io is unverified (test in Horizon). Post-RDP admin contacts are no longer collected for gTLDs (K10), so `SEND_AUTHCODE` recipient is unclear; Mosshatch should return the code inside its own authenticated UI instead. (S17, S21, K6) |
| startTransferOut | partial (no start/approve API) | none. Observe with `GET_TRANSFERS_AWAY`, `get` `status.transfer_away_in_progress` | Gaining registrar initiates. OpenSRS "sends the owner contact an email with a link to approve or decline"; "Owner does not respond within five days" = registry auto-acknowledges (K3). Preconditions: unlocked, auth code, no hold, >60 days since registration/transfer; disable WHOIS privacy first (S2). Domain stops resolving after transfer if it used SystemDNS (K3). |

Other useful commands: `GET_BALANCE`, `GET_DOMAINS_BY_EXPIREDATE`, `GET_DELETED_DOMAINS`, `GET_ORDERS_BY_DOMAIN`, `PROCESS_PENDING`, `REDEEM`, `REVOKE`, `MODIFY` `data=expire_action` (auto_renew/let_expire), `MODIFY` `data=whois_privacy_state`, `ADVANCED_UPDATE_NAMESERVERS`, `POLL`/`ACK` EVENT, `SET_DNSSEC_INFO` (fee conflict: see 9). No official JS SDK exists on npm (only third-party `opensrs@0.1.1`, last modified 2022-06-23, and `node-opensrs@1.0.0`, 2026-03-23); official toolkit is PHP (`osrs-toolkit-php`, linked from S8: https://github.com/OpenSRS/osrs-toolkit-php). Mosshatch will write a thin XML client.

---

## 3. Sandbox / OTE ("Horizon")

- Exists. Live API `rr-n1-tor.opensrs.net:55443`; test API `horizon.opensrs.net:55443`; test web: `manage.test.opensrs.com` (RCP), `horizon.opensrs.net/resellers/` (RWI), `horizon.opensrs.net/manage/` (MWI) (S10, K2, K-MI).
- Credentials: "Sign in ... using the credentials you chose when you first registered as an OpenSRS reseller"; the API key differs per system ("The private keys are different in both systems", S30). Test API "requires an API key but does not require IP authorization" (K2).
- Funding: "Every Horizon account starts with $5,000 in test credit" (K2).
- Differences (K2, K5, S23, S13, T1): "Registrations are not processed into the public root registry ... do not function on the internet"; "You cannot transfer domains in Horizon"; "Domain redemptions will not work on the Horizon testing server"; name suggestion tool unavailable; email not sent; billing/payment not available; `.ai` row "Available in Test environment: N" (`.com .dev .app .studio .io` = Y); "You can register names that are not available on the internet ... you still cannot register the same name twice within Horizon (including across resellers)" so test names must be unique.
- Not established: whether SystemDNS zone commands, expiry/renewal clocks, webhooks and premium tiers behave in Horizon. Live connectivity to `horizon.opensrs.net:55443` was attempted from this sandbox (unauthenticated TCP/TLS probe) and the tunnel was reset (proxy log: `ws_closed_mid_exchange`), so nothing was exercised live. `domains.opensrs.com` is blocked by egress policy (not used).

---

## 4. Rate limits and operational constraints

| Topic | Finding |
|---|---|
| Auth | reseller username + API key; signature `md5(md5(xml+key)+key)`; "Sub-users cannot authenticate to the API" (K18); "Generating a new API key immediately invalidates the previous key" (K1); MSA 2.8 requires notice "within four (4) hours of learning that its password ... [is] compromised" |
| IP allow-list | Live only. "You can have a maximum of five IP access rules", CIDR /25 to /32 (K1); changes take "up to 15 mins" (S30). Vercel functions do not have a documented fixed egress by default (inference); Vercel sells "Static IPs ... available on Enterprise and Pro plans" (V1), or route through a fixed-IP proxy |
| Formats | XML request and response; no JSON; message must be valid OPS DTD (S10) |
| Published rate limit | **None numeric.** Codes: 300 "Exceeded max command rate. Request deferred (for async)"; 310 "Exceeded max simultaneous connections"; 350 "A maximum of 100 commands can be sent through one connection/session" (S11). FAQ: "Are there usage limits? ... The APIs are built to grow with you" (opensrs.com/api/overview). Lookup is singled out in the MSA (3.2, 12.11). Only numeric limit found: the separate Storefront JSON API "rate limited per reseller account to 600 requests per minute" with 429 + `Retry-After` (K21); port-43 WHOIS 1 lookup/second/IP (K25) |
| Connection | "A connection ... remains open for no more than 60 seconds" (S11 unnumbered row); 705 "Timed out, resubmit request" |
| Error semantics | HTTP 200 with `response_code`/`is_success` in body. 401 for bad key/IP/MD5 (S30). Key codes: 200 ok; 210 available; 211 taken (with `is_success=1`); 221 taken (waiting registration exists); 250 async accepted; 400/404 internal; 410/415 auth; 435 permission; 437 another request waiting on domain; 440 over quota/insufficient funds; 465 invalid data / already renewed; 480 not owned/not supported; 485 domain taken; 486 "Entity already exists in a processing state ... Trying again in a few seconds to a minute should resolve"; 487 not transferable; 541 expiry-year mismatch; 552 "Domain is less than 60 days old"; 555 already renewed; 70x registry communication errors (S11) |
| Batch | `SUBMIT BULK_CHANGE`: up to 10,000 domains, `batch.opensrs.net` only, results by email (S28); `POLL EVENT` limit 100 (S27); `SUBMIT_BULK_CHANGE` for WHOIS privacy |
| Maintenance | Registry windows appear on the status page (e.g. Verisign .com/.net SRS outage 2026-10-11 01:00-05:00 UTC, "Duration: 4 hours"); full-platform window 2026-09-28 22:00-2026-09-29 04:00 UTC with "API endpoints ... unavailable between 2026-09-28 22:15 and 2026-09-29 00:15 UTC" (ST) |

### Making register safely retryable (no idempotency key exists)

1. Persist a Mosshatch order row (own idempotency key, domain, period, price) **before** calling.
2. Before any retry call `LOOKUP` with `no_cache=1` and `GET_ORDERS_BY_DOMAIN` (filter `type=new`, `status=pending|completed`) and `GET DOMAIN`; only resend if no order exists.
3. Treat 486/437/221 as "in flight": wait and re-poll, never resend blindly. Treat 485 after a timeout as ambiguous (could be our own success): resolve via `GET`/`belongs_to_rsp`.
4. On timeout (705, socket close) assume unknown outcome, reconcile the same way; subscribe to `domain.registered`/`domain.created` webhooks or poll events.
5. Always send explicit `period`, `handle=process`, `reg_username`, and `premium_price_to_verify` for premium names; pre-check `GET_BALANCE` (440 on low funds; forced-pending order otherwise).
6. Optional two-phase pattern: `handle=save` creates a pending order that `PROCESS_PENDING` completes or cancels (S15, `process_pending`): usable as a "reserved until passkey approval" step, but funds are still allocated ("Amount Allocated for New Registration in Progress", K16).

---

## 5. Wholesale prices (USD; what an OpenSRS reseller pays)

Basis: public rate card (S6 https://opensrs.com/domains/pricing, rendered with headless Chromium, tab per tier) and the effective-dated changes page (S7 https://opensrs.com/domains/tld-price-changes, "Last updated: Sep 29, 2026"). Prices are "US dollars per year/per transaction" (S6). `get_price` states its result "includes the OpenSRS price and the ICANN fee" (S14); the rate card does not say either way (treated as the same figure, unverified). Tier rules (K8): Essential = "No minimum"; Advanced $2,000 + 100 registrations/transfers; Premium $50,000 + 500; Enterprise $100,000 + 1,000. "Promotional discounts do not stack with plan-based discounts. The lowest available price always applies." Promos: "‡ Domain promotions do not apply to premium domains or new / legacy OpenSRS Storefront."

### Essential tier (default, no requirements)

| TLD | Register 1y | Renew | Transfer-in | Restore | Registration term / notes |
|---|---|---|---|---|---|
| .com | 14.50 | 14.50 | 14.50 | 80.00 | 1-10 yr. Verisign. **15.25 effective 2026-11-01** (S7). Grace 40 / redemption 30 (T1) |
| .ai | 111.00 | 111.00 | 111.00 | 200.00 | **Register 2-10 yr, explicit renewal 2-10 yr, transfer = "2 years renewal"** (K12). Expected first charge 2 x 111 = 222 (inference; `get_price` not run). Up from 101.00 on 2026-03-05 (S7). Identity Digital. Not in Horizon. Premiums not allowed |
| .dev | 17.00 (promo 10.00) | 17.00 | 17.00 | 150.00 | Promo end date not published. Was 13.50 before 2024-08-01. Google Registry, HSTS-preloaded |
| .io | 60.00 (promo 34.00) | 60.00 | 60.00 | 250.00 | Was 58.00 before 2026-01-19. Promo end date not published. Donuts/Identity Digital tech provider |
| .app | 21.00 (promo 14.00) | 21.00 | 21.00 | 150.00 | Was 19.00 before 2024-08-01. Google Registry, HSTS-preloaded |
| .studio | 42.00 | 42.00 | 42.00 | 80.00 | **51.00 effective 2026-10-06** (S7). Registry-premium group 2 (T1): premium names have premium registration and renewal prices |

### Other tiers (Register = Renew = Transfer; Restore identical in every tier)

| TLD | Advanced | Premium | Enterprise | Upcoming change (Adv / Prem / Ent) |
|---|---|---|---|---|
| .com | 13.50 | 12.50 | 11.50 | 14.25 / 13.25 / 12.25 on 2026-11-01 |
| .ai | 107.00 | 103.00 | 99.00 | none pending |
| .dev | 16.00 (promo 10.00) | 15.00 (promo 10.00) | 14.00 (promo 10.00) | none pending |
| .io | 59.00 (promo 34.00) | 58.00 (promo 34.00) | 57.00 (promo 34.00) | none pending |
| .app | 20.00 (promo 14.00) | 19.00 (promo 14.00) | 18.00 (promo 14.00) | none pending |
| .studio | 40.00 | 38.00 | 36.00 | 49.00 / 47.00 / 45.00 on 2026-10-06 |

Other price facts:
- WHOIS/Contact Privacy add-on: "$3.00 per year/domain ... Expires & renews with the domain" (S6). Counts toward neither tier requirement (K8).
- Managed DNS: "Managed DNS at no additional cost" (S6). MSA App. A: free "EXCEPT if the ratio of domains for which Tucows provides Managed DNS Service to the number of domains registered with or through Tucows exceeds 5:1" ($0.25 per record per month); not an issue for domains registered at OpenSRS.
- Price-change terms: "Tucows reserves the right to change prices. We will provide you with at least thirty (30) days' notice" (S1 App. A) but 12.6 lets Tucows adjust prices for ICANN/registry fee changes, and premium fees may change "without notice to the Customer" (S1 App. A). The .com rise (effective 2026-11-01) and the .studio rise (effective 2026-10-06, only 7 days after this fetch) were both listed on the changes page on 2026-09-29; when they were first posted, and therefore whether 30 days' notice was given for .studio, is unverified.
- Deposit costs: card/PayPal top-ups +3% (S5); $95 activation converts to credit (S5).
- Registry premium names (S1 10.6-10.7, App. A groups 1-3): no refunds on premium transactions, no auto-renew ("Tucows will not offer an auto-renewal option ... explicit renewal request"), group 3 renewals can vary with FX.
- Storefront-only fees (not applicable to API resale): MSA 12.5 "three percent (3%) payment processing fee plus $0.95"; KB says "$0.75 per-order" (K23): conflicting, irrelevant unless Storefront is used.

---

## 6. Lifecycle

| Topic | Finding |
|---|---|
| Add grace period (AGP) and refunds | **Not published by OpenSRS.** Only: `REVOKE` "Removes the domain at the registry. Use this command to request a refund ... A refund can be issued for only those domains which fall within the specified grace period as defined by each registry" (S24). MSA 12.2 "non-refundable amounts"; MDRA "All fees payable ... are non-refundable". Length for the six TLDs: unverified |
| Expiry grace | 40 days for all six TLDs (T1; `.com` "grace period changed to back to 40" on 2025-10-30, T2). Standard renew price applies; NS switch to OpenSRS expired-domain NS 3 days after expiry, originals restored on renewal (K8) |
| Redemption | 30 days for all six (T1). Fee = rate-card "Restore" (80/200/150/250/150/80). API `REDEEM` supports `.com .dev .studio` but the KB list for API redemption does **not** include `.ai .io .app` (K14; "TLD eligibility ... can change"). Redemption "non-refundable" (K8). `REDEEM` unusable in Horizon (S23) |
| Auto-renew | OpenSRS never auto-renews on its own: "Auto-renew by default: N" for all six; when `auto_renew=1` the job runs about 30 days before expiry ("Auto renew date: 30"), needs 2 days lead if enabled inside 30 days, and charges the reseller balance; "Auto-renew transactions fail if your reseller account has insufficient funds" (T1, K7). Registrant reminders at 90/60/30/5 days before and 3/10 after; reseller reminders 90/60/30/1/-40 (K7) |
| Post-expiry risk | Day 41-45 live auction ("Once a domain is queued for live auction, it cannot be redeemed by the original registrant"); day 70-75 drop; Tucows portfolio buy-back at 50% of fair market value, minimum $200, plus a year's fee (K8). MSA 9.1 "Tucows reserves the exclusive right to offer the registration to other Users and Registrants through the use of Tucows Auction Services"; MDRA "Tucows may, at its discretion, elect to assume the registration and may hold it in its own account, delete it, or sell it to a third party" |
| 60-day transfer lock after registration/transfer | Enforced: error 552 "Domain is less than 60 days old"; "must have resided with the losing registrar for more than 60 days since it was first registered or last transferred" (K5). ICANN Transfer Policy 3.7.5/3.7.6 (I2) |
| After registrant change | gTLD owner-contact change of first name, last name, organization or email starts an ICANN trade: new registrant approves (7 days), then current registrant (7 days); Designated Agent (default enabled) lets Tucows approve for them; "The COR process is not triggered for domains with Contact Privacy enabled" (K9). "usually mandatory 60-day inter-registrar transfer lock ... after a successful trade" can be toggled with `MODIFY_TRADE_LOCK_SETTING` (S29); ICANN 3.8.5 lets the registrar apply it unless the registrant opted out before the change (I2). K9 also mentions the COR process was "temporarily suspended": current state unverified |
| Registrant verification | New registration/transfer/contact change triggers a verification email; failure means suspension; statuses `unverified/pending/verifying/verified/not_verified/suspended/admin_reviewing`, with `verification_deadline` and `days_to_suspend` (S31). ICANN RDP effective 2025-08-20: Organization field decides legal owner; "Domains that fail Registrant Email Verification after a change will be suspended" (K10) |
| Auth code delivery | See 2 (`getAuthCode`). Auth code format for CentralNic TLDs 16-48 chars with mixed classes (K6, not our TLDs) |
| Transfer-in duration | Docs disagree. Flow (K5): admin-contact approval (5 days in K4/S20; 7 days "unique transfer key valid for seven days" in K5) then OpenSRS review "typically takes 24 to 48 hours" then losing registrar 5 days (silence = approval), and "If the losing registrar declines, OpenSRS waits up to nine more days before officially canceling". With valid `auth_info` the owner-approval step is skipped and the order goes to "Waiting for registry approval" (K4); `pending_registry` "completes after 7 days" per S20 vs 5-day registry ack per K4/K5. Best case minutes to a few days; worst case about 2 weeks |
| Transfer-away | Handled by OpenSRS: emails registrant approve/decline link; "Silence equals approval after five days" (K3); no fee found in any fetched doc |
| ccTLD differences | `.ai`: 2-10 yr terms, transfers add 2 years, WHOIS privacy N, Test env N, thick TLD "Registrant, Admin, and Tech contacts are required ... and will be displayed in WHOIS" (K12, T1). `.io`: privacy N, DNSSEC N, auth code set by support (K6), grace changed 0 to 40 on 2022-11-28 and redemption to 30 on 2023-09-08 (T2). Both had registry-link incidents (ST). IANA `.io` record last updated 2023-01-18, no RDAP server listed; `.ai` record updated 2025-02-11 with RDAP `https://rdap.identitydigital.services/rdap/` (I3, I4). `.io` long-term status (Chagos) not researched here |
| HTTPS-only preload | K13: `.dev` and `.app` are on the HSTS preload list; "Second-level domains under these TLDs will only load on modern browsers if a valid SSL certificate is configured, and the web server is serving HTTPS" and resellers must inform registrants at checkout. T1 "SSL Certificate on host required". Mosshatch's creature pages must serve valid HTTPS |

---

## 7. WHOIS privacy and RDAP redaction

- Not free: $3.00/yr/domain add-on (S6). MDRA: "Pricing for the Whois privacy registration service will be set by the Reseller" (S2). MSA App. A says only "We offer Whois Privacy for all allowed TLDs".
- Controllable via API: `f_whois_privacy=0|1` at `SW_REGISTER`; `MODIFY` `data=whois_privacy_state` (`state=enable|disable`, `affect_domains`); `GET` `type=whois_privacy_state` (S15, S17, S18). Default when omitted is not stated (unverified). It "commence[s] only after transfer completes" and "must be disabled" before an outbound transfer (S2).
- Availability (T1 "Whois Privacy available"): .com Y, .dev Y, .app Y, .studio Y, **.ai N, .io N**.
- Redaction without the paid service: since the ICANN Registration Data Policy (effective 2025-08-20), "By default, contact details (including Organization) will not be published in public WHOIS results. To make information public, contact OpenSRS to opt in" (K10); gated access for accredited parties (K11). Reduced data sets allowed from 2025-07-28; admin/billing/tech no longer collected for gTLDs from 2025-06-30 (K10); API docs still list four contact types (unverified whether optional).
- `.ai` policy page says contacts "will be displayed in WHOIS" and no privacy service is available: likely exposure of customer contact data for `.ai` (K12); confirm with a Horizon-independent test before selling `.ai` (not in Horizon).
- Privacy service registrant: "Contact Privacy Inc." (S2). Law-enforcement disclosure requires "a court order or other legal documentation" (K11).

---

## 8. Notifications

| Channel | Detail |
|---|---|
| Webhooks (API docs last updated 2026-07-28) | Configured only in the RCP (Account Settings > Event notifications). "As of 2026-07-17, complete these steps in the exact order shown" (select events, set URL, store secret, then enable) or webhooks can be "non-functional". Signed JSON POST: headers `HMAC-Signature` (HMAC-SHA256 of raw body with the 36-char shared secret, hex), `Idempotency-Key` (SHA-256 of body), `Event-ID`, `Created-At`. Respond 2xx within 5 s. 5xx retried with exponential backoff, max 5 retries over 24 h; 3xx/4xx dropped. Secret resets whenever the URL changes. (S25, updated 2026-07-28) |
| Event types | `opensrs.domain.created/registered/renewed/expired/deleted/nameserver_update/registrant_verification_status_change/message_status_change`, `opensrs.order.status_change`, `opensrs.transfer.status_change`, `opensrs.transfer.message_status_change` (S25, S26). No DNS-record, lock, or auto-renew-change events in the API event list; `DELETED` carries `reason` (expired/transfered/auction/by-request/...) and `redemption_grace_period_end_date` |
| Polling | `POLL EVENT` (`limit` max 100, default 1) then `ACK EVENT`; events must be acknowledged to leave the queue (S27, K19) |
| Email | JSON body to the account's technical contact (K19) |
| Gaps | Transfer-away requests: reseller is "notified" by email (K3); a matching webhook/poll event is not documented (unverified) |

---

## 9. Red flags and findings

| # | Finding | Evidence | Impact on Mosshatch |
|---|---|---|---|
| 1 | Unilateral suspension/termination | MSA 2.10 "in its sole discretion, may temporarily suspend access"; 19.2 "unilateral discretion, immediately suspend"; 17.1(a) 30-day termination by either party; 17.1(c) Tucows may end "any or all of its service offering" with "reasonable notice ... as is practicable"; 17.3 suspend if "failed to provide adequate support to Users" | Single point of failure; needs tested exit path (RSP-to-RSP push or transfers) |
| 2 | Unilateral contract and price changes | MSA 23.3 amend without consent if "generally applicable ... reasonable notice"; 12.2 adjust fee schedule "upon notice"; 12.6 pass-through of ICANN/registry fees; premium fees "without notice" | Margin risk; flat-fee model must absorb changes |
| 3 | Upcoming price rises | .com 14.50 to 15.25 (2026-11-01); .studio 42 to 51 (2026-10-06); .ai 101 to 111 (2026-03-05) | Re-quote at checkout via `GET_PRICE` |
| 4 | Lookup rate limit and fee unquantified | MSA 3.2, 12.11 | Cache availability results; ask Tucows for limit in writing |
| 5 | No idempotency, no per-record DNS, no scoped keys | S15, S19, K18 | Mosshatch must build reconciliation, DNS locking, and its own scoped-token layer over one master key |
| 6 | Static egress required | K1, V1 | Vercel Pro/Enterprise Static IPs or fixed-IP proxy; max 5 rules |
| 7 | Deposit terms | K15/K16 "non-refundable and cannot be withdrawn"; MSA 21.6 "return of any unused deposit"; MSA 12.1 negative balance is "material breach"; MSA 12.7 depleted balance blocks all services | Keep buffer; alerting on `GET_BALANCE`; low-balance threshold setting exists (K16) |
| 8 | Expired domains can be auctioned or taken | K8, MSA 9.1, S2 | Renew early; do not rely on redemption; warn users; store a "no lapse" policy |
| 9 | Draft renewals need manual clearing | K7 ("Delete draft" in RCP) | Ops runbook; test `CANCEL_PENDING_ORDERS` |
| 10 | Docs conflict on transfer windows, DNSSEC fee, deposit refund | see sections 6 and below | Test in Horizon or ask support |
| 11 | DNSSEC fee conflict | MDRA (S2): "Add DNSSEC key material: $500 per transaction. Change ...: $500 ... Remove: $0" vs API guide "There is no charge for this service" (dnssec-commands-overview) | Do not promise DNSSEC until confirmed |
| 12 | Outage history (status page, all "minor") | 2025-12-02 API failures/auth issues (17:49-19:27 UTC); 2026-01-29 and 2026-02-03 "Increased Latency & Error Rates in OpenSRS API" (about 6 h each); 2026-02-24 SystemDNS record deletion on update; 2026-04-19 .ai/.llc/.center lookups; 2026-06-17 identity services degraded (registrations, transfers, contact changes, 40 min); 2026-08-05/06 Identity Digital registry connection (.me .info .io .ai), about 24 h, registrations/renewals/management down; 2026-08-11 SystemDNS resolution outage (about 6 h); 2026-09-28/29 platform maintenance, API down 2 h | Queue and retry layer; status page subscription; DNS not the sole resolver for critical domains |
| 13 | Docs staleness | TLD clauses dated 2022-05-31 with no .ai/.io/.dev/.app text (S3); DNSSEC overview links an older TLD-chart spreadsheet ID; MSA Storefront fee (3% + $0.95) differs from KB ($0.75 per order); HTML MDRA now says "Tucows Domains Inc." while older PDF copy of Appendix B differs in wording | Mosshatch must fetch registry terms itself (MSA 3.17) |
| 14 | Registrant credentials | `reg_username`/`reg_password` create an OpenSRS profile usable in the Manage Web Interface (K-MI) where registrants view/change auth codes (K6) | Generate random passwords, keep in the vault; can MWI be disabled: unverified |
| 15 | Developer sentiment | Only dated anecdotes on Hacker News (H1): 2014 (item 7935036) "OpenSRS has seemingly been stuck in the 90s with UI stuff for a while now, and recently started charing [sic] $3/year extra for private registration"; 2009 (670992) "the built-in control panels are a bit clumsy"; 2012 (4971571) "Not the prettiest management panel but they give you lots of control over your domains with their API". Vendor testimonial (ikas) says integration was quick | Weak evidence; no systematic review possible (search budget exhausted) |
| 16 | Corporate | Tucows Inc. is public (NASDAQ: TCX); Q2 2026 results published 2026-08-06 (T3). No distress signal found | Low |

---

## 10. Recommendation

**Primary (conditional).** OpenSRS's *published contract* is explicitly a white-label resale agreement, requires no ICANN accreditation, has no monthly fee or minimums, publishes wholesale prices for all six launch TLDs (Essential .com 14.50, .dev 17, .app 21, .studio 42, .io 60, .ai 111), provides a sandbox, offers signed webhooks plus polling (docs updated 2026-07-28), and hosts DNS behind the same API. Every Mosshatch adapter method maps to a documented command except three engineering gaps that are workable: DNS is replace-all (build read-modify-write with a per-domain lock and skip CAA/TTL), availability is one domain per call (cache aggressively and batch `NAME_SUGGEST` for multi-TLD), and outbound transfers are approved by the registrant through OpenSRS emails rather than by API (surface status and unlock/auth-code prep only). The costs are operational rather than contractual blockers: XML/MD5 client, a static egress IP (Vercel Pro/Enterprise Static IPs or a fixed proxy), no idempotency key (reconcile through `GET_ORDERS_BY_DOMAIN`), a $3/yr privacy add-on that is unavailable for .ai and .io, .io auth codes issued by support, Horizon that cannot test transfers, redemption or .ai, and price steps already scheduled (.studio +$9 on 2026-10-06, .com +$0.75 on 2026-11-01). The MSA gives Tucows broad unilateral suspension, termination and price-change rights, and the platform had multiple API and registry-link incidents in the last ten months, so Mosshatch should (1) obtain written answers on lookup rate limits/fee, static-IP requirement, .ai/.io handling and pricing-tier promotion, (2) implement a queue/retry/reconciliation layer and a second registrar adapter, and (3) avoid launching .ai until its 2-year term, 2-year transfer charge and public-contact exposure are tested. If another candidate in the comparison offers JSON, idempotent registration and per-record DNS at equal or lower wholesale cost with a comparable resale contract, OpenSRS drops to fallback.

---

## Unverified items and why

1. Add-grace-period length and refund rule for the six TLDs (OpenSRS publishes only "as defined by each registry"; ICANN AGP page URL guesses returned 404).
2. Any numeric XML-API rate limit and the "excessive use" lookup fee amount (not published).
3. Whether the public rate card includes the ICANN fee (only `get_price` says it does).
4. Actual charge for `.ai` at `period=2` and for a `.ai` transfer (2-year renewal); `get_price` not run (no credentials).
5. End dates of `.io`, `.dev`, `.app` promo prices.
6. Live behaviour of any command: Horizon on port 55443 was unreachable from this sandbox (connection reset via proxy), and no credentials exist. Everything in section 2/4 is from documentation.
7. Whether Horizon supports SystemDNS zone commands, expiry clocks, webhooks, and premium tiers.
8. Whether new API resellers face manual approval or KYC (none documented; "Speak with our sales team").
9. Whether admin/tech/billing contacts are optional for gTLD API registrations after the ICANN RDP (KB says reduced sets are allowed from 2025-07-28; API docs unchanged).
10. Whether `domain_auth_info` returns a code for `.io`, and where `SEND_AUTHCODE` sends it now.
11. Whether a transfer-away request emits a webhook/poll event.
12. Whether the Manage Web Interface can be disabled or restricted for API-created profiles.
13. Current status of the ICANN change-of-registrant process at Tucows (K9 says it "was temporarily suspended").
14. Fees for outbound transfers (none found, not proven absent).
15. `.io` long-term delegation risk (only IANA record checked) and Vercel Static IPs pricing.
16. Developer complaints beyond dated HN anecdotes (GitHub org pages unavailable from this sandbox: "sessions are bound to their configured repositories"; web search budget was exhausted mid-task).
17. MSA effective date (only HTTP/PDF timestamps available).

---

## Source registry (all accessed 2026-09-29)

| ID | URL | What |
|---|---|---|
| S1 | https://assets.opensrs.com/Uploads/Master-Services-Agreement.pdf (also https://opensrs.com/legal/contract) | MSA incl. Appendix A/B |
| S2 | https://assets.opensrs.com/Uploads/Master_Domain_Registration_Agreement.html | Master Domain Registration Agreement (Exhibit A) |
| S3 | https://assets.opensrs.com/Uploads/TLD_clauses.html | TLD-specific terms |
| S4 | https://opensrs.com/join ; https://opensrs.com/ ; https://opensrs.com/api/overview ; https://opensrs.com/onboarding | program, API positioning, FAQ |
| S5 | https://opensrs.com/payment-terms | activation fee, funding |
| S6 | https://opensrs.com/domains/pricing | rate card (rendered) |
| S7 | https://opensrs.com/domains/tld-price-changes | dated price changes (rendered) |
| S8 | https://opensrs.com/resources/documentation | index of contracts and guides |
| S9 | https://domains.opensrs.guide/docs/quickstart | endpoints, auth |
| S10 | https://domains.opensrs.guide/docs/overview | connection info, IP rule, test env |
| S11 | https://domains.opensrs.guide/docs/codes | response codes |
| S12 | https://domains.opensrs.guide/docs/lookup-domain | lookup |
| S13 | https://domains.opensrs.guide/docs/name_suggest | name_suggest |
| S14 | https://domains.opensrs.guide/docs/get_price | get_price |
| S15 | https://domains.opensrs.guide/docs/sw_register-domain-or-trust_service- | sw_register |
| S16 | https://domains.opensrs.guide/docs/renew-domain | renew |
| S17 | https://domains.opensrs.guide/docs/get-domain | get |
| S18 | https://domains.opensrs.guide/docs/modify-domain | modify |
| S19 | https://domains.opensrs.guide/docs/set_dns_zone- ; /docs/get_dns_zone ; /docs/create_dns_zone ; /docs/force_dns_nameservers | DNS zone commands |
| S20 | https://domains.opensrs.guide/docs/check_transfer | check_transfer |
| S21 | https://domains.opensrs.guide/docs/send_authcode | send_authcode |
| S22 | https://domains.opensrs.guide/docs/get_transfers_away | get_transfers_away |
| S23 | https://domains.opensrs.guide/docs/redeem-domain | redeem |
| S24 | https://domains.opensrs.guide/docs/revoke-domain | revoke |
| S25 | https://domains.opensrs.guide/docs/webhooks-overview | webhooks |
| S26 | https://domains.opensrs.guide/docs/event-notifications-overview | events |
| S27 | https://domains.opensrs.guide/docs/poll_event | poll |
| S28 | https://domains.opensrs.guide/docs/submit-bulk_change | bulk change |
| S29 | https://domains.opensrs.guide/docs/trade-overview | ICANN trade/lock |
| S30 | https://domains.opensrs.guide/docs/troubleshooting | 401, IP delay, keys |
| S31 | https://domains.opensrs.guide/docs/get_registrant_verification_status | verification |
| K1 | https://support.opensrs.com/support/solutions/articles/201000063475 | API key and IP rules (max 5) |
| K2 | https://support.opensrs.com/support/solutions/articles/201000063061 | Horizon accounts |
| K3 | https://support.opensrs.com/support/solutions/articles/201000063132 | transfer away |
| K4 | https://support.opensrs.com/support/solutions/articles/201000063138 | transfer in |
| K5 | https://support.opensrs.com/support/solutions/articles/201000063316 | complete transfer guide |
| K6 | https://support.opensrs.com/support/solutions/articles/201000063434 | auth codes |
| K7 | https://support.opensrs.com/support/solutions/articles/201000063393 ; /201000063130 | renewing; renewal in draft |
| K8 | https://support.opensrs.com/support/solutions/articles/201000063315 ; /201000063182 | redeem lifecycle; pricing tiers |
| K9 | https://support.opensrs.com/support/solutions/articles/201000063114 | change of registrant |
| K10 | https://support.opensrs.com/support/solutions/articles/201000115819 | ICANN RDP changes |
| K11 | https://support.opensrs.com/support/solutions/articles/201000063098 | GDPR WHOIS |
| K12 | https://support.opensrs.com/support/solutions/articles/201000068801 | .AI policies |
| K13 | https://support.opensrs.com/support/solutions/articles/201000063167 | Google registry (.dev/.app) |
| K14 | https://support.opensrs.com/support/solutions/articles/201000063166 | TLDs redeemable via API |
| K15 | https://support.opensrs.com/support/solutions/articles/201000063052 | cancelling account |
| K16 | https://support.opensrs.com/support/solutions/articles/201000063400 | account balance |
| K17 | https://support.opensrs.com/support/solutions/articles/201000063205 | reseller setup, messaging |
| K18 | https://support.opensrs.com/support/solutions/articles/201000063062 | API troubleshooting (primary user only) |
| K19 | https://support.opensrs.com/support/solutions/articles/201000063405 | event notifications |
| K21 | https://support.opensrs.com/support/solutions/articles/201000127586 | Storefront API DNS (600 req/min) |
| K22 | https://support.opensrs.com/support/solutions/articles/201000131675 | Storefront API domains |
| K23 | https://support.opensrs.com/support/solutions/articles/201000114479 | Storefront migration ($0.75/order) |
| K25 | https://support.opensrs.com/support/solutions/articles/201000063438 | WHOIS rate limiting |
| K-MI | https://support.opensrs.com/support/solutions/articles/201000063394 | management interfaces (RCP, RWI, MWI, test URLs) |
| T1 | https://docs.google.com/spreadsheets/d/13t4l-kO3qAio4RCF3j1lF0X2AxaIr_G5kFIqIF3LAZU (gid=1203932299 CSV export) | TLD reference chart |
| T2 | same sheet gid=742697567 | chart modification log |
| T3 | https://tucows.com/news/ | corporate news (Q2 2026 results 2026-08-06) |
| ST | https://www.opensrsstatus.com/api/v2/incidents.json ; /scheduled-maintenances.json ; /summary.json | incident history and maintenance |
| A1 | https://tucowsdomains.com/report-abuse/ | abuse handling |
| I1 | https://www.icann.org/en/contracted-parties/accredited-registrars/registrar-accreditation-agreement/2013-registrar-accreditation-agreement-17-09-2013-en | RAA 3.12 resellers |
| I2 | https://www.icann.org/en/contracted-parties/accredited-registrars/transfer-policy-01-06-2016-en | Transfer Policy 3.7.5, 3.7.6, 3.8.5 |
| I3 | https://www.iana.org/domains/root/db/io.html | .io record |
| I4 | https://www.iana.org/domains/root/db/ai.html | .ai record |
| V1 | https://vercel.com/docs/networking/static-ips | "Static IPs are available on Enterprise and Pro plans" |
| N1 | `npm view opensrs`, `npm view node-opensrs` (registry.npmjs.org) | third-party clients only |
| H1 | https://hn.algolia.com/api/v1/search?query=opensrs&tags=comment | dated anecdotes |

Egress/availability notes: `domains.opensrs.com` blocked by egress policy (not used). `horizon.opensrs.net:55443` unreachable from this sandbox. GitHub API/org pages refused ("sessions are bound to their configured repositories").
