# ICANN Transfer Policy for a reseller-run registrar (Mosshatch), status as of 2026-09-29

Research only. All sources accessed 2026-09-29 (fetched live with curl through the agent proxy; raw copies in `working-directory/research/icann_raw/`). Nothing under /home/user/MossHatch was modified.

## TL;DR

1. **In force today (gTLDs .com .dev .app .studio):** Transfer Policy as updated 21 Feb 2024 (mandatory since 21 Aug 2025): "AuthInfo" code, Losing FOA within 24 h, 5-calendar-day auto-approve, 60-day post-creation/post-transfer denial, mandatory 60-day Change-of-Registrant lock (opt-out only if the registrar offers it). Gaining FOA is in the text but enforcement is Board-deferred since 2020.
2. **Adopted, NOT in force:** Transfer Policy Review (47 recs: TAC, no Gaining FOA, 720-hour locks, CoR lock removed). Board adopted 7 Jun 2026 (Res. 2026.06.07.04); ICANN lists it "In Queue"; no IRT, policy text or effective date announced as of 2026-09-29.
3. **Planning bound:** WG recommended an 18-month implementation window; ICANN practice is at least 6 months notice after announcement, so nothing new is enforceable before roughly Mar 2027, and 2028 is likelier (derived, not an ICANN statement).
4. **Future TAC rules (WG text):** RoR generates only on RNH request, RFC 9154 (128-bit), 336 h (14 d) TTL registry-enforced, issued within 120 h max, notice within 10 min, one-time use; 720 h (30 d) mandatory locks; CoR confirmations and lock removed.
5. **Blogs saying TAC "took effect 19 Nov 2024" conflict with ICANN's own pages; treated as wrong.** Build to today's policy; hold the future numbers as config.
6. **UI may promise:** up to 5 calendar days pending (.com RA App.7), code within 5 days by law (minutes by design), .com transfer adds 1 year (max 10). Never "instant"; no primary source for a "typical" duration.
7. **.ai and .io are ccTLDs:** ICANN "does not accredit registrars or set registration policies for ccTLDs"; use per-TLD rules (.ai +2 years, .io needs 60-day-old domain; registrar KBs).
8. **Reseller:** the sponsoring registrar stays responsible (RAA 3.12); Mosshatch's agreement must carry ICANN-required terms and name that registrar.
9. **Counsel flag:** Policy I.A.5.3 bars an unlock/auth-code mechanism "more restrictive than the mechanisms used for changing any aspect of the Registered Name Holder's contact or name server information": passkey-gate contact/NS edits too.

---

## 1. Status board (what is in force, what is adopted, what is pending)

| Item | Status on 2026-09-29 | Evidence (URL; accessed 2026-09-29) | Quote |
|---|---|---|---|
| Transfer Policy (in force) | Version "Updated 21 February 2024"; implement-by 21 Aug 2025, so mandatory now. Prior version "Effective 1 December 2016 through 20 August 2025". | https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers/policy ; https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers | "Updated 21 February 2024 to reflect changes required to implement the Registration Data Policy. Contracted parties may implement this updated Policy beginning on 21 August 2024 and must implement no later than 21 August 2025." / "Transfer Policy (Effective 1 December 2016 through 20 August 2025)" |
| What the 2024 update changed | Terminology/data-model only (Administrative Contact removed, "Transfer Contact" -> Registered Name Holder, Whois -> Registration Data). No TAC, no FOA removal. | https://itp.cdn.icann.org/en/files/consensus-policy/transfer-policy-redline-21feb24-en.pdf | Redline strikes the Administrative Contact and "Transfer Contact" wording; clean 2024 text of I.A.1.1 reads "The Registered Name Holder is the only party that has the authority to approve or deny a transfer request to the Gaining Registrar." |
| Registration Data Policy | Effective 21 Aug 2025 | https://www.icann.org/en/contracted-parties/consensus-policies | "Registration Data Policy (effective 21 August 2025, adopted by ICANN Board 15 May 2019; implementation documents posted 21 February 2024" |
| Gaining FOA enforcement | Deferred by Board since 26 Jan 2020; banner still on ICANN pages today | https://www.icann.org/en/board-activities-and-meetings/materials/approved-resolutions-open-session-of-board-workshop-los-angeles-regular-meeting-of-the-icann-board-26-01-2020-en ; https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers | "Resolved (2020.01.26.02), the Board accepts the GNSO Council request and directs ICANN's President and CEO, or his designee(s), to defer compliance enforcement of the Transfer Policy's Gaining Registrar FOA requirement until the matter is settled in the GNSO Council's planned Transfer Policy review." |
| TPR PDP Final Report | 47 recommendations, full consensus 31 Jan 2025, submitted 5 Feb 2025 (report dated 4 Feb 2025) | https://gnso.icann.org/sites/default/files/policy/2025/correspondence/tpr-team-to-gnso-council-04feb25-en.pdf ; https://gnso.icann.org/en/council/resolutions/2020-current | "On 31 January 2025, the Transfer Policy Review Working Group reached Full Consensus on all of the forty-seven (47) final policy recommendations" |
| GNSO Council approval | 12 Mar 2025, unanimous (motion 20250312-3); requested an IRT | https://gnso.icann.org/en/council/resolutions/2020-current | "The GNSO Council approves, and recommends that the ICANN Board adopt, all forty-seven (47) final recommendations" / "requests that ICANN org convene an Implementation Review Team (IRT)" |
| Board public comment | 28 Apr - 16 Jun 2025; 11 submissions; summary 2 Jul 2025 | https://www.icann.org/en/public-comment/proceeding/transfer-policy-review-working-group-final-report-for-icann-board-consideration-28-04-2025 | "The Public Comment proceeding was open from 28 April to 16 June 2025. The ICANN Board received a total of 11 submissions" |
| Board adoption | **7 Jun 2026, Resolution 2026.06.07.04** | https://www.icann.org/en/board-activities-and-meetings/materials/approved-resolutions-regular-meeting-of-the-icann-board-07-06-2026-en | "Resolved (2026.06.07.04), the Board adopts the Recommendations, and directs ICANN's President and CEO, or his designee(s), subject to prioritization, to implement the Recommendations, taking into account the ICANN org Feasibility Assessment and any additional operational, technical, legal, security, or resource considerations identified during implementation." |
| ICANN announcement of adoption | Chair's Blog 24 Jun 2026 | https://www.icann.org/en/blogs/details/chairs-blog-recap-of-the-june-board-workshop-and-icann86-24-06-2026-en | "the Board adopted the Generic Names Supporting Organization's (GNSO) Transfer Policy Review Policy Development Process (PDP) recommendations, which aim to provide increased security and other benefits for domain name registrants." |
| Implementation status | "Implementation Projects In Queue" (not "In Progress"; no expected completion date listed) | https://www.icann.org/policy/implementation | Listed under the heading "Implementation Projects In Queue" (separate from "Implementation Projects In Progress"): ccPDP3 Policy Implementation; EPDP Phase 2A on the Temporary Specification for gTLD Registration Data; GNSO Internationalized Domain Names EPDP Phase 2; "Transfer Policy Review"; Translation and Transliteration of Contact Information |
| GNSO Council project list (10 Sep 2026) | Phase "7 - Implementation"; "ICANN org has begun planning"; wiki space "TBD" | https://icann-community.atlassian.net/wiki/download/attachments/111086692/GNSO_Council_Project-List_20260910.pdf | "Following Board adoption of the Working Group's Final Report, ICANN org has begun planning for policy implementation." ... "Wiki Space (TBD)" |
| Public IRT wiki | None found (Confluence REST search of space titles 2026-09-29: no Transfer Policy IRT space; latest TPR space is the PDP space) | https://icann-community.atlassian.net/wiki/rest/api/search?cql=type%3Dspace%20AND%20title~%22Transfer%22 | (absence) |
| ICANN announcements list | No Transfer Policy item between 5 Jan and 22 Sep 2026 (8 pages scanned) | https://www.icann.org/en/announcements | (absence) |
| Recommended implementation window | 18 months (WG); ICANN org: "significant and extensive" | https://gnso.icann.org/sites/default/files/policy/2025/draft/gnso-council-recommendations-report-to-icann-board-tpr-wg-31mar25-en.pdf | "In recognition of the extensive changes to the Transfer Policy, an 18-month implementation window is recommended." / "ICANN org considers the scope of effort required for this implementation to be significant and extensive." |
| ICANN notice practice | Bundled effective dates; "window of at least six months" for contracted parties | https://www.icann.org/policy/implementation | "Policies within a bundle are announced together, which triggers a window of at least six months for contracted parties to update their operations to ensure compliance with the new policies." |
| Registrar-side view | Tucows/OpenSRS (ICANN86 recap): Board adoption "means that ICANN Org can now initiate the Implementation Review Team (IRT)"; "Over the coming months, we will participate in that IRT" | https://opensrs.com/blog/icann86-policy-recap/ | (secondary, dated June 2026) |

**Arithmetic bound (derived, not an ICANN statement):** because no implementation announcement exists yet and ICANN's stated practice is at least six months between announcement and effect, no new-policy requirement can be enforced before roughly late March 2027 at the earliest; with the WG's 18-month recommendation a 2028 date is more plausible. Treat as planning assumption only.

### Timeline

| Date | Event | Source |
|---|---|---|
| 12 Nov 2004 | Inter-Registrar Transfer Policy effective | https://www.icann.org/en/public-comment/proceeding/transfer-policy-review-working-group-final-report-for-icann-board-consideration-28-04-2025 ("went into effect on 12 November 2004") |
| 1 Jun 2012 - 31 Jan 2015 | Earlier policy version ("Inter-Registrar Transfer Policy (Effective 1 June 2012 through 31 January 2015)") | https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers |
| 31 Jan 2015 - 30 Nov 2016 | Earlier policy version ("Inter-Registrar Transfer Policy (Effective 31 January 2015 through 30 November 2016)"); renamed "Transfer Policy" in 2015 (Board resolution 7 Jun 2026: "renamed Transfer Policy in 2015") | same page; Board resolution |
| 1 Dec 2016 | IRTP Part C (Change of Registrant + 60-day lock) compliance date | https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers/policy ("All ICANN-accredited registrars are required to comply with policy by 1 December 2016.") |
| 25 May 2018 | Temporary Specification: Gaining FOA superseded where registrar cannot access registration data | Board res. 26 Jan 2020 rationale (URL above) |
| 26 Jan 2020 | Board defers Gaining FOA enforcement (2020.01.26.02) | above |
| 18 Feb 2021 | GNSO initiates Transfer Policy Review PDP | https://gnso.icann.org/en/group-activities/active/transfer-policy-review |
| 21 Jun 2022 / 1 Aug 2024 | Initial Reports (Phase 1(a); consolidated) | GNSO resolutions page |
| 21 Feb 2024 | Transfer Policy + TDRP + FOA forms republished for Registration Data Policy; implement 21 Aug 2024 - 21 Aug 2025 | policy page |
| 31 Jan / 4-5 Feb 2025 | WG full consensus; Final Report | GNSO Final Report |
| 12 Mar 2025 | GNSO Council unanimous approval (ICANN's May 2026 PRSP briefing says "13 March 2025"; Board resolution and GNSO resolutions page say 12 March, used here) | https://www.icann.org/en/system/files/files/prsp-pre-icann86-briefing-18may26-en.pdf |
| 10 Apr 2025 | Recommendations Report transmitted to Board | Board resolution |
| 21 Aug 2025 | Feb-2024 Transfer Policy and Registration Data Policy mandatory | policy page / consensus policies page |
| 25 May 2026 | GNSO groups write to Board complaining review "pending ... since April 2025" | https://itp.cdn.icann.org/en/files/correspondence/smigelski-et-al-to-sinha-25-05-2026-en.pdf |
| 7 Jun 2026 | **Board adopts all 47** | Board resolution |
| 10 Sep 2026 | GNSO project list: implementation phase, planning begun | project list PDF |
| 29 Sep 2026 | No effective date; ICANN page still shows Feb-2024 policy | policy page |

---

## 2. Conflicts between sources (reported, not resolved by guess)

| Claim | Source | Conflict / resolution |
|---|---|---|
| "The ICANN Transfer Policy that took effect on 19 November 2024 replaced the old static auth code with the Transfer Authorization Code" | https://seo.domains/seo-resources/transfer-process/epp-code-auth-code/ (marketplace blog) | Contradicted by ICANN policy page ("Updated 21 February 2024 ..."), Board resolution of 7 Jun 2026 (adoption only), and ICANN implementation queue. Treated as incorrect. |
| TAC "Valid for a reasonable time period (typically at least 30 days)" | https://www.namesilo.com/blog/en/domain-names/icann-transfer-policy-updates-tac-codes-losinggaining-notifications-and-what-changed (20 Nov 2025) | Contradicts WG Rec 9.1: "valid for 336 hours". Unreliable. |
| "as of September 2026 some already run the TAC model while others still offer the older always-available code" and "The policy ICANN lists as operative is the Transfer Policy updated on 21 February 2024" | https://snapshot.internetx.com/en/auth-code/ | Consistent with ICANN primary sources. Registrars may voluntarily adopt TAC behaviour early. |
| GNSO vote date 12 vs 13 March 2025 | Board resolution + GNSO resolutions (12 March) vs ICANN PRSP briefing (13 March) | Primary resolution text used: 12 March 2025. |
| ICANN's registrant page "Transferring Your Domain Name" still says "ICANN's Transfer Policy (Effective as of 1 December 2016)" and FAQ still refers to the Administrative Contact and Initial Authorization form | https://www.icann.org/resources/pages/transferring-your-domain-name-2017-10-10-en ; https://www.icann.org/resources/pages/name-holder-faqs-2017-10-10-en | Stale ICANN copy; the Feb 2024 policy text (above) governs. |

---

## 3. The policy in force now (Transfer Policy, updated 21 Feb 2024): critical rules, exact wording

Source for every row in this section: https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers/policy (accessed 2026-09-29; numbering as printed in the policy and cited by the WG, e.g. I.A.3.7.4).

### 3.1 Authority, authorization, FOA

| Ref | Exact wording | Notes |
|---|---|---|
| I.A.1 | "Registered Name Holders must be able to transfer their domain name registrations between Registrars provided that the Gaining Registrar's transfer process meets the minimum standards of this policy and that such transfer is not prohibited by ICANN or Registry policies." | The right to transfer out. |
| I.A.1.1 | "The Registered Name Holder is the only party that has the authority to approve or deny a transfer request to the Gaining Registrar." | An AI agent cannot be the approving party. |
| I.A.2.1 | "Obtain express authorization from the Registered Name Holder. Hence, a transfer may only proceed if confirmation of the transfer is received by the Gaining Registrar from the Registered Name Holder" | Gaining FOA text; enforcement deferred (2020.01.26.02). |
| I.A.2.1.1 | "Until such time as a secure method for transferring data is required by ICANN to be offered, if the Gaining Registrar is unable to gain access to then-current Registration Data for a domain name subject of a transfer, the Gaining Registrar is not required to obtain a Form of Authorization from the Registered Name Holder. Additionally, the Gaining Registrar must require the Registered Name Holder to independently re-enter Registration Data with the Gaining Registrar." | Explicit carve-out. |
| I.A.2.2.1 | "Transmission of a "transfer" command constitutes a representation on the part of the Gaining Registrar that the requisite authorization has been obtained from the Registered Name Holder where required pursuant to Section I.A.2." | Gaining side takes the legal risk when it sends the EPP transfer. |
| I.A.3.1 | "A Registrar of Record shall confirm the intent of the Registered Name Holder when a notice of a pending transfer is received from the Registry by notifying the Registered Name Holder of the transfer." | Losing-side confirmation (the "Losing FOA"). |
| I.A.3.3 | "...no Registrar shall add any additional information to the FOA used to obtain the consent of the Registered Name Holder in the case of a transfer request." and "This requirement does not preclude the Registrar of Record from marketing to its existing customers through separate communications." | Do not put creature flavour text or upsells inside the confirmation email. |
| I.A.3.3 | "The FOA shall be communicated in English" (other languages optional) | English mandatory. |
| I.A.3.4 | "The FOA should be sent by the Registrar of Record to the Registered Name Holder as soon as operationally possible, but must be sent not later than twenty-four (24) hours after receiving the transfer request from the Registry Operator." | 24 h. |
| I.A.3.5 | "Failure by the Registrar of Record to respond within five (5) calendar days to a notification from the Registry regarding a transfer request will result in a default "approval" of the transfer." | Auto-acknowledgement. |
| I.A.3.6 | "In the event that a Registered Name Holder listed in the RDDS has not confirmed their request to transfer with the Registrar of Record and the Registrar of Record has not explicitly denied the transfer request, the default action will be that the Registrar of Record must allow the transfer to proceed." | Silence = approve. |
| ICANN's form | Losing FOA template: "If you want to proceed with this transfer, you do not need to respond to this message. If you wish to cancel the transfer, please contact us before <insert date> by:" ... "If we do not hear from you by <insert date>, the transfer will proceed." Template names "<insert name of registrar and/or name of reseller>" | https://www.icann.org/en/contracted-parties/accredited-registrars/standardized-form-of-authorization-domain-name-transfer-confirmation-of-registrar-transfer-request-21-02-2024-en |

### 3.2 When a transfer may / must / must not be denied (current text)

| Ref | Exact wording |
|---|---|
| I.A.3.7 (lead-in) | "Upon denying a transfer request for any of the following reasons, the Registrar of Record must provide the Registered Name Holder and the potential Gaining Registrar with the reason for denial. The Registrar of Record may deny a transfer request only in the following specific instances:" |
| 3.7.1 | "Evidence of fraud." |
| 3.7.2 | "Reasonable dispute over the identity of the Registered Name Holder." |
| 3.7.3 | "No payment for previous registration period (including credit card charge-backs) if the domain name is past its expiration date or for previous or current registration periods if the domain name has not yet expired. In all such cases, however, the domain name must be put into "Registrar Hold" status by the Registrar of Record prior to the denial of transfer." |
| 3.7.4 | "Express objection to the transfer by the authorized Registered Name Holder. ... In all cases, the objection must be provided with the express and informed consent of the authorized Registered Name Holder on an opt-in basis and upon request by the authorized Registered Name Holder, the Registrar must remove the lock or provide a reasonably accessible method for the authorized Registered Name Holder to remove the lock within five (5) calendar days." |
| 3.7.5 | "The transfer was requested within 60 days of the creation date as shown in the registry RDDS record for the domain name." (a permitted reason, "may") |
| 3.7.6 | "A domain name is within 60 days (or a lesser period to be determined) after being transferred (apart from being transferred back to the original Registrar in cases where both Registrars so agree and/or where a decision in the dispute resolution process so directs)." (permitted) |
| 3.8 (MUST deny) | "3.8.1 A pending UDRP proceeding that the Registrar has been informed of. 3.8.2 Court order by a court of competent jurisdiction. 3.8.3 Pending dispute related to a previous transfer pursuant to the Transfer Dispute Resolution Policy. 3.8.4 URS proceeding or URS suspension that the Registrar has been informed of. 3.8.5 The Registrar imposed a 60-day inter-registrar transfer lock following a Change of Registrant, and the Registered Name Holder did not opt out of the 60-day inter-registrar transfer lock prior to the Change of Registrant request." |
| 3.9 (may NOT deny) | "3.9.1 Nonpayment for a pending or future registration period. 3.9.2 No response from the Registered Name Holder. 3.9.3 Domain name in Registrar Lock Status, unless the Registered Name Holder is provided with the reasonable opportunity and ability to unlock the domain name prior to the Transfer Request. 3.9.4 Domain name registration period time constraints, other than during the first 60 days of initial registration, during the first 60 days after a registrar transfer, or during the 60-day lock following a Change of Registrant pursuant to Section II.C.2. 3.9.5 General payment defaults between Registrar and business partners / affiliates in cases where the Registered Name Holder for the domain in question has paid for the registration." |
| 3.10 | "the Registrar of Record must not employ transfer processes as a mechanism to secure payment for services from a Registered Name Holder" (exceptions: non-payment of previous period after expiry, or of current period before expiry) |

**When an outbound transfer must be honoured (procedure implied by the current text):**
1. RNH asks for the code / unlock: give it at once via self-service, or within five (5) calendar days (I.A.5.1-5.2); never refuse over a payment dispute (I.A.5.4).
2. Gaining registrar sends the EPP transfer with a valid code; registry notifies the Registrar of Record; Losing FOA goes to the RNH within 24 hours (I.A.3.4).
3. The Registrar of Record must let it proceed unless (a) a MUST-deny condition applies (I.A.3.8) or (b) it elects one of the enumerated permitted denials (I.A.3.7) and sends a NACK, giving the RNH and the gaining registrar the reason.
4. If the Registrar of Record does nothing within five (5) calendar days, the transfer is approved by default (I.A.3.5, 3.6, 6.2; .com RA App.7 3.3.1).
5. Reasons in I.A.3.9 (unpaid pending/future period, RNH silence, a lock the RNH was not able to lift, partner payment defaults) can never justify denial.

**60-day lock after initial registration:** at policy level it is a *permitted* denial reason (3.7.5), but registries make it hard: the .com Registry Agreement (1 Dec 2024) says "Transfers under Part A of the ICANN Policy on Transfer of Registrations between Registrars may not occur during the Add Grace Period or at any other time within the first 60 days after the initial registration. Enforcement is the responsibility of the Registrar sponsoring the domain name registration and is enforced by the SRS." (https://itp.cdn.icann.org/en/files/registry-agreements/com/com-agreement-html-01-12-2024-en.htm ; same in https://www.icann.org/en/registry-agreements/com/com-registry-agreement-appendix-7-1-12-2012-en). Post-transfer: "After a transfer of a domain, the EPP TRANSFER request may be denied for 60 days." and "it is the Registrar's responsibility to enforce this restriction."

### 3.3 Lock and auth-code duties (I.A.5) - most relevant to Mosshatch's UX

| Ref | Exact wording |
|---|---|
| 5.1 | "Registrars may only set a domain name in "ClientTransferProhibited" status upon registration or subsequent request by the Registered Name Holder, provided, however, that the Registrar includes in its registration agreement (obtaining the express consent of the Registered Name Holder) the terms and conditions upon which it prohibits transfer of the domain name. Further, the Registrar must remove the "ClientTransferProhibited" status within five (5) calendar days of the Registered Name Holder's initial request if the Registrar does not provide facilities for the Registered Name Holder to remove the "ClientTransferProhibited" status." |
| 5.2 | "Registrars must provide the Registered Name Holder with the unique "AuthInfo" code and remove the "ClientTransferProhibited" within five (5) calendar days of the Registered Name Holder's initial request if the Registrar does not provide facilities for the Registered Name Holder to generate and manage their own unique "AuthInfo" code and to remove the "ClientTransferProhibited" status." |
| 5.3 | "Registrars may not employ any mechanism for complying with a Registered Name Holder's request to remove the "ClientTransferProhibited" status or obtain the applicable "AuthInfo Code" that is more restrictive than the mechanisms used for changing any aspect of the Registered Name Holder's contact or name server information." |
| 5.4 | "The Registrar of Record must not refuse to remove the "ClientTransferProhibited" status or release an "AuthInfo Code" to the Registered Name Holder solely because there is a dispute between the Registered Name Holder and the Registrar over payment." |
| 5.5-5.7 | "Registrar-generated "AuthInfo" codes must be unique on a per-domain basis." / "The "AuthInfo" codes must be used solely to identify a Registered Name Holder, whereas the FOAs still need to be used for authorization or confirmation of a transfer request" / "Registrar SHALL follow best practices in generating and updating the "AuthInfo" code to facilitate a secure transfer process." |

Consequence: a default `clientTransferProhibited` at registration is allowed only if the Mosshatch registration agreement contains the terms and obtains express consent (5.1). There is **no** current policy requirement to notify the registrant when an AuthInfo code is issued (Section I.A.5 read in full) and no policy TTL.

### 3.4 Registry side and effect on term

| Ref | Exact wording |
|---|---|
| 6.1 | "Upon receipt of the "transfer" command from the Gaining Registrar, Registry Operator MUST (1) verify that the "AuthInfo" code provided by the Gaining Registrar is valid ... and MUST (2) transmit an electronic notification to both Registrars." |
| 6.2 | "The Registry Operator shall complete the requested transfer unless, within five (5) calendar days, Registry Operator receives a NACK protocol command from the Registrar of Record." |
| Effect on Term of Registration | "The completion by Registry Operator of a holder-authorized transfer under Section I.A shall result in a one-year extension of the existing registration, provided that in no event shall the total unexpired term of a registration exceed ten (10) years." |
| .com RA (1 Dec 2024) 2.3 | "Upon change of sponsorship of the registration of a Registered Name from one Registrar to another, according to Part A of the ICANN Policy on Transfer of Registrations between Registrars, the term of registration of the Registered Name shall be extended by one year, provided that the maximum term of the registration as of the effective date of sponsorship change shall not exceed ten years." |
| .com Transfer Pending Period | "The current value of the Transfer Pending Period is five calendar days for all Registrars. ... If the current Registrar (Registrar B) does not explicitly approve or reject the request initiated by Registrar A, the Registry Operator will approve the request automatically after the end of the Transfer Pending Period. During the Transfer Pending Period: a. EPP TRANSFER request or EPP RENEW request is denied. ... c. EPP DELETE request is denied. ... e. EPP UPDATE request is denied." (https://itp.cdn.icann.org/en/files/registry-agreements/com/com-agreement-html-01-12-2024-en.htm) |
| EPP protocol | "A server MAY automatically approve or reject all transfer requests that are not explicitly approved or rejected by the current sponsoring client within a fixed amount of time." (https://www.rfc-editor.org/rfc/rfc5730.txt) |

### 3.5 Change of Registrant (Section II) - current

| Ref | Exact wording |
|---|---|
| II.A.1.1 | ""Change of Registrant" means a Material Change to any of the following: 1.1.1 Prior Registrant name 1.1.2 Prior Registrant organization 1.1.3 Prior Registrant email address" |
| II.A.1.3 | "'Material Change' means a change which is not a typographical correction." (includes "Any change to the Registered Name Holder's email address.") |
| II.C.1 | Registrar must (1.2) obtain New Registrant confirmation: "The Registrar must use a secure mechanism to confirm that the New Registrant and/or their respective Designated Agents have explicitly consented to the Change of Registrant.", (1.3) inform Prior Registrant that "if its final goal is to transfer the domain name to a different registrar, the Prior Registrant is advised to request the inter-registrar transfer before the Change of Registrant to avoid triggering the 60-day lock", (1.4) obtain Prior Registrant confirmation, both requests "will not proceed if it is not confirmed in a number of days set by the Registrar, not to exceed sixty (60) days"; (1.5) "Process the Change of Registrant within one (1) day of obtaining the confirmations"; (1.6) notify both parties "before or within one day of the completion". |
| II.C.2 | "The Registrar must impose a 60-day inter-registrar transfer lock following a Change of Registrant, provided, however, that the Registrar may allow the Registered Name Holder to opt out of the 60-day inter-registrar transfer lock prior to any Change of Registrant request." |
| Note on the lock | "Registrars are not required to apply a specific EPP status code for the 60-day inter-registrar transfer lock described in section II.C.2; however, if a registrar chooses to apply the clientTransferProhibited EPP status code, it must also lock the name in a way that prohibits the Registered Name Holder from removing the lock per section I.A.5.1." |

**Answer to "is the 60-day CoR lock optional or removed?"** Today: mandatory, but a registrar *may* offer opt-out *before* the CoR request (so it is "optional at registrar's choice"). After the adopted-but-unimplemented reforms: removed entirely (Rec 26.4). See section 4.

Registrant-facing ICANN FAQ (https://www.icann.org/resources/pages/name-holder-faqs-2017-10-10-en): "At their discretion, some registrars may provide an option for you to opt-out of this 60-day lock period. However, this rule is in place for your protection against unauthorized transfers and the registrar does not have to offer this option."

### 3.6 Fees, expired domains, redemption

| Topic | Rule | Source |
|---|---|---|
| Fee to transfer OUT | "Yes. Registrars are allowed to set their own prices for this service so some may choose to charge a fee. However, a transfer cannot be denied due to non-payment of this transfer fee." WG: "The Transfer Policy does not prohibit such fees." and "The Transfer Policy does not contain any provisions allowing the Registrar to deny a transfer for non-payment of transfer fees" | https://www.icann.org/resources/pages/name-holder-faqs-2017-10-10-en ; WG Final Report Annex 11 (p.154) |
| Expired domain | "No. You have the right to transfer an expired domain. Registrars are not allowed to deny a transfer due to expiration or nonrenewal, (unless you haven't paid for a previous registration period)." | name-holder FAQ |
| Redemption | "if the current registrar has begun to delete your domain (i.e., the EPP status code ... shows the domain in Redemption Grace Period ...), the name must be restored by your current registrar before it can be transferred. This may result in an additional fee" ; ERRP 3.2 "During the Redemption Grace Period, the registry must disable DNS resolution and prohibit attempted transfers of the registration." | name-holder FAQ ; https://www.icann.org/en/contracted-parties/consensus-policies/expired-registration-recovery-policy/expired-registration-recovery-policy-28-02-2013-en |
| Fees shown on reseller sites | ERRP 4.1.2: "registrars must ensure that these fees are displayed on their resellers' websites" (renewal, post-expiration renewal, redemption/restore) | ERRP URL above |
| Registry wholesale transfer fee (.com) | Registry charges the gaining registrar per transfer; schedule effective 1 Sep 2024: ".com Domain-Name Transfer ... $10.26" (later 2025/2026 schedules NOT retrieved; see Unverified) | https://itp.cdn.icann.org/en/files/registry-agreements/com/com-fees-01-09-2024-en.pdf |

### 3.7 Transfer Dispute Resolution Policy (TDRP) and TEAC

| Point | Exact wording | Source |
|---|---|---|
| Current version | "Updated 21 February 2024 ... must implement no later than 21 August 2025." | https://www.icann.org/en/contracted-parties/accredited-registrars/registrar-transfer-dispute-resolution-policy-21-02-2024-en |
| Who can file | "Either the Gaining Registrar or Losing Registrar may submit a Complaint." Complainant "may be either a Losing Registrar (in the case of an alleged fraudulent transfer) or a Gaining Registrar (in the case of an improper NACK)". **Registrants cannot file a TDRP complaint**; the WG's Rec 33 asks the GNSO to study expanding it. | TDRP page; WG Rec 33 |
| Time limit | "A dispute must be filed no later than twelve (12) months after the alleged violation of the Transfer Policy." | TDRP 2.2 |
| Providers | Asian Domain Name Dispute Resolution Centre; National Arbitration Forum | https://www.icann.org/en/help/dndr/tdrp/providers |
| Registrant remedy | "you should then submit a formal Transfer Complaint with ICANN." (ICANN Compliance cannot reverse a transfer per WG Rec 33 rationale: "ICANN Contractual Compliance does not have the authority to reverse a transfer.") | name-holder FAQ ; WG Final Report p.52 |
| TEAC (current) | "Responses are required within 4 hours of the initial request" (Policy I.A.4.6.3); registrar-to-registrar; Mosshatch's wholesale registrar must staff it. Future: 24 hours (Rec 29), updates every 72 hours (Rec 31), initial contact within 720 hours (Rec 30). | policy page ; WG Final Report pp.48-50 |
| Evidence duties | I.A.4.3: "In instances where the Registrar of Record has requested copies of the FOA, the Gaining Registrar must fulfill the Registrar of Record's request (including providing the attendant supporting documentation) within five (5) calendar days." I.A.4.2: ICANN, the Registry Operator, a court or a dispute panel "may also require such information within five (5) days of the request." | policy page |

---

## 4. Adopted by the Board (7 Jun 2026) but NOT yet effective: Transfer Policy Review recommendations, exact wording

Source for every row in this section: TPR PDP WG Final Report dated 4 Feb 2025, https://gnso.icann.org/sites/default/files/policy/2025/correspondence/tpr-team-to-gnso-council-04feb25-en.pdf (accessed 2026-09-29; page numbers are "Page N of 163"). Board adoption: https://www.icann.org/en/board-activities-and-meetings/materials/approved-resolutions-regular-meeting-of-the-icann-board-07-06-2026-en. The WG "recommends the recommendations be considered as one package"; the Board adopted the package. The final policy text will be drafted by ICANN org with an IRT, so wording can change in details ("subject to prioritization ... taking into account the ICANN org Feasibility Assessment"). The Board also notes a separate "Change of Registrant Data (CORD) Policy" must be designed ("design and production of a separate Change of Registrant Data (CORD) Policy").

### 4.1 TAC (replaces AuthInfo)

| Rec (page) | Exact wording |
|---|---|
| 4 (p.12) | "the Transfer Policy and all related policies MUST use the term "Transfer Authorization Code" or "TAC" in place of the currently used term "AuthInfo Code" and related terms. This recommendation is for an update to terminology only" |
| 5 (p.12) | "A Transfer Authorization Code (TAC) is a token created by the Registrar of Record and provided upon request to the RNH or their designated representative. The TAC is required for a domain name to be transferred from one Registrar to another Registrar and when presented authorizes an eligible transfer." ; "Designated representative" means an individual or entity that the RNH explicitly authorizes to request and obtain the TAC on their behalf. In the event of a dispute, the RNH's authority supersedes that of the designated representative." |
| 6 (p.13) | "the Transfer Policy MUST continue to require Registrars to set the TAC at the Registry and issue the TAC to the RNH or their designated representative within five calendar days of a request, although the Working Group recommends that the policy state the requirement as 120 hours rather than 5 calendar days ... the policy MUST make clear that 120 hours is the maximum and not the standard period" |
| 7 (p.14) | "the minimum requirements for the composition of a TAC MUST be as specified in RFC 9154 ... The requirement in section 4.1 of RFC 9154 regarding the minimum bits of entropy (i.e., 128 bits) should be a MUST in the policy" |
| 8 (p.15) | Registry "MUST verify that the TAC meets the syntax requirements" when stored |
| 9.1 (p.15) | "The TAC MUST be valid for 336 hours from the time it is set at the Registry, enforced by the Registry." |
| 9.2 (p.16) | "The Registrar of Record MAY reset the TAC to null prior to the end of the 336 hours (i) by agreement by the Registrar of Record and the RNH OR (ii) without the agreement of the RNH in cases where when resetting the TAC to null is in the best interests of the RNH, e.g., security breach, account compromise, etc." ; 9.3 "MUST provide the rationale to the RNH if requested" |
| 10.1 (p.17) | "The TAC MUST only be generated by the Registrar of Record upon request by the RNH or their designated representative." |
| 10.2 (p.18) | Registry "MUST store the TAC securely, at least according to the minimum standard set forth in RFC 9154"; guidance: "strong one-way cryptographic hash with at least a 256-bit hash function ... per-authorization information random salt with at least 128 bits" |
| 13 (p.20) | "the TAC ... MUST be "one-time use." In other words, it MUST be used no more than once per domain name. The Registry Operator MUST reset the TAC to null when it accepts a valid TAC from the Gaining Registrar." (read-only verification is exempt) |
| 14 (p.21) | Registrar "MUST retain all records pertaining to the provision of the Transfer Authorization Code (TAC) ... At a minimum, the records retained MUST document the date/time, means, and contact(s) to whom the TAC and notifications are sent." (15-month retention per rationale) |

RFC 9154 (the standard the WG points to; https://www.rfc-editor.org/rfc/rfc9154.txt): "For authorization information to be secure, it MUST be generated using a secure random value." ; "the implementation SHOULD use at least 128 bits of entropy" ; "The authorization information SHOULD only be set when a transfer is in process." ; "the sponsoring registrar MUST inform the registrant of the TTL when the authorization information is provided to the registrant." ; "Upon successful completion of the transfer, the registry MUST automatically unset the authorization information."

### 4.2 Notifications (what a registrar must tell the registrant)

| Rec (page) | Exact wording |
|---|---|
| 11 (p.18-19) | "the Registrar of Record MUST send a "Notification of TAC Issuance" to the RNH without undue delay but no later than 10 minutes after the Registrar of Record issues the TAC. ... the Registrar of Record MUST use contact information as it was in the registration data at the time of the TAC request." Footnote: "this notification MAY be sent via email, SMS, or a secure messaging system" |
| 11.1 | "This notification MUST be provided in English and in the language of the registration agreement (if different) and MAY also be provided in other languages." |
| 11.2 | Must include: "Domain name(s); Explanation that the TAC will enable the transfer of the domain name to another Registrar; Date and time that the TAC was issued and information about when the TAC will expire; Instructions detailing how the RNH can take action if the request is invalid (how to invalidate the TAC); If the TAC has not been issued via another method of communication, this communication will include the TAC" |
| 11 fn.5 | Best practice: deliver the notification by a different channel than the TAC; if the same channel is used the registrar "MAY choose to send the "Notification of TAC Issuance" and the TAC together in a single communication." |
| 17 (p.24) Transfer Confirmation (replaces "Losing FOA") | 17.1 term "Transfer Confirmation" replaces "Standardized Form of Authorization (FOA)"; 17.2 "MUST include the Gaining Registrar's IANA ID and a link to ICANN-maintained webpage listing accredited Registrars"; 17.3 "MUST be provided in English and the language of the registration agreement"; 17.4 "Failure by the Registrar of Record to respond within 120 hours to a notification from the Registry regarding a transfer request will result in a default "approval" of the transfer."; **17.5 "The Transfer Confirmation MUST NOT include a mechanism for immediately approving the inter-Registrar transfer."** |
| 16 (p.23) | Registry "MUST provide the Gaining Registrar's IANA ID to the Losing Registrar in the notification of a pending transfer request" |
| 19 (p.28) | "the Losing Registrar ... MUST send a "Notification of Transfer Completion" to the RNH without undue delay but no later than 24 hours after the transfer is completed." Contents (19.3): domain name(s); IANA ID(s) of Gaining Registrar(s) and link; "Text stating that the domain was transferred"; "Date, time, and time zone that the transfer was completed"; "Instructions detailing how the RNH can contact the Losing (Prior) Registrar for support if they believe the transfer was invalid, and any deadlines or policies which may be relevant." |

### 4.3 Gaining FOA removed

| Rec (page) | Exact wording |
|---|---|
| 15 (p.22) | "The Working Group recommends eliminating from the Transfer Policy the requirement that the Gaining Registrar send a Gaining FOA. This requirement is detailed in section 1.A.2 of the Transfer Policy." |

### 4.4 Locks after creation and after transfer (60 days -> 720 hours, mandatory)

| Rec (page) | Exact wording |
|---|---|
| 3 (p.10) | "the Registrar MUST restrict the RNH from transferring a domain name to a new Registrar for 720 hours from the Creation Date in RDDS." 3.1: "an RRA, RA, or registration agreement that specifies a period other than 720 hours would need to be amended pursuant to this recommendation" (this includes the 60-day text in the .com RA Appendix 7, which will therefore need amending). |
| 18 (p.25-26) | "The Registrar MUST restrict the RNH from transferring a domain name to a new Registrar for 720 hours from the completion of an inter-Registrar transfer." Early removal only if all of: 18.1 registrar "received a specific request from the RNH to remove the 720-hour restriction"; 18.2 "a reasonable basis" (informed intentional request; mutual agreement of registrars to transfer back; escrow intermediary; documented acquisition; AUP/ToS/local-law release); 18.3 record kept "no fewer than fifteen (15) months". |
| 22 (p.34) | 720-hour post-creation and post-transfer denials move from MAY-deny to MUST-deny: "changing the following reasons that the Registrar of Record currently MAY deny a transfer into reasons that the Registrar of Record MUST deny a transfer" |

### 4.5 Reasons to deny (revised)

| Rec | Change |
|---|---|
| 21 (p.30) MAY deny | 3.7.1 becomes "(a) Evidence of fraud or (b) evidence of DNS Abuse as defined in Section 3.18.1 of the Registrar Accreditation Agreement. If the Registrar denies a transfer request for this reason, the Registrar MAY provide specific evidence/rationale to the RNH upon request."; 3.7.2 reframed around a transfer "not requested by the Registered Name Holder"; 3.7.3 adds "payment disputes". The Board notes Rec 21 is permissive ("may") and plans to engage GNSO on why (Board resolution rationale). |
| 22 (p.33-34) MUST deny | Express RNH objection (opt-in); 720 h post-creation; 720 h post-transfer. |
| 23 (p.35-36) MUST deny | Pending UDRP/URS "notified ... by the Provider"; court order; pending TDRP dispute. The old 3.8.5 (CoR 60-day lock) is deleted because the WG "recommends removal of the 60-day inter-Registrar transfer lock". |
| 24 (p.36-38) MUST NOT deny | Same list as today, with Implementation Guidance: "Registrars are prohibited from denying domain name transfer requests based on non-payment of fees for pending or future registration periods during the Auto-Renew Grace Period, provided that any auto-renewal costs borne by the Registrar are reversible for future period." and "a Registrar-applied inter-Registrar transfer lock is likely the ClientTransferProhibited EPP Status". 3.9.5 now names "Reseller, as defined in the RAA". |
| 20 (p.29) | Reason for denial goes to RNH always, to Gaining Registrar "upon request". |

### 4.6 Change of Registrant -> "Change of Registrant Data" (CORD)

| Rec (page) | Exact wording |
|---|---|
| 25 (p.39) | Term becomes "Change of Registrant Data": "a Material Change to the Registered Name Holder's name or organization, or any change to the Registered Name Holder's email address"; 25.3 "does not apply to the addition or removal of Privacy Service Provider data in RDDS when such Privacy services are provided by the Registrar or its Affiliates." |
| 26 (p.40-41) | "eliminating Section II from the Transfer Policy; instead ... a standalone "Change of Registrant Data" policy MUST be established" ; 26.3 "eliminating ... the requirement that the Registrar request and obtain confirmation from both the Prior Registrant and the New Registrant" ; **26.4 "eliminating from the future Change of Registrant Data Policy the requirement that the Registrar impose a 60-day inter-Registrar transfer lock following a Change of Registrant."** ; 26.1 "all references to Designated Agent MUST be eliminated" |
| 27 (p.42-43) | After a CORD "the Registrar MUST send a Change of Registrant Data notification to the RNH without undue delay, but no later than 24 hours after the Change of Registrant Data occurred." Contents: domain name(s); "which registrant data field(s) were updated"; date/time; "how to initiate a reversal". On email change: "MUST send the ... notification to the RNH's prior email address". Retain records "the shorter of 15 months or the longest period permitted by applicable law". |
| 28 (p.45) | Registrars "MAY provide RNH with the option to opt out"; if offered: enabled by default at registration and at transfer-in; "clear instructions"; "warning of the consequences"; record of opt-out kept "no fewer than fifteen (15) months following the end of the Registrar's sponsorship"; "does not apply to any verification notices sent pursuant to the RDDS Accuracy Program Specification". |

Public comment note: RrSG worried "a registrant could potentially change its contact information in the middle of a dispute such as a ... UDRP" after the removal of restrictions (https://itp.cdn.icann.org/en/files/public-comment/summary-report-transfer-policy-review-wg-final-report-icann-board-consideration-02-07-2025-en.pdf) and "the need for a sufficient implementation buffer window".

### 4.7 Other adopted items (registrar-facing)

- TEAC (Rec 29-31): response 4 h -> 24 h ("update the required timeframe for initial response from 4 hours to 24 hours"); initial contact "no more than 720 hours following the alleged unauthorized loss"; updates "at least every 72 hours".
- Rec 33: GNSO asked to study expanding TDRP to registrants / new registrant-facing dispute mechanism (a study request, not a new right).
- Rec 34-47: portfolio and bulk transfer fee ceilings (BTAPPA), not relevant at launch.

---

## 5. Side-by-side: requested topics, current vs adopted-future

| Topic | In force now (Feb 2024 policy) | Adopted, not yet effective (TPR Final Report) |
|---|---|---|
| Code name | "AuthInfo" code | "Transfer Authorization Code (TAC)" (Rec 4) |
| Who generates / issues | Registrar of Record provides it; may offer self-service (I.A.5.2) | Only "generated by the Registrar of Record upon request by the RNH or their designated representative" (Rec 10.1) |
| Timing to provide | "within five (5) calendar days of the Registered Name Holder's initial request" (I.A.5.2) | 120 hours maximum (Rec 6) |
| Validity | No policy TTL | 336 hours (14 days), registry-enforced; early reset allowed; one-time use (Rec 9, 13) |
| Composition | "best practices" (I.A.5.7) | RFC 9154; >=128 bits entropy MUST (Rec 7) |
| Notice to registrant on issue | None required | Within 10 minutes with 5 required elements (Rec 11) |
| Gaining FOA | In text (I.A.2.1); enforcement deferred since 2020 | Eliminated (Rec 15) |
| Losing FOA | "FOA" within 24 h; may include approve link | "Transfer Confirmation"; must include gaining IANA ID; English + agreement language; **no immediate-approve mechanism** (Rec 17) |
| Pending-transfer window / auto-ack | 5 calendar days (I.A.3.5, 6.2; .com RA 3.3.1) | 120 hours (Rec 17.4); registry contracts to follow |
| After initial registration | May deny within 60 days (I.A.3.7.5); .com RA hard-blocks 60 days | MUST restrict 720 h (30 d) from Creation Date (Rec 3, 22) |
| After inter-registrar transfer | May deny within 60 days (I.A.3.7.6) | MUST restrict 720 h with narrow early-release conditions (Rec 18) |
| Change of Registrant | Two-party confirmation + mandatory 60-day lock, opt-out at registrar's option (II.C) | Section II removed; standalone CORD policy; notification only (<=24 h), no confirmations, **no lock** (Rec 26-28) |
| Permitted denials | Fraud; identity dispute; non-payment; RNH objection; 60d creation; 60d post-transfer | Fraud or DNS abuse; not-requested-by-RNH; non-payment/payment disputes at current RoR (MAY) (Rec 21) |
| Mandatory denials | UDRP, court order, TDRP, URS, CoR lock | UDRP/URS (notified by Provider), court order, TDRP, RNH opt-in objection, 720 h locks (Rec 22-23) |
| Must-not-deny | Non-payment for pending/future period; no response; lock w/o opportunity to unlock; etc. | Same, plus Auto-Renew Grace Period guidance (Rec 24) |
| When outbound must be honoured | Right to transfer (I.A.1); code within 5 calendar days; lock removed within 5 days if no self-service; default approval after 5 calendar days | Same principles, in hours; lock removal by RNH per I.A.5.1-5.4 retained |
| Fees | Registrar may charge for transfer-out; cannot deny for unpaid transfer fee | Unchanged; WG did not recommend a rule (Annex 11) |
| TEAC | 4 h | 24 h; 72 h updates |
| Effective / enforcement | Mandatory since 21 Aug 2025 | None announced; adopted 7 Jun 2026 |

---

## 6. What a registrar must tell the registrant when a TAC / auth code is issued

**Today (mandatory):** nothing is mandated at issuance; the mandatory registrant-facing messages are (a) the Losing FOA / transfer confirmation within 24 h of the registry notice (I.A.3.4, English, no added info, template above) and (b) for a denial, the reason (I.A.3.7). Ambient duties: registration agreement must state lock terms (I.A.5.1); registrant-facing instructions on transfer processes must be available (Registrants' Benefits and Responsibilities: "Instructions that explain your Registrar's processes for registering, managing, transferring, renewing, and restoring your domain name registrations").

**When the reform is implemented (mandatory):** "Notification of TAC Issuance" within 10 minutes with: domain name(s); explanation that the TAC enables a transfer to another registrar; issue date/time and expiry; how to invalidate the TAC if the request is invalid; and the TAC itself if not delivered by another channel (Rec 11.2). Then "Notification of Transfer Completion" within 24 h (Rec 19.3).

**Recommended for Mosshatch now (cheap, compliant either way):** send the Rec 11 notice by a second channel (email + in-app), with the TTL stated (RFC 9154 4.2), keep the record (date/time, means, contact) 15 months, and keep the Transfer Confirmation free of a one-click approve link.

---

## 7. EPP status codes -> what the Mosshatch UI should show

EPP definitions: RFC 5731 https://www.rfc-editor.org/rfc/rfc5731.txt ("Requests to transfer the object MUST be rejected." for both `clientTransferProhibited` and `serverTransferProhibited`; ""pendingTransfer" status MUST NOT be combined with either "clientTransferProhibited" or "serverTransferProhibited" status."; "pendingDelete" status MUST NOT be combined with clientDeleteProhibited/serverDeleteProhibited). Plain-language meanings: ICANN https://www.icann.org/resources/pages/epp-status-codes-2014-06-16-en. RGP/pending-delete durations: .com Appendix 7 https://www.icann.org/en/registry-agreements/com/com-registry-agreement-appendix-7-1-12-2012-en and ERRP.

| EPP status (RDAP value) | Set by | ICANN / registry meaning (quote) | Suggested UI state | Actions to show | Notes |
|---|---|---|---|---|---|
| `ok` (active) | server | "the standard status for a domain, meaning it has no pending operations or prohibitions" | Active, transfer allowed | Lock, Get transfer code | Policy locks (age, recent transfer, CoR) can still apply without any EPP flag. |
| `clientTransferProhibited` ("client transfer prohibited") | registrar (Mosshatch/wholesale) | "tells your domain's registry to reject requests to transfer the domain from your current registrar to another." | "Transfer lock ON (yours to lift)" | Unlock (self-service; see I.A.5.3 caution) | Default-on only with consent in the registration agreement (I.A.5.1). If used for the CoR 60-day lock it must not be removable by the RNH (Note to II.C.2). Never combined with pendingTransfer. |
| `serverTransferProhibited` ("server transfer prohibited") | registry | "It is an uncommon status that is usually enacted during legal or other disputes, at your request, or when a redemptionPeriod status is in place." Registry Lock services "set this status" and removal "can take longer" | "Locked by the registry" | Contact support; no self-unlock | Explain likely causes: dispute, court order, Registry Lock. |
| `pendingTransfer` ("pending transfer") | server | "a request to transfer your domain to a new registrar has been received and is being processed." "If you did not request to transfer your domain, you should contact your registrar immediately to request that they deny the transfer request" | "Transfer in progress" - outbound: show gaining registrar (IANA ID once available), deadline (<=5 days .com), Decline/Approve; inbound: "waiting for current registrar, up to 5 calendar days" | Decline (outbound), Cancel (inbound) | .com: EPP UPDATE/RENEW/DELETE are denied in this window - grey out edits and renewals. |
| `redemptionPeriod` ("redemption period") | server (RGP) | "held in this status for 30 days"; registry "must disable DNS resolution and prohibit attempted transfers" (ERRP 3.2); .com: "The only action a Registrar can take ... is to request that it be restored." | "Deleted - can be restored until <date>" | Restore (costs money -> passkey approval) | Transfer disabled; DNS off; restore fee (see Google Registry rate card "Domain Restore Fee"; .com restore fee $40.00 on 2024 schedule). |
| `pendingRestore` | server | registrar asked to restore; "revert to redemptionPeriod status" if documentation not sent in time | "Restore pending" | none | ~7 day window per ICANN text. |
| `pendingDelete` ("pending delete") | server | not restored in 30 days: "remain in this status for several days, after which time your domain will be purged"; .com "The current length of this Pending Delete Period is five calendar days." | "Being released - can no longer be recovered" with expected release date | none | Do not show Restore or Transfer. |
| `addPeriod`, `renewPeriod`, `autoRenewPeriod`, `transferPeriod` | server | informative grace periods (.com: Add 5 d, Renew 5 d, Auto-Renew 45 d, Transfer 5 d) | small badges ("New", "Just renewed", "Just moved in") | none | Tie to policy age locks; do not treat as locks. |
| `clientHold` / `serverHold` | registrar / registry | DNS not published; "usually enacted during legal disputes, non-payment" | "Paused - not resolving" | Explain reason | "Registrar Hold" is the prerequisite to deny a transfer for non-payment (I.A.3.7.3). |
| `clientUpdateProhibited`, `clientDeleteProhibited`, `clientRenewProhibited` (+server variants) | registrar / registry | reject update/delete/renew | "Edits locked" / "Delete-protected" | Unlock if client-set | Not transfer-related but often set together. |
| `inactive` | server | no nameservers | "No nameservers set" | Add nameservers | |

**Policy-derived states with no EPP flag (compute from dates):**
1. "Too new to transfer" = creation date + 60 days now (Rec 3: 720 h once implemented). Enforced in .com by the SRS.
2. "Recently transferred" = last transfer-complete + 60 days now (720 h later).
3. "Recent registrant change" = CoR + 60 days if the wholesale registrar applies the II.C.2 lock and no opt-out was chosen (removed after reform).
4. "Dispute hold" (UDRP / URS / court order / TDRP): MUST deny; show as "Held for a legal or dispute process" without details.
Keep the durations in config keyed by policy version so the flip to 720 h and to no-CoR-lock is a config change.

---

## 8. Timing: what the UI may promise

| Statement | May promise? | Basis |
|---|---|---|
| "The current registrar can approve at any time; if it does nothing, a .com transfer completes automatically after up to 5 calendar days" | Yes | Policy I.A.3.5; .com RA App.7 3.3.1 ("five calendar days for all Registrars"). |
| "We will give you your transfer code immediately/within minutes" | Yes, if self-service; the legal maximum is 5 calendar days (I.A.5.2), 120 h after reform | Mosshatch product choice |
| "Transfers finish in N hours/instantly" | **No** | No ICANN or registry basis; depends on other registrar's approval and pending window |
| "A typical transfer takes about X days" | **Unverified**: no primary source for a "typical" figure (all sources give the 5-day cap, not a median) | See Unverified |
| ".com transfer adds one year" | Yes ("one-year extension", capped at 10 years) | Policy "Effect on Term of Registration"; .com RA 2.3 |
| ".ai transfer adds 2 years" | Yes with caveat: from registrar/reseller KBs (OpenSRS: "Domain Transfer: 2 years renewal"; Gandi: "The domain is renewed for 2 years."; CentralNic KB: "Renewal on transfer yes 2 years") | Not registry primary |
| ".io transfer adds 1 year and needs the domain to be 60+ days old" | Yes with caveat: Gandi ".io": "the domain was created at least 60 days prior to the request ... the registration period is extended by one year"; CentralNic KB ".io": "transfer locked from the registry for a period of 60 days" | Not registry primary |
| ".dev/.app/.studio transfer adds 1 year" | Yes (gTLD consensus policy via Registry Agreement 2.2 / Spec 1) | Policy + base RA; no registry-specific override found |
| "Domains under 60 days old can't move" | Yes now; must become 30 days (720 h) when the reform takes effect | Policy I.A.3.7.5 / Rec 3 |
| "Transfer codes expire after 14 days" | Yes as Mosshatch policy (matches the adopted rule); do not attribute to ICANN yet | Rec 9.1 not yet effective |
| "Transfers are free" | Only if Mosshatch bears the wholesale registry transfer charge (the registry bills the gaining registrar; .com $10.26 on the 1 Sep 2024 schedule, current figure not verified) | ICANN permits fees but forbids denying for unpaid transfer fees |

### Per-TLD table (starting extensions)

| TLD | Type / governing rules | Registry operator (IANA record) | Pending window / auto-approve | Post-creation lock | Term added on inbound transfer |
|---|---|---|---|---|---|
| .com | gTLD: ICANN Transfer Policy + .com RA (1 Dec 2024) | VeriSign Global Registry Services (https://www.iana.org/domains/root/db/com.html) | 5 calendar days, auto-approve (RA App.7 3.3.1) | 60 days, SRS-enforced (RA App.7 3.1.1) | +1 year, max 10 (RA 2.3) |
| .dev | gTLD: ICANN policy via base RA 2.2 / Spec 1; Google Registry policies | Charleston Road Registry Inc. (https://www.iana.org/domains/root/db/dev.html) | Not found in registry docs (unverified); policy 5-day default | Policy: may deny <60 d; registry-specific not found | +1 year by policy |
| .app | as .dev | Charleston Road Registry Inc. | as .dev | as .dev | +1 year by policy |
| .studio | gTLD | Dog Beach, LLC c/o Identity Digital Inc. (https://www.iana.org/domains/root/db/studio.html) | Not found (unverified) | not found | +1 year by policy |
| .ai | **ccTLD, own rules** | Manager: Government of Anguilla; registry site run by Identity Digital (https://www.iana.org/domains/root/db/ai.html; https://www.nic.ai) | unverified | unverified | +2 years (registrar KBs) |
| .io | **ccTLD, own rules** | Internet Computer Bureau Limited (https://www.iana.org/domains/root/db/io.html) | unverified | 60 days (registrar KBs) | +1 year (Gandi) |

Base RA clause (new gTLDs) https://itp.cdn.icann.org/en/files/registry-agreements/base-registry-agreement-30-04-2023-en.html: "Registry Operator shall comply with and implement all Consensus Policies and Temporary Policies found at https://www.icann.org/consensus-policies". ICANN's consensus-policies page: "ICANN's agreements with accredited registrars and with gTLD registry operators require compliance with various specifically stated procedures, "consensus policies", and temporary policies." Google Registry publishes a per-registrar "Domain Transfer Fee" and "Domain Restore Fee" on its rate card and a 30-day Redemption Grace Period, 5-day Add Grace Period, 45-day Auto-Renew Grace Period (https://www.registry.google/policies/pricing/dev/).

---

## 9. ccTLDs .ai and .io are outside the ICANN Transfer Policy

| Claim | Quote | Source |
|---|---|---|
| ICANN does not set ccTLD registration policy | "ICANN does not accredit registrars or set registration policies for ccTLDs. For details about ccTLD registration policies, you should contact the designated country code manager." | https://www.icann.org/resources/pages/faqs-2014-01-21-en |
| Each ccTLD sets its own policy | "Each country-code top-level domain (ccTLD) is operated by an independent registry operator that sets policies to govern the registration and use of that particular ccTLD. Consequently, each ccTLD and its domain names is governed by a unique set of policies." | same |
| Consensus policies bind gTLD contracted parties | "ICANN's agreements with accredited registrars and with gTLD registry operators require compliance with various specifically stated procedures, "consensus policies", and temporary policies." | https://www.icann.org/en/contracted-parties/consensus-policies |
| ccNSO membership voluntary | "ccNSO membership is open to all ccTLD Managers, but joining is voluntary." | https://www.icann.org/en/ccnso |
| Transfer Policy scope | "All ICANN-accredited registrars and unsponsored gTLD registry operators are required to follow this policy." | https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers |
| .ai registry | IANA "ccTLD Manager": "Government of Anguilla"; RDAP server "https://rdap.identitydigital.services/rdap/"; nic.ai: "Official Registry Operator Website ... ©2025 Identity Digital Inc." | https://www.iana.org/domains/root/db/ai.html ; https://www.nic.ai |
| .io registry | IANA "ccTLD Manager": "Internet Computer Bureau Limited"; nic.io Terms & Conditions clause 13: "The Applicant (either directly or via an agent) may transfer, modify or surrender the registration of the Domain Name via the appropriate process(es)." and "NIC.IO reserves the right to charge a fee for all transfers, modifications or deletions." (legacy site, footer "Copyright © 1997-2021 Internet Computer Bureau Ltd.") | https://www.iana.org/domains/root/db/io.html ; https://nic.io/terms.htm |

Design consequence: the transfer UI must be driven by a per-TLD rules table (lock length, term added, pending window, code format/length, whether a losing-side confirmation email is used), not by the ICANN policy version. Registrar/reseller KBs show ccTLD differences (CentralNic: .ai and .io "Authcode length 8 - 32 characters"; .ai registration "2 years ... 10 years").

---

## 10. Reseller-specific obligations (Mosshatch on a wholesale registrar's API)

| Obligation | Exact wording | Source |
|---|---|---|
| Registrar remains responsible | "Registrar is responsible for the provision of Registrar Services for all Registered Names that Registrar sponsors being performed in compliance with this Agreement, regardless of whether the Registrar Services are provided by Registrar or a third party, including a Reseller." | RAA (21 Jan 2024) 3.12, https://www.icann.org/en/system/files/files/registrar-accreditation-agreement-21jan24-en.htm |
| Reseller agreement | "Registrar must enter into written agreements with all of its Resellers that enable Registrar to comply with and perform all of its obligations under this Agreement." | RAA 3.12 |
| Registration agreement content | "Any registration agreement used by reseller shall include all registration agreement provisions and notices required by the ICANN Registrar Accreditation Agreement and any ICANN Consensus Policies, and shall identify the sponsoring registrar or provide a means for identifying the sponsoring registrar" | RAA 3.12.2 |
| Identify sponsor on request | "Its Resellers identify the sponsoring registrar upon inquiry from the customer." | RAA 3.12.3 |
| Publish B&R spec | "Its Resellers shall publish on their website(s) and/or provide a link to the Registrants' Benefits and Responsibilities Specification" | RAA 3.12.7 |
| Fees on reseller site | "registrars must ensure that these fees are displayed on their resellers' websites" (renewal, post-expiration renewal, redemption/restore) | ERRP 4.1.2 |
| Reseller defined | "A "Reseller" is a person or entity that participates in Registrar's distribution channel for domain name registrations ... or ... facilitating the entry of the registration agreement between the Registrar and the Registered Name Holder." | RAA 1.24 |
| Transfer-related reseller reference | Policy Rec 24 (future) revises 3.9.5 to name "General payment defaults between Registrar and Reseller, as defined in the RAA" as a must-not-deny reason; ICANN's Losing FOA template has a slot for "<insert name of registrar and/or name of reseller>" | WG Final Report p.38; FOA template |
| Wholesale example | OpenSRS treats itself as the party that "receives the registry notification, validates eligibility, emails the owner for confirmation, and updates the domain": the wholesale platform may send the Losing FOA for the reseller, and "Owner does not respond within five days - The registry automatically acknowledges the transfer" | https://support.opensrs.com/support/solutions/articles/201000063132-transfer-away-process (provider-specific; other wholesale APIs need checking by the API dossier) |

---

## 11. Checklist of concrete requirements (exact wording of the critical rules)

Legend: **NOW** = in force today (Transfer Policy Feb 2024, gTLDs). **FUTURE** = adopted by the Board 7 Jun 2026, not yet effective, no date. "RoR" = Registrar of Record (Mosshatch's wholesale registrar). All sources accessed 2026-09-29. Policy URL P = https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers/policy ; WG = https://gnso.icann.org/sites/default/files/policy/2025/correspondence/tpr-team-to-gnso-council-04feb25-en.pdf

| ID | Requirement (exact wording) | Applies | Source | How Mosshatch meets it |
|---|---|---|---|---|
| C-01 | "Registered Name Holders must be able to transfer their domain name registrations between Registrars provided that the Gaining Registrar's transfer process meets the minimum standards of this policy and that such transfer is not prohibited by ICANN or Registry policies." | NOW, RoR + reseller | P I.A.1 | Every domain has a self-service transfer-out path; no retention gates; block only for MUST-deny reasons. |
| C-02 | "The Registered Name Holder is the only party that has the authority to approve or deny a transfer request to the Gaining Registrar." | NOW | P I.A.1.1 | Approve/decline of a pending transfer and unlock/TAC require a human account-owner passkey; agent tokens cannot approve. |
| C-03 | "...remove the "ClientTransferProhibited" status within five (5) calendar days of the Registered Name Holder's initial request if the Registrar does not provide facilities for the Registered Name Holder to remove the "ClientTransferProhibited" status." and "Registrars must provide the Registered Name Holder with the unique "AuthInfo" code ... within five (5) calendar days of the Registered Name Holder's initial request if the Registrar does not provide facilities for the Registered Name Holder to generate and manage their own unique "AuthInfo" code" | NOW | P I.A.5.1-5.2 | Build self-service lock toggle and code generation (removes the 5-day fallback). Also need a human-support fallback with a 5-calendar-day SLA if the wholesale API lacks self-service. |
| C-04 | "Registrars may not employ any mechanism for complying with a Registered Name Holder's request to remove the "ClientTransferProhibited" status or obtain the applicable "AuthInfo Code" that is more restrictive than the mechanisms used for changing any aspect of the Registered Name Holder's contact or name server information." | NOW | P I.A.5.3 | Give contact and nameserver changes at least the same authentication step (passkey step-up) as unlock/TAC, or do not gate unlock/TAC harder than those. Counsel to confirm (see section 13). |
| C-05 | "The Registrar of Record must not refuse to remove the "ClientTransferProhibited" status or release an "AuthInfo Code" to the Registered Name Holder solely because there is a dispute between the Registered Name Holder and the Registrar over payment." | NOW | P I.A.5.4 | Never gate code release on billing state. Payment-based denial only via I.A.3.7.3 with Registrar Hold. |
| C-06 | "Registrars may only set a domain name in "ClientTransferProhibited" status upon registration or subsequent request by the Registered Name Holder, provided, however, that the Registrar includes in its registration agreement (obtaining the express consent of the Registered Name Holder) the terms and conditions upon which it prohibits transfer of the domain name." | NOW | P I.A.5.1 | Default lock ON at registration, with an explicit consent line in the Mosshatch registration agreement at checkout. |
| C-07 | "Registrar-generated "AuthInfo" codes must be unique on a per-domain basis." / "Registrar SHALL follow best practices in generating and updating the "AuthInfo" code to facilitate a secure transfer process." | NOW | P I.A.5.5, 5.7 | CSPRNG codes, per domain, regenerated on each request (RFC 9154 style). |
| C-08 | "The FOA should be sent by the Registrar of Record to the Registered Name Holder as soon as operationally possible, but must be sent not later than twenty-four (24) hours after receiving the transfer request from the Registry Operator." + "The FOA shall be communicated in English" + "no Registrar shall add any additional information to the FOA" | NOW, RoR (reseller may send) | P I.A.3.3-3.4 | Confirm with wholesale registrar who sends it; if Mosshatch sends, use ICANN's template verbatim (English, cancel-before-date, "If we do not hear from you by <insert date>, the transfer will proceed"), no creature copy or upsell inside it. |
| C-09 | "Failure by the Registrar of Record to respond within five (5) calendar days to a notification from the Registry regarding a transfer request will result in a default "approval" of the transfer." | NOW | P I.A.3.5 | UI: pending outbound transfer shows deadline = request + 5 calendar days; silence = approval; Decline button. |
| C-10 | "Upon denying a transfer request for any of the following reasons, the Registrar of Record must provide the Registered Name Holder and the potential Gaining Registrar with the reason for denial. The Registrar of Record may deny a transfer request only in the following specific instances:" (fraud; identity dispute; non-payment with Registrar Hold; RNH opt-in objection; <60 d from creation; <60 d from prior transfer) | NOW | P I.A.3.7 | Denial console limited to the enumerated reasons, reason emailed to the RNH and available to gaining registrar. |
| C-11 | MUST deny: "A pending UDRP proceeding ..."; "Court order by a court of competent jurisdiction."; "Pending dispute related to a previous transfer pursuant to the Transfer Dispute Resolution Policy."; "URS proceeding or URS suspension ..."; "The Registrar imposed a 60-day inter-registrar transfer lock following a Change of Registrant, and the Registered Name Holder did not opt out ..." | NOW | P I.A.3.8 | Dispute-hold flag set from wholesale-registrar / provider notices; blocks transfer-out and registrant change. |
| C-12 | MAY NOT deny: "Nonpayment for a pending or future registration period."; "No response from the Registered Name Holder."; "Domain name in Registrar Lock Status, unless the Registered Name Holder is provided with the reasonable opportunity and ability to unlock the domain name prior to the Transfer Request."; "General payment defaults between Registrar and business partners / affiliates in cases where the Registered Name Holder for the domain in question has paid for the registration." | NOW | P I.A.3.9 | No renewal-upsell gating; if Mosshatch fails to pay its wholesale registrar, customers' transfers still proceed. |
| C-13 | "...the Registrar of Record must not employ transfer processes as a mechanism to secure payment for services from a Registered Name Holder." | NOW | P I.A.3.10 | No "pay before you can leave" prompts beyond unpaid registration periods. |
| C-14 | "You have the right to transfer an expired domain. Registrars are not allowed to deny a transfer due to expiration or nonrenewal, (unless you haven't paid for a previous registration period)." / redemption: "the name must be restored by your current registrar before it can be transferred." | NOW | https://www.icann.org/resources/pages/name-holder-faqs-2017-10-10-en ; ERRP 3.2 | Expired-but-renewable domains keep the transfer button; RGP domains show Restore first. |
| C-15 | "The completion by Registry Operator of a holder-authorized transfer under Section I.A shall result in a one-year extension of the existing registration, provided that in no event shall the total unexpired term of a registration exceed ten (10) years." | NOW | P Effect on Term | Inbound quote shows +1 year (.com/.dev/.app/.studio), capped at 10 years; .ai +2, .io +1 per registry rules. |
| C-16 | Change of Registrant: "The Registrar must impose a 60-day inter-registrar transfer lock following a Change of Registrant, provided, however, that the Registrar may allow the Registered Name Holder to opt out of the 60-day inter-registrar transfer lock prior to any Change of Registrant request." Plus two-party confirmations by "secure mechanism", processing "within one (1) day of obtaining the confirmations", notices "before or within one day". | NOW | P II.C | Treat any edit to registrant name/organisation/email as CoR; keep login email separate from registrant email; warn before the edit; offer opt-out choice before the request if the wholesale registrar allows; use wholesale CoR API if provided. |
| C-17 | "Each Registrar is responsible for keeping copies of documentation, including the FOA and the Registered Name Holder's response thereto"; FOA copies requested by the other registrar within "five (5) calendar days" (I.A.4.3); ICANN/registry/court/panel requests "within five (5) days" (I.A.4.2); TEAC "Responses are required within 4 hours of the initial request". | NOW, RoR | P I.A.4.1-4.6 | Contract with wholesale registrar to route TEAC/evidence requests; keep transfer logs. |
| C-18 | "Registrar is responsible for the provision of Registrar Services ... including a Reseller." + "Any registration agreement used by reseller shall include all registration agreement provisions and notices required by the ICANN Registrar Accreditation Agreement and any ICANN Consensus Policies, and shall identify the sponsoring registrar or provide a means for identifying the sponsoring registrar" + publish B&R specification + show renewal/restore fees. | NOW, reseller | RAA 3.12, 3.12.2, 3.12.7; ERRP 4.1.2 | Registration agreement names the sponsoring registrar (link to lookup.icann.org), links B&R spec, fee table on the site. |
| C-19 | TDRP: "Either the Gaining Registrar or Losing Registrar may submit a Complaint." (registrants cannot); registrant path "submit a formal Transfer Complaint with ICANN". | NOW | TDRP 3.1.1; name-holder FAQ | Help page explains the registrant route; internal escalation to wholesale registrar for TDRP. |
| C-20 | Gaining FOA text remains ("Obtain express authorization from the Registered Name Holder") but "ICANN Contractual Compliance will defer enforcement of Section I(A)(2.1)" | NOW (deferred) | P News banner; Board 2020.01.26.02 | Inbound flow uses an authenticated passkey confirmation by the account owner and stores it; get written confirmation from wholesale registrar about its stance. |
| C-21 | ccTLDs: "ICANN does not accredit registrars or set registration policies for ccTLDs." | NOW | https://www.icann.org/resources/pages/faqs-2014-01-21-en | Per-TLD rules table for .ai/.io; do not show ICANN-policy claims on those TLDs. |
| F-01 | "The TAC MUST only be generated by the Registrar of Record upon request by the RNH or their designated representative." | FUTURE | WG Rec 10.1 p.17 | Self-service "Request TAC" behind passkey; no pre-generated standing codes; agents only if RNH explicitly designated. |
| F-02 | "The TAC MUST be valid for 336 hours from the time it is set at the Registry, enforced by the Registry." | FUTURE | WG Rec 9.1 p.15 | Show "valid 14 days"; cancel button; unset authInfo on cancel/expiry (RFC 9154 5.2). |
| F-03 | "...issue the TAC to the RNH or their designated representative within five calendar days of a request ... 120 hours ... is the maximum and not the standard period" | FUTURE | WG Rec 6 p.13 | Instant issuance by default; 120 h only as manual-review ceiling. |
| F-04 | "the minimum requirements for the composition of a TAC MUST be as specified in RFC 9154 ... (i.e., 128 bits) should be a MUST in the policy" | FUTURE | WG Rec 7 p.14 | CSPRNG, >=128-bit entropy (20 chars over 94 printable ASCII). Check wholesale API accepts it (ccTLD KB lists 8-32 char authcodes for .ai/.io). |
| F-05 | "...MUST send a "Notification of TAC Issuance" to the RNH without undue delay but no later than 10 minutes after the Registrar of Record issues the TAC." (domain(s); TAC enables transfer; issue time + expiry; how to invalidate; TAC if not delivered another way) | FUTURE | WG Rec 11 pp.18-19 | Email + in-app notice within 10 min with a one-click "This wasn't me - invalidate" link (passkey-free, safe direction). |
| F-06 | "...it MUST be used no more than once per domain name. The Registry Operator MUST reset the TAC to null when it accepts a valid TAC" | FUTURE | WG Rec 13 pp.20-21 | Do not display a used TAC as reusable; mark consumed. |
| F-07 | "The Registrar MUST retain all records pertaining to the provision of the Transfer Authorization Code (TAC) ... the date/time, means, and contact(s) to whom the TAC and notifications are sent." (15 months) | FUTURE | WG Rec 14 pp.21-22 | Immutable log table with 15-month minimum retention; legal review for GDPR. |
| F-08 | "The term "Transfer Confirmation" MUST be used in place of "Standardized Form of Authorization (FOA)."; MUST include Gaining Registrar IANA ID; English + agreement language; "within 120 hours"; "MUST NOT include a mechanism for immediately approving the inter-Registrar transfer." | FUTURE | WG Rec 17 p.24 | Build the confirmation email now without an approve link (decline/cancel only). |
| F-09 | "...Losing Registrar ... MUST send a "Notification of Transfer Completion" to the RNH without undue delay but no later than 24 hours after the transfer is completed." | FUTURE | WG Rec 19 p.28 | Completion email with gaining IANA ID, date/time/zone, how to contact Mosshatch. |
| F-10 | "the Registrar MUST restrict the RNH from transferring a domain name to a new Registrar for 720 hours from the Creation Date in RDDS." and "...for 720 hours from the completion of an inter-Registrar transfer." (early removal only under 18.1-18.3) | FUTURE | WG Rec 3 p.10; Rec 18 pp.25-26 | Config: lockHours=1440 now (60 d), 720 later; early-release workflow not needed at launch. |
| F-11 | "eliminating from the future Change of Registrant Data Policy the requirement that the Registrar impose a 60-day inter-Registrar transfer lock following a Change of Registrant." + notification "no later than 24 hours after the Change of Registrant Data occurred" to the prior email address | FUTURE | WG Rec 26.4 p.41; Rec 27 p.42-43 | Feature-flag the CoR confirmations/lock; ship the CORD notification (prior email) now. |
| F-12 | Denial reasons: DNS abuse may be a reason ("evidence of DNS Abuse as defined in Section 3.18.1 of the Registrar Accreditation Agreement"); RNH opt-in objection, 720 h locks, UDRP/URS/court/TDRP are MUST-deny. | FUTURE | WG Rec 21-23 | Update the denial console reason list when policy text lands. |
| F-13 | Gaining FOA eliminated: "The Working Group recommends eliminating from the Transfer Policy the requirement that the Gaining Registrar send a Gaining FOA." | FUTURE | WG Rec 15 p.22 | Remove the compliance text at effective date; keep account-owner confirmation as security. |
| F-14 | TEAC response "from 4 hours to 24 hours"; updates "at least every 72 hours" | FUTURE, RoR | WG Rec 29, 31 | Contractual flow-down to wholesale registrar. |

---

## 12. Design implications for Mosshatch

1. **Policy profile as data.** Store `{tld, policyVersion, effectiveFrom, postCreateLock, postTransferLock, corLock, pendingWindow, tacTtl, tacIssueMaxHours, notices}`. Today: gTLD = 60 d / 60 d / CoR lock 60 d w/ optional opt-out / 5 d / no TTL. Flip to 30 d (720 h) / 30 d / none / 120 h / 336 h when ICANN publishes the effective date. .ai/.io have their own rows.
2. **Ship TAC behaviour early, not as an ICANN claim.** On-demand generation, single use, 14-day expiry, notice within 10 minutes, 15-month log. It is compatible with today's I.A.5 and removes rework. Confirm the wholesale API can set/unset authInfo (RFC 9154 5.1-5.2); this dossier did not verify any provider's API (other dossiers cover it).
3. **Transfer-out is a money/risk action but is also a regulated right.** Gate TAC/unlock/approve with a human passkey and never let agent tokens do it (I.A.1.1: only the RNH decides; Rec 5: a "designated representative" must be "explicitly" authorized by the RNH and the RNH's authority supersedes). But I.A.5.3 forbids a mechanism "more restrictive than" contact/nameserver changes, so put contact and nameserver edits behind the same passkey step-up, or seek counsel before shipping a stricter gate for transfers only.
4. **Change of Registrant is a trap in a reseller UI.** Any edit of registrant name, organisation or email is a CoR today, with confirmations and a 60-day lock. Keep the account/login email separate from the registrant email; warn on edit; optionally offer a lock opt-out before the change (if the wholesale registrar supports it); after reform the flow becomes notification-only. AI agents must not be able to change registrant fields without a passkey-approved human step.
5. **Emails:** the Losing confirmation must be English, plain and unadorned (I.A.3.3), must not include a one-click approve link once reformed (Rec 17.5), should state gaining registrar IANA ID when the registry provides it (Rec 16-17). The creature branding belongs in separate messages or in-app, not in the confirmation text.
6. **UI states:** derive from EPP plus dates (section 7); grey out edits/renewals/deletes while `pendingTransfer` (.com denies them); show Restore only in `redemptionPeriod`; show nothing actionable in `pendingDelete`.
7. **Timing copy:** promise caps not medians: "up to 5 calendar days after submission (.com), sooner if the current registrar approves"; .com +1 year; per-TLD for .ai (+2 years) and .io (60-day-old requirement, +1 year). Never "instant".
8. **Fees:** outbound transfer fee is legal but unpaid transfer fees cannot block a transfer; with a "wholesale plus one flat fee, no upsells" model publish "free to leave". Inbound transfers cost the registry's transfer charge (renewal-equivalent for .com: $10.26 on the 1 Sep 2024 schedule; verify current) and give the customer +1 year.
9. **Denials:** only enumerated reasons; always tell the RNH the reason; give the gaining registrar the reason on request (Rec 20 clarifies the "upon request").
10. **Evidence and records:** keep who/when/how for TAC issue, notices, approvals; the future rule is 15 months (Rec 14, 18.3, 27.8, 28.4).
11. **Business continuity:** if the wholesale registrar is acquired or loses accreditation, ICANN-approved bulk transfers apply (Policy I.B: "lack of accreditation of that Registrar") - keep registrant data exportable and do not assume the sponsoring registrar is permanent.
12. **Sanctions/geo blocks:** the Transfer Policy has no sanctions-based denial reason; the WG chose not to add one ("it is up to each Registrar to determine how to do so" (comply with national law)). Do not add transfer blocks by country without counsel.
13. **DNSSEC/DNS continuity on transfer-out:** the SSAC raised DNS operational continuity; no rule adopted, but the UI should warn that moving registrars does not move hosting/DNS records (WG Final Report Annex 11 topic "Additional Topic Suggested by SSAC").

---

## 13. Needs a lawyer or accountant

- Whether a passkey-gated TAC/unlock complies with Transfer Policy I.A.5.3 when contact/nameserver changes are gated less; and how to structure the auth ladder for AI-agent scoped tokens vs the "only party that has the authority" rule (I.A.1.1) and the future "designated representative" concept.
- Allocation of duties between Mosshatch and the wholesale registrar of record (Losing FOA/Transfer Confirmation sender, TAC notices, record retention, TEAC, TDRP, CoR), and the reseller agreement terms required by RAA 3.12.
- Reliance on the Gaining FOA enforcement deferral (Board 2020.01.26.02) and what to do when it ends.
- Registration-agreement wording: `clientTransferProhibited` consent (I.A.5.1), sponsoring-registrar identification (RAA 3.12.2), fee disclosures (ERRP 4.1.2).
- GDPR/CCPA treatment of transfer notifications and 15-month logs; sanctions screening vs the no-sanctions-denial-reason policy.
- ccTLD terms: .ai (Identity Digital/Government of Anguilla) and .io registry terms (and whether the .io future is affected by British Indian Ocean Territory sovereignty changes; not researched here).
- Accountant: revenue/tax treatment of the transfer fee vs the bundled one-year extension; VAT/sales tax on transfer-in; refund handling for failed transfers.

---

## 14. Unverified, gaps and caveats

1. **Effective and enforcement dates for the reform:** unverified because none exist. No IRT wiki, no draft policy, no ICANN announcement as of 2026-09-29 (announcements, blogs, Policy Implementation page, GNSO project list, Confluence checked). "Subject to prioritization" in the Board text. The 18-month window is a WG recommendation, not a decided date.
2. **Whether the Gaining FOA compliance deferral remains in force after Board adoption:** the deferral is "until the matter is settled in the GNSO Council's planned Transfer Policy review"; ICANN's pages still carried the banner on 2026-09-29; no lifting notice found.
3. **"Typical" transfer duration in days:** no primary source; only the 5-calendar-day caps.
4. **.ai and .io registry-side pending window, auto-approve, and lock rules:** only registrar/reseller-platform KBs (OpenSRS, Gandi, CentralNic) and a legacy nic.io site; nic.ai FAQ answers were collapsed/not retrievable; no registry policy PDFs found. The exact .io term added on transfer (1 year) rests on Gandi only.
5. **.dev, .app, .studio registry-specific transfer rules:** Google Registry and Identity Digital pages fetched contain only pricing/grace-period and (for .dev/.app) HTTPS notices; no transfer-specific overrides found; assumed base ICANN policy.
6. **Current .com registry transfer fee:** only the schedule effective 1 Sep 2024 was retrievable (the 2025/2026 schedule URLs I guessed returned 404; ICANN's fee-notification list loads dynamically). Defer to the pricing dossier.
7. **Whether any registry (Verisign etc.) or wholesale registrar already enforces a TAC TTL / RFC 9154 today:** unverified; InternetX (Sept 2026) says "some already run the TAC model", no primary source. WebSearch budget was exhausted mid-run so follow-up searches on this were not possible.
8. **ICANN87 (Bali) schedule for any Transfer Policy IRT session:** icann87.sched.com returned a Cloudflare challenge; not worked around (egress/bot policy).
9. **ICANN org Feasibility Assessment** for the TPR recommendations was not located; its content (e.g., dependencies, timeline) is unverified.
10. **RAA:** 3.12 text verified in the RAA dated 21 Jan 2024; the 2024 global amendment (effective 5 Apr 2024) was not diffed against 3.12.
11. **Quoted WG text is from the Final Report, not from final policy language.** Wording, numbering (e.g., I.A.3.7.x) and details may change during IRT drafting.
12. **PDF text extraction** garbles table strike-throughs (Rec 21, 22, 24 tables); rows there are paraphrased rather than quoted.

---

## 15. Source list (all accessed 2026-09-29)

| # | URL | Used for |
|---|---|---|
| 1 | https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers/policy | Current Transfer Policy text (Feb 2024) |
| 2 | https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers | Version list, Gaining FOA deferral banner, scope sentence |
| 3 | https://itp.cdn.icann.org/en/files/consensus-policy/transfer-policy-redline-21feb24-en.pdf | 2024 redline |
| 4 | https://www.icann.org/en/contracted-parties/consensus-policies | Consensus policy list, Registration Data Policy dates |
| 5 | https://www.icann.org/en/board-activities-and-meetings/materials/approved-resolutions-regular-meeting-of-the-icann-board-07-06-2026-en | Board adoption 2026.06.07.04 |
| 6 | https://www.icann.org/en/blogs/details/chairs-blog-recap-of-the-june-board-workshop-and-icann86-24-06-2026-en | ICANN announcement of adoption |
| 7 | https://www.icann.org/policy/implementation | "In Queue"; six-month practice |
| 8 | https://icann-community.atlassian.net/wiki/download/attachments/111086692/GNSO_Council_Project-List_20260910.pdf | Implementation phase status |
| 9 | https://gnso.icann.org/sites/default/files/policy/2025/correspondence/tpr-team-to-gnso-council-04feb25-en.pdf | WG Final Report (47 recs) |
| 10 | https://gnso.icann.org/sites/default/files/policy/2025/draft/gnso-council-recommendations-report-to-icann-board-tpr-wg-31mar25-en.pdf | 18-month window; org impact |
| 11 | https://gnso.icann.org/en/council/resolutions/2020-current | Council motion 20250312-3 |
| 12 | https://www.icann.org/en/public-comment/proceeding/transfer-policy-review-working-group-final-report-for-icann-board-consideration-28-04-2025 ; https://itp.cdn.icann.org/en/files/public-comment/summary-report-transfer-policy-review-wg-final-report-icann-board-consideration-02-07-2025-en.pdf | Board public comment |
| 13 | https://itp.cdn.icann.org/en/files/correspondence/smigelski-et-al-to-sinha-25-05-2026-en.pdf | GNSO letter on Board delay |
| 14 | https://www.icann.org/en/board-activities-and-meetings/materials/approved-resolutions-open-session-of-board-workshop-los-angeles-regular-meeting-of-the-icann-board-26-01-2020-en | Gaining FOA deferral |
| 15 | https://www.icann.org/en/contracted-parties/accredited-registrars/registrar-transfer-dispute-resolution-policy-21-02-2024-en ; https://www.icann.org/en/help/dndr/tdrp/providers | TDRP |
| 16 | https://www.icann.org/en/contracted-parties/accredited-registrars/standardized-form-of-authorization-domain-name-transfer-confirmation-of-registrar-transfer-request-21-02-2024-en | Losing FOA template |
| 17 | https://www.icann.org/resources/pages/epp-status-codes-2014-06-16-en | EPP status meanings |
| 18 | https://www.rfc-editor.org/rfc/rfc5730.txt ; rfc5731.txt ; rfc9154.txt ; rfc3915.txt (fetched) | EPP and TAC standards |
| 19 | https://itp.cdn.icann.org/en/files/registry-agreements/com/com-agreement-html-01-12-2024-en.htm ; https://www.icann.org/en/registry-agreements/com/com-registry-agreement-appendix-7-1-12-2012-en ; https://itp.cdn.icann.org/en/files/registry-agreements/com/com-fees-01-09-2024-en.pdf | .com transfer mechanics and fee |
| 20 | https://itp.cdn.icann.org/en/files/registry-agreements/base-registry-agreement-30-04-2023-en.html | Base gTLD RA consensus-policy clause |
| 21 | https://www.icann.org/en/system/files/files/registrar-accreditation-agreement-21jan24-en.htm | RAA 3.12 reseller |
| 22 | https://www.icann.org/en/contracted-parties/consensus-policies/expired-registration-recovery-policy/expired-registration-recovery-policy-28-02-2013-en | ERRP |
| 23 | https://www.icann.org/resources/pages/name-holder-faqs-2017-10-10-en ; https://www.icann.org/resources/pages/faqs-2014-01-21-en ; https://www.icann.org/en/ccnso | Registrant FAQ, ccTLD statements |
| 24 | https://www.iana.org/domains/root/db/{com,dev,app,studio,ai,io}.html | Registry operators |
| 25 | https://www.registry.google/policies/pricing/dev/ | Google Registry rate-card items and grace periods |
| 26 | https://nic.io/terms.htm ; https://www.nic.ai ; https://support.opensrs.com/support/solutions/articles/201000068801--ai-domain-policies ; https://www.gandi.net/en-US/domain/tld/io ; https://www.gandi.net/en-US/domain/tld/ai ; https://kb.centralnicreseller.com/domains/tlds/io/ ; https://kb.centralnicreseller.com/domains/tlds/ai/ | ccTLD specifics (secondary for .ai/.io) |
| 27 | https://opensrs.com/blog/icann86-policy-recap/ ; https://support.opensrs.com/support/solutions/articles/201000063132-transfer-away-process | Registrar-side commentary / wholesale example |
| 28 | https://seo.domains/seo-resources/transfer-process/epp-code-auth-code/ ; https://www.namesilo.com/blog/en/domain-names/icann-transfer-policy-updates-tac-codes-losinggaining-notifications-and-what-changed ; https://snapshot.internetx.com/en/auth-code/ | Conflicting secondary claims |
| 29 | https://www.icann.org/en/announcements ; https://www.icann.org/en/blogs | Absence of further ICANN announcements |
