# Registrar dossier: Namecheap (as wholesale/reseller backend for Mosshatch)

## TL;DR (10 lines)

1. **Resale: conditional.** Namecheap says outright "Currently, we do not have a domain reseller program. Still, you can resell domains with us using our API" and "You can resell the domains at your own prices" (KB, S1/S2). No reseller/API agreement is published in Namecheap's legal sitemap (S6). The binding texts (Universal ToS, Registration Agreement) sit behind a Cloudflare challenge I could not pass, so the actual resale clauses are **unread**.
2. **No wholesale tier.** "The prices are the same using API"; only after "50+ domains in your account, we can set a special pricing" (S1). Mosshatch cost = Namecheap public retail (regular list: .com 11.28, .ai 89.98, .dev 10.98, .io 34.98, .app 10.98, .studio 14.98 to register; renewals run from 1.3x (.ai) to 3.5x (.studio) the register price).
3. **API is real-time XML over HTTPS**, sandbox exists (separate account, key "almost immediately"), needs >= $50 balance or 20 domains or $50 spent in 2 years for production, plus an **IPv4 allow-list** (a hard problem on Vercel: Static IPs cost $100/month/project).
4. **Adapter gaps:** no getAuthCode, no startTransferOut, no webhooks, no idempotency key on register, DNS is replace-all (`setHosts`), no registry EPP status codes in getInfo, RGP restore and refunds are support-ticket only, no auto-renew toggle found.
5. **Rate limit conflict:** Namecheap KB says 50/min, 700/hour, 8000/day per key; Namecheap's own SDK/Terraform docs say 20/min. Plan for 20/min.
6. **ICANN plumbing:** Namecheap (IANA ID 1068) is registrar of record; it emails the WHOIS-verification link and expiry notices straight to the registrant (Namecheap-branded); Mosshatch is a "Reseller" under RAA 1.24/3.12 and must flow down registrant terms.
7. **Privacy:** free, but API default is `AddFreeWhoisguard=Yes`, `WGEnabled=No` (must send WGEnabled=Yes); RDAP shows "WITHHELD FOR PRIVACY LLC" as registrant.
8. **Evidence limits:** www.namecheap.com/support/api/*, /legal/*, /domains/* returned Cloudflare 403; challenge host brunhild.challenges.cloudflare.com is blocked by egress policy. API details come from Namecheap's own GitHub SDK transcription (dated 2026-05-28), the Namecheap KB, and live probes.
9. **Recommendation: FALLBACK** (not primary). Fast to sandbox-test and workable for register/renew/DNS, but outbound transfer, contract clarity, idempotency, and wholesale economics are weak for a reseller product.
10. Full tables, quotes, and the unverified list follow.

---

Research date and access date for every source below: **2026-09-29**. Analyst notes: research only, no application code written, nothing under /home/user/MossHatch modified.

## 0. Source index and evidence limits

All accessed 2026-09-29. "KB" = Namecheap knowledgebase (reachable by curl). Pages that returned Cloudflare 403 ("Just a moment...") are listed in 0.2.

### 0.1 Sources (keys used below)

| Key | URL | What |
|---|---|---|
| S1 | https://www.namecheap.com/support/knowledgebase/article.aspx/9739/63/api-faq/ | KB "API - FAQ" (page footer: Updated 6/5/2026). Requirements, sandbox, limits, pricing, payment |
| S2 | https://www.namecheap.com/support/knowledgebase/article.aspx/754/63/do-you-have-a-domain-reseller-program/ | KB reseller program (Updated 10/12/2018, stale) |
| S3 | https://www.namecheap.com/support/knowledgebase/article.aspx/763/63/what-is-sandbox/ | KB What is Sandbox (Updated 4/9/2020) |
| S4 | https://www.namecheap.com/support/knowledgebase/subcategory/63/namecheap-api/ | KB API subcategory index |
| S5 | https://www.namecheap.com/nc-support-sitemap.xml | Namecheap sitemap (lastmod 2026-09-29): lists every API method page |
| S6 | https://www.namecheap.com/nc-main-sitemap.xml | Namecheap sitemap: lists legal documents |
| S7 | https://github.com/namecheap/go-namecheap-sdk/blob/master/docs/namecheap-api-v2.md | Official Namecheap-org SDK: transcription of the API method pages ("Added: 2026-05-28", "Source: https://www.namecheap.com/support/api/methods/"). Cloned at commit 6f5a73e (2026-09-24) |
| S8 | https://github.com/namecheap/go-namecheap-sdk/blob/master/README.md | Same repo: behaviour notes (non-idempotent calls, 405 rate limit, setHosts) |
| S9 | https://github.com/namecheap/go-namecheap-sdk/blob/master/namecheap/transport.go | Same repo: retry/rate-limit constants |
| S10 | https://raw.githubusercontent.com/namecheap/terraform-provider-namecheap/master/docs/guides/ci-environments.md | Namecheap-org Terraform provider guide: IP whitelist, 20/min quota |
| S11 | https://api.sandbox.namecheap.com/xml.response and https://api.namecheap.com/xml.response | My live probes with bogus credentials (see 4.4) |
| S12 | https://www.namecheap.com/support/knowledgebase/article.aspx/258/84/what-should-i-do-to-transfer-a-domain-from-namecheap/ | KB transfer out (Updated 8/15/2023) |
| S13 | https://www.namecheap.com/support/knowledgebase/article.aspx/259/8/what-is-an-authepp-code/ | KB Auth/EPP code |
| S14 | https://www.namecheap.com/support/knowledgebase/article.aspx/9175/83/how-to-transfer-a-domain/ | KB transfer in (Updated 6/11/2024) |
| S15 | https://www.namecheap.com/support/knowledgebase/article.aspx/9819/2209/new-icanns-interregistrar-transfer-policy/ | KB Transfer Policy / Designated Agent (quotes Registration Agreement text) |
| S16 | https://www.namecheap.com/support/knowledgebase/article.aspx/9916/2207/tlds-grace-periods/ | KB TLD grace periods (Updated 5/21/2026) |
| S17 | https://www.namecheap.com/support/knowledgebase/article.aspx/242/2207/what-is-the-domain-redemption-grace-period/ | KB RGP (Updated 9/10/2025) |
| S18 | https://www.namecheap.com/support/knowledgebase/article.aspx/1420/2207/why-is-the-redemption-fee-so-high/ | KB redemption fee (Updated 1/22/2026) |
| S19 | https://www.namecheap.com/support/knowledgebase/article.aspx/10064/2207/what-happens-to-my-domain-name-after-it-expires/ | KB after expiry (Updated 7/11/2024) |
| S20 | https://www.namecheap.com/support/knowledgebase/article.aspx/10045/46/what-to-do-with-an-unwanted-domain/ | KB refunds/cancellation (Updated 8/21/2025) |
| S21 | https://www.namecheap.com/support/knowledgebase/article.aspx/10564/2207/can-i-set-up-automatic-billing-for-my-namecheap-services/ | KB auto-renew (Updated 6/24/2026) |
| S22 | https://www.namecheap.com/support/knowledgebase/article.aspx/239/2207/how-can-i-renew-my-domain/ | KB renew (Updated 5/19/2025) |
| S23 | https://www.namecheap.com/support/knowledgebase/article.aspx/263/83/if-i-transfer-a-domain-to-namecheap-will-it-be-renewed-for-another-year/ | KB transfer renewal |
| S24 | https://www.namecheap.com/support/knowledgebase/article.aspx/775/37/do-you-provide-free-domain-privacy-subscriptions-with-every-newly-registered-domain/ | KB free privacy (Updated 3/18/2026) |
| S25 | https://www.namecheap.com/support/knowledgebase/article.aspx/280/37/do-you-provide-any-domain-privacy-protection-services/ | KB privacy types, TLD exclusions |
| S26 | https://www.namecheap.com/support/knowledgebase/article.aspx/344/37/how-does-domain-privacy-work/ | KB how privacy works |
| S27 | https://www.namecheap.com/support/knowledgebase/article.aspx/9305/46/whois-verification-process/ | KB Whois verification |
| S28 | https://www.namecheap.com/support/knowledgebase/article.aspx/10717/46/why-was-my-domain-suspended-with-a-serverhold-or-clienthold-status/ | KB serverHold/clientHold |
| S29 | https://www.namecheap.com/support/knowledgebase/article.aspx/1187/46/how-can-i-move-a-domain-from-one-namecheap-account-to-another/ | KB Change Ownership (account push) |
| S30 | https://www.namecheap.com/support/knowledgebase/article.aspx/9196/5/how-and-where-can-i-file-abuse-complaints/ | KB abuse reporting |
| S31 | https://www.namecheap.com/support/knowledgebase/article.aspx/580/83/transfer-statuses/ | KB transfer statuses (Updated 6/27/2019) |
| S32 | https://www.namecheap.com/support/knowledgebase/article.aspx/10824/34/namecheap-mcp/ | KB "Namecheap MCP - Tools Reference" (mcp.namecheap.com/mcp) |
| S33 | https://rdap.namecheap.com/domain/namecheap.com | Live RDAP from Namecheap (privacy-redacted registrant, abuse contact) |
| S34 | https://rdap.verisign.com/com/v1/domain/namecheap.com | Live Verisign RDAP: registrar IANA ID 1068 |
| S35 | https://www.iana.org/assignments/registrar-ids/registrar-ids-1.csv | IANA registrar IDs |
| S36 | https://www.icann.org/en/contracted-parties/accredited-registrars/registrar-accreditation-agreement/2013-registrar-accreditation-agreement-17-09-2013-en | ICANN 2013 RAA text |
| S37 | https://www.icann.org/en/contracted-parties/accredited-registrars/transfer-policy-01-06-2016-en | ICANN Transfer Policy |
| S38 | https://vercel.com/docs/networking/static-ips | Vercel Static IPs |
| S39 | https://domainoffer.net/tld/{com,ai,dev,io,app,studio}/namecheap | Third-party price scrape ("Prices Updated: Sep 29, 2026 18:16"), regular vs coupon |
| S40 | https://tldes.com/{com,ai,dev,io,app,studio} | Third-party aggregator ("updated 30 minutes ago"), best price incl. ICANN fee |
| S41 | https://hostingcompass.com/en/domains/app | Third-party (Namecheap ".app" checked Aug 6) |
| S42 | https://www.stackscored.com/pricing/domain-registrars/namecheap/ | Third-party, undated, stale |
| S43 | https://exit1.dev/blog/namecheap-domain-expiration-fees-how-to-avoid and https://magnifyi.io/expired-domains-on-namecheap-auctions-recovery/ | Third-party redemption-fee statements |
| S44 | https://get.dev/ and https://get.app/ | Google Registry: HSTS preload |
| S45 | https://www.icann.org/en/blogs/details/the-chagos-archipelago-and-the-io-domain-14-11-2024-en | ICANN on .io |
| S46 | https://www.iana.org/domains/root/db/io.html (and ai/dev/app/studio) | IANA root zone DB |
| S47 | https://www.namecheap.com/status-updates/ and /status-updates/feed/ | Namecheap status posts |

### 0.2 Pages that could not be read (not evidence about the provider)

| URL | Result |
|---|---|
| https://www.namecheap.com/support/api/intro/ and all /support/api/* (methods, global-parameters, error-codes, change-log, transfer-statuses, extended-attributes) | curl 403 and WebFetch 403; headless Chromium (Playwright, proxy CA imported into NSS) gets Cloudflare "Just a moment..." (Ray ID a42d4168bfa8c609) |
| https://www.namecheap.com/legal/* (Universal ToS, Registration Agreement, Refund Policy, Court order policy, ICANN fee) | same Cloudflare 403 |
| https://www.namecheap.com/domains/* (pricing, redemption-pricing, tier-pricing, TLD pages) and www.sandbox.namecheap.com | same Cloudflare 403 |
| brunhild.challenges.cloudflare.com | **blocked by egress policy** (connect_rejected), so the Cloudflare challenge cannot complete; not worked around |
| status.namecheap.com, blog.namecheap.com | **blocked by egress policy** (CONNECT 502) |
| web.archive.org | tunnel closed after ~11s on every try; WebFetch says "unable to fetch from web.archive.org"; Common Crawl and archive.ph also unreachable |
| tld-list.com, domcomp.com, tldspy.com | Cloudflare 403 |
| GitHub issues API for namecheap/* repos | session is bound to another repository; not added |
| WebSearch | session budget exhausted (200/200) midway; a few early search summaries are used only as leads and are flagged "snippet only" |

---

## 1. RESALE

**Verdict: conditional.** Namecheap's support documentation permits and describes reselling via API at your own prices. There is no formal program and no contract I could read.

### 1.1 What the sources say

| Claim | Evidence (URL, accessed 2026-09-29, quote) |
|---|---|
| No formal reseller program; resale via API is the path | S2: "Currently, we do not have a domain reseller program. Still, you can resell domains with us using our API." and "you should develop your site, integrate it with any billing application (WHMCS, Ubersmith or any other) and then link it to our system using API." Caveat: article "Updated 10/12/2018". |
| Own price, own checkout | S1: "You can resell the domains at your own prices. Your profit is the difference between your buying and selling prices." |
| No API fee | S1: "No, there is no additional fee for resellers using our API." |
| Prohibited use | S1: "Unfortunately, we do not allow drop catching using our API." |
| Volume-tier pricing exists, unpublished | S1: "The prices are the same using API, however, you can use our monthly coupons for domain registrations. Alternatively, once you get 50+ domains in your account, we can set a special pricing for your account which will be working for renewals as well as new registrations." |
| Prerequisites for API access | S1: "have at least 20 domains under your account; have at least $50 on your account balance; have at least $50 spent within the last 2 years." No application/approval step, no KYC step, no contract mentioned. |
| Prepaid balance only | S1: "All billing operations through API can be performed using your Namecheap account balance only." (fund by card, PayPal, Bitcoin, Bitcoin Cash) |
| The API sits inside the normal account, no partner entity | S1: "Your Namecheap account username will act as API username." (all domains live under the single account; getInfo returns OwnerName/IsOwner per S7) |
| No reseller/API agreement is published | S6 (legal sitemap, lastmod 2026-09-29) lists: universal-tos, data-processing-addendum, registration-agreement, supplemental-registry-agreement, registrant-rights-benefits-and-responsibilities, fast-transfer-agreement, rdap-tos, whois-privacy-service-agreement, phishing-reports-api-tou, affiliate-agreement, and an **SSL** `reseller-service-agreement`. There is **no domain reseller agreement and no domain API terms document** in the list. (Negative evidence from a sitemap; the /legal/ index itself was blocked.) |
| Sub-account reseller API may exist | S7 documents `namecheap.users.create` ("Creates a new account at Namecheap under this ApiUser", `AcceptTerms` "Must be 1 to accept terms"), `users.login`, `users.resetPassword`. But S5 (current sitemap) has no page for `users/create`, and the SDK README calls it "reseller-only account creation; weak demand" (S8). Whether a new API user can call it is **unverified**. |

### 1.2 Governing documents (Namecheap-side)

| URL | Accessed | What | Status |
|---|---|---|---|
| https://www.namecheap.com/legal/universal/universal-tos/ | 2026-09-29 | Universal ToS (a search-result description said it covers "systems, software, platforms, APIs"; snippet only) | **unread (Cloudflare 403)** |
| https://www.namecheap.com/legal/domains/registration-agreement/ | 2026-09-29 | Registration Agreement | **unread**; two excerpts quoted second-hand by KB (S15 Designated Agent text; S20 "all the domain registrations/renewals are final, cannot be canceled, and are not refundable") |
| https://www.namecheap.com/legal/domains/registrant-rights-benefits-and-responsibilities/ | 2026-09-29 | Registrant rights page | **unread** |
| https://www.namecheap.com/legal/general/court-order-and-subpoena-policy/ | 2026-09-29 | Legal process policy | **unread** |
| https://www.namecheap.com/legal/domains/rdap-tos/ | 2026-09-29 | RDAP ToS (text embedded in S33 notice, forbids "high volume, automated electronic processes") | partly read via RDAP notice |

### 1.3 Roles and ICANN duties (what the contracts must look like, and what Namecheap does in practice)

| Question | Answer and evidence |
|---|---|
| Registrar of record | **NameCheap, Inc., IANA ID 1068**. S35: `1068,"NameCheap, Inc.",Accredited,https://rdap.namecheap.com/`. S34: Verisign RDAP for namecheap.com lists entity roles `registrar`, publicIds `IANA Registrar ID` `1068`. Every Mosshatch domain will show Namecheap as sponsoring registrar; it cannot be white-labelled. |
| Is Mosshatch a "Reseller" in ICANN terms? | Yes. S36 RAA 1.24: a Reseller "participates in Registrar's distribution channel ... including collecting registration data about Registered Name Holders, submitting that data to Registrar, or facilitating the entry of the registration agreement between the Registrar and the Registered Name Holder." |
| What Namecheap must impose on resellers | S36 RAA 3.12: "Registrar must enter into written agreements with all of its Resellers"; 3.12.2: "Any registration agreement used by reseller shall include all registration agreement provisions and notices required by the ICANN Registrar Accreditation Agreement and any ICANN Consensus Policies, and shall identify the sponsoring registrar or provide a means for identifying the sponsoring registrar"; 3.12.3 resellers "identify the sponsoring registrar upon inquiry"; 3.12.5 provide a link to the ICANN registrant education page; 3.12.7 "publish on their website(s) and/or provide a link to the Registrants' Benefits and Responsibilities Specification". Tension: Namecheap says it has no reseller program, so the "written agreement" is presumably the ToS/Registration Agreement you accept as account holder. **Unverified** (text unread). |
| Registrant of record | Whoever Mosshatch enters in the four contact blocks of `domains.create` (Registrant, Tech, Admin, AuxBilling all required, S7). RAA 3.7.7.3 (S36): a Registered Name Holder that licenses use "is nonetheless the Registered Name Holder of record". Best practice for Mosshatch's ownership promise: the end customer is registrant (real name/email). |
| Who obtains registrant's acceptance of the registrar agreement | RAA 3.7.7: "Registrar shall require all Registered Name Holders to enter into an electronic or paper registration agreement". S15 says "By registering the domain name with Namecheap, you accept its Registration Agreement." In the API model there is no click-through for the end customer inside Namecheap; per RAA 3.12.2, **Mosshatch's own checkout must present the ICANN-required provisions and identify Namecheap as sponsoring registrar.** Whether Namecheap contractually assigns this to Mosshatch is unverified. |
| Who sends ICANN-mandated notices | **Namecheap sends them directly to the registrant email, Namecheap-branded**: WHOIS verification (S27: "When a new domain is registered, we will immediately send an email to the Registrant email address specified for the domain ... from verification@namecheap.com or support@namecheap.com ... within 15 calendar days ... the domain will be suspended"), expiry reminders (S19: "email reminders (30 days, 15 days, 7 days and 1 day, respectively) ... to two email addresses ... your account's primary email address and ... your domain Registrant email address"), Change of Registrant confirmations (S15). Mosshatch cannot brand-replace these; it should tell customers to expect them. |
| Abuse reports | Go to the registrar. S33 RDAP abuse entity: `abuse@namecheap.com`, `tel:+1.9854014545`. S30: "please send an email to abuse@namecheap.com (for domain names registered with us)". Namecheap may apply clientHold: S28 "Client Hold status is assigned by the domain registrar, mostly for reasons related to fraudulent/abusive activity and non-compliance with our Terms of Service ... legalandabuse@namecheap.com". Namecheap acts on the domain and (presumably) contacts the account holder (Mosshatch). |
| Legal process (subpoena, court orders) | Registrar-level; policy page unread (S6 lists /legal/general/court-order-and-subpoena-policy/). Mosshatch holds the account; customer-level process handling would be Mosshatch's own. Unverified. |
| WHOIS accuracy | S27 and RAA 3.7.7.2 (S36): failure to respond "for over fifteen (15) days to inquiries by Registrar concerning the accuracy of contact details ... shall constitute a material breach". |

---

## 2. API COVERAGE (Mosshatch RegistrarAdapter)

Base URLs (S7, confirmed by my probes in S11): production `https://api.namecheap.com/xml.response`, sandbox `https://api.sandbox.namecheap.com/xml.response`. Global parameters on every call: `ApiUser`, `ApiKey`, `UserName`, `ClientIp`, `Command` (S7). Responses are XML; errors come back as **HTTP 200** with `<ApiResponse Status="ERROR">` (S11).

Method list cross-check: S5 (current sitemap) lists API method pages for domains (getList, getContacts, create, getTldList, setContacts, check, reactivate, renew, getRegistrarLock, setRegistrarLock, getInfo), domains.dns (setDefault, setCustom, getList, getHosts, getEmailForwarding, setEmailForwarding, setHosts), domains.ns (create, delete, getinfo, update), domains.transfer (create, getStatus, updateStatus, getList), ssl, users (getPricing, getBalances, changePassword, update, createaddfundsrequest, getAddFundsStatus, login, resetPassword), users.address, domainprivacy/whoisguard. **There is no auth-code, transfer-out, restore, cancel, auto-renew or DNSSEC method.** Parameter tables below come from S7 (Namecheap's own SDK repo, transcribed 2026-05-28 from the methods pages); the original pages were unreadable to me.

| # | Adapter method | Support | Endpoint / command | Caveats (evidence) |
|---|---|---|---|---|
| 1 | checkAvailability (bulk names x TLDs) | **yes** | `namecheap.domains.check` (`DomainList` comma-separated) | S7: "Comma-separated list of domains to check (max 50)"; error `2011169` "Only 50 domains allowed in a single check command". No names x TLDs matrix: Mosshatch expands to FQDNs, <= 50 per call, each call spends one request of the per-minute quota (so max ~1,000 to 2,500 names/min). Result fields per domain: `Available`, `IsPremiumName`, `PremiumRegistrationPrice`, `PremiumRenewalPrice`, `PremiumRestorePrice`, `PremiumTransferPrice`, `IcannFee`, `EapFee`. IDNs: punycode only (S1). Reserved/blocked names: unverified. |
| 2 | quote (wholesale + renewal price, premium detection) | **partial** | Standard names: `namecheap.users.getPricing` (`ProductType=DOMAIN`, `ProductCategory`, `ActionName` e.g. REGISTER/RENEW/TRANSFER, `ProductName` = TLD). Premium: `domains.check` fields above. | getPricing returns per-duration `Price`, `RegularPrice`, `YourPrice`, `PromotionPrice`, `Currency` (S7, S8: "the live API sends PromotionPrice="0.0" on tiers with no promotion"; "The sheet is large and slow-changing, so fetch it once and cache it"). Not per-name, so premium is only via check; a REACTIVATE/restore category is not documented (unverified). `YourPrice` is the account-specific price, i.e. the true cost after any 50+-domain tier. |
| 3 | register (contacts, privacy flag, duplicate/retry) | **partial** | `namecheap.domains.create` | Params (S7): `DomainName`, `Years` (default 2), `PromotionCode`, Registrant*/Tech*/Admin*/AuxBilling* (all four blocks Required), `Nameservers`, `AddFreeWhoisguard` (default Yes), `WGEnabled` (default No), `IsPremiumDomain`, `PremiumPrice`, `EapFee`. Synchronous: S1 "Domain registrations are real time through the API." **No idempotency key.** S8: Create/Renew/Reactivate "are treated as non-idempotent: on an ambiguous transport or server-side failure the SDK does not retry (a resend could double-charge) ... Reconcile such failures via the account order history." Duplicate/retry error code for "already registered" is **unverified**; safe pattern = check, create once, on ambiguity poll `domains.getInfo`/`getList` (SearchTerm) before any retry. Charged from prepaid balance immediately. |
| 4 | renew | **yes** | `namecheap.domains.renew` (`DomainName`, `Years`, `PromotionCode`, `IsPremiumDomain`, `PremiumPrice`) | Non-idempotent too (S8). S22: "Premium domains may have a higher domain renewal. They can be renewed for 1 year only in one order."; ".AI domains can be renewed for 2, 3, ... 9 years. It is not possible to renew .AI for 1 year only."; "registration term cannot exceed full 10 years". Response `DomainDetails/NumYears` "the live API frequently returns 0" (S7). |
| 5 | getDomain (status, expiry, lock, NS, registry status codes) | **partial** | `namecheap.domains.getInfo`, `getRegistrarLock`, `getList` | getInfo (S7): `Status` "OK, Locked, Expired", `DomainDetails` CreatedDate/ExpiredDate (MM/DD/YYYY), `DnsDetails` nameservers/provider, `Whoisguard`, `Modificationrights`; `LockDetails` "observed empty in all captures; use namecheap.domains.getRegistrarLock". "getInfo has no domain-level auto-renew field"; `getList` carries `IsLocked`, `AutoRenew`, `IsExpired`, `WhoisGuard`, `IsPremium`, `IsOurDNS` (page size 10-100). **Registry EPP status codes (clientTransferProhibited, redemptionPeriod, pendingDelete, serverHold) are not returned**; even Namecheap's own MCP gateway states "eppStatuses ... Not reported by Namecheap" (S32). Use RDAP (Verisign etc.) for registry statuses. Domains in RGP disappear from the account list (S19: "removed from the Domain List and will enter the Redemption Grace Period"). |
| 6 | setLock | **yes** | `namecheap.domains.setRegistrarLock` (`LockAction` LOCK/UNLOCK), `getRegistrarLock` | S7. Maps to clientTransferProhibited (S12 "Registrar Lock is disabled"). |
| 7 | listRecords | **yes** (Namecheap DNS only) | `namecheap.domains.dns.getHosts` (SLD, TLD) | Returns HostID, Name, Type, Address, MXPref, TTL, `IsUsingOurDNS`. S1: "If the domain is using our PremiumDNS/FreeDNS, you will not be able to manage it via API." DNS is hosted by Namecheap (S1 refers to "our BasicDNS"; the SDK's getInfo fixture, namecheaptest/fixtures/domains_getInfo.xml in S8's repo, shows nameservers under registrar-servers.com). |
| 8 | upsertRecord / deleteRecord | **partial** | `namecheap.domains.dns.setHosts` (replace-all) | S8: "`SetHosts` ... is the only write endpoint the API offers, and it **replaces the entire record set**. To change one record you must read every record, edit the slice, and write them all back — forget one and it is silently deleted." "The API is not transactional ... a concurrent writer between your read and your write causes a lost update." Types (S7): A, AAAA, ALIAS, CAA, CNAME, MX, MXE, NS, TXT, URL, URL301, FRAME; TTL "(300-60000)" per S7; `EmailType` (MXE/MX/FWD/OX) required. Bind-zone import unsupported (S1). Mosshatch must serialize per-zone writes (row lock in Neon) and do read-modify-write-verify. Also `setEmailForwarding`/`getEmailForwarding` exist. DNSSEC/DS management: no method found. |
| 9 | startTransferIn (auth code) | **partial** | `namecheap.domains.transfer.create` (`DomainName`, `Years` "Should be set to 1 year only", `EPPCode` Required, `PromotionCode`, `AddFreeWhoisguard`, `WGenable`) | Charged at creation from balance (S7 response `ChargedAmount`). S7 header: "Supported TLDs: .biz, .ca, .cc, .co, .com, .com.es, .com.pe, .es, .in, .info, .me, .mobi, .net, .net.pe, .nom.es, .org, .org.es, .org.pe, .pe, .tv, .us." **.ai, .io, .dev, .app, .studio are not in that documented list.** Per-TLD truth is `domains.getTldList` `IsApiTransferable` (S7) - must be checked in the sandbox/production; **unverified for our six TLDs**. `transfer.updateStatus` (`Resubmit=true`) re-submits after the losing side unlocks. |
| 10 | getTransfer (poll or webhook) | **partial** (poll only) | `namecheap.domains.transfer.getStatus` (`TransferID`), `transfer.getList` (ListType ALL/INPROGRESS/CANCELLED/COMPLETED) | No webhook. S8: "The Namecheap API doc does not enumerate the numeric StatusID codes"; SDK classifies by keyword. Namecheap's transfer-status page (/support/api/transfer-statuses/, S5) was unreadable. Human-readable statuses in KB S31 ("Awaiting authorization code", "Awaiting release from previous registrar" "takes up to 5-7 days"). |
| 11 | getAuthCode | **no** | none | Not in S5 method list or S7. S12: auth code is obtained in the UI: "Sharing & Transfer > Transfer Out ... the code will be sent to the Registrant email address". A human must log in to the Namecheap panel (or support must act) per outbound customer. |
| 12 | startTransferOut | **no** | none (only `setRegistrarLock UNLOCK` via API) | Losing-registrar side is passive: S12 "After the transfer at the new registrar is initiated and the Auth Code is provided, the transfer will be initiated at the Registry level. Namecheap has 5 days to release your domain(s) as per ICANN Transfer policy." Outgoing status not visible: S31 "Outgoing transfer statuses are not visible in your Namecheap account". ICANN Transfer Policy 5.2 (S37) requires the AuthInfo code within five calendar days of the request when there is no self-service, so Mosshatch needs a manual runbook or a cross-account push (below). |

Extra rows Mosshatch will need:

| Need | Support | Command / note |
|---|---|---|
| set/get contacts | yes | `domains.setContacts` / `getContacts`. Changing registrant first name, last name or email queues a verification: S27 "You must verify the email address ... within 7 calendar days after the update ... contact details will not be changed in public Whois until the verification email is approved." |
| reactivate an expired domain (in grace) | yes | `domains.reactivate` (charge-bearing, non-idempotent) |
| restore from RGP | **no** | S17: "add the correct amount to your account balance and contact our Support team, who will complete the process." |
| cancel / refund a new registration | **no** | S20: "you will need to contact us within 5 days (120 hours) after registration"; "Refunds are not possible for Premium Domains." |
| toggle auto-renew | **none found** | getList exposes `AutoRenew`; no setter in S5/S7. Account-level default in UI only (S21). |
| privacy on/off after registration | partial | `whoisguard.enable` (needs `WhoisguardID` + `ForwardedToEmail`) / `disable` / `getlist` / `renew`; command names keep the old "whoisguard" prefix (S7 note). |
| balance / top-up | yes | `users.getBalances`, `users.createaddfundsrequest` (credit-card redirect flow), `users.getAddFundsStatus` |
| move domain to a customer's own Namecheap account | UI only | S29 "Change Ownership" (no fee, no 60-day wait): "You don't have to wait for 60 days to move a domain to another Namecheap account"; no API method in S5. |

---

## 3. SANDBOX / OTE

| Item | Finding and evidence |
|---|---|
| Exists | **Yes.** URL http://www.sandbox.namecheap.com (site itself Cloudflare-blocked for me); API endpoint `https://api.sandbox.namecheap.com/xml.response` responds (S11, HTTP 200, error 1011102 with bogus key). |
| Credentials | S3/S1: "you will need to sign up for an account here (this account will not be associated with the one you have at http://www.namecheap.com)"; "go to the Profile section, select Tools and choose the Namecheap API Access option for Business & Dev Tools. You will get the API key almost immediately. Your API username is the same as your Sandbox account username." "You should whitelist at least one IP before your API access begin to work ... only IPv4". No $50/20-domain threshold is stated for the sandbox (S1: "you are free to test our API through the Sandbox"). |
| Simulation | S3: "All purchases processed through the sandbox API are simulated." S1: "linked to the registry testing environment" (so it behaves like production against OTE). |
| Differences from production | S1: "domain names registered in real will be shown as available in the Sandbox, unless you register them in the sandbox environment"; nameservers must exist in the sandbox first ("you'll need to register nameserver.com domain in the sandbox first"); "we do not provide any coupon codes for testing in the sandbox"; test domains cannot be deleted/reset ("we cannot reset or cancel all test domain registrations for a specific user"). |
| Simulates transfers? expiry? DNS? | **Unverified.** No source states transfer-in/out, expiry/RGP, or per-TLD (.ai, .io, .dev, .app, .studio) OTE coverage. The only sandbox-specific behaviour I found beyond S1/S3 is that `getPricing` works there (S9 users_get_pricing.go: "observed against the sandbox for .com REGISTER/RENEW/TRANSFER"); nothing on DNS propagation. Plan: run the adapter contract tests against the sandbox and record which TLDs/commands fail. |

---

## 4. RATE LIMITS AND OPERATIONAL CONSTRAINTS

### 4.1 Limits (two Namecheap-authored numbers conflict)

| Source | Statement |
|---|---|
| S1 (KB, Updated 6/5/2026) | "Our general API calls restriction is 50/min, 700/hour, and 8000/day across the whole key." |
| S8 README, S9, S10 (Namecheap GitHub org: Go SDK, Terraform provider) | S8: "Namecheap documents 20 requests/minute, 700/hour and 8000/day"; provider `requests_per_minute` "(default 20, valid range 1-20)"; "Namecheap enforces a documented primary quota (per-minute request limit) at the account level." The API intro page these cite was unreadable. |
| Signal on breach | S9 transport.go: the server "responds with HTTP 405, which Namecheap uses to signal rate limiting" and "Namecheap returns 405 before it processes the request" (so retrying is safe). HTTP 405, not 429. |

Budget Mosshatch at **20 req/min per account/key** (700/hour, 8000/day) until confirmed. One `domains.check` call carries 50 names.

### 4.2 Other constraints

| Constraint | Detail and evidence |
|---|---|
| Auth scheme | Shared secret `ApiKey` + `ApiUser` + `UserName` + `ClientIp` as request parameters (S7). Use POST: the SDK's architecture notes say "`Client.DoXML()` sends a POST request with URL-encoded body" (https://github.com/namecheap/go-namecheap-sdk/blob/master/AGENTS.md), S7 header says "Use HTTP GET with query parameters", and my probes show GET and POST both accepted. Secrets in GET query strings end up in logs. S1: "You can send API calls with http, however we recommend using https". |
| IP allow-list | S1: "you should whitelist at least one IP before your API access begin to work ... only IPv4 addresses can be used." S10: "Every Namecheap API call is authorized against the public IP address the Namecheap API sees as the caller, and that IP must be whitelisted for your account ... If the calling IP is not whitelisted, the Namecheap API rejects requests regardless of whether the credentials are correct." WHMCS docs (https://docs.whmcs.com/8-13/troubleshooting/troubleshoot-domains/namecheap/namecheap-registrar-errors/): "Registrar Error Invalid Request IP ... You have not whitelisted your server's IP address". **Impact on Vercel functions:** egress IPs are dynamic. S38: "Static IPs are available on Enterprise and Pro plans ... Pricing $100/month per project, plus Private Data Transfer at regional rates." Alternative: a tiny fixed-IP egress proxy/VM for Namecheap calls only. Number of allow-listed IPs allowed: unverified. |
| Formats | XML only (S7: "All API calls return XML responses"). |
| Error semantics | HTTP 200 + `Status="ERROR"` + `<Error Number="...">`. Observed live (S11): `<Error Number="1010101">Parameter APIUser is missing</Error>` (no params) and `<Error Number="1011102">API Key is invalid or API access has not been enabled</Error>` (bogus creds, both GET on sandbox and POST on production). Codes seen in docs: 2019166 domain not found, 2016166 not associated with your account, 2030166 invalid, 2011169 >50 domains, 2011170 promo code invalid, 2033409 order not found, 3031510/3050900 upstream ("Enom") error, 5050900 unhandled (S7). Transient server codes worth retrying per SDK: 3050900, 5019169, 5050169, 5050900 (S8 errors.go). |
| Batch limits | check: 50 names; getList PageSize 10-100; setHosts: record-count limit unverified; getTldList is "heavyweight ... many hundreds of entries" (cache). |
| Payment | Prepaid Namecheap balance only (S1); `getBalances` returns `FundsRequiredForAutoRenew` (S7). A zero balance makes register/renew fail; Mosshatch must reconcile Stripe receipts against a Namecheap balance top-up flow (top-up is by card/PayPal/crypto; `createaddfundsrequest` is a redirect flow, not silent auto-top-up). |
| Concurrency | S8: "requests are now concurrent by default" is a client choice; DNS writes are not transactional. Use per-domain locks. |

### 4.3 Making register safely retryable

1. Persist an intent row (Neon) with a unique key (customer, FQDN, years, quoted price) **before** calling.
2. Call `domains.check` (fresh availability + `IsPremiumName`); refuse premium unless a human approved the `PremiumPrice`.
3. POST `domains.create` once. Never auto-retry on timeout/5xx/`Status=ERROR` with unknown outcome (S8 rule). Retry only on the pre-execution HTTP 405.
4. On ambiguity: poll `domains.getInfo`/`getList?SearchTerm=` (owner = our account, created date today) and `users.getBalances` delta; reconcile with the response's `OrderID`/`TransactionID`/`ChargedAmount`. Namecheap offers no server-side dedupe key.
5. Only then mark the intent completed and charge/settle the customer.

### 4.4 Live probes (evidence for error semantics)

Requests made 2026-09-29 19:15 UTC with intentionally invalid credentials (no charge possible):
- `GET https://api.sandbox.namecheap.com/xml.response?ApiUser=nobody&ApiKey=bogus&UserName=nobody&ClientIp=203.0.113.1&Command=namecheap.domains.check&DomainList=example.com` -> `HTTP/2 200`, `server: cloudflare`, body `<ApiResponse Status="ERROR" ...><Errors><Error Number="1011102">API Key is invalid or API access has not been enabled</Error>`.
- `POST https://api.namecheap.com/xml.response` same fields -> identical error, HTTP 200.
- `GET https://api.sandbox.namecheap.com/xml.response` (no params) -> `<Error Number="1010101">Parameter APIUser is missing</Error>`.

---

## 5. WHOLESALE PRICES (USD)

**What a reseller/API customer pays = Namecheap public retail.** S1: "The prices are the same using API". A special price applies "once you get 50+ domains in your account" (no published table; `getPricing` `YourPrice` will show it). Coupons work through the API `PromotionCode` (S1: "you can use our coupons for purchases through API as well") but are capped per customer (e.g. "Limit 5 per customer", "Limit 30 per customer", "New customers only, Limit 1 per customer" in S39), and S21 notes "promo codes are not applied automatically during auto-renewals". Treat **Regular** as the planning number.

Namecheap's own pricing pages (namecheap.com/domains/*, /redemption-pricing/, /tier-pricing/) were Cloudflare-blocked, so **all figures are third-party scrapes of Namecheap's price list, dated "Sep 29, 2026 18:16" (S39) and "30 minutes ago" (S40)**. Consistency checks: S41 (Namecheap .app checked Aug 6: register $10.98, renew $22.98) matches S39 Regular; S40 = S39 best-coupon price + $0.20 ICANN fee for gTLDs (e.g. .dev 10.78+0.20=10.98), so the two agree. S42 (undated: ".com $6.98 first year then $15.88 renewal", ".io at $49.98 renewal") is **stale and conflicts** with S39 (.io renewal Regular $75.98, best coupon $60.78); do not use it.

Mandatory ICANN fee for gTLDs: $0.20 per registration/renewal/transfer/restore, itemized on top (S17: "plus $0.20 ICANN fee for generic TLDs"; S39 "ICANN fee: $0.20"). ccTLDs .ai/.io carry none.

| TLD | Register 1y (Regular / best coupon) | Renew (Regular / best coupon) | Transfer-in (Regular / best coupon) | Restore (redemption) | Notes and gotchas | Source |
|---|---|---|---|---|---|---|
| .com | $11.28 / $6.79 (NEWCOM679, new customers, limit 1; others $7.98-$11.08, limits 5-30) | $18.48 / $14.78 | $11.48 / $10.91 | ~$88.88 + renewal + $0.20 (third-party, generic-gTLD figure; **per-TLD unverified**) | +$0.20 ICANN. Transfer includes 1-year extension for most gTLDs (S23) | S39 https://domainoffer.net/tld/com/namecheap ; S40 https://tldes.com/com (6.99 / 14.98 / 11.08 all-in) |
| .ai | $89.98 / $83.98 | $114.98 / $91.98 | $99.98 / n.a. | **unverified** | **2-year minimum** on registration/renewal (S22: "It is not possible to renew .AI for 1 year only"; S32: "`.ai` allows 2-10"). It is **unverified whether the third-party figure is per year or the 2-year total**; read `getPricing` `Duration`. No ICANN fee. Expired .ai goes to serverHold (S28) | S39 https://domainoffer.net/tld/ai/namecheap ; S40 https://tldes.com/ai (83.98 / 91.98 / 99.98) |
| .dev | $10.98 / $10.78 | $20.98 / n.a. | $15.98 / $15.78 | ~$88.88 class (unverified) | HTTPS-only: S44 "The .dev top-level domain is included on the HSTS preload list, making HTTPS required on all connections". +$0.20 ICANN | S39 https://domainoffer.net/tld/dev/namecheap ; S40 https://tldes.com/dev (10.98 / 21.18 / 15.98 all-in) |
| .io | $34.98 / $31.98 | $75.98 / $60.78 | $65.98 / $52.78 | **unverified** (third party says ccTLD redemption "can carry ... $150 to $250+", S43, unverified) | Registration term 1-5 years (S32: ".co and .io allow 1-5"). Auth/EPP required (S13). Renewal is 2.2x the register price. Long-term risk: ISO code "IO" may be removed; S45: "a five-year time window will commence during which usage of the domain will need to be phased out"; as of the ICANN blog, "'IO' persists in the ISO 3166-1 standard". IANA record last updated 2023-01-18 (S46). | S39 https://domainoffer.net/tld/io/namecheap ; S40 https://tldes.com/io (31.98 / 60.78 / 52.78) |
| .app | $10.98 / $10.78 | $22.98 / n.a. | $17.98 / $17.78 | ~$88.88 class (unverified) | HTTPS-only: S44 "The .app top-level domain is included on the HSTS preload list, making HTTPS required on all connections to .app websites". +$0.20 ICANN | S39 https://domainoffer.net/tld/app/namecheap ; S41 ; S40 https://tldes.com/app |
| .studio | $14.98 / $13.98 | $52.98 / $42.38 | $39.98 / $31.98 | ~$88.88 class (unverified) | Renewal 3.5x the register price (largest first-year-trap of the six). +$0.20 ICANN | S39 https://domainoffer.net/tld/studio/namecheap ; S40 https://tldes.com/studio (14.18 / 42.58 / 32.18 all-in) |

Restore fee evidence: S17 "redemption price (plus $0.20 ICANN fee for generic TLDs). You can check redemption prices here" (table unreadable); S18 "It is set by our upstream Registrar and Domain Registry, that is why we cannot waive it"; third parties (S43) state "$88.88" for most generic TLDs. Treat as an estimate; get the table from a browser.

Premium/reserved: `domains.check` returns `IsPremiumName` and Premium{Registration,Renewal,Restore,Transfer}Price; `domains.create` needs `IsPremiumDomain` + `PremiumPrice` (S7); S20 "Refunds are not possible for Premium Domains"; S22 premium renewals "for 1 year only in one order".

---

## 6. LIFECYCLE

| Topic | Finding and evidence |
|---|---|
| Add-grace / cancellation / refund | No API. S20: "all the domain registrations/renewals are final, cannot be canceled, and are not refundable ... in some cases, we may provide a refund if you have a valid reason ... you will need to contact us within 5 days (120 hours) after registration. ... cancellation and refund may not be possible due to restrictions imposed by the applicable registry ... Refunds are not possible for Premium Domains." (Registration Agreement text itself unread.) |
| Auto-renew (does Namecheap renew on its own?) | Only if auto-renew is enabled per domain or via account default ("Enabling Auto-Renewal for future services", S21). S21: "The system will attempt to renew your domain 30 days before its expiration ... every 24 hours until the renewal is successful or the domain name expires"; charges "Namecheap account balance first" then cards; "promo codes are not applied automatically". Default for API-created domains: **unverified**; no API setter found (only `getList.AutoRenew`). Mosshatch should set the account default deliberately (OFF, and drive renewals through `domains.renew`, or ON as a safety net knowing customers cannot be prevented from being renewed if Mosshatch wants to cancel). |
| Renewal grace after expiry (gTLD) | S16: "for generic TLDs ... you have a period of about 30 days after the actual expiration date during which you can still renew the domain at Namecheap at the regular rate." S19: after expiry "the nameservers of a domain name are changed to Namecheap parking nameservers"; "No changes can be made to expired domains, including contact details update" (S17). |
| Auction risk | S16: "If you do not renew the domain within this grace period, your domain name may be auctioned off and purchased by someone else." Expired customer domains can be lost to Namecheap-side auction. |
| Redemption (RGP) | S16/S17: "Redemption Grace Period that lasts 30 days"; restore only via Support after adding funds (no API); fee "set by our upstream Registrar and Domain Registry" (S18); then "PendingDelete stage at the Registry for 5 days. On the 6th day, the domain should be released"; "Normally, generic TLDs get released approximately in 70-80 days" (S16), "80-85 days" (S18). |
| 60-day transfer lock | ICANN: S37 lists as denial reasons "3.7.5 The transfer was requested within 60 days of the creation date" and "3.7.6 ... within 60 days ... after being transferred". Namecheap: S12 "The domain is more than 60 days old; The domain was not transferred between registrars within the last 60 days". |
| 60-day lock after registrant change | Namecheap opts customers out: S15 quotes the Registration Agreement: "you explicitly opt out of any 60-day inter-registrar transfer lock that would otherwise be imposed under the Transfer Policy due to any such Change of Registrant. In addition, you explicitly authorize us and/or the registrar of record to act as its 'Designated Agent' ... to approve each 'Change of Registrant' ... Such approval will happen automatically". Registrant changes still trigger WHOIS re-verification (S27: 7-day queue, no suspension for contact updates). |
| Registrant-change behaviour | First name, last name, organization or email edits trigger the Transfer Policy flow (S15); confirmation emails go to both prior and new registrant; "if you are a Domain Privacy customer, you will not receive confirmation emails each time the anonymized email address is changed". |
| Auth code delivery (out) | S12: sent to the Registrant email after unlock in the UI; ICANN 5 days (S37 5.2: "within five (5) calendar days of the Registered Name Holder's initial request if the Registrar does not provide facilities for the Registered Name Holder to generate"). No API. |
| Transfer-in duration | S14: after submission "the domain acquires 'pendingTransfer' status. Transfers that have reached this stage are automatically confirmed within 5 days. Finally, it may take additional 24-48 hours for the Registry"; S31 "Awaiting release from previous registrar ... up to 5-7 days". S37 3.5: losing registrar silence for 5 days = default approval. Nameserver edits are blocked during the transfer (S14). |
| Transfer-in pricing/term | S23: "Most generic TLDs ... get renewed as part of the transfer. As to country code TLDs, each Registry sets their own rules"; API `Years` must be 1 (S7). |
| Outbound transfer fee/handling | KB S12 mentions no fee; Namecheap "has 5 days to release"; outbound state not visible in account (S31). Fee statement in the Registration Agreement unread. |
| Domain-to-customer's own Namecheap account | S29 "Change Ownership" push: free, immediate if the recipient auto-accepts, or invitation link valid 7 days; UI only. |
| Verification suspension | S27: unverified new registrations are suspended after 15 calendar days ("the domain will be suspended, and the DNS of the domain name will be changed"); reminders at 10 and 5 days. |
| ccTLD differences | **.ai:** min 2-year terms; expired .ai goes to serverHold (S28: ".AI and .CX domains are placed on serverHold when expired ... Reactivate your .AI domain using the instructions"); S16 says .AI and .IO "live according to the general domain life-cycle" otherwise. Transfers to Namecheap of .ai reportedly add 2 years (search-snippet only, unverified). **.io:** 1-5 year terms (S32), EPP required (S13), no ICANN fee, sovereignty/retirement risk (S45). Domain Privacy works for both (neither is in S25's exclusion list). |

---

## 7. WHOIS PRIVACY AND RDAP REDACTION

| Question | Finding and evidence |
|---|---|
| Free? | Yes. S24: "Our system adds a free Domain Privacy subscription with every registration, renewal, transfer, and reactivation for all eligible TLDs." S25: "we are offering privacy protection for free." |
| Default on? | In the UI cart: S24 "added to the Shopping Cart ... and enabled by default." **In the API the documented defaults differ:** S7 `AddFreeWhoisguard` "Add free domain privacy. Default: Yes", `WGEnabled` "Enable domain privacy. Default: No" (same on transfer.create as `WGenable`). Send `WGEnabled=Yes` explicitly. S1: "Yes, you can add a free Privacy Protection subscription to your domain name registration through API." |
| Controllable through API? | Yes: create-time flags; later `whoisguard.enable` (needs `WhoisguardID`, `ForwardedToEmail`) / `disable` / `getlist` / `renew` / `changeemailaddress` (S7; "The privacy service provider was renamed from WhoisGuard to WithheldforPrivacy. The API commands still use 'whoisguard' naming"). `getInfo` `Whoisguard Enabled` = "True"/"False"/"NotAlloted". |
| What the public sees | S33 (live Namecheap RDAP, 2026-09-29): `rdapConformance` includes `"redacted"`; registrant entity `org` = "Privacy service provided by WITHHELD FOR PRIVACY LLC", address Lewes, Delaware, email `b9ea79ab741f464db85514b28cc28ed9.protect@withheldforprivacy.com` (relay). S26: "every email sent to this email address will be forwarded to your Registrant email address." Fallback for unsupported TLDs: S25 "'Redacted for Privacy' ... only the State/Province and Country will be shown". S19: "for most gTLDs, your domain name's contact details will not be displayed in the Whois search since the recent GDPR implementation." |
| Exclusions | S25 excludes ccTLDs like .ca, .de, .in, .us, .uk etc.; none of .com/.ai/.io/.dev/.app/.studio. |
| Implications | The privacy operator is a third party (Withheld for Privacy LLC) forwarding to the registrant email, so registrant email must be a mailbox the customer controls (or a Mosshatch-controlled alias, which weakens "customer is registrant" and breaks the verification-link flow if Mosshatch does not forward). RDAP rate terms: S33 forbids "high volume, automated electronic processes"; use registry RDAP for status polling. |

---

## 8. NOTIFICATIONS

| Event | Mechanism |
|---|---|
| Webhooks | **None found** in S5 method list, S7, S8 (SDK offers polling only: `WaitForCompletion` polls `getStatus`, default 30 s). |
| Transfers in | Poll `transfer.getStatus`/`getList`. Email to Namecheap account owner on completion (S31: "you will receive a corresponding notification from us when the domain name transfer is completed or if it is rejected", for out). |
| Expiry | Namecheap emails account and registrant at 30/15/7/1 days and on expiry day (S19). Mosshatch should run its own scheduler from `getList ListType=EXPIRING`. |
| DNS | No events; read-after-write verify. |
| Registry status / RGP / pendingDelete | Not exposed by API; use RDAP. |
| Namecheap-side status | www.namecheap.com/status-updates (feed of 10 latest: only scheduled registry/Private Email/VPS maintenance in Sept 2026); status.namecheap.com blocked by egress policy. |

---

## 9. RED FLAGS

| # | Flag | Evidence |
|---|---|---|
| 1 | No reseller contract, program, or discount schedule; "special pricing" is a negotiation at 50+ domains. Resale permission rests on support articles (one dated 2018). | S2, S1, S6 |
| 2 | Binding legal text and API docs sit behind bot protection, unreadable to automated tooling; ToS clauses on price changes, suspension, resale, AUP unread. | 0.2 |
| 3 | IPv4 allow-list breaks serverless egress; Vercel Static IPs cost $100/month/project. | S1, S10, S38 |
| 4 | Two Namecheap-authored rate-limit numbers (50/min vs 20/min); throttling signalled as HTTP 405; errors as HTTP 200. | S1, S9, S10, S11 |
| 5 | No idempotency key; money-moving calls must not be retried. | S8 |
| 6 | DNS is replace-all and non-transactional; SDK maintainers call it a "footgun" (issue #49). | S8 |
| 7 | No auth-code or transfer-out API; auth code only emailed to registrant after UI action; no registry status codes; no restore/cancel/auto-renew APIs. | S5, S12, S17, S32 |
| 8 | Prepaid balance only; no invoiced credit; a low balance silently fails renewals. | S1, S21 |
| 9 | Retail-parity cost with coupon churn; renewals far above first-year price (.studio 3.5x, .io 2.2x, .dev 1.9x, .app 2.1x). | S39 |
| 10 | Expired domains may be auctioned; RGP restore via ticket and high fee. | S16, S17, S18 |
| 11 | Namecheap-branded emails to end customers; sponsoring registrar visible everywhere. | S27, S19, S33 |
| 12 | Concentration risk: all customers' domains in one account subject to ToS enforcement ("clientHold ... non-compliance with our Terms of Service"). | S28 |
| 13 | Prohibited: drop catching; HTTP (port 80) is accepted for API calls ("we recommend using https"). | S1 |
| 14 | Upstream wind-down precedent: 2026-06-10 notice that all Handshake TLDs are "no longer available for new registrations, renewals, transfers or management" due to "wind-down of the corresponding upstream provider" (not one of our TLDs). | S47 |
| 15 | Developer-friction reports: IP-whitelist errors (1011102/1011150) recur in third-party issue trackers (search results only; not opened, unverified). | search snippet |
| 16 | Docs note: `users.create` reseller sub-accounts appear in the transcript but not in the current sitemap; status unclear. | S7, S5, S8 |

Outages: https://www.namecheap.com/status-updates/ (accessed 2026-09-29) lists only 11 posts in total (planned registry/Private Email/VPS/EasyWP maintenance plus the Handshake notice), so it is not an incident log and says nothing about API downtime; status.namecheap.com is blocked by egress policy. API outage history is **unverified**.

---

## 10. RECOMMENDATION: FALLBACK

Namecheap is a workable **fallback** but not the primary reseller backend for Mosshatch. In its favour: a simple real-time API (check/create/renew/getInfo/transfer.create, DNS via setHosts, free privacy), a live sandbox, no API fee, prepaid entry threshold of $50, an ICANN-accredited registrar (IANA 1068) whose own GitHub org keeps a well-maintained Go SDK (last commits 2026-09-24), and explicit support statements that you may "resell domains with us using our API ... at your own prices". Against it: there is no reseller programme or published contract (so the resale, suspension and price-change clauses that matter are unread and the only stated discount is an unpublished tier at 50+ domains), so Mosshatch's "wholesale plus one flat fee" model collapses to retail-plus-fee with coupon-dependent cost swings; it lacks the adapter methods that a passkey-gated ownership product needs (no getAuthCode/startTransferOut, meaning every outbound transfer becomes a manual UI task inside ICANN's 5-day window, no registry status codes, no restore or auto-renew control, no webhooks, no idempotency key); DNS is replace-all only; and the IPv4 allow-list forces paid static egress ($100/month on Vercel) or a proxy. Use Namecheap for a first sandbox spike and as a hot standby for register/renew/DNS in the six starting TLDs, but require a primary that offers a written reseller agreement, wholesale pricing, idempotent orders, auth-code retrieval and webhooks; before relying on Namecheap even as fallback, obtain the Universal ToS and Registration Agreement text through a browser, ask Namecheap support in writing whether commercial reselling under one API account is accepted (and whether `users.create` sub-accounts are available), and confirm `getTldList` flags (`IsApiRegisterable`/`IsApiTransferable`) for .ai/.io/.dev/.app/.studio in the sandbox.

---

## 11. UNVERIFIED (could not be established)

1. Text of Universal ToS, Registration Agreement, Refund Policy, Court-order policy: any resale, API-use, suspension, price-change clauses (Cloudflare 403; challenge host blocked).
2. Original API method pages (intro, global-parameters, error-codes, transfer-statuses, extended-attributes, change-log): parameters are from the Namecheap-org SDK transcription (S7), not the live pages. Rate-limit statement on the intro page (20 vs 50/min) not seen.
3. Whether `.ai`, `.io`, `.dev`, `.app`, `.studio` have `IsApiRegisterable`/`IsApiTransferable` = true; documented transfer.create TLD list excludes them.
4. Whether the third-party `.ai` price ($83.98/$89.98) is per year or the mandatory 2-year total.
5. Official per-TLD restore (redemption) prices; only a third-party "$88.88" generic figure.
6. Namecheap tier-pricing schedule for 50+ domains; API `YourPrice` values for our account.
7. Sandbox behaviour for transfers, expiry/RGP, per-TLD OTE coverage, DNS propagation; whether sandbox needs the $50/20-domain threshold.
8. Error code for "domain already registered" / duplicate create; whether a retried create after success errors or double-charges.
9. Default auto-renew state for API-created domains; whether any API can toggle it.
10. Number of IPs that can be allow-listed; per-call `setHosts` record limit; TTL minimum (SDK transcription says 300-60000).
11. Whether `namecheap.users.create` (reseller sub-accounts) is available to a new API user.
12. Legal-process and abuse handling obligations passed to a reseller (RAA 3.18 style); Namecheap's reseller-side notice flow.
13. Outage/incident history (status.namecheap.com blocked); developer complaint volume (GitHub issue trackers not accessible).
14. Snippet-only search leads not opened: "All .ai transfers to Namecheap come with a 2-year renewal", Registration Agreement "you"/"your" definition, Universal ToS scope wording.
15. Whether the ICANN Transfer Policy's newer TAC-based rules apply to Namecheap yet (ICANN page S37 shows the 2016 policy with a 2024 update note).
16. Wayback/Common Crawl copies of the blocked pages: unreachable.
