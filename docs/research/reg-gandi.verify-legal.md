# reg-gandi: LEGAL / PROGRAM verification notes

Verifier: adversarial, legal lens. Date: 2026-09-29. Everything below was re-fetched by me from primary sources into
`.../scratchpad/research/vgandi-legal/` (my own copies; I did not reuse the analyst's `gandi/` folder text).
Method: curl -sSL with browser UA via the pre-configured proxy; PDFs extracted with pypdf (crypto import blocked, same
technique the analyst used); Cloudflare-protected helpdesk pages via Playwright/Chromium (`/opt/pw-browsers`), which passed
the interstitial on its own. WebSearch budget was exhausted (200/200), so no searches were run. One egress rejection
(`rdap.nic.io:443`) appeared in a proxy notice during my first download command; it was not a request I made and I did not
retry or work around it.

## Bottom line

Resale by an independent company, under its own brand and checkout, ordering through the API, is expressly authorised by
Gandi's own paper and marketing. I found no "own use only" API clause, no resale prohibition, no approval gate, no minimum
deposit, no volume commitment. The analyst's headline legal conclusion (permitted, not a blocker, FALLBACK on price/engineering)
holds. I found 3 places where the analyst was wrong or loose and about a dozen clauses they missed. The most consequential
misses: (1) Reseller Art. 4.2 forbids using the domain as collection leverage and requires honoring customer rights even on
non-payment; (2) MSA Art. 12.2 makes contracting "in the name and on behalf of third parties without authorization or mandate"
an immediate-termination material breach, which is directly relevant to agent-initiated purchases; (3) Art. 7 + Art. 9 + RAA
3.12.1 bar Mosshatch from presenting itself as a registrar, while the project brief calls Mosshatch "a domain registrar";
(4) the US paper is a three-document, two-law split, not a two-document conflict.

## Documents opened (all HTTP 200, 2026-09-29)

| Doc | URL | sha256 (first 16) |
|---|---|---|
| Reseller Agreement intl v2020.1.1 (Gandi SAS, French law) | https://contract.gandi.net/v5/contracts/50047/Reseller_SAS_2020.1.1_en.pdf | 84f12405916b600d |
| Reseller Agreement en-GB v2020.1 (Gandi International, Luxembourg) | https://contract.gandi.net/v5/contracts/42644/Reseller_Intl_2020.1_en.pdf | 768b043d0e29446c |
| Reseller Agreement US v2025.1 (Gandi US Inc.) | https://contract.gandi.net/v5/contracts/62158/Reseller_US_2025.1_en.pdf | c11c4baab401f7b1 |
| General Terms intl v2020.1.1 | https://contract.gandi.net/v5/contracts/50035/MSA_SAS_2020.1.1_en.pdf | ac3e1d375207983c |
| General Terms US v2025.1 | https://contract.gandi.net/v5/contracts/62153/MSA_US_2025.1_en.pdf | 41649c324ab14d8c |
| Domain registration contract intl v2024.1 | https://contract.gandi.net/v5/contracts/61283/DomainNameConditions_SAS_2024.1_en.pdf | 9d1f514549a0361a |
| Domain registration contract US v2024.1 (analyst listed, never read) | https://contract.gandi.net/v5/contracts/61286/DomainNameConditions_US_2024.1_en.pdf | (fetched) |
| DPA v2023.0 | https://contract.gandi.net/v5/contracts/53949/DPA_2023.0_en.pdf | e15551fdea1b246a |
| .ai special conditions v3.0 (15 Jan 2025) | https://contract.gandi.net/v5/contracts/61431/special_conditions_AI_3.0.pdf | (fetched) |
| .io v1.5 (9 Nov 2023), .com v2.3 (11 May 2020), .dev v1.0, .app v1.0, .studio (DOGBEACH v2.4) | contracts 55468, 42926, 35760, 34426, 59458 | (fetched) |
| Website Terms of Use | https://www.gandi.net/en/contracts/terms-of-use | n/a |
| Contracts index (default, en-US, en-GB) | https://www.gandi.net/en/contracts/terms-of-service, /en-US/..., /en-GB/... | n/a |

The contracts index (fetched today) lists 50047 (default), 62158 (US) and 42644 (en-GB) as "Current version", so these are the live papers.
I diffed the three Reseller Agreements sentence by sentence: they are textually identical except counterparty, "Gandi US Inc./Gandi International
acts as a reseller of Gandi SAS" sentence, governing law and forum. I diffed the two General Terms and the two Domain contracts likewise.

Web pages: docs.gandi.net reseller section (index, getting_started, reseller_pricing, reseller_vs_organization, benefits/index, use_cases, api,
faq, reseller_contract, reseller_disputes, reseller_billing), docs.gandi.net/en/billing/price_rates, www.gandi.net/en/reseller, per-TLD price pages
(A and E grids for all six TLDs) and TLD list page, api.gandi.net/docs (domains, organization, reference, authentication, billing), ICANN 2013 RAA,
ICANN Transfer Policy, IANA registrar-ids.xml, helpdesk articles 18536928521244 and 14001695744668 (Playwright), Your.Online press release,
Domain Name Wire 2023-03-02, Gandi About page, Wikipedia.

## Claim-by-claim verdicts

1. **Independent company may resell under own brand/price via API** - CONFIRMED. Reseller Agreement Preamble ("any legal entity that
   registers and manages domain names on behalf of its own customers"), Art. 3.1, 3.3 (API "for order management"), Art. 9 ("propose Your own
   interface to Your clients"), MSA Art. 3.1/19 (contemplates "any other person to whom You resell Our Services"). Marketing page
   https://www.gandi.net/en/reseller: "A comprehensive API for implementation under your own brand" and "Our API lets you completely and
   transparently integrate with Gandi's services, fully customized, on your own platform". docs use_cases.html: "Reseller Mode with API
   Integration ... Customers interact with the reseller's platform, not with Gandi itself." The analyst missed use_cases and the landing-page
   "own brand" text; both are the strongest program-level evidence.
2. **Quotes Art. 3.1, 3.3, 4.2, 9** - CONFIRMED verbatim (Art. 3.1 "non-exclusive, revocable and non-transferable"; "sole point of contact ... sole management").
3. **Art. 7 "not as is / added value / disclose Gandi" caveat** - CONFIRMED text. Art. 7 is titled "Resale Conditions of Our Services to Your clients"
   and opens "By exception, You are authorized to resell Your Reseller services, provided that: [not] as is ... own added value; You inform Your
   customers that You use Gandi Services and You don't act as an accredited Registrar; customers accept Our Contracts". Given the title, I would not
   call it merely ambiguous: treat it as a binding condition on Mosshatch's offer to its own customers. A bare "buy a domain" storefront is the risk
   case; a bundled product (DNS wiring, vault, agents) is the mitigation. Counsel should confirm.
4. **Registrant of record is the end customer** - CONFIRMED (Art. 3.1 "declared as the owner as soon as ... registered"; Art. 4.2 "register each of Your customers as the owner";
   Organization API "the product is not legally owned by the organization, but by the organization's customers"; docs vs_org: "Clients do not have an account with Gandi").
5. **Formal program, free, self-service, irreversible, legal person, individuals cannot convert** - CONFIRMED. Getting-started steps and "permanent and cannot be reversed";
   Preamble "be a legal person and be able to justify it on first request"; FAQ "restricted to organizations". API: PATCH organization `reseller` "cannot be set to false".
   Practical precondition the analyst did not spell out: Mosshatch needs an incorporated entity before it can convert.
6. **No approval step, minimum deposit or volume commitment documented** - CONFIRMED as to published paper (reseller page: "free and without commitment"; nothing in
   Agreement/docs). Caveat: MSA Art. 3.4 gives Gandi an audit right ("incorporation certificate, power of attorney ... proof of Your ability or quality to contract"), and
   Reseller Art. 4.1 obliges a "declaration of conformity" on request. Whether onboarding involves manual review remains unobservable without signing up.
7. **Prepaid (Art. 4.1), org-specific prepaid account, unfunded orders pending max 2 months** - CONFIRMED (Reseller Art. 4.1; MSA Schedule 1 Art. 2, Art. 4). Added: balance is
   refundable on 7 business days' notice (once a month free, else EUR 15 fee), Schedule 1 Art. 6; Gandi can disable the org if a top-up is reversed and the balance cannot cover it (Art. 3.3.3).
8. **"Gandi will not reimburse prepaid services if the customer does not pay (Art. 8)"** - CORRECTED. Art. 8 opens "Unless otherwise expressly validated by Our customer service
   department", so a written exception is possible (negotiable). It also promises reimbursement "for any operation that could not be completed, provided that this operation can still
   be cancelled and reimbursed by the Registry". FAQ separately: auto-renewal "cannot be refunded. The risk of non-payment must be borne by the reseller".
9. **"Reseller may leave anytime (one month notice by letter)"** - CORRECTED. Art. 11.1: by request "subject to acceptance by Gandi", or registered letter with one month's prior notice.
   Exit also carries duties (11.3): on ceasing activity "seek a buyer" for the domains, and obtain customers' "express and written agreement" before management is handed to Gandi.
10. **Suspension/termination: 15-day cure; serious breaches without notice incl. many customer complaints; Art. 12 domain interventions** - CONFIRMED (Art. 11.2.1 bullet list; Art. 12 five bullets incl. rejected payment, disputes).
    Also Art. 6: Gandi may contact your clients after 48h of your silence and "propose to the client to dissociate the domain name(s) from Your Reseller Organization".
11. **On default termination Gandi takes over customers; domains stay with customers** - CONFIRMED (Art. 11.3; FAQ "ownership of the domains would remain with the customers").
12. **Unilateral change (MSA Art. 23), assignment (Art. 24)** - CONFIRMED, with nuance: Art. 23 states purposes ("legal or technical evolution or any evolution of service providers fees");
    new versions "may also come into force during the course of a Service Agreement and will be notified to You when You log in to Our Website" (an API-only integrator may never log in);
    remedy is termination. Art. 24: Gandi may assign to any entity, you may not without written consent.
13. **Insurance certification (MSA Art. 20)** - CONFIRMED (both intl and US; identical text). Applies to every Gandi customer, not only resellers.
14. **Three counterparties; US paper internally inconsistent** - CORRECTED (understated). Counterparties confirmed: Gandi SAS/French law/Paris courts; Gandi International (Bertrange, LU)/Luxembourg law/Luxembourg courts;
    Gandi US Inc. (c/o ORCOM US, 600 California St, San Francisco). In the US stack there are three documents and two laws: Reseller Agreement Art. 17.1 French law with venue at "Gandi US Inc.'s registered office";
    General Terms Art. 27.1 California law with exclusive California courts; Domain registration contract US (never read by the analyst) Art. 17 California law/California courts.
    Reseller Agreement prevails over the General Terms (Art. 1.2). Mosshatch would be bound under French law while its own customers (registrants) are bound to a California-law domain contract.
    US and LU papers state the counterparty is itself "a reseller of ... Gandi SAS", so Mosshatch would be a second-tier reseller in those regions.
15. **Gandi emails registrants directly (expiry notices, 15-day reachability)** - CONFIRMED (Reseller Art. 6; Domain contract Art. 5.1 and Appendix 1 Art. 3; docs getting_started "customer will have to click in an email sent to their personal address").
16. **ICANN flow-downs (Art. 4.2, 4.3.2; RAA 3.12.2)** - CONFIRMED, one wording fix. RAA 3.12.2 quote is accurate. RAA 3.7.5.6 says a registrar "should" state the redemption fee, not "must"; the binding
    obligation on Mosshatch comes from Reseller Art. 4.3.2 (publish renewal, late-renewal and restoration rates and the expiry-notification terms). RAA 3.12 intro makes Gandi responsible for resellers' compliance (hence the strictness); 1.24 defines "Reseller" broadly.
17. **Docs: "Resellers are free to charge their customers any price"; API "free from any Gandi labelling"** - CONFIRMED verbatim (reseller_pricing.html; reseller_vs_organization.html).
18. **API reseller purchase route; ownership statement** - CONFIRMED (api.gandi.net/docs/domains: "Special case - buy a domain as a reseller organization ... sharing_id=<reseller-id>"; adds "The invoice will be edited with the reseller organization's information";
    api/organization: "not legally owned by the organization, but by the organization's customers").
19. **Grid A-E thresholds and reset** - CONFIRMED (A $0-599, B $600-1,999, C $2,000-5,999, D $6,000-11,999, E $12,000+; reset every 1 January; loyalty at EUR 2,500 for two consecutive years).
    Gandi's own docs conflict: Billing API `annual_balance` is "purchased over the past 12 months since the request" (rolling). Docs also mention Corporate Services customers have "their own price rate".
20. **Six-TLD prices (A and E)** - CONFIRMED by re-fetch of all 12 pages: .com reg 11.00/11.00, renew 38.38/29.39, restore 55.00/55.00; .ai reg 112.06/84.74 per yr (2-10 yrs), renew 179.76/118.64 "For 2 to 9 years", transfer 181.47/160.77, restore 191.82/167.67;
    .dev reg 16.39 (promo 9.99)/12.39, renew 39.98/30.79, restore 113.96/75.90; .io reg 60.00 (promo 31.99)/58.00, renew 74.99/71.99, transfer 54.00, restore 120.00; .app reg 23.29/14.95 (promo 9.99), renew 47.98/37.79, restore 113.96/78.34;
    .studio reg 38.36/24.64 (promo 14.99), renew 87.98/72.79, restore 114.21/73.45.
21. **No published wholesale list; new reseller pays public grid A** - CONFIRMED: reseller_pricing.html sends resellers to the public Price Rates page; price_rates: "New accounts ... have A rates by default". "Temporarily lower your rate" for a sales push is in benefits/index.html.
22. **Price-page footer reservation and stale "$8.80"** - CONFIRMED, location corrected: both sentences are on the TLD list page (`/en-US/domain/tld?prefix=c`), not the per-TLD page ("Gandi reserves the right to change its domain name prices in response to strong variations of domain cost or exchange rate"; "example: $8.80 per year for a .com at E rate"). The Domain contract Art. 14 also says tariffs "are subject to change".
23. **Acquired Feb 2023 by Total Webhosting Solutions (Your.Online)** - CONFIRMED with framing note. Your.Online press release dated 10.02.2023: Gandi SAS and TWS "announced their merger and the creation of Your.Online"; Montefiore sold its stake (Wikipedia citing McDermott). Domain Name Wire (2 Mar 2023) headlines it an acquisition but quotes "officially ... merged".
24. **Gandi SAS IANA ID 81, Accredited** - CONFIRMED (registrar-ids.xml, record updated 2019-05-28; file updated 2026-09-23). No separate Gandi US/LU accreditation in the list.
25. **DPA: Gandi as processor, covers reseller contract** - CONFIRMED (DPA preamble lists "The reseller contract"; Art. 2.1). Not stated by the analyst: the reseller is the controller (Art. 2.2) and carries the duties in Art. 6.2-6.4 (inform data subjects, answer DSARs, notify its own authority of breaches). Data goes to ICANN, an escrow agent and registries outside the EU under SCCs/Art. 49(1)(b) (Art. 3.3, 5.4). None of .com/.ai/.io/.dev/.app/.studio appears in the sub-processor appendix.
26. **.ai lifecycle/transfer ambiguities** - CORRECTED (resolved by the binding contract). .ai special conditions v3.0: transfer "the registration period is extended by two years"; expiry hold is 45 days with late renewal at normal price, then 30-day redemption. So "treat 30 days as the safe bound" and "transfer term unresolved (1 vs 2 years)" should be replaced by 45 days and 2 years (the docs deadlines page/transfer table are the outliers). .com/.io/.studio special conditions agree with the analyst (+1 year on transfer; 45-day hold + 30-day redemption).
27. **72-hour unlock delay unless TOTP** - CONFIRMED text (helpdesk 18536928521244, read via Chromium, "Updated 1 year ago"). Applicability to API/PAT remains UNVERIFIED. Legal context the analyst omitted: ICANN Transfer Policy I.A.5.2 allows 5 calendar days to provide AuthInfo, and I.A.5.3 forbids unlock/AuthInfo mechanisms "more restrictive than" changing contact or nameserver data.
28. **Reseller FAQ statements** (legal@gandi.net desk, abuse desk, ".com registrations can be canceled up to day 5", non-payment "borne by the reseller", classic API 30 requests/2s, termination outcome) - CONFIRMED verbatim.
29. **Rate limit 1000 req/min/IP** - CONFIRMED (api.gandi.net/docs/reference/).
30. **Outbound transfer of reseller domains** - CONFIRMED (helpdesk 14001695744668: contact the reseller; owner FOA from `...-transfer-out@gandi.net`; auto-accepted after 5 full days, 8 for .fr; reseller can "release" the domain).
31. **Sandbox limited to .com/.net/.org/.fr, no idempotency, no webhooks, 1-name check, etc.** - UNVERIFIABLE by me: outside the legal lens, not re-checked.
32. **"None of these is a legal blocker"** - CONFIRMED, with conditions: incorporated entity; Art. 7 added-value and disclosure; not presenting as registrar; flow-down contracts; insurance; prepaid funding; abuse/legal desk process; counsel review of the US/LU/FR split.

## Missed by the analyst (details)

- Reseller Art. 4.2: reseller must respect owners' rights "even in the event of non-payment by your customers" and must not "solicit Our intervention to put pressure on Your customer via the domain name(s)". Consistent with ICANN Transfer Policy 3.9.1/3.10 (transfer may not be blocked for non-payment of future periods or used to secure payment). Mosshatch's dunning cannot rely on locking or suspending domains; its brief's transfer-out "cooling-off" must stay inside ICANN's 5-day AuthInfo rule and Gandi's Art. 4.2.
- MSA Art. 12.2: "conclusion of a Service Agreement in the name and on behalf of third parties without authorization or mandate" is a material breach permitting immediate termination without notice; Reseller Art. 4.2 requires written proof of authority "upon first request". Agent-initiated purchases therefore need an auditable human approval record per order (the brief's passkey approval log can serve).
- MSA Art. 11: Gandi may "withdraw or cease providing a Service at any time for any reason whatsoever" (best-effort six months' notice on withdrawal from sale); Reseller Art. 3.1 says the right is "revocable"; also "non-transferable", so Mosshatch cannot assign the reseller position or customer base in an exit without Gandi's written consent (Art. 24).
- Liability asymmetry: Gandi's liability is capped at amounts paid for the unavailable service and excludes indirect loss (MSA Art. 16; Domain contract Art. 12), while Mosshatch indemnifies Gandi, registries and their officers without a stated cap (Reseller Art. 5; MSA Art. 17), and registrants indemnify the registry, Identity Digital and Gandi within 30 days of demand (.ai, .studio special conditions).
- Branding: Art. 9 allows the "Gandi" mark only to communicate about its services, revocable at any time, and forbids claiming registrar status; RAA 3.12.1-3.12.3 (no ICANN logo, no representation as accredited, identify the sponsoring registrar on inquiry). The project brief describes Mosshatch as "a domain registrar"; customer-facing copy must say domains are registered through Gandi SAS, an ICANN-accredited registrar.
- Flow-down deliverables: Domain contract preamble obliges the reseller to give each owner "a copy of the Agreement"; Art. 4.2 requires inserting Annex 1 obligations into the reseller's own contracts; Art. 4.3.2 requires publishing renewal/late-renewal/restoration prices, expiry-notification terms and two ICANN links; Reseller Art. 14 requires informing customers of data collection and Whois publication and warrants their consent.
- Website Terms of Use s.4: "mass and/or automated queries sent to our Whois database" are forbidden; use `/v5/domain/check`, never whois.gandi.net, for availability. s.3 restricts redistribution of data "communicated as part of the use of our services" (wording garbled; low risk for own-price display).
- Per-TLD special conditions (analyst listed the index, opened none): all six read; no resale restriction; all reserve registry sole-discretion rights to deny, cancel, suspend or transfer; .ai and .io are "open to anyone"; .io registry is Internet Computer Bureau Ltd with Identity Digital as technical operator (v1.5 dates from Nov 2023 and has no retirement clause).
- Notice mechanics and language: contract changes are "notified when You log in"; French versions prevail (MSA Art. 26.3, Domain contract Art. 16; en-GB Reseller says both authentic but French prevails).
- Not resolved: ICANN compliance history of Gandi SAS (ICANN notices URL returned 404; no search budget left); whether Gandi SAS holds a direct written agreement with a US/LU second-tier reseller.
