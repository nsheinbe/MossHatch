# CentralNic Reseller (formerly Hexonet / RRPproxy) - registrar-reseller dossier for Mosshatch

Prepared 2026-09-29. Every source below was fetched on 2026-09-29 ("accessed 2026-09-29"). `[Sn]` resolves to the full URL in the Sources table at the end; load-bearing claims carry a short exact quote. Raw evidence (OpenAPI JSON, page dumps) is in `working-directory/research/cn/`.

## TL;DR

1. **Verdict: FALLBACK, upgradeable to primary.** Resale under your own brand and price is expressly contracted (Wholesale MSA + Reseller Schedule [S1]); the end customer is the registrant; the ICANN-accredited registrar of record is Key-Systems GmbH (IANA ID 269) [S51].
2. **API covers every RegistrarAdapter method** via a REST layer (OpenAPI 3.0, public spec, OT&E sandbox) that only went live in production on 2026-07-28 [S13]; the provider's own docs still call the legacy HTTPS API "the proven, fully documented path" [S21].
3. **Price is the blocker.** Only .com is publicly priced (Basic Plus USD 18.33 register/renew/transfer, Elite Plus 13.82, restore 98.88 [S9]); .ai/.io/.studio have no public price, .app/.dev only a promo USD 15.00 that ends 2026-09-30 [S10]. Cannot validate "wholesale + flat fee" without a written quote.
4. **Onboarding friction:** EUR 75 prepay to activate, "unverified" accounts capped at that balance, signed RSP contracts, and a stated 100-domains-per-year qualification that the pricing page contradicts [S7][S9].
5. **Throughput:** documented limit is 1 command/second across the whole account (EPP FAQ) and "roughly one command per second" for API automation; a breach can trigger code 422 temporary account lock [S23][S28][S24].
6. **No webhooks; no idempotency key.** Async events are polled (`GET /event`); `cltrid` is correlation only and duplicate register returns 554 [S25][S24][S14].
7. **Contract risks:** prices changeable on 30 days' notice (or less when a registry raises fees), suspension without notice on low balance, expired-domain "utilization" (parking/auction) clause, liability capped at fees paid, German law/Saarland courts [S1][S2].
8. **Reseller duties are heavy:** you obtain registrant acceptance of the Registration Agreement, send expiry notices, keep 2 years of records, and (NIS2, live 2025-11-25) verify and log registrant data; fines can be charged to your account [S1][S38].
9. **Reliability:** ~9h13m platform outage 2025-07-03/04; fibre cut 2026-02-27; API-wide maintenance today (2026-09-29) extended by IPv6 problems [S46].

---

## 1. RESALE

**Verdict: YES (explicit, contract-based, conditional on signing the Reseller Schedule).**

### 1.1 Governing clauses (all from the Wholesale Master Service Agreement page [S1], accessed 2026-09-29)

The MSA is between **Key-Systems GmbH ("Service Provider")** and the reseller ("Customer") [S1]. Order of precedence puts the MSA first, then the Reseller Schedule, then other schedules, the Anti-Abuse Policy, the general T&Cs and Third-Party Policies (MSA clause 30) [S1].

| Topic | Clause | Exact quote |
|---|---|---|
| Resale is off by default | MSA 5.2 | "Customer will not use the System or the Services to provide Service Provider's services to Customer-Clients unless explicitly permitted by Service Provider. Any permitted Reseller Activity shall be governed by the terms of the Reseller Schedule to this Agreement." |
| Grant of resale | Reseller Schedule 1 | "Service Provider grants permission to the Customer to engage in Reseller Activity to provide services to Customer-Clients." |
| Signing the schedule is enough | R&M Schedule 1.2.2 | "Agreement to the Reseller Schedule to the Master Service Agreement by both Parties shall be considered sufficient agreement to engage in Reseller Activity." |
| Definition | MSA 1.19 | "'Reseller' - a Customer using the Services on behalf or for the benefit of third-party Registrants with the agreement of Service Provider." |
| Own customer relationship | Reseller Schedule 3.4 | "Customer shall be solely responsible for provision or customer service, billing and technical support to Customer-Clients." and "Customer remains Service Provider's only contracting party for the receipt of Services under the Agreement." |
| Ordering on customers' behalf | Reseller Schedule 4.8 | "Customer further warrants that each Registrant has explicitly authorized Customer and the Service Provider to manage Domain Names on their behalf." |
| Own brand / white label | Program page [S6] | "sell domains to the public under their own brand, without ICANN accreditation. You control the pricing and customer relationships, while CentralNic Reseller handles the infrastructure, compliance, and technical backend." and "Customers purchase through your branded site while registrations are automated via CentralNic Reseller." |
| Own price and checkout | Pricing FAQ [S9] | "You set the domain reseller pricing on your own storefront. We provide you with the wholesale rate for each domain extensions, and then you choose whatever markup suits your business strategy." |
| Not hiding the registrar | Reseller Schedule 4.3 | "Upon inquiry by the Registrant, Customer shall identify Service Provider as sponsoring Registrar of their Registration or provide other means for identifying the sponsoring registrar." |
| No ICANN pretence | Reseller Schedule 4.11 | Customer is "prohibited from using any ICANN or Registry logo or graphic ... or from holding itself out to be accredited by ICANN or any Registry" (unless it is itself accredited). |
| Consumers | Reseller Schedule 2 | Customer (the reseller) must be "an established legal entity, entrepreneur, trader, freelancer or public institutions ... and that consumer protection laws are not applicable to it." Sign-up form adds: "CentralNic Reseller is a B2B service that does not provide services to private consumers or individuals based in the EU" [S8]. This binds the account holder (Mosshatch), not its end customers; whether consumer end-registrants are welcome is not stated (see Unverified). |

### 1.2 Formal program and requirements

- Yes, a "Domain Reseller Program" exists [S6]. Tiers: "New resellers start on an entry tier with full API access. Higher tiers unlock better pricing, dedicated support, and custom commercial terms." [S6]
- **Application/approval:** online sign-up form (company data, VAT ID, industry, volume); ticks acceptance of T&Cs, Wholesale MSA and Registration Agreement [S8]. FAQ: "In order to become an accredited Reseller Service Provider (RSP) of Key-Systems GmbH, the registrar of record for CentralNic Reseller ..." then "complete your registrar data and charge your account with 75 EUR" [S7].
- **Contract:** "you will be contacted by your Account Manager ... you will receive the necessary contracts (RSP General Agreement, Confidentiality Agreement, RSP Data Info-Form) that must be signed and submitted via email, fax or post." [S7] (the contents of these three documents are not public).
- **Minimum deposit / prepay:** EUR 75 to activate; the whole model is prepaid: "the Services shall be provided on a pre-payment basis" (MSA 14.3) [S1]. "unverified" accounts: "your transactions are limited to the initial 75 EUR account balance. The amount of allowed API commands is limited as well, as you are in the Basic price scale." [S7]
- **Volume commitment (conflicting statements):** FAQ: "you must register at least 100 domains within 1 year OR transfer at least 100 domains to CentralNic Reseller after you sign-up. You'll also need API access for your business." [S7]; pricing page footnote repeats it [S9]; the same pricing page FAQ says "No, there is no minimum purchase required to access our domain reseller pricelist. You can start with as little as a single domain registration" [S9]. MSA 13.1(ii) lets the provider terminate "in the event the Customer is not using any paid Services" after 36 months [S1]. Confirm in writing.
- **KYC:** MSA 13.5: provider "may from time to time conduct a validation of any credentials and data provided by Customer or initiate a background check of the Customer, Registrants using Service Providers' services through the Customer and/or the Customer-Clients" [S1]. Sanction screening: contact creation "for persons from these countries will be fully rejected": Cuba, Iran, Syria, South Sudan, North Korea, Crimea, Russia, Belarus, and the Luhansk/Donetsk/Crimea regions of Ukraine [S39]. Account Service Fee: "we charge an account-level service fee. This fee does not apply to all customers." [S7] (amount not public).

### 1.3 Who is the registrant, who signs what, who notifies whom

| Question | Answer | Evidence |
|---|---|---|
| Registrant of record | The end customer (Mosshatch's user). "Customer will register Domain names in the names of the Registrants only, unless expressly agreed otherwise with the Registrant." Registrant = "the individual or organization entered into the RDS as Owner Contact, i.e. the party legally responsible for the use of the Domain Name." Key-Systems is the sponsoring registrar. | Reseller Sched. 4.4; MSA 1.13; R&M 1.3.6 [S1] |
| Registrar agreement acceptance | **Mosshatch must obtain it.** "Customer shall require all Registrants to enter into a paper or electronic Registration Agreement with Service Provider and to agree to the terms contained in the applicable Third-Party Policies ... Customer shall document and maintain the respective confirmations of approval of these terms by the Registrant" Also: resellers "are obliged to transmit these conditions completely and obligatory to the end customer/registrants and to document their approval by appropriate evidence." | Reseller Sched. 4.3 [S1]; Registration Agreement s.1 [S2] |
| Registry-registrant terms, UDRP/URS, GDPR consent | Also on Mosshatch: "Customer shall further ensure and document the explicit consent of the Registrant to the processing of the Registrant Information by Service Provider and/or the Registry." | Reseller Sched. 4.13 [S1] |
| ICANN Registrants' Benefits and Responsibilities | Mosshatch must publish or link it: "Customer agrees to publish on its website(s) and/or provide a link to the ICANN Registrants' Benefits and Responsibilities Specification". | Reseller Sched. 4.10 [S1] |
| Expiry notices | Mosshatch: "written or email notice one month and one week prior to the expiration date, as well as within 5 days after the expiration date". CNR *also* sends ICANN ERRP emails to registrants (30 days, 7 days before, 1 day after expiry) that "will not contain any direct reference to Key-Systems / CentralNic Reseller"; sender address customisable (`ICANNERRP-EMAIL-SENDER`). | Reseller Sched. 4.7 [S1]; ERRP page [S40] |
| Contact verification (ICANN RAA) | CNR sends the registrant verification email; "customizable white-label solution"; unverified domains are suspended after `X-TIME-TO-SUSPENSION` = "created date/transfer date ... plus 15 days". | [S41] |
| Owner-change (registrant change) notices | Default FOA mode: "both the old and the new domain owner receive a separate mail and need to confirm". Optional Designated Agent mode requires the reseller to pass on the Key-Systems Registration Agreement and to "inform their customers that an update of the ownership data will result in a 60-day transfer lock". | [S42] |
| Auth code delivery | "Customer shall provide the Registrant with the authorization codes necessary for Domain Name transfers within 5 days of any request". ICANN Transfer Policy 5.2 also caps this at 5 calendar days. | Reseller Sched. 4.6 [S1]; [S50] |
| NIS2 data verification | "both registrars and resellers share the responsibility for ensuring that registration data is accurate and complete"; reseller must "Maintain logs documenting verification for each registrant contact." "any fines applied to us by a registry operator regarding unverified registration data supplied by you may be charged to your account." Live since 2025-11-25. | [S38] |
| Records | "for two years thereafter create and maintain sufficient documentary records of its business dealings with the Customer-Clients" including "evidence of the acceptance of the Terms". | Reseller Sched. 3.10 [S1] |
| Abuse reports | Public reports go to Key-Systems: "For general abuse reports, please use: https://abuse.cleandns.space/cleandns"; registries/law enforcement have a dedicated address. Mosshatch must act: "Customer shall investigate any report of abusive use of the Service received from Service Provider or any third party and take all necessary action to stop any abusive behavior so identified as well as provide feedback". Key-Systems may act itself: "deny, cancel, suspend, disable, lock or transfer any Service where it deems necessary and at its sole discretion". | [S47]; Reseller Sched. 3.9 [S1]; [S4] |
| Legal process | Key-Systems answers courts: "will implement all valid court orders or seizure warrants from courts, arbitration tribunals, or law enforcement agencies of applicable jurisdictions, provided the court orders and seizure warrants are enforceable at the domicile of Service Provider" (Germany). On any complaint or lawsuit, "the Customer agrees not to make any changes to the Domain Name record without the Service Provider's prior written approval" and provider may lock or transfer control to the registry (R&M 1.6). | [S4]; [S1] |
| Provider may contact your customers | "The Service Provider reserves the right to contact any customers of Customer and/or Customer-Clients with notices required by Third-Party Policies" and may provide services directly to a Customer-Client and charge you a fee if you fail to support them. | Reseller Sched. 3.7, 3.8 [S1] |

**Design consequence for Mosshatch:** AI-agent-initiated actions still need the registrant's recorded authorisation (Reseller Sched. 4.6: "the Reseller must ensure the authorization by the third party" before termination or change of ownership; keep evidence "for as long as legally possible").

---

## 2. API COVERAGE (one row per RegistrarAdapter method)

Facts about the API surface:
- **REST base URLs:** OT&E `https://rest-ote.rrpproxy.net/v1`; production `https://rest.rrpproxy.net/v1` ("Real registrations, from 28 July 2026") [S13]. Auth: HTTP Basic or Bearer JWT [S13]. Public OpenAPI 3.0 spec: `https://rest-ote.rrpproxy.net/v1/openapi.json` (v2.0.0-ote.3) and `https://rest.rrpproxy.net/v1/openapi.json` (labelled v0.0.3); I diffed them: same 287 operations and identical parameters, only the version label differs [S14][S15].
- The REST layer is a thin wrapper: "each endpoint maps to an established command (a `GET /domain/{domain}/availability` call runs CheckDomain, a `POST /domain` runs AddDomain) and returns the familiar code / description / property response envelope" [S13]. Success is `code` 200 in the JSON body; HTTP-status mapping is not documented.
- The docs warn: "The API is actively evolving - if you were already using an earlier version, review the changes (some are breaking) before you move to the consolidated release" [S13].

| Adapter method | Supported | REST endpoint (XRRP command) | Caveats |
|---|---|---|---|
| `checkAvailability` (bulk names x TLDs) | **yes** | `GET /domain/-/availability?domain=a.com&domain=b.ai...` or `POST` same path (CheckDomains); single: `GET /domain/{domain}/availability` (CheckDomain) [S14] | "You can submit a CheckDomains for up to 32 domain names." Client must build the name x TLD cross product and chunk by 32. Codes 210 available / 211 not available [S24]. A check is not a hold. Premium names come back "domain name not available" until premium handling is switched on (see quote) [S33]. Subject to the ~1 cmd/s limit. |
| `quote` (register + renewal price, premium detection) | **yes** | `GET /domain/{domain}/price?type=ADDDOMAIN\|RENEWDOMAIN\|TRANSFERDOMAIN\|RESTOREDOMAIN&period=N` (DomainPrice); `GET /domain/-/prices?domain=` (all types and periods); `GET /price/-/zone?zone=` (QueryZonePriceList); premium fee via `x-fee-command/-domain/-period` on the availability call [S14] | Response fields include `setup`, `annual`, `transfer`, `restore`, `trade`, `premium`, `currency`, `price`, `promotion`, `vat` [S14]. Premium class returned as `X-FEE-CLASS` "(Premium \| Standard)" [S34]. Promo code via `x-promotion-code`. Account currency default EUR; USD available (see s.5). |
| `register` | **yes** | `POST /contact` (AddContact) to create a handle, then `POST /domain` (AddDomain) with `ownercontact0`, `admincontact[]`, `techcontact[]`, `billingcontact[]`, `nameserver[]`, `period`, `transferlock`, `renewalmode`, `x-whois-privacy` [S13][S14] | Two-step (contact handle first). WHOIS-privacy flag is `x-whois-privacy=0\|1`. .app/.dev require `x-accept-ssl-requirement=1` (see s.5). Premium requires `x-fee-amount` handshake: "If the price at the registry changes between the check and the creation, the handshake will fail" [S33]. Per-TLD `X-...` fields (357 body fields in the schema) [S14]. Duplicate/retry behaviour: see s.4. |
| `renew` | **yes** | `PATCH /domain/{domain}/renew` body `period`, `expiration` (current expiration year) (RenewDomain) [S14] | "You can not explicitly renew domains with a maximum registration period of one year. For those domains you have to set the domain renewalmode accordingly." (RENEWONCE). `expiration` is a guard against double renewal (code 555 "Domain already renewed") [S24]. CNR manages renewal against its own *renewal date*, 35 days after registry expiry for gTLDs [S27]. .ai renews in 2-9 year steps [S34]. |
| `getDomain` (status, expiry, lock, NS, registry status codes) | **yes** | `GET /domain/{domain}` (StatusDomain) [S14] | Returns `status[]` (EPP codes e.g. clientTransferProhibited), `rgp_status` / `rgp_enddate` (redemptionPeriod), `transfer_lock`, `registration_expiration_date`, `paiduntil_date`, `renewal_date`, `renewalmode`, `nameserver`, contacts, `pending_job`, `x-whois-privacy`, `x-authcode-expiration`, `auth` [S14]. Use `renewal_date`, not registry expiry, for deadlines. |
| `setLock` | **yes** | `PATCH /domain/{domain}` body `transferlock=0\|1` (ModifyDomain); optional `status`/`addstatus`/`delstatus` for `clientTransferProhibited`, `clientUpdateProhibited`, `clientDeleteProhibited`, `clientHold` [S14] | `transferlock` "(not supported by all registries)". CNR applies `clientTransferProhibited` automatically to every registered/transferred-in domain and "if the domain is not transferred out within 30 days, the lock is automatically reapplied" [S32]. Registry Lock is a separate paid service [S1]. |
| `listRecords` | **yes** | `GET /dnszone/{dnszone}/rr` (QueryDNSZoneRRList) with filters `name`, `type`, `content`, `prio`, `ttl` [S14] | DNS **is hosted by the provider** (KeyDNS). Response returns record *lines* (`rr#`), **no record IDs** [S14]. Zone must exist (`POST /dnszone`, `GET /dnszone/{z}/availability`). |
| `upsertRecord` | **partial** | `PATCH /dnszone/{dnszone}` body `addrr[]`, `delrr[]`, `rr[]` ("Set of resource records to exchange") (ModifyDNSZone) [S14][S44] | No native upsert. Documented pattern: "repointing a host - is a delete plus an add in the same command" [S30]. To delete you must supply the *exact* record line, so read first (`GET .../rr`). Both per-record CRUD and replace-set exist. Rules: TTL below 60 raised to 60; TXT must be double-quoted; "A single domain/record-type pair is capped at 1,000 records" [S30]. Only effective if the domain delegates to KeyDNS nameservers (`anycast1.dnsres.net`, `anycast2.dnsres.net` or `ns1-3.dnsres.net`) [S30]. |
| `deleteRecord` | **yes** | `PATCH /dnszone/{dnszone}` body `delrr[]` (exact line) or `delallrr` wildcard [S14] | Same exact-line requirement. |
| `startTransferIn` | **yes** | `POST /domain/{domain}/transfer` body `action=REQUEST`, `auth`, `ownercontact0` ... (TransferDomain); pre-check `GET /domain/{domain}/transfer/availability` (CheckDomainTransfer) [S14][S28] | Owner contact mandatory for thin/MDS TLDs incl. .com and .studio [S28]. CheckDomainTransfer: "Only possible for .COM, .NET, .JOBS, .ORG, .BIZ, .INFO, .NAME and .MOBI - domain names" [S14]. Charged on initiation: "A transfer-in is charged against your prepaid balance the moment it is initiated, and most transfers extend the domain by a year" [S28]. .ai transfer renews 2 years and can run without an auth code (7-day losing-registrar window) [S34]. Bulk: ~1 cmd/s [S28]. |
| `getTransfer` | **partial (poll only)** | `GET /domain/{domain}/transfer` (StatusDomainTransfer: `transfer_status`, `request_date`, `execute_date`, `requesting_registrar`); `GET /domain/-/transfer` (QueryTransferList); `GET /event?class=DOMAIN_TRANSFER` [S14][S25] | Statuses: pending/REQUESTED/INITIATED, clientApproved, serverApproved, clientRejected, clientCancelled, serverCancelled [S28]. Events `TRANSFER_SUCCESSFUL/PENDING/FAILED/NOTIFY` and `FOREIGN_TRANSFER_*` [S25]. **No webhook.** |
| `getAuthCode` | **yes (gTLD via StatusDomain)** | `GET /domain/{domain}` -> property `auth` (+ `x-authcode-expiration`) [S14]; `PATCH /domain/{domain}/authcode` (SetAuthCode) only for .de/.eu/.be/.sg/.priv.no [S14] | Auth format 8-32 chars, must mix letters, digits and specials [S34 .com/.studio]. Not verified live for .ai/.io (no account). ICANN: release within 5 calendar days of request [S50]. |
| `startTransferOut` | **partial (composite)** | Unlock: `PATCH /domain/{domain}` `transferlock=0`; reveal auth (`GET /domain/{domain}`); track/act: `GET /domain/-/foreigntransfer` (QueryForeignTransferList, lists pending outbound with available actions "approve, deny or approve and deny") and `POST /domain/{domain}/transfer` `action=APPROVE\|DENY`; auto policy `PUT /domain/{domain}/transfermode` `AUTOAPPROVE\|AUTODENY\|DEFAULT` [S14][S45] | The *gaining* registrar starts the transfer with your auth code; your adapter's job is unlock + code + optional approve. Default gTLD path: registrant FOA email, auto-finalised after 5 days [S34]. No outbound fee documented (unverified). |

**Premium handling quote [S33]** (simple mode also exists: `allow-simplemode` enables premium purchase with `X-ACCEPT-PREMIUMPRICE=1` instead of the fee handshake): "The new premium domain system will be disabled by default for each registrar, which causes our system to return 'domain name not available' on availability checks for a premium domain name through our API." Enabled under Account > Settings > Premium Domain (`active`, `allow-simplemode`; both default 0) [S33].

---

## 3. SANDBOX / OT&E

**Exists: yes.**
- **URLs:** REST `https://rest-ote.rrpproxy.net/v1` (Swagger UI at `.../v1/openapi.html`); legacy HTTPS `https://api-ote.rrpproxy.net/api/call?s_opmode=OTE&s_login=...&s_pw=...&command=CheckDomain&domain=example.com`; RDAP `https://rdap-ote.rrpproxy.net/domain/[DOMAINNAME]` [S13][S18][S36]. The Control Panel page "API > API Gateways" lists the authoritative hostnames per account [S18].
- **Credentials:** "The OT&E login is your standard account login, but you set its password from the live Control Panel under Account -> Settings -> Passwords." [S16] Conflicting notes: REST guide says "OT&E credentials do not work against production" [S13]; cutover guide says "By default, OT&E credentials are identical to the production ones, but individual changes may apply" [S19]. Unknown whether OT&E is reachable before the EUR 75 activation (see Unverified).
- **What it simulates:** "a full sandbox that runs the same commands and speaks the same protocols as production ... nothing is billed" [S18]. Registration end to end (check, create, modify, status) and transfer end to end "including the asynchronous status flow" [S18]. Premium flows via designated test names ("Every premium domain from the live system is usable for testing in OT&E") [S18][S33].
- **Not documented:** simulation of expiry/renewal-date lifecycle, redemption, DNS resolution, or registry-specific behaviour for .ai/.io. Treat these as untested until you try.
- **Differences from production:** separate system and data ("Nothing You Do in OT&E Carries Over"), no charges, own credentials, own IP allow-list check, premium test names only [S18][S19]. The OT&E and production OpenAPI files differ only in version label [S14][S15].

---

## 4. RATE LIMITS and operational constraints

| Item | Finding | Evidence |
|---|---|---|
| Documented limit | EPP FAQ: "Is there a rate limit ... ? One (1) command per second." EPP guide: "1 command per second, measured across the whole account, not per connection." "5 concurrent connections per registrar (there is no per-IP limit)." Idle 10 min, session TTL 24 h. Transfer guide (generic API automation): "CentralNic Reseller enforces roughly one command per second across the account". | [S23][S22][S28] |
| REST-specific limit | **Not documented** (no rate-limit, 429 or Retry-After text in the OpenAPI or KB). Assume the account-wide 1 cmd/s applies to all gateways. | [S14] (0 hits) |
| Abuse lock | Code 422: "Abuse detected! The account has been temporarily locked! Please standby some minutes." Temporary errors 4xx: "please resubmit your command at a later point in time"; 421 "Client should try again". | [S24] |
| Auth scheme | REST: HTTP Basic (`accountname:username` + password for sub-users, colon collides with `curl -u`) or Bearer JWT. Legacy HTTPS API sends `s_pw` in the query string or uses `StartSession persistent=1`. Password policy is stated two ways on one page: "10-64 characters" and "8-32 characters". | [S13][S16][S54] |
| IP allow-list | Optional, **off by default**; "up to five (5) IPv4 addresses or ranges. Ranges from /24 to /30"; IPv4 only; applies to REST/EPP/SOAP/HTTPS/XRRP/XML-RPC, not the Control Panel. The return-code table has 535 "Restricted IP address" (probably the allow-list refusal; the KB troubleshooting table itself only says "Connection refused or times out immediately"). Vercel functions have no fixed egress IPs, so leave it off or buy static egress. | [S16][S17][S24] |
| Least privilege | Sub-users with ACLs ("One User per Integration"); 2FA (Google Authenticator) for the Control Panel. | [S16][S20] |
| Formats | REST: JSON in/out, OpenAPI 3.0, envelope `code`, `description`, `property`, `cltrid`, `svtrid`, `queuetime`, `runtime`. Legacy: key/value over HTTPS, XML-RPC, SOAP, EPP, XRRP, SMTP. | [S13] |
| Batch limits | CheckDomains 32 names per call. List commands paginate with `first`/`limit`. No documented bulk-register endpoint (loop with pacing). | [S14] |
| Async | `jobqueue=1` on AddDomain/RenewDomain/ModifyDomain "Queue the command and process it in non-real time"; results arrive as events with `jobid`. | [S14][S25] |
| Errors | 2xx success; 4xx temporary; 5xx permanent: e.g. 530 auth failed, 535 restricted IP, 540 not unique, 545 entity not found, **546 credit limit exceeded**, 548 not up for renewal, **554 domain already registered**, 555 already renewed, 557 object status prohibits operation. | [S24] |
| Safe retry of `register` | No idempotency-key feature. OpenAPI: `cltrid` = "Unique identifier for this request, must be changed with every request, the default is autogenerated" (it is echoed for correlation, not de-duplication). A blind retry after a timeout returns 554 if the first call succeeded. **Pattern (documented pieces, untested):** persist your own order row + a `cltrid` per attempt; on timeout/421/5xx first call `GET /domain/{domain}` (StatusDomain): 200 means it exists (treat as success, read `pending_job`), 545 means not found (safe to retry); confirm via `GET /event?class=DOMAIN_REGISTRATION` (`REGISTRATION_SUCCESSFUL/PENDING/FAILED`, carries `cltrid`, `jobid`); never retry on 546/554. | [S14][S24][S25] |
| Prepay dependency | Charges are immediate against balance; "an empty balance stops new registrations". Set a low-balance warning. | [S20][S1] |

---

## 5. WHOLESALE PRICES (USD)

**Basis:** what a reseller pays CNR (wholesale price scales). Public data is partial. The public table lists ~30 popular TLDs in three volume tiers: **Basic Plus** (fewer than 250 domains under management; the tab label says 249), **Pro Plus** (250-999), **Elite Plus** (over 1,000) [S9]. "All prices are displayed in the original currency. VAT is not included" [S9]. The complete list is "in your control panel after registration" [S9] and via `GET /domain/{d}/price` / `GET /price/-/zone` [S14]. Account currency: MSA default EUR ("The Parties may agree to accounting in USD", 14.6) [S1]; the sign-up form lets you pick USD/EUR/GBP/CHF/PLN/AUD/NZD [S8].

| TLD | Register 1y | Renew | Transfer-in | Restore | Basis / source | Gotchas |
|---|---|---|---|---|---|---|
| **.com** | Basic Plus 18.33 / Pro Plus 16.12 / Elite Plus 13.82 | same as register (18.33 / 16.12 / 13.82) | same as register | 98.88 (all tiers) | Public tier list, confirmed from `data-pricing-tier` attributes in the page HTML [S9] | 60-day registry transfer lock after registration; thin registry; owner contact required on transfer. CNR's own blog says Verisign's registry fee rises "from $10.26 to $10.97 per year from November 2026" (not independently verified) [S53]. Basic Plus renewal (18.33) sits far above that registry fee. |
| **.ai** | **unverified** (not public) | **unverified** | **unverified** (billed for 2 years) | **unverified** | No public price. Control panel/API only. | Registration min **2 years** (2-10); renewal 2-9 years; "Upon successful transfer, .AI domains are renewed by two years and billed accordingly"; redemption 30 days; deletion 43 days after expiry; transfer possible without auth code (7-day confirm window); no WhoisPrivacy listed [S34]. |
| **.dev** | Promo **15.00** (1-year registration only), 2026-07-01 to **2026-09-30**; regular price unverified | unverified | unverified | unverified | Promotions table [S10]; "Domain promotions are usually only valid for new registrations. Renewal and transfer pricing is separate and are often different from promotional rates." | HSTS preload: HTTPS required; must send `x-accept-ssl-requirement=1` after presenting the notice to the registrant [S34][S14]. |
| **.io** | **unverified** | **unverified** | **unverified** | **unverified** | No public price. | Registry (nic.io) applies a 60-day transfer lock after registration; 5-day post-transfer lock; Handle updates "no" ("Create a new handle and assign it by using the ModifyDomain command to update contact information"); autorenew grace 35 d, redemption 30 d; WhoisPrivacy supported [S34]. |
| **.app** | Promo **15.00** (1-year only), 2026-07-01 to **2026-09-30**; regular unverified | unverified | unverified | unverified | Promotions table [S10] | Same HSTS/SSL acknowledgement as .dev; "Directly accredited" with Google registry [S34]. |
| **.studio** | **unverified** | **unverified** | **unverified** | **unverified** | No public price. | Donuts registry, "Directly accredited"; premium names need `X-ALLOCATION-TOKEN`; 60-day registry lock; OFAC state/province validation; owner contact required on transfer [S34][S28]. |

Discount tiers: Basic Plus / Pro Plus / Elite Plus by portfolio size; "Set your own pricing with volume-based discounts that improve as you grow" and "custom commercial terms" for higher tiers [S6]. Price change terms: see s.9. Premium names are priced per name and surfaced by `DomainPrice`/fee extension; premium handling is off by default [S33].

---

## 6. LIFECYCLE

| Item | Behaviour | Evidence |
|---|---|---|
| Add grace period (AGP) | Informative `addPeriod` status "for the first several days" and "the deletion of the domain within this timeframe would result in a revert of the registration" [S27]. Delete API returns `PAYBACK` / `ADDGRACEDELETIONS` for refunded AGP deletes ("For refunded AGP deletes the response will confirm the successful completion of the command") [S43]. Per-zone AGP quota exists (`QueryAGPDeleteslist` sample: agp percentage 9.0, agp days 5) [S43]. Exact length/refund rules per TLD and MSA refund rule: MSA 14.8 says fees "are not refundable" except as stated. **Exact AGP terms unverified.** | [S27][S43][S1] |
| Auto-renew grace | gTLDs: "It grants a 45 day extension before the domain expires"; CNR subtracts 8 days ERRP and 2 days buffer: "the renewal date will be 35 days after the expiration date for gTLDs: 45 days - 8 days ERRP - 2 days buffer." During the ERRP portion the domain is suspended (`pendingDelete`, stops resolving); a plain renewal is still possible. | [S31][S27] |
| Does CNR auto-renew by itself? | Only per renewal mode. Default mode = "automatic deletion of domains at the end of the registration period"; `AUTORENEW` is recommended ("the safe default for most resellers"). AutoRenew needs balance: "If funds are short at the renewal date, an AutoRenew domain is left to auto-expire instead and removed - recovering it then means a paid restore." Modes: DEFAULT, AUTORENEW, AUTOEXPIRE, AUTODELETE, RENEWONCE, RENEWONCETHENAUTODELETE, RENEWONCETHENAUTOEXPIRE, EXPIREAUCTION. | [S31][S20][S27][S14] |
| Redemption | gTLDs: "redemption grace period (RGP) of 30 days"; then "pending delete phase of 5 days when you cannot restore the domain anymore". Deleting before expiry "will enter RGP immediately". Restore is a separate billable op ("Restores are billed in addition to any renewal fees"; after end-of-life restore CNR sets `RenewOnce` and renews within minutes). .com restore USD 98.88 [S9]. | [S31][S27][S9] |
| Expired-domain handling by provider | R&M 1.7: provider may "suspend the Domain Name ... including directing them to parking pages or commercial search engines that may display advertisements", return it to the registry, or "dispose, auction, transfer to third parties or take over the Domain Name in his own continuance"; starts "no earlier than: (a) five (5) days after the expiration of Domain Names with a Renewal Grace Period"; "no renewal shall be possible 30 days after the expiration of the registration". (The Registration Agreement s.5 says 14 days for the same step; the MSA takes precedence under its clause 30.) | [S1] |
| 60-day lock after registration | Registry-side lock: .io and .studio pages say "it will be transfer locked from the registry for a period of 60 days"; the .com page says "After successful registration, there is a 60 days transfer lock." ICANN Transfer Policy 3.7.5 lets the losing registrar deny a transfer "requested within 60 days of the creation date". CNR additionally sets `clientTransferProhibited` on all new/transferred-in domains. | [S34][S50][S32] |
| 60-day lock after registrant change | ICANN Transfer Policy (version updated 2024-02-21, implementation mandatory by 2025-08-21, so in force today [S49]): "The Registrar must impose a 60-day inter-registrar transfer lock following a Change of Registrant" unless the holder opted out beforehand. CNR: "Updates to the registrant whois information authorised by Key-Systems or Reseller as Designated Agents will always result in a lock ... for 60 days". "Change of registrant" fields: first/middle/last name, organization, email. | [S50][S42] |
| Auth code delivery | Read from StatusDomain `auth` (gTLD); reseller must hand it to the registrant within 5 days; `x-authcode-expiration` exposes expiry. | [S14][S1][S50] |
| Transfer-in duration | gTLD (.com/.dev/.app/.studio): losing registrar emails the registrant; "If neither explicitly approved nor denied, the transfer will be automatically finalized after 5 days"; response gives `execute_date`. .ai up to 7 days without auth; .io needs auth + domain older than 60 days. Most transfers add one year (.ai two) and are charged at initiation. | [S34][S28] |
| Transfer-out | Gaining registrar initiates; you can approve/deny via API or set `transfermode` AUTOAPPROVE/AUTODENY; CNR re-applies its lock 30 days after you unlock. Fee for outbound: none documented. | [S14][S32] |
| Registrant-change behaviour | Default FOA mode (both parties confirm); optional Designated Agent mode. Contact verification email required after new registration and on registrant email change; unverified = suspension after 15 days (`X-TIME-TO-SUSPENSION`). | [S42][S41] |
| **ccTLD differences** | .ai and .io are not bound by ICANN policy: .ai has 2-year minimum terms, 43-day deletion timeframe and optional auth-less transfer; .io has a registry-imposed 60-day lock, "Handle updates: no" (create a new handle and reassign) and 35-day deletion timeframe. CNR: "ccTLDs are not bound by ICANN and vary, so treat 35 days as the gTLD case, not a universal constant"; "some ccTLDs do not support explicit renewal at all". ERRP notices, contact-verification and FOA apply to gTLDs only. | [S34][S27] |

---

## 7. WHOIS PRIVACY and RDAP REDACTION

- **Default redaction is on and free:** "By default, we are not publishing your private data in Whois, i.e. we do NOT disclose your data." Our WHOIS shows contact fields redacted/replaced ("REDACTED FOR PRIVACY") and a generic email routed via domain-contact.org [S37][S29].
- **Paid WHOIS Privacy add-on:** "This service is charged annually for all names containing the flag 'x-whoisprivacy'"; forwards mail through an anonymised address for 14 days (thin registries only); provider may disclose on UDRP or cease-and-desist [S35]. Controlled via the API: `x-whois-privacy=0|1` on AddDomain, read back in StatusDomain [S14]. Supported per TLD page for .com, .io, .dev, .app, .studio; the .ai page does **not** list WhoisPrivacy [S34]. Price and whether the flag defaults to on: unverified (schema enum only).
- **Legal-entity data may be published (NIS2):** roadmap item "Resume partially unredacted publication of registration data of legal entities, as identified by the use of the 'Organization' field and the X-LEGALFORM extension" [S38]; leave Organization empty for private persons [S29].
- **RDAP:** CNR runs it at `https://rdap.rrpproxy.net/domain/[DOMAINNAME]` (OT&E `rdap-ote`); IANA lists it as the RDAP base URL for Key-Systems GmbH (ID 269) [S36][S51].
- If Mosshatch itself offers a privacy service it must escrow registrant data and publish terms (R&M 2.2.4) [S1].

---

## 8. NOTIFICATIONS

- **No webhooks or callbacks.** Zero hits for "webhook"/"callback" in the OpenAPI (208 paths) and the fetched KB [S14].
- **Polling event queue:** `GET /event` (QueryEventList; filters `class`, `subclass`, `mindate`, `history`), `GET /event/{event}` (StatusEvent), `DELETE /event/{event}` (DeleteEvent). Classes include DOMAIN_REGISTRATION, DOMAIN_RENEWAL, DOMAIN_MODIFICATION, DOMAIN_DELETION, DOMAIN_TRADE, DOMAIN_TRANSFER (incl. FOREIGN_TRANSFER_*), ACCOUNT_MODIFICATION (CREDITCARD_FAILED/EXPIRED) with payload `domain cltrid svtrid jobid roid` [S25][S26]. Transfer text: "Transfer outcomes are pushed to your event queue as they happen" (read with EPP Poll or the event API) [S28]. Event retention period: unverified.
- **Email:** registrar email classes NEWSLETTER, MAINTENANCE, ABUSE, INVOICE (`AddRegistrarEmailAddress`); low-balance emails; weekly reseller emails on incorrect registrant data (NIS2) [S14][S38]. Registrant-facing emails (ERRP, contact verification, FOA) come from CNR unless you customise sender/templates [S40][S41].
- **Provider status:** Atlassian Statuspage with Atom/RSS at `https://status.centralnicreseller.com/history.atom` [S46].
- DNS changes: synchronous command result; no event documented for DNS.

---

## 9. RED FLAGS

**Contract (MSA unless noted [S1]):**
- **Unilateral price change:** 14.2 "Service Provider is permitted to modify prices at any time by providing an email notice to Customer or by announcing the new fees in its regular newsletters. For fee increases that are not based on a fee increase of Third-Party Providers, Service Provider shall provide a notice period of no less than thirty (30) days." Third-party (registry) increases pass through with only "endeavor to provide thirty (30) days' written notice ... or without undue delay". Your only remedy: "terminate the Agreement with two weeks' notice." Registration Agreement: "renewal and transfer fees may change on a short notice" and provider "is authorized to cancel or modify orders if a price change occurs between the date of the order and the fulfillment date" [S2]. T&Cs: "The prices can be changed at any time." [S3]
- **Suspension without notice:** 14.3 "If there are insufficient funds ... the Service Provider reserves the right to deny any additional orders, as well as, suspend the Services without notice." 5.4: may "temporarily disable Customers' access to the System". Anti-abuse: may "deny, cancel, suspend, disable, lock or transfer any Service ... at its sole discretion" [S4].
- **Chargeback forfeiture:** 14.7 "Customer automatically forfeits all rights to the Services if there is any charge back by the Customer's bank or credit card company" and reserved domains may be released. Top up by wire, not card, to avoid this.
- **Termination and sunsetting:** 13.1 either party may terminate on 6 months' notice after 36 months; provider may terminate immediately if you use no paid services; 13.4 termination for public disparagement; 22 "Service Provider may from time to time in its own discretion determine to sunset services".
- **Unilateral change of terms:** clause 21 lets the provider amend the MSA "effective upon notice" when it judges this required by ICANN, law or registries (you get 30 days to terminate); clause 9 lets its other terms and policies change with only newsletter/online notice; clause 7: you must update your integration "at its own cost".
- **Liability and indemnity:** 19 caps liability at "THE TOTAL AMOUNT PAID BY CUSTOMER FOR THE SPECIFIC SERVICES GIVING RISE TO THE CLAIM"; 20 and Reseller Sched. 5.1-5.3 full liability and indemnity for Customer-Clients; 24 German law, exclusive courts in Saarland.
- **Expired-domain "utilization"** (R&M 1.7, above): auction/parking with ads, no refund, no renewal after 30 days.
- **Uptime commitment:** only "commercially reasonable efforts ... 99% of the time throughout the year" (MSA 3), no credits.
- **Fines pass-through:** NIS2 fines by registries can be "charged to your account" [S38].

**Operational / product:**
- **REST API is new** (production 2026-07-28), "actively evolving ... some breaking" [S13]; official Node SDK `@team-internet/apiconnector` 11.0.0 (2026-08-26, MIT) still wraps the legacy `api/call.cgi` command API, and the older `@hexonet/ispapi-apiconnector` 9.0.8 last changed 2024-11-12 [S52].
- **Outages** [S46]: 2025-07-03 19:09 UTC to 2025-07-04 04:22 UTC "Reachability Issues" (~9h13m, platform access); 2025-09-19 packet loss (11:20-13:18 UTC); 2026-02-27 fibre cut with packet loss, follow-up 2026-03-05; 2024-06-18 firewall issue after maintenance; **today 2026-09-29** 04:00-06:00 UTC maintenance hitting XRRP, EPP, SOAP, XML-RPC, HTTPS, REST, web UI, WHOIS, RDAP and OT&E, extended to 08:25 UTC because of "ongoing IPv6 connectivity issues". Domains kept resolving.
- **Rate limit** 1 cmd/s per account constrains bulk search; unknown for REST.
- **Docs hygiene:** OpenAPI `termsOfService` URL (`rrpproxy.net/Legal/Terms_und_Conditions`) now redirects to the home page; password policy given as both 10-64 and 8-32; marketing numbers disagree (10,000+ vs 20,000 partners; 1,200+ vs 1,900+ TLDs; 7.8M vs 10M domains) [S55][S48][S11]; KB sitemap points at a UAT host (`dk-uat.ispcomfort.net`); the old developer portal `developers.hexonet.net` is blocked in this environment (see Unverified).
- **Legacy gateway** puts `s_pw` in query strings (use REST Basic/JWT or persistent sessions) [S54].
- **White-label leakage:** default ERRP/verification/FOA emails come from CNR; customise sender, templates and the "interrupt" nameservers/landing pages [S40][S41].
- **Sanctions:** contact creation refused for the embargoed list in s.1.2 [S39]. Donuts TLDs add OFAC state/province checks [S34].
- **Developer complaints:** could not be assessed (Trustpilot 403, SDK GitHub API not enabled in this session).

---

## 10. RECOMMENDATION

**Fallback (upgrade to primary only after three written confirmations).** Evidence for: CNR is the clearest of the terms reviewed on the exact thing Mosshatch needs, since resale under your own brand, price and checkout, ordering through the API on end customers' behalf, is written into a standard MSA and Reseller Schedule with a named ICANN-accredited registrar of record (Key-Systems GmbH, IANA 269); all six starting TLDs have KB pages and direct registry connections for .com/.app/.studio; every adapter method has a REST endpoint; DNS is hosted and included; an OT&E sandbox and a public OpenAPI spec exist; premium purchases have a price-lock handshake. Evidence against making it primary: (1) you cannot verify the economics, because only .com is priced publicly and at Basic Plus (USD 18.33 renewal) it leaves little room for a "wholesale + one flat fee" promise, and .ai/.io/.studio prices are behind a login; (2) a stated 100-domain/yr qualification, EUR 75 prepay, unverified-account caps, an undisclosed account service fee and paper-signed RSP contracts; (3) the REST layer is two months old with "breaking" changes flagged, no webhooks, no idempotency key, and a 1-command-per-second account ceiling; (4) reseller-hostile clauses (30-day price changes, suspension without notice, parking/auction of expired names, capped liability, NIS2 fines on your account) plus a 9-hour outage in 2025 and an extended API maintenance today. **Conditions to promote to primary:** a written price schedule for .com/.ai/.dev/.io/.app/.studio (register, renew, transfer, restore) at or near your target margin; written waiver or clarification of the 100-domain rule and the account service fee; and a passing OT&E soak test of the RegistrarAdapter (register retry, transfer, DNS upsert, event polling) under the 1 cmd/s limit. Adapter design implications: single global rate-limiter (queue in Neon), poll `GET /event` on a schedule, own idempotency ledger, set provider `renewalmode` deliberately (AUTORENEW spends money without a passkey approval; AUTOEXPIRE needs Mosshatch to renew before the `renewal_date`), keep registrant verification logs, and show the .app/.dev HTTPS notice before sending `x-accept-ssl-requirement=1`.

---

## UNVERIFIED (could not be established from primary sources)

1. Wholesale prices (register/renew/transfer/restore) for .ai, .io, .studio; regular (non-promo) prices for .dev and .app; renew/transfer/restore for the promo TLDs. Not public; control panel/API only.
2. Account Service Fee amount and which accounts it applies to.
3. Contents of the signed RSP General Agreement, Confidentiality Agreement and RSP Data Info-Form, and of the DNS, Lock and TLD Appendices referenced by the MSA; any negotiated terms.
4. Whether the 100-domain qualification is enforced (pricing page FAQ says no minimum purchase).
5. Whether consumer (individual) end-registrants are allowed; the B2B/EU-consumer language is written about the account holder.
6. REST-specific rate limits, HTTP status mapping, 429/Retry-After behaviour, maximum concurrency; whether 1 cmd/s applies to REST. No account, so nothing tested live.
7. Whether OT&E works before the EUR 75 activation/verification; what OT&E simulates for expiry, DNS and .ai/.io behaviour; simulated transfer completion time.
8. Exact add-grace-period length and refund/quota rules per TLD (only KB sample values: 5 days, 9.0%); ICANN AGP policy page not retrievable.
9. WHOIS Privacy add-on price and default state; outbound-transfer fee (none documented); event retention period.
10. Idempotent behaviour on duplicate register beyond documented code 554; retry with identical `cltrid`.
11. Independent confirmation of Verisign's .com fee change to USD 10.97 in November 2026 (only CNR's blog).
12. Legacy developer portal `developers.hexonet.net`: connection rejected with 502 at CONNECT, logged as `connect_rejected` by the agent proxy (treated as **blocked by egress policy**); the current KB at `kb.centralnicreseller.com` supersedes it. `support.centralnicreseller.com` (SDK guides, help centre): Cloudflare bot challenge (403), also from headless Chromium.
13. Developer sentiment: Trustpilot returned 403; the SDK's GitHub repo API is not enabled for this session.
14. Regulatory status of .io/.ai beyond the IANA delegation records (.io last updated 2023-01-18; .ai 2025-02-11); not researched.

---

## SOURCES (all accessed 2026-09-29)

| Ref | URL | What |
|---|---|---|
| S1 | https://www.centralnicreseller.com/wholesale-services-agreements/ | Wholesale Master Service Agreement with Reseller Schedule and R&M Schedule (Key-Systems GmbH) |
| S2 | https://www.centralnicreseller.com/registration-agreement/ | Registration Agreement (applicable from 2018-05-25) |
| S3 | https://www.centralnicreseller.com/terms-conditions/ | Key-Systems Terms & Conditions |
| S4 | https://www.centralnicreseller.com/anti-abuse-policy/ | Anti-Abuse Policy (updated Dec 2020) |
| S5 | https://www.centralnicreseller.com/service-agreements/ | Index of legal documents |
| S6 | https://www.centralnicreseller.com/domain-reseller-program/ | Reseller program page and FAQ |
| S7 | https://www.centralnicreseller.com/faqs/ | Requirements, 75 EUR, account statuses, service fee |
| S8 | https://www.centralnicreseller.com/sign-up/ | Sign-up form and B2B attestation |
| S9 | https://www.centralnicreseller.com/domain-reseller-pricing/ | Public tier price table, pricing FAQ |
| S10 | https://www.centralnicreseller.com/domain-reseller-promotions/ | Promotion table (.app, .dev 15.00 USD) |
| S11 | https://www.centralnicreseller.com/rest-api/ | REST API product page |
| S12 | https://www.centralnicreseller.com/introducing-the-centralnic-reseller-rest-api-a-modern-way-to-integrate-domain-services/ | REST API launch post (2026-07-30) |
| S13 | https://kb.centralnicreseller.com/how-to/building-your-integration/rest-api-integration-guide/ | REST base URLs, auth, envelope, go-live 2026-07-28 |
| S14 | https://rest-ote.rrpproxy.net/v1/openapi.json | OpenAPI 3.0.3 spec (OT&E, v2.0.0-ote.3, 208 paths) |
| S15 | https://rest.rrpproxy.net/v1/openapi.json | OpenAPI spec (production, labelled v0.0.3) |
| S16 | https://kb.centralnicreseller.com/how-to/building-your-integration/authentication-credentials-ip/ | Credentials, ACL users, IP allow-list |
| S17 | https://kb.centralnicreseller.com/api/api-security/ | IP whitelisting |
| S18 | https://kb.centralnicreseller.com/how-to/building-your-integration/testing-in-ote/ | OT&E guide |
| S19 | https://kb.centralnicreseller.com/how-to/start-here/moving-from-ote-to-production/ | OT&E to production |
| S20 | https://kb.centralnicreseller.com/how-to/start-here/your-first-day/ | Funding, security, renewal mode defaults |
| S21 | https://kb.centralnicreseller.com/how-to/start-here/which-integration-method/ | Integration method comparison |
| S22 | https://kb.centralnicreseller.com/how-to/building-your-integration/epp-integration-guide/ | EPP limits |
| S23 | https://kb.centralnicreseller.com/api/epp-server/frequently-asked-questions/ | EPP FAQ (rate limit, connections) |
| S24 | https://kb.centralnicreseller.com/api/return-codes/ | Return codes |
| S25 | https://kb.centralnicreseller.com/api/events/ | Event classes and subclasses |
| S26 | https://kb.centralnicreseller.com/api/api-command/queryeventlist/ | QueryEventList / StatusEvent / DeleteEvent |
| S27 | https://kb.centralnicreseller.com/how-to/working-with-domains/complete-domain-lifecycle/ | Lifecycle |
| S28 | https://kb.centralnicreseller.com/how-to/working-with-domains/transfer-a-domain-in/ | Transfer-in, statuses, rate note |
| S29 | https://kb.centralnicreseller.com/how-to/working-with-domains/contacts-handles-ownership/ | Contacts, GDPR |
| S30 | https://kb.centralnicreseller.com/how-to/working-with-domains/dns-automation/ | KeyDNS API usage |
| S31 | https://kb.centralnicreseller.com/domains/renewal-system/ | Renewal system, ARGP, RGP, restore |
| S32 | https://kb.centralnicreseller.com/domains/transfers/transfer-lock/ | Default transfer lock |
| S33 | https://kb.centralnicreseller.com/domains/premium-domains/ (and /account-premium-domain-settings/) | Premium handling |
| S34 | https://kb.centralnicreseller.com/domains/tlds/com/ , /ai/ , /io/ , /dev/ , /app/ , /studio/ | Per-TLD pages; command pages under /api/api-command/{checkdomain,adddomain,statusdomain,transferdomain,setdomaintransfermode}/ |
| S35 | https://kb.centralnicreseller.com/services/whois-privacy/ | WHOIS Privacy service |
| S36 | https://kb.centralnicreseller.com/services/rdap/ | RDAP URLs |
| S37 | https://kb.centralnicreseller.com/help/gdpr/reduced-publication-and-transmission-of-whois-data/ | Default redaction |
| S38 | https://kb.centralnicreseller.com/domains/nis2-compliance/ | NIS2 obligations |
| S39 | https://kb.centralnicreseller.com/help/sanction-screening/ | Sanction screening, embargoed list |
| S40 | https://kb.centralnicreseller.com/domains/icann/errp/realization-of-the-errp-what-must-be-done/ | ERRP notices |
| S41 | https://kb.centralnicreseller.com/domains/icann/contact-verification/ (and /frequently-asked-questions/) | Contact verification, 15-day suspension |
| S42 | https://kb.centralnicreseller.com/domains/icann/icann-ownerchange/ | Owner-change modes, 60-day lock |
| S43 | https://kb.centralnicreseller.com/api/api-command/deletedomain/ (and /statusagpdeletes/, /queryagpdeleteslist/) | AGP deletes |
| S44 | https://kb.centralnicreseller.com/api/api-command/modifydnszone/ | ModifyDNSZone |
| S45 | https://kb.centralnicreseller.com/api/api-command/queryforeigntransferlist/ | Outbound transfer list |
| S46 | https://status.centralnicreseller.com/ and https://status.centralnicreseller.com/history.atom | Incident history |
| S47 | https://www.centralnicreseller.com/report-abuse/ and /legal-notice/ | Abuse and legal contacts, Key-Systems imprint |
| S48 | https://www.centralnicreseller.com/about-us/ | Corporate: part of Team Internet Group PLC (AIM: TIG) |
| S49 | https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers | Transfer Policy versions and implementation dates |
| S50 | https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers/policy | ICANN Transfer Policy (2024-02-21) |
| S51 | https://www.iana.org/assignments/registrar-ids/registrar-ids-1.csv | "269,Key-Systems GmbH,Accredited,https://rdap.rrpproxy.net/" |
| S52 | npm registry: `@team-internet/apiconnector`, `@hexonet/ispapi-apiconnector` | SDK versions and dates |
| S53 | https://www.centralnicreseller.com/pricing-strategies-every-domain-reseller-should-know/ | Verisign fee claim |
| S55 | https://www.centralnicreseller.com/ | Home page (1,200+ extensions claim, promo banner) |
| S54 | https://kb.centralnicreseller.com/api/https-session-handling/ and /api/connecting/hypertext-transfer-protocol-socket/ | Legacy HTTPS gateway |
