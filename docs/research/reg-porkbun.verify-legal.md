# Verification notes: reg-porkbun, lens = LEGAL / PROGRAM

Verifier run date: 2026-09-29. All sources below were fetched by me (curl -sSL with browser UA through the agent proxy, TLS verification on). Raw copies and extracted text are in
`working-directory/research/vlegal-porkbun/` (dnra.txt, ptos.txt, spec.txt, llmsfull.txt, raa.txt, tp.txt, regcond_full.txt, kb*.txt, ...).
WebSearch was attempted and refused (session budget 200/200 exhausted), so no search-based discovery; everything is direct fetch of primary URLs plus the Porkbun KB search page (kb.porkbun.com/search?query=...).

## Bottom line

The analyst's central legal conclusion survives: no document I could open forbids reselling second-level domains; the DNRA (effective March 17, 2025) expressly contemplates "purchasing a domain name on behalf of a third party" and "reselling"; and the API spec (v3.44) says the API "does not establish a reseller relationship". "Conditional / fallback" is a fair reading.

What needed correction or was missed:
1. "Suspend/terminate at any time, and without notice" is quoted from a clause that is conditioned on breach or ICANN/legal requirement. The truly broad power is a different clause (INTERRUPTION OF DOMAIN SERVICES: sole discretion, "any other lawful reason", conduct that "place[s] unreasonable demands upon Porkbun"). Substance stands, quote is incomplete.
2. Liability is "amount paid, but never more than $500", and Porkbun separately excludes liability "under any circumstances" for suspension, loss or modification of a domain registration and for service unavailability. The $500 figure understates how little recourse exists.
3. Indemnity is broader than summarised (covers "Your use of the Services", "failure to register or renew", any breach).
4. Not covered anywhere in the dossier: Oregon governing law, mandatory-style AAA arbitration in Portland before a three-member panel with prevailing-party cost shifting, 30 days' written notice to cancel, $50/hour admin fee, no refund on termination.
5. `agreeToTerms` on /domain/create is documented as confirming the DNRA + Product ToS + Privacy Policy + auto-renewal terms. Each API purchase is therefore a click-through by the account holder; it does not discharge the DNRA duty to collect each customer's own acceptance.
6. "No partner surface" is too absolute: llms-full.txt labels POST /auth/login a "Partner-only endpoint (requires auth:login access on the API key)". A non-public partner tier plausibly exists even though no public program page does.
7. Sandbox keys do not require a Porkbun account: POST /apikey/request with {"sandbox": true} is documented to return a throwaway sandbox key pair immediately, no credentials (I did not call it).
8. The analyst listed "which payment source auto-renew uses" as unverified; the DNRA answers it (payment method associated with the account first; account credit only if no payment method is specified).

## Claim-by-claim

### C1. No document forbids domain resale; only resale prohibition is the Email Service
- Fetched: DNRA https://porkbun.com/legal/agreement/domain_name_registration_agreement ("This agreement is effective March 17, 2025."), Product ToS https://porkbun.com/legal/agreement/product_terms_of_service ("effective February 1, 2021"), Privacy Policy (Last Revised July 2, 2026), Customer Service & Abuse Policy, Data Disclosure Policy, Additional Registration Requirements (effective August 28, 2026), Ambassador Agreement, Marketplace Agreement, Ownership & Officers. Legal index https://porkbun.com/legal lists 20 documents; none is an API terms-of-use or reseller agreement.
- grep of DNRA for resell/resale/white-label/own use/commercial: only hit is the data-notice clause "If You engage in the reselling of domain names You agree to provide...". No prohibition.
- Product ToS: "The Email Service provided by Porkbun is intended for individuals and is for Your use only. Any unauthorized resale of the Email Service provided is expressly prohibited." Confirmed. NOT the only one: the Third-level Domain and Website Service section says "You may not sell or lease third-level domains to third parties". Irrelevant to .com/.ai/.dev/.io/.app/.studio but the word "only" is slightly wrong.
- Product ToS covers Hosting, Third-level Domain, and Email only; nothing on domain registration. It also says "Nothing contained in this Agreement shall be construed as creating any agency, partnership, or other form of joint enterprise".
- Verdict: confirmed (load-bearing part). Minor correction on "only".

### C2. DNRA contemplates purchase for third parties; duties fall on the account holder
Verbatim (DNRA, "Agents and Licensees" paragraphs):
- "In the event You are purchasing a domain name on behalf of a third party, You agree not to represent that You are an ICANN-accredited registrar, unless you have written permission from ICANN to do so, or that You are in any way providing superior access to the ICANN Domain Name Registry. You also agree not to use the ICANN trademark logo in any of your promotional materials including your website. You agree to obtain each of your customers' acceptances to the then current version of this Agreement, and to retain evidence of their acceptance for a period of not less than three (3) years. Should you require that your customers accept additional terms and conditions that are not required by Porkbun, You agree that such additional terms and conditions shall not conflict with this Agreement and the policies and procedures adopted by ICANN."
- "If You intend to license use of a domain name to a third party, You shall nonetheless be the registered name holder of record ... You shall accept liability for any harm caused by wrongful use of the registered name, unless You disclose the current accurate contact information provided by the licensee and the identity of the licensee within seven (7) days to a party providing You reasonable evidence of actionable harm." (mirrors RAA 3.7.7.3, confirmed in raa.txt)
- USE OF INFORMATION: "If You engage in the reselling of domain names You agree to provide any individuals whose personal information You have obtained, information about the possible uses of their personal information pursuant to ICANN policy. You also agree to obtain consent, and evidence of consent..."
- Verdict: confirmed verbatim. The analyst omitted the ICANN-logo prohibition (it is in the same paragraph).

### C3. API spec "Intended use" disclaimer
- spec.txt (JSON, info.description) and llms-full.txt both contain, under "## Intended use": "The Porkbun API is not a reseller service as defined under ICANN's Registrar Accreditation Agreement (RAA). All domain registrations are processed directly by Porkbun as the registrar of record. The API is intended for managing domains within your own account or on behalf of clients, and does not establish a reseller relationship." API version 3.44.
- Same document also advertises "Agentic domain registration ... register domains on behalf of users with a single API call". So the disclaimer is best read as "we will not treat you as a Reseller under RAA 3.12 / no reseller contract", not "on-behalf-of use is barred". The analyst quoted the full sentence including "on behalf of clients", so no misquote.
- Nuance: "All domain registrations are processed directly by Porkbun as the registrar of record" is not universal. Porkbun KB 235 and Registry Conditions say .ca, .cx, .it.com, .la, .nl (and .am) are provided through CentralNic Reseller (RRPProxy), so the registrar of record differs. None of the six starter TLDs are affected.
- Verdict: confirmed.

### C4. No public reseller / partner / wholesale program; affiliate program discontinued
- Re-probed https://porkbun.com/{reseller,resellers,partners,partner,wholesale,enterprise,business,reseller-program,agencies,agency,api,bulk,white-label,whitelabel,developers}: all HTTP 404. /contact 200 (support@porkbun.com only; page states "Average email response time is currently 6 hours, though response times can stretch to over 12 hours"; no partner/legal-sales contact).
- https://porkbun.com/affiliate carries the banner "The affiliate program has been discontinued." (the page body still describes the Ambassador program). The Ambassador Agreement is still linked from /legal but is a referral-commission contract, not resale.
- KB search kb.porkbun.com/search?query=resell returns nothing; query=reseller returns only KB 235 (CentralNic) and KB 163 (Afternic).
- Correction: llms-full.txt documents POST /auth/login as "Partner-only endpoint (requires `auth:login` access on the API key)", the spec text says "All v3 POST endpoints (excluding partner-only routes)", and the public /mock index lists /auth/getToken, /auth/login and /abuse/* (9 routes) that are not in the OpenAPI paths. So Porkbun has at least some non-public partner-gated API capability. It is login-on-behalf plumbing, not evidence of a reseller program, but "no partner surface" cannot be asserted flatly. The dossier itself calls the /abuse and /auth routes trust-and-safety; the /auth/login "Partner-only" label contradicts that for at least one route.
- Verdict: confirmed for public surface; corrected on the absolute framing (partner-gated capability exists, terms unknown).

### C5. Suspension / termination "at any time, and without notice"
- TERMINATION OR SUSPENSION OF SERVICES: "Porkbun may terminate or suspend this Agreement or any part of its Services at any time, and without notice to You, in the event of a breach of this Agreement or if termination or suspension is or becomes required by any policy of ICANN, and applicable law, or by any governmental authority." Conditional on breach or legal requirement. Also "Porkbun's failure to notify You or act upon any possible breach ... shall not constitute a waiver".
- INTERRUPTION OF DOMAIN SERVICES (the broad one): "Porkbun, in its sole discretion and without liability to You ... may take immediate corrective action, including ... deletion, suspension, cancellation, termination ... of Your Account ... at any time ..., if Porkbun determines that (i) You are or are alleged to be violating ...; (ii) Your conduct may harm Porkbun or others, cause Porkbun or others to incur liability, place unreasonable demands upon Porkbun, or disrupt Porkbun's business operations (as determined by Porkbun in its sole discretion); (iii) ...; or (iv) for any other lawful reason". Fees non-refundable.
- Account-holder side: "should You cancel or terminate ... provide at least thirty (30) days' written notice"; no refund on cancellation.
- ORDERS_BLOCKED: spec error table: "This account cannot place new orders. HTTP 403." No criteria published.
- Verdict: corrected. Substance (Porkbun can act at will in practice, no notice-and-cure, no refund) is right; the specific quote overstates the first clause.

### C6. Chargeback blast radius
- PAYMENT ISSUES: "In the event of a charge back by a credit card company ... We may suspend access to any and all Accounts You have with Us, and all interests in and use of any Services, including without limitation domain name registration services, website hosting, and/or email services ... We may reinstate ... solely at our discretion, and subject to our receipt of the unpaid Fees and our then-current reinstatement Fee".
- Relevance: API funding is by card top-up into credit, so a disputed top-up charge is a chargeback "in connection with Your payment of Fees". Inference, but direct.
- Verdict: confirmed.

### C7. Unilateral price changes
- FEES AND PAYMENT: "the applicable Service fees set forth on the Pricing Page, as may be amended from time to time, or otherwise communicated to You. Please check the Pricing Page often for any changes". TERM OF SERVICE: "the then-current renewal price may be higher or lower than the price You paid".
- Note: the DNRA defines "Fees" as "the prices for the Services as set forth in any written agreement between You and Porkbun" and speaks of prices "otherwise communicated to You". That is the only textual hook for negotiated commercial terms; worth citing if Mosshatch asks Porkbun for a written agreement.
- Live pricing re-fetched (https://api.porkbun.com/api/json/v3/pricing/get?tlds=com,ai,dev,io,app,studio): com 11.08/11.08/11.08; ai 82.70/82.70/165.09; dev 8.75/12.87/12.87; io 28.12/51.80/51.80; app 8.75/14.93/14.93; studio 11.84/32.44/32.44; coupons empty. Matches the analyst. Blog table (https://porkbun.com/blog/upcoming-price-increases/) rows: .studio 2026-10-06 $43.00; .com 2026-11-01 $11.81; .io 2027-01-19 $60.00; .ai 2026-03-05 $84/$84/$167 (not reflected in live price); .io 2026-01-19 $53 (live regular is 51.80). KB 201 confirms ".com price will be raising November 1, 2026, 0400 UTC to approximately $11.81" and ~7%/yr to 2030. KB 266: 10.26 + 0.20 + 0.62 = 11.08, "Porkbun is a domain registrar, meaning we sell domains directly to the public", "markup $1 or less".
- Verdict: confirmed.

### C8. Liability cap $500
- Verbatim: "IN NO EVENT SHALL PORKBUN'S AND/OR ANY REGISTRY OPERATOR'S MAXIMUM AGGREGATE LIABILITY EXCEED THE TOTAL AMOUNT PAID BY YOU FOR THE SERVICES, BUT IN NO EVENT GREATER THAN FIVE HUNDRED DOLLARS ($500.00)."
- Also: "YOU AGREE THAT PORKBUN, ICANN AND/OR ANY REGISTRY OPERATOR WILL NOT BE LIABLE, UNDER ANY CIRCUMSTANCES, FOR ANY (i) SUSPENSION, LOSS, OR MODIFICATION OF YOUR DOMAIN NAME REGISTRATION ... (iii) UNAVAILABILITY OF SERVICES ... OR ANY INTERRUPTION OF BUSINESS ...". Services "AS IS"; no consequential damages or lost profits.
- Verdict: corrected. Cap is the lesser of fees paid and $500, and the wrongful suspension/loss of a domain is carved out of liability entirely.

### C9. Indemnity
- Analyst summarised: account holder indemnifies Porkbun, ICANN and registry operators for use of domains in its name, IP disputes, registrant transfers.
- Actual: "defend, indemnify and hold harmless Porkbun, ICANN and/or any Registry Operator (including any parents, subsidiaries, shareholders, members, officers, directors, employees, affiliates, agents and subcontractors ...) from any third party claim ... due to ... (i) Your use of the Services, (ii) Your application for and registration of, or failure to register or renew, a particular domain name; (iii) Your use of any domain name registered in Your name; (iv) Your breach of this Agreement; (v) any disputes involving the intellectual property rights of others; (vi) processing any registrant transfers in accordance with this Agreement; and (vii) Your use of any domain name affected by any transfer of registrant request. This indemnification is in addition to any indemnification required under the UDRP".
- Plus: $50/hour administrative fee and attorneys' fees if the account holder alleges unauthorised access; $120 reversal fee for registrar or registrant transfers of domains "for which You are not the valid owner".
- DNRA "You" is defined as "Yourself as the customer and Your agents, including each person listed in Your account information as being associated with Your account and the registrant listed in the WHOIS contact information". So the allocation between Mosshatch and an end customer who becomes registrant is not clean: the registrant is itself part of "You".
- Verdict: corrected (understated).

### C10. Governing law and dispute resolution (NOT in dossier)
- DNRA: governed by "the laws of the State of Oregon"; "Either party may initiate binding arbitration administered by the American Arbitration Association ... Claims shall be heard by a three member arbitration panel. The place of mediation and arbitration shall be Portland, Oregon ... The arbitrator shall award to the prevailing party ... all of their costs and fees" (exception: non-payment by You). Third-party disputes about the account holder's domains: "You (but not Porkbun) agree to submit to ... the United States District Court for the District of Oregon".
- Product ToS (hosting/email/third-level): exclusive venue W.D. Oregon; liability caps $100.
- Verdict: missed by analyst; verified by me.

### C11. Registrant of record and the API create call
- Spec `CreateDomainRequest` fields: cost, agreeToTerms, whoisPrivacy, dryRun. No contact fields. Confirmed.
- llms-full.txt (changelog and error table): transfer refusal `REGISTRANT_EMAIL_NOT_ACCEPTED` says "Change the email on the default registrant contact for the account and retry". So for transfers the account default registrant contact is documented as the source; for create it remains an inference but very likely.
- `POST /domain/updateContacts/{domain}`: "a registrant (name/organization/email) triggers the same material-change record and new-owner notice/verification email (no 60-day transfer lock is imposed)". Confirmed. That the email is "Porkbun-branded" is an assumption (not stated).
- DNRA CHANGE OF REGISTRANT: "Porkbun has the authority to act as your Designated Agent ... maintain the right to approve requests to modify registrant information and changes in domain ownership"; "You also expressly agree to opt out of the 60 day inter-registrar transfer lock following any Material Change ... with the exception that the 60-day ... lock will still apply to the Material Change ... when a domain is purchased via Porkbun's marketplace." Confirmed. The ICANN Transfer Policy (updated 21 Feb 2024) II.C.1.2 requires the registrar to tell a New Registrant it "must enter into a registration agreement with the Registrar", so the customer-as-registrant model puts the customer in direct privity with Porkbun.
- Consequence flagged by DNRA (not by dossier): "failing to respond for over fifteen (15) days to inquiries by Us concerning the accuracy of Account and WHOIS contact information will constitute an incurable material breach ... a basis for suspension and/or cancellation". Porkbun's verification emails go to the registrant email; if that is an unresponsive end customer, the domain can be suspended and the public API exposes no EPP/status codes to detect it.
- Verdict: confirmed (with create-path inference flagged).

### C12. Customer acceptance evidence, and what `agreeToTerms` means (partly missed)
- llms-full.txt /domain/create: `agreeToTerms` "Must be 'yes' or '1' to confirm agreement to the Domain Name Registration Agreement, Product Terms of Service, Privacy Policy, and automatic renewal terms."
- So the API call records the account holder's acceptance, not the customer's. The DNRA duty to obtain each customer's acceptance of "the then current version of this Agreement" and keep evidence 3+ years remains Mosshatch's, and the DNRA can change on 30 days' email notice (so Mosshatch must re-collect or track versions).
- Verdict: confirmed, plus missed nuance.

### C13. Program requirements
- Confirmed from spec: "Account email and phone must be verified"; prepaid credit only; ORDER_TOO_LARGE "A single API registration cannot exceed $100. Register it on the website"; premium unsupported; TOPUP_LIMIT_EXCEEDED "per-day (5) or per-month (20) ceiling on API top-ups"; API-set top-up amount 500-50000 cents; "an account that has never set one still gets a $100/month ceiling" on top-ups.
- KB 225 (last updated June 19, 2026): "we have made the decision to require photo ID verification for a subset of new Porkbun accounts", Veriff, submissions retained 15 days. Confirmed.
- KB 181 (last updated Sept 3, 2025): ACH Only, "save over 3%", request by email/secure message, "as part of the process we will have you complete an ID verification", US bank; converting the main account disables cards/PayPal; suggests a subaccount. Confirmed.
- No application, minimum deposit, volume commitment or wholesale tier appears in any document I opened (absence, not proof).
- Sanctioned alternative: guide https://porkbun.com/llms/guides/onboard-a-mobile-app-user ("get a user's own Porkbun API keys"; "issued key is a full-account key") and POST /account/invite ("go through Porkbun's normal account creation flow - including CAPTCHA, address collection, and TOS acceptance"). Confirmed; customer becomes Porkbun's direct customer.
- Verdict: confirmed.

### C14. ICANN RAA 1.24 / 3.12 framing
- raa.txt (https://www.icann.org/en/contracted-parties/accredited-registrars/registrar-accreditation-agreement/2013-registrar-accreditation-agreement-17-09-2013-en): 1.24 "A 'Reseller' is a person or entity that participates in Registrar's distribution channel for domain name registrations (a) pursuant to an agreement, arrangement or understanding with Registrar or (b) with Registrar's actual knowledge, provides some or all Registrar Services, including collecting registration data about Registered Name Holders, submitting that data to Registrar, or facilitating the entry of the registration agreement..." 3.12 "Registrar must enter into written agreements with all of its Resellers"; 3.12.1 (no ICANN logo), 3.12.2 (registration agreement with required notices, identify sponsoring registrar), 3.12.3, 3.12.5 (registrant education link), 3.12.7 (Registrants' Benefits and Responsibilities). All quoted correctly. 3.7.7.3-3.7.7.6 (licensee, data-notice, consent) match DNRA flow-down.
- Correction of attribution: the dossier says written reseller agreements are something "Porkbun says it does not have". Porkbun only says the API "does not establish a reseller relationship". Whether Porkbun has RAA 3.12 agreements with anyone is not stated. Also this is legal analysis: Porkbun's label cannot change the RAA definition; the (b) limb ("actual knowledge") arguably captures Mosshatch once Porkbun knows. The risk cuts both ways: Porkbun may decide the pattern creates a 3.12 compliance problem and block it.
- Verdict: confirmed (text); corrected (attribution).

### C15. Abuse and legal-process paths
- Abuse policy: "All reports of abuse ... must be submitted through our Abuse Reporting Form ... we cannot accept any abuse reports via email"; "Porkbun only addresses DNS-related abuse in alignment with our ICANN contract"; "You will receive a confirmation email that your Abuse Report was received within 24 hours". The "reviewed within 24 hours" wording is in the DNRA ("All well-founded reports of Illegal Use submitted to these contacts will be reviewed within 24 hours"), not the abuse policy.
- Data Disclosure Policy: legal@porkbun.com; "valid subpoena or court order issued by a court with jurisdiction over Sherwood, Oregon, USA"; acknowledgement within two business days, decision "within thirty (30) calendar days"; relay form forwards to the registrant's email on file; KYC at Porkbun's sole discretion. Confirmed.
- DNRA lets Porkbun act on litigation: "we may suspend your ability to use, update and/or transfer your domain name registrations, and/or we may deposit control of Your domain name record into the registry of the judicial body"; "Porkbun may submit a Registrar Certificate or relinquish custodianship and/or control over a domain name, Service, or account". Confirmed.
- Verdict: confirmed (minor attribution fix on the 24h).

### C16. Expiry and lifecycle terms as they bind the account holder
- KB 37 (last updated March 20, 2026) confirmed: 10 days normal; after day 10 Porkbun NS/expired notice, Client Hold or parking; ~day 21 may be submitted to third-party auction; days 26-37 may be at auction, a bid removes the domain from the account and blocks renewal; removal on day 35-45 (typically 37-38); 30-day RGP with "redemption fee which varies by the registry", via Support; ".ai registry may auction off the domain".
- DNRA EXPIRATION: Porkbun "may direct the domain name to name-servers ... which host a parking page or a commercial search engine that may display advertisements", may "change the contact information in the WHOIS output for the expired domain name so that You are no longer the listed registrant", may auction "anytime after expiration", is "not obliged to contact You", "not required to offer" the Reactivation Period (up to 30-43 days), may choose not to participate in RGP, and may keep the name in an "extended redemption grace period" for 120 days at the ERGP fee. Not in dossier beyond a mention of ERGP and auction.
- Auto-renew: DNRA "Porkbun will take payment from the payment method associated with your account, or account credit if no payment method is specified and sufficient account credit is present" and "domain name renewal transactions are final, irreversible, non-refundable". This answers an item the dossier lists as unverified.
- Add-grace: KB 293 (updated September 4, 2026): "four day (96 hour) grace period", "refund fee of 5%", "Some TLDs do not qualify", both Refund Registration and Refund Renewal. DNRA: refund/credit for deletion "within the first five (5) days ... at Porkbun's sole discretion ... less the applicable deletion Fee". Conflict confirmed; plan on 96 hours.
- Verdict: confirmed; additional DNRA discretion missed.

### C17. 60-day lock and ICANN Transfer Policy references
- DNRA: "You agree that You may not transfer Your domain name registration to another domain name registrar during the first sixty (60) days from the effective date of Your initial domain name registration". Confirmed.
- ICANN Transfer Policy (https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers/policy, "Updated 21 February 2024 ... must implement no later than 21 August 2025"): 3.7.5 is a permitted denial reason ("requested within 60 days of the creation date"), not a mandate; 3.5 default approval after five calendar days; 5.2 AuthInfo and ClientTransferProhibited removal within five calendar days if no self-service. Confirmed.
- Verdict: confirmed.

### C18. Registry conditions
- https://porkbun.com/legal/agreement/registry_conditions: "effective as of August 28, 2026. It applies to all domain names registered through Porkbun, including domain names registered before that date"; changes bind immediately; .ai "sponsored by the Government of Anguilla ... abide by terms ... at https://www.nic.ai/"; .io "sponsored by Internet Computer Bureau Limited"; .app/.dev "sponsored by Charleston Road Registry" (text refers to "Google Registry"); .com Verisign; .studio in the Identity Digital list. Registrant indemnities to registry operators are included.
- Verdict: confirmed.

### C19. Data handling
- Privacy Policy (Last Revised July 2, 2026): Porkbun LLC is "the Controller"; discloses to registries and escrow providers; RDAP redaction depends on registry compliance ("Porkbun cannot guarantee their compliance"); international transfers "for example, Standard Contractual Clauses". No DPA, processor terms or reseller data-sharing terms anywhere in /legal. Mosshatch and Porkbun would be independent controllers of the same registrant data. "If in the past you have joined one of our affiliate, reseller, or referral programs to earn commission" appears (confirmed) but only as a data-category note.
- Verdict: confirmed (no DPA is an absence finding). Not raised by the analyst as a gap.

### C20. Registrar identity
- IANA registrar-ids.xml: value 1861, "Porkbun LLC", Accredited, RDAP server https://cart-before.porkbun.horse/rdap/. Ownership page: Porkbun LLC is "a fully owned subsidiary of Top Level Design LLC". Confirmed.

### C21. Sandbox needs a Porkbun account (technical, checked because it appears in the summary)
- llms-full.txt POST /apikey/request: "SANDBOX: pass sandbox: true to skip approval and get a sandbox key pair back immediately"; "No credentials are required"; rate limit 20 requests per IP per 3600 s. So the summary's "requires a Porkbun account" and the Unverified item are wrong on the documented behaviour. I did not call it (documentation only).
- Verdict: refuted (on documented behaviour; not exercised).

### C22. Order cap, prepaid credit, top-up limits
- Confirmed in spec text (see C13). .ai 2-year price vs $100 cap still unverified (no authenticated call); the spec text says 82.70 is the pricing/get value and KB says 2-year minimum.

## Other observations for the Mosshatch decision
- Porkbun's own materials frame API use as owner-operated ("Porkbun for AI agents": "how to keep an agent safe on your account"; KB 308) and as user-owned-account handoff (PKCE, /account/invite). Multi-tenant resale from one account is tolerated by DNRA text but is not a marketed pattern.
- Sub-accounts exist (KB 242 fetched; KB 182 listed in KB search only) but sub-accounts cannot unlock, transfer, generate auth codes or push; their fitness as a per-customer blast-radius boundary via API keys is unverified.
- Only contact path for a negotiated deal: support@porkbun.com / chat / 1.855.767.5286; no partner desk published.
- No sanctions/OFAC or export clause in the DNRA; no assignment/change-of-control clause; no SLA anywhere.
