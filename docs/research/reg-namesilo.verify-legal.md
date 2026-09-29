# reg-namesilo: LEGAL / PROGRAM verification notes

Verifier: adversarial, legal lens. Date: 2026-09-29 (fetches 20:15-20:35Z). Everything below was re-fetched by me into
`.../scratchpad/research/vns-legal/` (my own copies; I did not reuse the analyst's `ns/` folder text, except to compare which pages the analyst
had actually obtained: the analyst's `ns/sup/account-options__account-funds-manager.txt` is a Cloudflare challenge page, i.e. never read).
Method: curl with browser UA through the pre-configured proxy (works for some `/support/v2/articles/*` pages, 403 challenge for others);
headless Chromium (`/opt/pw-browsers`, `NODE_PATH=/opt/node22/lib/node_modules`) for the challenged pages, one page per fresh session with pauses.
I did not solve or bypass any challenge (two pages returned "Just a moment" on first try and passed on a later fresh session, same as the analyst).
WebSearch budget was exhausted (200/200), so no searches ran. `web.archive.org` CDX query failed with a connection reset (relay failure, not
retried further). Nothing authenticated, nothing charged, no API calls made; only public pages and public documentation fragments were fetched.

## Bottom line

1. **The public paper is friendlier to resale than the analyst's tone implies, but the decisive contract is still unread by both of us.**
   NameSilo's marketing and support text expressly invite independent resale under the reseller's own brand through a free API
   ("Whitelabel all NameSilo services and brand them as your own"; "create an entirely custom reselling web site using our API"; official
   WHMCS/HostBill/Blesta/BoxBilling/Clientexec modules; "We have a number of people and companies who are active resellers of ours").
   No public clause prohibits resale, white-labelling or automated API ordering. The "reseller terms and conditions" are shown only in a
   logged-in account (`/account_reseller.php` redirects to `/login?redirect=/account_reseller.php`); I could not read them and found no public copy.
   Verdict on the analyst's headline (conditional; legal gate unverified): **holds**.
2. **The analyst missed four governing/adjacent documents or clauses that matter to a reseller:** (a) the second half of AGENTS AND LICENSES
   (a licensor stays "domain name holder of record" and personally liable for harm, RAA 3.7.7.3 flow-down) which decides what happens when
   Mosshatch, not the customer, is registrant; (b) the **Account Funding Terms and Conditions** (`/popups/account_fund_terms.php`), never opened,
   which contain a 60-day lock-up, 3.4-4% refund fee, sole-discretion changes "may or may not notify", and **document automatic replenishment**
   (the dossier says none is documented: refuted); (c) the Discount Program FAQ clawback ("refund you the amount minus the discounts you received");
   (d) data-handling terms: NameSilo claims ownership of registrant contact data, allows bulk-WHOIS/"targeted marketing" use, requires
   consent from third parties whose data is submitted, and its Privacy Policy still cites EU-U.S. Privacy Shield with no DPA.
3. **Two small corrections:** RAA 3.12.2 quote is truncated (drops the "or provide a means for identifying the sponsoring registrar" alternative);
   the liability cap is the lesser of fees paid and $200, not simply $200.

## Documents opened (all HTTP 200 unless noted; sha256 first 16 of my text copy)

| Doc | URL | copy / sha256 |
|---|---|---|
| Registration Agreement ("Terms and Conditions"), undated, ~99,900 chars, read in full | https://www.namesilo.com/support/v2/articles/general-terms/terms-and-conditions | tos.txt 248d4a4415e0509f |
| Reseller FAQ | https://www.namesilo.com/support/v2/articles/domain-manager/reseller-frequently-asked | reseller-faq.raw.txt 946578c3516e300b |
| Reseller landing page + expanded FAQ | https://www.namesilo.com/reseller | reseller-landing.txt 9f595f92730db631 / reseller-landing-faq.txt 3e97bf0108010115 |
| Reseller Options | https://www.namesilo.com/support/v2/articles/about/reseller-options | about_reseller-options.txt 6cf4bb52c06598be |
| Reseller Manager (public article) | https://www.namesilo.com/support/v2/articles/account-options/reseller-manager | account-options_reseller-manager.txt 2a3b42e69ab4e116 |
| Reseller Complaints and Policies | https://www.namesilo.com/support/v2/articles/policies/reseller-complaints | reseller-complaints.txt bbfdf2ffb78ff32f |
| API Automated Batch Processing | https://www.namesilo.com/support/v2/articles/account-options/api-automated-batch | 5256cc77fda9ff95 |
| API Manager | https://www.namesilo.com/support/v2/articles/account-options/api-manager | 08798426ec4a2064 |
| Sub-Account Manager | https://www.namesilo.com/support/v2/articles/account-options/sub-account-manager | account-options_sub-account-manager.txt |
| Abuse Reporting Procedures | https://www.namesilo.com/support/v2/articles/policies/abuse-reporting-procedures | d549f1f9ca0e5ed9 |
| Change of Registrant | https://www.namesilo.com/support/v2/articles/policies/change-registrant | 48f94bec86bac4e5 |
| Cancelling Orders | https://www.namesilo.com/support/v2/articles/policies/cancelling-orders | 87284e92c675aadd |
| Expiration Process | https://www.namesilo.com/support/v2/articles/policies/expiration-process | 0cac4d2d8ce766c0 |
| Discount Program (program page + expanded FAQ) | https://www.namesilo.com/discount-program | discount-program.txt f52139bc8003dd98 / dp-faq.txt 7d53442c67d66953 |
| Discount Program (support article) | https://www.namesilo.com/support/v2/articles/ordering/discount-program | ordering_discount-program.txt |
| **Account Funding Terms and Conditions (NEW, analyst never read)** | https://www.namesilo.com/popups/account_fund_terms.php | fundterms.txt add81bce50f8043d |
| **Account Funds Manager (analyst copy was a Cloudflare challenge)** | https://www.namesilo.com/support/v2/articles/account-options/account-funds-manager | funds.txt 4cf019841fac327f |
| Privacy Policy | https://www.namesilo.com/support/v2/articles/general-terms/privacy-policy | 3448a0fd7bd10b68 |
| WHOIS Email Verification | https://www.namesilo.com/support/v2/articles/general-terms/whois-email-verification | dc560976c6cb633c |
| RDAP terms | https://www.namesilo.com/support/v2/articles/general-terms/rdap | ab94cd2c1344b6d1 |
| RDAP disclosure form | https://www.namesilo.com/support/rdap | rdap-form.txt |
| Policies index ("Terms and Conditions" overview: links Privacy, WHOIS, RDAP, ICANN rights, "GDPR Policies") | https://www.namesilo.com/support/v2/articles/policies/terms-and-conditions | tos2.txt |
| TLD-Specific Details (only ".CA Domains") | https://www.namesilo.com/support/v2/articles/policies/tld-specific-details | tld-specific.txt |
| WHMCS module page | https://www.namesilo.com/reseller/whmcs | whmcs.txt |
| MCP wrapper page | https://mcp.namesilo.com | mcp.txt |
| API reference: register-domain fragment, landing page, response-code bundle chunk | https://www.namesilo.com/api-reference/pages?uid=domains/register-domain ; /api-reference ; /spa/search-domains/js/2591.91b826f1.js | rd.txt 5de7723860e951c2, apiref.txt, codes.js |
| Pricing page (Registrations, Renewal, Transfer tabs) | https://www.namesilo.com/pricing | pricing-rows.txt 1e0a0dbc52e908cd, pricing-Renewal.txt, pricing-Transfer.txt |
| ICANN RAA 2024-01-21 | https://www.icann.org/en/system/files/files/registrar-accreditation-agreement-21jan24-en.htm (redirects to itp.cdn.icann.org) | raa.txt 42d72c794620e998 |
| IANA registrar IDs | https://www.iana.org/assignments/registrar-ids/registrar-ids.xml | iana.xml |
| RDAP sample | https://rdap.namesilo.com/domain/NAMESILO.COM | rdap-ns.json |
| In-account reseller terms | `/account_reseller.php` -> 302 to `/login?redirect=/account_reseller.php` (plus Cloudflare interstitial) | NOT READABLE |
| Tried and failed | web.archive.org CDX (connection reset by peer, `ws_closed_mid_exchange` in proxy log) | not retried |

## Claim-by-claim verdicts

1. **Resale is openly invited; sign-up is a click-through with no application.** CONFIRMED. Reseller FAQ: "There is no special sign up required.
   Simply create a new account on our web site and then visit the Reseller Manager page. You will be required to accept our reseller terms and
   conditions. Once you do so, you are then set up as a reseller." Landing page repeats it in three steps and adds a stronger hero line the analyst
   never quoted: "Your one-stop shop for reselling domains. Whitelabel all NameSilo services and brand them as your own." Reseller Options page
   (title "Become a Domain Reseller"): "We have a number of people and companies who are active resellers of ours. We have an API that many people
   have used as well as modules for WHMCS, HostBill, Blesta, BoxBilling and Clientexec". `/reseller/whmcs` page: the official module lets WHMCS
   "interface with NameSilo's API to provide Registration, Transfer, Renewal, EPP Authcodes, DNS management" and needs "your live API key".

2. **"We offer our API for free ... you can create an entirely custom reselling web site using our API."** CONFIRMED verbatim (FAQ, landing FAQ).
   No "own use only" wording found anywhere. The API Manager article says the API is "a convenience to customers who have additional automation
   requirements" and "allows access to accounts via our users' own software"; that is descriptive, not a restriction, and the FAQ contradicts any
   own-use reading. I searched the Registration Agreement for "reseller", "resell", "API", "automated": zero hits (offsets empty).

3. **"There is no special pricing for resellers."** CONFIRMED verbatim on the FAQ and on Reseller Options; the landing page instead says
   "You decide your own profit margin with our digressive price rates" and points to the Discount Program.

4. **The reseller terms and conditions are in-account only and unread.** CONFIRMED as a gap (I could not read them either). `/account_reseller.php`
   (the "Sign Up Now"/"Become a NameSilo Reseller" link target on the landing page) redirects to the login page. No public copy found; the public
   Reseller Manager article lists only Generic Site, Reseller Name, Reseller Email, Custom WHOIS Footer, Hide WHOIS Ads, Generic WHOIS Terms.
   Extra evidence that the in-account page holds more than the public article: the `registerDomain` API page says you can "configure your account
   to reject orders with invalid contact information via the Reseller Manager page in your account", an option the public article does not list.
   Consequence: every question the lens asks about (resale scope, minimums, price change, suspension, indemnity, flow-down of RAA 3.12) remains
   unverifiable from public text. Also unverified: whether the "violates our terms of service" language in the batch-API article (claim 14)
   lives in those reseller terms, since the public Registration Agreement never mentions the API.

5. **Public Registration Agreement has no reseller/API clause; AGENTS AND LICENSES makes the account holder warrant "the authority to bind".**
   CORRECTED (quote correct, analysis incomplete). Verbatim first sentence is right: "If you are registering a domain name for or on behalf of
   someone else, you represent that you have the authority to bind that person as a principal to all terms and conditions provided herein."
   The same paragraph continues: "If you license the use of a domain name you register to us or a to third party, you remain the domain name holder
   of record, and remain responsible for all obligations at law and under this Agreement, including but not limited to payment obligations, and
   providing (and updating, as necessary) both your own full contact information, and accurate technical, administrative, billing and zone contact
   information ... You further agree to accept liability for harm caused by wrongful use of the Registered Name, unless you disclose the current
   contact information provided by the licensee and the identity of the licensee within seven (7) days to a party providing the Registered Name
   Holder reasonable evidence of actionable harm." This is RAA 3.7.7.3 nearly word for word (raa.txt lines ~641-650). It is the clause that applies if
   Mosshatch ends up as registrant (see claim 6). Also in the Agreement, not in the dossier: "you" is defined as "you and the registrant associated
   with the WHOIS contact information", so NameSilo treats the WHOIS registrant as bound through the account holder; "Only the registrant and the
   administrative contacts listed in the WHOIS information may approve or deny a transfer request" (TRANSFERS).

6. **Registrant of record = whoever is in the contact data Mosshatch submits; bad contact data still succeeds with the account default contact
   (code 302) unless the account rejects invalid contacts.** CONFIRMED against the API fragment (rd.txt lines 23 and 58, exact sentence quoted in
   the dossier). Legal add-on the analyst did not draw: the default-contact fallback silently makes the account holder (Mosshatch) the WHOIS
   registrant, which under AGENTS AND LICENSES makes Mosshatch "domain name holder of record" with the licensee-liability duty, and under the
   Reseller Complaints procedure (claim 18) the end customer could not match a government ID to the WHOIS name.

7. **RAA 1.26 (Reseller) and 3.12.2 obligations.** CORRECTED. Fetched the RAA myself. 1.26 is confirmed: a Reseller is one that "(a) pursuant to an
   agreement, arrangement or understanding with Registrar or (b) with Registrar's actual knowledge, provides some or all Registrar Services,
   including collecting registration data ... submitting that data to Registrar, or facilitating the entry of the registration agreement", so
   Mosshatch qualifies under limb (a) regardless of how it treats the registrant. 3.12.2 quote is truncated: the text ends "and shall identify the
   sponsoring registrar **or provide a means for identifying the sponsoring registrar, such as a link to the ICANN Registration data lookup tool
   (https://lookup.icann.org)**". Not in the dossier: 3.12 preface ("Registrar must enter into written agreements with all of its Resellers that
   enable Registrar to comply with and perform all of its obligations", so a written reseller contract must exist, consistent with a click-through
   but making the unread terms load-bearing); 3.12.1 (resellers must not display the ICANN or ICANN-Accredited Registrar logo or represent
   themselves as ICANN-accredited); 3.12.3 (identify sponsoring registrar upon inquiry); 3.12.5 (link to ICANN registrant education page, see
   3.16); 3.12.7 (publish or link the Registrants' Benefits and Responsibilities Specification); and Registrar Information Specification items 26-27
   (NameSilo must keep a list of its Resellers available to ICANN). NameSilo publishes its own Registrant Rights and Responsibilities at
   `/support/v2/articles/general-terms/icann`.

8. **Program requirements: click-through, no application/approval/KYC/volume/deposit; practical gates are a verified card or funded balance.**
   CORRECTED. Public text supports "no formal application, volume commitment or reseller deposit". But "no approval/KYC" is too strong:
   (a) Terms, SERVICES PROVIDED AT WILL: "We may reject your domain name registration application or elect to discontinue providing Services to you
   for any reason within 30 days of a Service initiation or a Service renewal"; (b) same clause lists as cause "failure to respond to inquiries from
   us regarding payment inquiries for over 24 hours" and "failure to respond to inquiries from us for over three (3) calendar days";
   (c) Privacy Policy: "We may also request proof of identification, financial information, or other forms of information necessary to provide the
   services that you request"; (d) card funding needs a verified card (Account Funding T&Cs). API gate confirmed: "You must have at least one
   verified credit card or adequate account funds to utilize these commands" (rd.txt line 4).

9. **Discount Program requirements: account funds only, at least $50 each time funds are added, no coupons, 0-99 starter tier.** CONFIRMED
   (discount-program page and expanded FAQ). Quotes: "Discounts apply only when checking out using Account Funds at time of purchase"; "There's no
   minimum balance requirement for your account. However, when adding funds, you must add at least $50 each time during your participation in the
   program and for 30 days after cancellation"; "Coupon codes cannot be used while enrolled"; tiers 0-99 / 100-499 / 500-999 / 1000-2499 / 2500-4999
   / 5000+. **Missed by the analyst** (FAQ, "What happens if I cancel"): "If you choose to withdraw the remaining funds from your account after
   opting out, we will refund you the amount minus the discounts you received on your domain registrations and renewals." So DP discounts are
   effectively clawed back on withdrawal. Also: "bulk order registration discounts will still apply" while enrolled, "Drop-catch orders using our
   API are not eligible for discounts" (which implies, but does not state, that ordinary API orders are eligible: the analyst's open question
   "do DP prices apply to API orders" remains unproven, only hinted at).

10. **Price claims (.com starter tier 11.05 reg/renew; retail 17.29; transfer 10.80 sale/11.95; other TLD registration rows).** CONFIRMED for what I
    re-read today from the live pricing tables: `com | 17.29 | 17.19 | 17.09 | 11.05 | 11.00 ...` (Registrations); Renewal tab `com | 17.29 | 11.05 | 11.00
    ...`; Transfer tab `com | $10.80 $11.95 Sale`. Registrations rows today: `.ai 99.99 / DP 0+ 94.99`; `.dev 14.99$10.99 / DP 0+ 14.89$10.89`; `.io 69.99$38.99 /
    DP 0+ 69.89$38.89`; `.app 16.89$10.89`; `.studio 40.89$17.89` (crossed-out = post-promo regular). Transfer prices for .ai/.dev/.io/.app/.studio and
    the renewal rows for those TLDs were not re-read (my Transfer/Renewal extraction only surfaced the first rows), so those specific numbers
    are UNVERIFIED by me. The "registry cost about 10.46" and Verisign 2026-11-01 step are outside this lens and were not checked.

11. **Termination and suspension rights: 30-day no-cause termination; may suspend all Services on the Account over one domain; may terminate the
    entire account for repeated abuse; no refund for cause.** CONFIRMED verbatim in SERVICES PROVIDED AT WILL. Add: (a) NameSilo may cause-terminate
    for "abuse of the Services" and "payment irregularities" (undefined), (b) the "prohibited domain names" list includes "Domains and web sites
    involved in unauthorized repetitive, high volume inquires into any of the services provided by us or a third-party", (c) after non-cause
    termination the customer must transfer within 30 days "or risk that we may delete your domain name, transfer the registration services ... to
    ourselves or a third party", pro-rata refund only.

12. **Unilateral changes: fee changes need only "reasonable efforts" at 30 days' notice; agreement changes bind 30 days after notification.** CONFIRMED
    (FEES; CHANGES TO THIS AGREEMENT; exclusive remedy is to transfer or cancel). Worse for the Discount Program funds: Account Funding T&Cs say "We
    reserve the right to change the terms of this agreement in our sole discretion by updating this document at any time. We may or may not notify you
    of any such changes" and "We reserve the right to suspend or cancel your use of this program at any time without cause."

13. **Chargeback clause lets NameSilo suspend all accounts and domains, cancel orders without refund, charge a reinstatement fee.** CONFIRMED
    (PAYMENT ISSUES: "we may suspend access to any and all Accounts you have with us and all interests in and use of any domain name registration
    services"; reinstatement "solely at our discretion" and subject to "our then-current reinstatement fee").

14. **Batch-API policy: /api for human-triggered calls, /apibatch for automated calls; monitored signals include repeated same-domain calls and a
    high ratio of unsuccessful responses; suspension risk.** CONFIRMED verbatim. Two details for the legal lens: the article says executing batch
    calls in the standard API "violates our terms of service" and "will in all likelihood result in API and/or account suspension", yet the public
    Registration Agreement contains no API clause, so the governing text is either the unread reseller terms or unwritten. The article's own definition
    ("Standard Use ... any API call that was directly triggered by a human action"; "Batch ... software programs make automated and often times
    repetitive API calls") puts Mosshatch's cron polling and agent-initiated availability checks in /apibatch and leaves human-approved purchases
    arguably in /api; the classification of agent-driven traffic is still an open question for NameSilo to answer in writing. Positive signal not in the
    dossier: NameSilo advertises an MCP server "empowering AI agents" (mcp.namesilo.com, JSON-RPC over HTTPS, `X-API-KEY` header), so AI-agent use is
    an intended audience, though the page contains no terms.

15. **API is per-account and not available to sub-accounts.** CONFIRMED (response code 112 "API not available to Sub-Accounts" in the bundle
    chunk; Sub-Account Manager article: sub-users log in "as though they are logged into your account"; Terms make the account holder "entirely
    responsible for any changes requested or made by any Sub-Users"). So there is no contractual or technical way to isolate end customers into
    separate sub-accounts for API use.

16. **NameSilo will contact "the registrant and/or account holder" with a 72-hour response window on abuse reports.** CONFIRMED verbatim
    (Abuse Reporting Procedures). Adjacent Terms duties the analyst did not list: replies to WHOIS-privacy infringement notices within 3 days or
    NameSilo may "immediately release your contact information"; failure to answer accuracy inquiries for over 3 calendar days is "an incurable
    material breach"; "You are responsible for regularly monitoring email sent to the email address in your Account".

17. **Legal process: NameSilo complies with court orders and UDRP decisions; "It is not our responsibility to forward court orders or other
    communications to you"; non-public RDAP data only via form with 48h acknowledgement / 30-day decision.** CONFIRMED (Terms NOT INCLUDED...;
    `/support/rdap`: "acknowledge receipt of your request within 48 hours and provide a final response (approval or denial) within 30 calendar days").

18. **Unresponsive-reseller procedure: NameSilo "may work with you to transfer the domain to an account you control" after government ID matching WHOIS;
    no involvement in reseller payment disputes.** CONFIRMED with a reading correction. "You" is the complaining end customer, not the reseller.
    The path: customer emails reseller and NameSilo; after 72 hours of reseller silence the customer forwards it as "Reseller Problem"; NameSilo
    tries to contact the reseller; if unanswered or unwilling, NameSilo "may work with" the customer, who must create an account and supply "a valid
    government-issued identification card matching the name found in WHOIS for the domain". NameSilo "will not make any changes to domains during the
    process" and "will not vary from the steps". Practical effect: Mosshatch has a de facto 72-hour customer-support SLA and the procedure only works
    for customers who appear in WHOIS (not if privacy hides them or Mosshatch is the registrant).

19. **Change of Registrant: NameSilo acts as Designated Agent, auto-approves changes, opts out of the 60-day lock, users cannot opt out.** CONFIRMED
    (Terms AGENTS AND LICENSES; Change of Registrant article "No, you cannot"). Mosshatch must add its own approval and lock for registrant changes.

20. **ICANN-mandated notices go through NameSilo's system, private-labelled via Reseller Manager; registrant email verification within 15 days else
    clientHold.** CONFIRMED (WHOIS Email Verification: "our system will send private-labeled notifications to your customers with links referencing the
    generic web site with no mention of NameSilo"; 15 days; reminders every 4 days to the registrant and "if the Registrant email address does not
    match the email address of the account holder, then the account holder will receive a reminder every 3 days"). FAQ limit also confirmed: "there is no
    method for entirely hiding ourselves as the underlying registrar"; WDRP and WHOIS must show the registrar. Combined with RAA 3.12.1 this is consistent
    with the Gandi verifier's point that Mosshatch must not present itself as ICANN-accredited unless it is (the brief calls Mosshatch "a domain registrar").

21. **Restoration/redemption fee is not published.** CONFIRMED, with an internal inconsistency the analyst did not note. The Expiration Process page
    says only "you can restore ... for a restoration fee ... may or may not include a renewal year" with no amount, while the Terms say "You can find
    our restoration/redemption pricing and our schedule ... on our expiration process page". The Terms also make the reactivation period and RGP
    participation discretionary ("We may, in our sole discretion, choose not to offer a reactivation period"; "choose not to participate in the RGP
    process"), and let NameSilo auction expired names; the support-page timeline (auction days 31-40) is policy, not a contractual promise.
    RAA 3.7.5.6 (fee for RGP recovery to be stated on a registrar's registration/renewal website) text confirmed in raa.txt; whether it binds a
    reseller's storefront is NameSilo's/ICANN's call and was not resolved here.

22. **Liability capped at $200.** CORRECTED. Verbatim: "IN NO EVENT SHALL OUR MAXIMUM AGGREGATE LIABILITY EXCEED THE TOTAL AMOUNT PAID BY YOU FOR SERVICES,
    AND IN NO EVENT SHALL OUR LIABILITY BE GREATER THAN $200.00", i.e. the lesser of fees paid and $200. Also confirmed: DNS "absolutely no guarantee",
    DNSOwl.com third-party DNS with an indemnity running to DNSOwl.com, and a broad indemnity covering ICANN, registry operators and NameSilo
    for third-party claims "including ... use of the Services ... by anyone else using the Services" (so Mosshatch indemnifies for its customers'
    domains). Not in the dossier: NameSilo may demand "written assurances ... the posting of a performance bond(s) or other guarantees"; failing to
    provide them can cost "your right to control the disposition of domain name Services"; and a $100/hour administrative fee plus attorneys' fees if
    Mosshatch alleges unauthorized account access.

23. **"Funding needs a stored verified card, no auto top-up documented."** REFUTED (auto top-up half). The Account Funds Manager article lists
    "Automatic Replenishment ... set your minimum threshold and replenishment amount, and once your balance goes below your threshold we will
    automatically add funds to your account!", and the Account Funding T&Cs say "You will be able to set the minimum threshold, the replenishment
    amount and the credit card to use ... We make no warranties or assurances that replenishment transactions will always succeed". Whether it is
    configurable through the API (vs UI only) is unverified. The analyst's copy of that article was a Cloudflare challenge page, so it was never read.
    Terms of the funds themselves (new): refunds of the balance only if the last funds purchase was more than 60 days ago; full balance only;
    returned to original payment method "in reverse order"; "3.4 - 4% fee for all refund transactions" per transaction; NameSilo may "withhold up to the
    full amount" if it doubts the funding source; no interest accrues for the customer; crypto funding non-refundable; NameSilo may suspend or cancel
    the funds program "at any time without cause". A balance held at NameSilo is unsecured credit exposure with a 60-day exit.

24. **Data-handling terms.** NOT COVERED by the dossier (no hits for GDPR, DPA, Privacy Shield, consent). Findings: (a) OWNERSHIP OF INFORMATION AND DATA:
    "We own ... the name, postal address, e-mail address, voice telephone number ... of the registrant and all contacts" for registrations we sponsor;
    (b) SHARING OF WHOIS INFORMATION: NameSilo may make the data available "for targeted marketing and other purposes as required or permitted by
    applicable laws, including by way of bulk WHOIS data access provided to third parties" and the registrant "irrevocably waive[s] any and all
    claims"; (c) two consent duties: "If ... you provide information about or on behalf of a third party, you represent and warrant that you have
    (a) provided notice ... and (b) obtained the third party's express written or verbal consent", and PRIVACY: "you hereby agree not to submit anybody
    else's personal information to us ... without first communicating your intended use ... along with our privacy policy and then obtaining their
    consent", so Mosshatch's checkout must present NameSilo's privacy policy; (d) the Privacy Policy cites only the EU-U.S. Privacy Shield (invalidated
    in 2020) and offers no DPA/SCCs; the "GDPR Policies" link on the Policies index points to `https://gdpr-info.eu` (third-party statute text), not
    a NameSilo DPA. (e) The Privacy Policy says NameSilo's WHOIS privacy service "is free and is enabled by default", but the `registerDomain`
    reference says "If not supplied, the domain will be registered without privacy" (`auto_renew` defaults on): policy and API disagree, so Mosshatch
    must send `private=1`, as the analyst says. That partly answers dossier unverified item 10 (UI default is asserted by the Privacy Policy; API
    default confirmed off). (f) The RDAP terms forbid "high volume, automated, electronic processes" and storing results (CONFIRMED as the analyst says),
    so status must come from registry RDAP, not rdap.namesilo.com.

25. **Registrar identity: NameSilo, LLC, IANA ID 1479, Accredited; RDAP server rdap.namesilo.com with `redacted` conformance.** CONFIRMED against
    IANA `registrar-ids.xml` (record updated 2025-02-27) and the RDAP sample (`rdapConformance` includes `redacted`; registrar entity publicId 1479).

26. **Sandbox is by request only ("please contact us and we will get right back to you with your sandbox API credentials"); code 116 "Invalid sandbox
    account".** CONFIRMED for the sentence and the code (API reference landing page; response-code chunk; MCP page "contact support for test
    credentials"). Turnaround and scope remain unverifiable; not re-probed (outside legal lens).

27. **Governing law Arizona, JAMS arbitration in Maricopa County; Terms undated.** CONFIRMED (GOVERNING LAW AND JURISDICTION FOR DISPUTES; no revision date
    in page text, in HTML metadata I could see, or in response headers, which were a Cloudflare 403 to curl). Note: third-party disputes about domain
    use go to the courts of the WHOIS registrant's domicile and where NameSilo is located.

28. **Items I did not re-verify (outside the legal lens or not reachable):** 2022 TIR v. Cloudflare/NameSilo suit and the HN comments (UNVERIFIABLE by me:
    no search budget, not opened); status.namesilo.com outage history (egress-blocked per analyst, not retried); .ai two-year minimum handling and
    $245 .ai transfer; DNSOwl propagation (third-party lego docs); registry cost figures.

## What the analyst's recommendation looks like after this pass

The FALLBACK (weak) recommendation still stands, but the reasons should be rebalanced: the resale-permission risk is lower than "unread contract"
suggests (public marketing and official modules invite exactly Mosshatch's model), while the **contract-and-money exposure is higher**: a single account
whose key is a full-credential, a 30-day-notice no-cause exit plus at-will rejection within 30 days of any renewal, unilateral change rights over both the
agreement and the funds program, a 60-day/3.4-4% exit on prepaid balances, DP discount clawback on withdrawal, indemnity plus possible performance-bond demand,
$200 liability cap, no DPA, and data-ownership language that conflicts with a privacy-first brand. Before adopting: obtain the in-account reseller terms
(create a throwaway account and accept them only with the owner's consent; not done here, that is an authenticated action), ask NameSilo in writing (support@namesilo.com)
whether DP prices apply to API orders, how agent-driven traffic is classified, whether Mosshatch may list the end customer as WHOIS registrant with NameSilo's Terms binding the customer through Mosshatch as agent, and whether auto-replenishment can be set via API.
