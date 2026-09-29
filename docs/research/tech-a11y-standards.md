# Accessibility standards and patterns for a WebGL scene with a full DOM equivalent

Project: Mosshatch (Phase 0, research only). Written 2026-09-29. Every source below was opened and read on 2026-09-29 (access date for all URLs in the Source index, S1 to S31, unless a row says otherwise). Search snippets were not used as evidence.

## TL;DR

1. Target WCAG 2.2 Level AA (W3C Recommendation, updated 12 Dec 2024; ISO/IEC 40500:2025 = the Oct 2023 text). WCAG 3 is only a Working Draft (10 Sep 2026) and "does not replace WCAG 2" [S1, S2, S3]. The EU legal reference is still EN 301 549 v3.2.1 (WCAG 2.1 AA); v4.1.1 (WCAG 2.2) was published Sep 2026 but is not yet cited in the Official Journal [S13, S14].
2. EAA: an online domain shop selling to EU consumers is very likely an "e-commerce service" (Art 2(2)(f), recital 43; no guidance names domains) and non-EU sellers are covered (Art 3(4)), BUT microenterprises (fewer than 10 staff and turnover or balance sheet at most EUR 2M) providing services are exempt (Art 4(5); DE BFSG s.3(3); IE Reg 5(4)) [S11, S15, S16]. Launch-stage Mosshatch is probably exempt; the exemption ends when it grows; get a lawyer to confirm (see section 1.5).
3. US: no Title III technical regulation exists; federal web-access suits were 3,117 in 2025 (+27%) and Title III filings hit 5,006 in H1 2026; Section 508 matters only if selling to US federal agencies (WCAG 2.0 AA) [S17, S18, S20].
4. Computed contrast (script in section 4): Lantern on Night 9.61:1, Ink on Lantern 10.51:1, Shell on Night 14.31:1, Shell on the frosted glass 6.29:1 even over pure white. Failures: Lantern focus ring or text on a Shell surface is 1.49:1, Shell on Pool is 2.80:1. A three-band ring (Night | Lantern | Night) is at least 3.10:1 on any background.
5. State dot hues have almost identical lightness (needs-attention vs traveling 1.01:1, healthy vs traveling 1.04:1), so colour cannot carry state; every state needs shape plus text (1.4.1).
6. Hold-to-reveal: the 2.1.1 Understanding lists "a key must be held down for an extended period" as a specific timing, so treat a hold-only keyboard path as a failure; ship a single-activation path with confirmation. The 10 s auto re-hide is a 2.2.1 time limit: make it adjustable (10x range) and never put the value in a live region.
7. `prefers-reduced-motion` alone is not a listed sufficient technique for 2.2.2 (C39 is for 2.3.3, AAA); keep the in-page Calm control, make it a real pause, and make the Arrival demo play once and be pausable.
8. axe-core 4.13.0 (2026-08-05) has 105 rules; only `target-size` maps to a WCAG 2.2 SC and it is OFF by default (verified by probe; Playwright's own docs example omits `wcag22aa`). It returns colour-contrast "incomplete" for text on glass over a canvas and cannot see hold, drag, focus-obscured or announcement quality. Vendor claim: about 57% of issues.
9. Screen reader matrix (WebAIM #11, Jul-Aug 2026, n=1780): JAWS 55.0% primary, NVDA 32.9%, VoiceOver 6.5%; JAWS+Chrome is the top pair (31.2%); mobile: VoiceOver 72.2%, TalkBack 29.5%. Add JAWS to the NVDA/VoiceOver/TalkBack plan. Budget checklist: section 8 (58 gates).

## 0. Method, fetch notes and limits

- Fetched with curl and the Chrome user agent first. w3.org answered 403 "Just a moment" (Cloudflare challenge); headless Chromium also failed because the challenge host `brunhild.challenges.cloudflare.com` is rejected by the egress proxy (recorded as blocked by egress policy; not worked around). The same w3.org pages returned 200 to curl with the plain user agent `Mozilla/5.0`, which was used for public W3C specification pages only. EUR-Lex (AWS WAF challenge, HTTP 202) was read through headless Chromium.
- WebSearch was unavailable (the shared 200-call budget was already used), so sources were located by opening known primary URLs directly. Consequence: no third-party commentary was searched for; gaps are listed in section 9.
- Empirical checks run here: (a) the contrast script `a11y/contrast.py` (output `a11y/contrast-output.txt`), (b) an axe-core 4.13.0 probe in headless Chromium with a real WebGL2 canvas (`a11y/axe/test.html`, `run.js`, `run-output.txt`), (c) queries of `axe.getRules()` and of npm registry metadata, (d) MDN browser-compat-data 8.1.3 and caniuse `data.json` (updated 2026-09-28) for browser support.
- Scratch files live in `working-directory/research/a11y/` (raw pages in `raw/`).
- Palette and UI rules come from the project brief (`scratchpad/brief.md` section 4): Night #131a33, Canopy #16302b, Moss #9dbb55, Lantern #ffb257, Shell #f1ead8, Pool #3a9a98, Ink #0c1122; state colours sleeping #8fa3c8, needs attention #ff9a7e, traveling #b9a7ff; glass rgba(11,18,33,.72) with 14 to 20px blur; targets at least 44px; focus in Lantern.
- Assumptions I made (veto them): Mosshatch sells to individuals as well as businesses in the EU; the operating entity is small at launch; the DOM is the primary UI and the canvas is presentational; Stripe-hosted Checkout stays the payment step; passkeys are the only sign-in method.
- "Confidence" in the findings register: high = read in a primary source; medium = primary source plus my interpretation; low = inference.

## 1. Standards and legal status

### 1.1 Standards status table

| Item | Status on 2026-09-29 | Evidence (source, quote) |
|---|---|---|
| WCAG 2.2 | W3C Recommendation, 12 December 2024 (first published 5 Oct 2023). 9 new SCs vs 2.1; 4.1.1 Parsing removed. Backwards compatible with 2.1 and 2.0 [S1, S3, S4] | S3: "WCAG 2.2 does not deprecate or supersede WCAG 2.1"; "content that conforms to WCAG 2.2 also conforms to WCAG 2.1 and WCAG 2.0". S4: "4.1.1 Parsing is obsolete and removed from WCAG 2.2." |
| ISO/IEC 40500 | WCAG 2.2 (Oct 2023 text) is ISO/IEC 40500:2025; the Dec 2024 text is expected as ISO/IEC 40500:2026 "by late 2026" [S3] | S3: "WCAG 2.2 is an approved International Organization for Standardization (ISO) standard: ISO/IEC 40500:2025" |
| WCAG 3.0 | W3C Working Draft, 10 September 2026. Not citable as a requirement. "does not replace WCAG 2"; "still has several years of work" [S2] | S2: "It is inappropriate to cite this document as other than a work in progress."; "WCAG 3 does not replace WCAG 2. WCAG 2 is used around the world and will still be required by different countries for a long time to come."; "Meeting WCAG 2 at AA level means you will be close to meeting WCAG 3" |
| EN 301 549 v3.2.1 (2021) | Still the reference the EAA and Web Accessibility Directive rely on; based on WCAG 2.1 AA [S13] | S13: "Until the European Commission formally cites EN 301 549 v4.1.1 in the Official Journal of the European Union, the current reference remains EN 301 549 v3.2.1 (2021), which is based on WCAG 2.1 Level AA." |
| EN 301 549 v4.1.1 (2026-09) | Published September 2026 (ETSI adoption 24 Aug 2026; ETSI deliver folder dated 2 Sep 2026). Clauses 9 to 11 aligned to WCAG 2.2. New Annex ZB maps to the EAA. Presumption of conformity only "Once the present document is cited in the Official Journal" [S13, S14] | S14 foreword: "the requirements of clauses 9, 10 and 11 have all been updated to align with the WCAG 2.2 recommendation"; new clause 9.7 "User preferences for web pages" (see section 3.6) |
| WAI-ARIA 1.2 | W3C Recommendation, 6 June 2023 [S7] | S7 header: "W3C Recommendation 06 June 2023" |
| "Using ARIA" note | Discontinued Draft (24 Feb 2026); use the APG instead [S31] | S31: "Using ARIA is a Discontinued Draft ... For further guidance ... see the ARIA Authoring Practices Guide (APG)." |
| WebAuthn Level 3 | W3C Recommendation, 25 August 2026; has a dedicated Accessibility Considerations section [S28] | S28 s.15.1: "Recommended range: 300000 milliseconds to 600000 milliseconds. Recommended default value: 300000 milliseconds (5 minutes)." |
| Section 508 (US federal) | Revised 508 Standards incorporate WCAG 2.0 Level AA [S20] | S20: "The Revised 508 Standards incorporate by reference the WCAG 2.0 Level AA Success Criteria" |
| DOJ ADA Title II web rule (US state and local government only) | WCAG 2.1 AA; compliance dates extended by an Interim Final Rule published 20 Apr 2026 to 26 Apr 2027 (population 50,000 or more) and 26 Apr 2028 (smaller) [S17] | S17: "extending the compliance date for State and local government entities with a total population of 50,000 or more to April 26, 2027." Not applicable to a private registrar; shown because it is the only US web-accessibility technical standard in a regulation. |

Reading: WCAG 2.2 AA is the right build target. It is a superset of what the EU (2.1 AA today) and US (no Title III regulation; 2.0 AA for Section 508; 2.1 AA for Title II) currently require, and the EU's own next reference standard is already on WCAG 2.2. WCAG 3 should be ignored for compliance in 2026 and watched.

### 1.2 European Accessibility Act (Directive (EU) 2019/882): does it apply?

Directive text read from EUR-Lex [S11]. Step by step:

| # | Question | Answer | Basis (quote) |
|---|---|---|---|
| 1 | From when does it apply? | 28 June 2025. My reading: a service launched after that date gets no transitional relief. | Art 31(2): "They shall apply those measures from 28 June 2025." Art 32(1) transitional periods only cover services using products lawfully used before, and "Service contracts agreed before 28 June 2025 may continue without alteration until they expire, but no longer than five years from that date." |
| 2 | Is an online domain-registration shop within scope? | Very likely yes, as an "e-commerce service". This is my reading of the text; I found no Commission guidance or case that names domain registration (unverified, see section 9). | Art 2(2)(f) lists "e-commerce services"; Art 3(30): "'e-commerce services' means services provided at a distance, through websites and mobile device-based services by electronic means and at the individual request of a consumer with a view to concluding a consumer contract"; recital 43: "The e-commerce services accessibility obligations of this Directive should apply to the online sale of any product or service" |
| 3 | Does it reach a non-EU seller? | Yes, if it offers to consumers in the Union. | Art 3(4): "'service provider' means any natural or legal person who provides a service on the Union market or makes offers to provide such a service to consumers in the Union" |
| 4 | Who is a "consumer"? | Natural persons acting outside trade, business, craft or profession. Business-only customers are not consumers; a mixed audience (solo builders who register personal projects) is. | Art 3(22): "'consumer' means any natural person who purchases the relevant product or is a recipient of the relevant service for purposes which are outside his trade, business, craft or profession" |
| 5 | What must an e-commerce service do? | Make the website accessible (perceivable, operable, understandable, robust), give accessibility information, and make identification, security and payment functionality accessible. | Annex I Section III(c); Section IV(g)(ii): "ensuring the accessibility of the functionality for identification, security and payment when delivered as part of a service instead of a product by making it perceivable, operable, understandable and robust". This lands directly on passkey sign-in, step-up approvals and the hosted payment page. |
| 6 | Information duty | Accessibility information goes in the general terms and conditions (or equivalent). | Annex V(1): "The service provider shall include the information assessing how the service meets the accessibility requirements referred to in Article 4 in the general terms and conditions, or equivalent document." |
| 7 | Micro-enterprise exemption for services | Yes. Exempt from Annex I Sections III and IV and from "any obligations relating to the compliance". Definition: fewer than 10 persons AND turnover or balance sheet not above EUR 2M. Must "genuinely fulfil" Recommendation 2003/361/EC, which is aimed at "preventing the circumvention of its rules" (linked and partner enterprises count). | Art 4(5): "Microenterprises providing services shall be exempt from complying with the accessibility requirements referred to in paragraph 3 of this Article and any obligations relating to the compliance with those requirements."; Art 3(23); recital 53; recital 70: "demanding such an assessment from microenterprises providing services would in itself constitute a disproportionate burden" |
| 8 | Other relief | Fundamental alteration or disproportionate burden may be claimed, but must be assessed, documented, and renewed at least every 5 years. Not available to skip the exercise cheaply. | Art 14(1) to (5) |
| 9 | Third-party content | Excluded from the content scope only if "neither funded, developed by, or under the control of, the economic operator concerned". Stripe-hosted Checkout is chosen by Mosshatch and is the payment step Annex I IV(g) is about, so treat it as in the flow (my interpretation). | Art 2(4)(d) |

Consequence: if Mosshatch launches as a micro-enterprise it has no EAA compliance obligation, but (a) the exemption is lost as soon as it has 10 or more people or turnover and balance sheet both exceed EUR 2M (test on linked enterprises), (b) a voluntary accessibility statement is cheap, and (c) US and contractual exposure is independent of the EAA.

### 1.3 EAA national enforcement (Directive minimums plus two national texts read)

| Layer | What the law says | Source |
|---|---|---|
| Directive | Member States "shall ensure that adequate and effective means exist to ensure compliance"; consumers can go to court or "competent administrative bodies"; associations "may engage ... either on behalf or in support of the complainant". Penalties "effective, proportionate and dissuasive"; account for "the number of persons affected". | Art 29(1) and (2), Art 30(2) and (4) [S11] |
| Germany (BFSG, in force for services from 28 Jun 2025) | Service providers include those who offer "auf dem Unionsmarkt" to consumers (s.2 Nr 4). Micro-enterprise services exempt: "Absatz 1 gilt nicht für Kleinstunternehmen, die Dienstleistungen anbieten oder erbringen." (s.3(3)). Enforcement by the Länder market-surveillance authorities (s.20), with spot checks without cause (s.28(2)), orders that can end in a stop order (s.29(3): "das Angebot oder die Erbringung der Dienstleistung einzustellen"). Consumers and recognised associations can force the authority to open proceedings (s.32) and challenge in administrative court (s.33). Fine up to EUR 100,000 for offering a service in breach of s.14(1) (s.37(1) Nr 8, (2): "bis zu hunderttausend Euro"); up to EUR 10,000 for information failures. | [S15] |
| Ireland (S.I. 636/2023, in operation 28 Jun 2025) | The Competition and Consumer Protection Commission is the compliance authority for e-commerce services (Reg 4(2)(g), which points at Reg 3(2)(g) e-commerce services). Micro-enterprise exemption: "Paragraph (3) and Regulation 14 shall not apply to a service provided by a microenterprise." (Reg 5(4)). Offence penalties: summary conviction "a class A fine or ... imprisonment for a term not exceeding 6 months or to both"; on indictment "a fine not exceeding €60,000 or to imprisonment for a term not exceeding 18 months or to both" (Reg 32(6)). | [S16] |
| Other Member States | Not verified (France, Netherlands, Spain, Italy, others). The EU Commission's own recent news says formal complaints "remain rare" while barriers are widespread, which is not evidence of low enforcement risk. | [S13a] |

### 1.4 United States

| Topic | Fact | Source |
|---|---|---|
| Title III technical standard | None in regulation. DOJ: "The Department of Justice does not have a regulation setting out detailed standards, but the Department's longstanding interpretation of the general nondiscrimination and effective communication provisions applies to web accessibility." Seyfarth describes Title III web rulemaking as "now paused indefinitely". DOJ's 22 Sep 2025 regulatory agenda notice announced a re-examination of the Title II/III regulations on a "To Be Determined" timetable. | [S17], [S18] |
| Federal web-accessibility suits | 2025: 3,117 in federal court, +27% on 2024's 2,452; 36% of all 8,667 ADA Title III federal filings; NY 1,021, FL 961, IL 585; California federal courts only 4. H1 2026: 5,006 federal Title III suits (all types), +9% on H1 2025 (4,575), highest since 2021. | [S18] |
| Who gets sued | Seyfarth: "judges in New York federal courts have been more favorable toward plaintiffs when the defendant is an online-only business while in California, both federal and state courts of appeals have reached the conclusion that online only businesses are not covered by the ADA". Demand letters and state-court suits are not in the federal counts. | [S18] |
| Monthly tracker (vendor) | UsableNet, August 2026: 432 new ADA web accessibility lawsuits; 108 defendants previously sued; 134 sued "despite using a third-party accessibility widget". UsableNet sells accessibility services; treat as indicative. | [S19] |
| Defence value of effort | A New York federal court dismissed a website suit as moot on unrebutted evidence of "commercially reasonable" WCAG steps (Seyfarth, 1 Apr 2026). | [S18] |
| Section 508 | Applies to federal agencies "when they develop, procure, maintain, or use" ICT. Only relevant if Mosshatch sells to US federal buyers; then a conformance report against WCAG 2.0 AA (in practice 2.2 AA covers it) is the ask. | [S20] |

Design consequence: do not buy an "overlay" widget (UsableNet counts 134 defendants in one month who had one); fix the source. WCAG 2.2 AA plus a dated accessibility statement and a working feedback channel is the defensible posture.

### 1.5 What needs a lawyer

- Whether the Mosshatch operating entity is a "microenterprise" under Recommendation 2003/361/EC including linked/partner enterprises, when the threshold is crossed, and which Member State rules apply to each target market.
- Whether domain registration through a website is an "e-commerce service" in each target Member State (no guidance found), and whether business customers reduce exposure.
- Whether to put voluntary accessibility information in the Terms (Annex V style) and how to word it so it is accurate.
- US demand-letter response process, insurance, and any contractual accessibility warranties given to customers.

## 2. WCAG 2.2 success criteria that bite Mosshatch

Normative wording quoted from S1 (https://www.w3.org/TR/WCAG22/). "Understanding" pages are at `https://www.w3.org/WAI/WCAG22/Understanding/<slug>.html` (S5). "axe" = whether axe-core 4.13.0 has a rule (checked with `axe.getRules()` and the probe in section 6.2).

| SC (level) | What it says (short quote) | Where it bites in Mosshatch | Design response | axe? |
|---|---|---|---|---|
| 2.1.1 Keyboard (A) | "All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes" | Hold-to-reveal; scene tags; every panel action. Understanding: "specific timings" include "where a key must be held down for an extended period before the keystroke is registered". | Non-timed activation path for every hold; all tags are real buttons (section 3.2, 3.4) | Partial (nested-interactive, scrollable-region-focusable only) |
| 2.1.2 No Keyboard Trap (A) | "focus can be moved away from that component using only a keyboard interface" | Modal panels, sheet, canvas focus | Esc closes; no trap in scene container; test manually | No |
| 2.1.4 Character Key Shortcuts (A) | Turn off, remap, or active only on focus | Any single-key shortcut (for example "C" for Calm, "/" for search) | Avoid, or add Shift/Alt modifier, or only on focus | No |
| 2.2.1 Timing Adjustable (A) | Turn off, adjust to at least ten times, or extend with 20 s warning | 10 s secret auto re-hide; agent-approval expiry; Checkout session (Stripe: 30 minutes to 24 h); WebAuthn ceremony timeout. Understanding: security limits "can be considered essential, and may be exempt" | Reveal duration setting chosen before reveal (10 s, 30 s, 60 s, 120 s, until hidden); approvals do not silently expire mid-action | No |
| 2.2.2 Pause, Stop, Hide (A) | Moving content that "(1) starts automatically, (2) lasts more than five seconds, and (3) is presented in parallel with other content" needs "a mechanism for the user to pause, stop, or hide it" unless essential | Fireflies, drift, breathing, lantern flicker, water, the Arrival demo, wandering creature tags | In-page Calm control that truly freezes ambient loops; demo plays once and is pausable. Understanding lists sufficient techniques G4, G186 (a control in the page), G191; `prefers-reduced-motion` is not among them | Only `blink`, `marquee` |
| 2.3.1 Three Flashes (A) | "no more than three general flashes ... within any one-second period" or below threshold | Hatch flash, crack ticks, shard burst, attention pulse rings | One flash, lower than the general flash threshold (10% luminance pair, darker image below 0.80, area under 25% of a 10 degree field); none in Calm | No |
| 2.3.3 Animation from Interactions (AAA) | "Motion animation triggered by interaction can be disabled" | Camera dolly, fly-to, parallax, shake | Adopt as a target: Calm cuts these. Techniques C39 (CSS) and SCR40 (JavaScript `matchMedia`) are sufficient for 2.3.3 only | No |
| 2.4.7 Focus Visible (AA) | "Any keyboard operable user interface has a mode of operation where the keyboard focus indicator is visible." | Tags over a moving scene, glass panels | Three-band ring (section 4) | No |
| 2.4.11 Focus Not Obscured (Min) (AA) | "the component is not entirely hidden due to author-created content" | Detail panel, bottom sheet, bottom bar, sticky header covering tags. Understanding: "Typical types of content that can overlap focused items are sticky footers, sticky headers, and non-modal dialogs" and overlays "that apply a blur" may fail 1.4.11 for the ring | Modal on mobile, `scroll-padding`, Esc reveals hidden focus target | No |
| 2.5.1 Pointer Gestures (A) | Multipoint or path-based gestures need a single-pointer alternative | Any pinch or drag camera. Understanding: alternatives include "tap, click, double tap, double click, long press, or click & hold" | Camera only moves by selection or buttons; no pinch-zoom on the scene | No |
| 2.5.2 Pointer Cancellation (A) | No down-event execution, or abort/undo, or up reversal | Hold-to-reveal. Understanding names the pattern: "press-and-hold actions such as where a transient popup appears ... but the popup ... disappears as soon as the user releases the pointer" | Release before completion aborts; "Hide now" undoes | No |
| 2.5.3 Label in Name (A) | "the name contains the text that is presented visually" | Tags: state dot plus domain; chips with name, extension, price; voice control users say the visible text | Accessible name starts with the visible text: "moonfern.dev, healthy" | Experimental (`label-content-name-mismatch`, off) |
| 2.5.4 Motion Actuation (A) | Motion-operated functions need UI alternatives and disabling | Any gyro or shake parallax on phones (brief lists only pointer parallax) | Do not use device motion | No |
| 2.5.7 Dragging Movements (AA) | "achieved by a single pointer without dragging" | Any drag of the crate, egg, ledger column reorder | Do not require drag; Rescue crate is animation only | No |
| 2.5.8 Target Size (Min) (AA) | "at least 24 by 24 CSS pixels" unless spacing, equivalent, inline, user agent, essential | Projected tags and chips; charms; dots. Understanding: the "Equivalent" exception applies when "another control ... meets the requirements", which the Ledger row controls do | Build to 44 (AAA 2.5.5 and Apple 44x44 pt) with a 24 floor; measure the DOM box, not the sprite | Yes but off by default; needs tag `wcag22aa` or `withRules(['target-size'])` |
| 3.2.1 On Focus (A) | "does not initiate a change of context" | Focusing a tag must not open a panel or navigate | Focus highlights only (camera nudge allowed, cut in Calm); Enter/click opens | No |
| 3.2.6 Consistent Help (A), 3.3.7 Redundant Entry (A) | Help in the same relative place; do not re-ask for data in the same process | Rescue three-step flow; Hatch sheet then Stripe (contact details) | Consistent help link in header; auto-populate | No |
| 3.3.4 Error Prevention (AA) | Legal or financial transactions: reversible, checked, or confirmed | "Pay and hatch"; transfer out; token creation | The Hatch sheet is the review step; transfer has cooling-off and cancel | No |
| 3.3.8 Accessible Authentication (Min) (AA) | No "cognitive function test" unless alternative, mechanism, object recognition or personal content | Passkey sign-in and step-up; account recovery | Understanding: "A website uses WebAuthn so the user can authenticate with their device instead of username/password." and OS mechanisms "such as Windows Hello, or Touch ID/Face ID" "are not a cognitive function test". Recovery codes must be pasteable/autofillable | No |
| 4.1.2 Name, Role, Value (A) | Name and role programmatically determinable; state changes notified | Tags, toggles (Calm, Sound), tabs, hold control | Native `button`; `aria-pressed` on toggles with a stable label (APG: "it is critical the label on a toggle does not change when its state changes") | Yes (many rules) |
| 4.1.3 Status Messages (AA) | "status messages can be programmatically determined through role or properties such that they can be presented ... without receiving focus" | Transfer pending, DNS spreading, registration, payment failed, approval requests | Section 3.5 | No (only checks ARIA validity) |
| 1.3.3 Sensory Characteristics (A) | Instructions do not rely "solely on sensory characteristics ... such as shape, color, size, visual location, orientation, or sound" | "Tap the glowing egg" copy; wisp waits with "?" | Text instructions name the control, not its look | No |
| 1.4.1 Use of Color (A) | "Color is not used as the only visual means of conveying information" | State dots, price emphasis, extension in Lantern | Dot + shape + text (section 3.8) | Partial (`link-in-text-block`) |
| 1.4.2 Audio Control (A) | Audio playing over 3 s needs pause/stop or independent volume | Wind-and-crickets bed | Off by default; header toggle is the control | Yes for media elements only (`no-autoplay-audio`), not Web Audio |
| 1.4.3 Contrast (Min) (AA) | 4.5:1 text, 3:1 large; Understanding: "computed values should not be rounded (e.g., 4.499:1 would not meet the 4.5:1 threshold)" | All text on Night, glass, Shell cards, Lantern buttons | Token table in section 4 | Partial; "incomplete" over canvas |
| 1.4.11 Non-text Contrast (AA) | "at least 3:1 against adjacent color(s)" for UI components, states and graphics | Focus ring, dots, outlines, progress ring, checkboxes | Section 4 | Not for CSS-drawn states or focus rings |
| 1.4.13 Content on Hover or Focus (AA) | Dismissible, hoverable, persistent | Tag tooltips, price explainer, "The deal" | Esc dismisses; pointer can enter the tooltip | No |
| 1.4.10 Reflow, 1.4.4 Resize Text, 1.4.12 Text Spacing, 1.3.4 Orientation (AA) | 320 CSS px reflow; 200% text; spacing overrides; no orientation lock | Panel and sheet on phones; portrait FOV logic | Test at 320 px and 400% zoom; never lock orientation | Partial (`meta-viewport`, `avoid-inline-spacing`) |
| 5.2.3 Complete processes; 5.2.5 Non-interference | All pages of a purchase process must conform; 1.4.2, 2.1.2, 2.3.1 and 2.2.2 apply to all content even if not "relied upon" | Find, Hatch sheet, Stripe, confirmation; the WebGL scene | Scene motion, sound and flashes are in scope even though the DOM carries the function | No |

Conforming alternate version, for the Ledger: it must provide "all of the same information and functionality in the same human language" and be "as up to date as the non-conforming content" (S1 definition). Practical rule: nothing in the scene may be doable or readable only there. The recommended architecture makes the DOM the primary UI and the canvas presentational, so the Ledger is a peer view, not a bolt-on alternate.

## 3. Patterns

### 3.1 Canvas plus DOM overlay: make the DOM the product

Facts from the HTML Standard [S9]: when a canvas is rendered, "the user can still focus descendants of the canvas element (in the fallback content)"; "authors should have a one-to-one mapping of interactive regions to focusable areas in the fallback content. (Focus has no effect on mouse interaction events.)"; and "When a canvas is interactive, authors should include focusable elements in the element's fallback content corresponding to each focusable part of the canvas". That pattern is for canvases that are the interaction surface. Mosshatch's brief (non-negotiable 7) inverts it: everything in the scene has a DOM equivalent, so the canvas is presentation only.

Recommended structure (my synthesis of S9, S1, S7, S8):

- `<canvas aria-hidden="true">` with no children. Nothing focusable inside it, which also keeps axe's `aria-hidden-focus` rule ("Ensure aria-hidden elements are not focusable nor contain focusable elements") quiet. Pointer events on the canvas may drive hover/parallax only; every action is also a DOM control.
- One `<main>` holding the overlay: a heading, the search input, the egg chips, the creature tags (real `<button>` or `<a>`), the summary bar ("7 creatures, 1 drowsy, 1 needs you"), and the Ledger link. `<header>` holds view links, Sound and Calm toggles. Skip link first (2.4.1). One `<h1>` per view and a distinct `document.title` per view (2.4.2). On SPA route change move focus to the view heading and update the title.
- Overlay container `pointer-events: none`; tags `pointer-events: auto`. Position tags with `transform`, never by re-ordering or re-creating nodes per frame: recreating a focused node drops keyboard focus to `<body>`. Keep tag DOM order equal to Ledger sort order, not screen projection order (1.3.2, 2.4.3).
- A tag whose creature is behind the camera or off-screen stays in the DOM and stays focusable (parked in a stable offscreen slot or shown in the list layout); otherwise it is unreachable, which fails 2.1.1. The narrow-screen "horizontal list above the input" in the brief is the same idea.
- Tags that move while the user is trying to press them are a usability and 2.2.2 problem (constant movement that starts automatically and lasts over 5 s). Freeze a tag's position while it is hovered, focused or pressed; in Calm, freeze all tags.
- Parity test: a Playwright test that renders the Grove and the Ledger from the same fixture and asserts that, per domain, the name, state text, renewal text, lock state and connection labels are identical (`expect(locator).toMatchAriaSnapshot()` is available; S22).
- Text is never drawn in the canvas (1.4.5, 1.4.4, 1.4.12).

### 3.2 Hold-to-reveal with a keyboard path and an alternative for people who cannot hold

Guidance that applies (all read on 2026-09-29):

- 2.1.1 Understanding [S5]: "Examples of 'specific timings for individual keystrokes' include situations where a user would be required to repeat or execute multiple keystrokes within a short period of time or where a key must be held down for an extended period before the keystroke is registered." So "hold Space/Enter" cannot be the only keyboard route. This is my reading of how the criterion is applied; it is the sentence a reviewer would quote, and the cure is cheap.
- 2.5.1 Understanding [S5]: "Multipoint or path-based gestures can be used so long as the functionality can also be operated by another method, such as a tap, click, double tap, double click, long press, or click & hold." A long press is a legitimate single-pointer method; it is not a path-based gesture.
- 2.5.2 Understanding [S5] describes this exact pattern as acceptable: "press-and-hold actions such as where a transient popup appears (or a video plays) when the user presses on an object (down-event), but the popup (or video) disappears as soon as the user releases the pointer (up-event)". The normative options are No Down-Event, Abort or Undo, Up Reversal, Essential.
- Apple HIG Gestures [S26]: "Avoid requiring specific body movements or positions for input ... If your experience requires movement, consider supporting alternative inputs to let people choose the interaction method that works best for them." and "Offer both indirect and direct interactions when possible."
- 2.2.1 Timing Adjustable [S1, S5]: the 10 s auto re-hide is a time limit set by the content. Understanding says security-motivated limits "can be considered essential, and may be exempt", but relying on that is a judgement call; the cheap route is the "Adjust" option (at least ten times the default, set before it is met).

Proposed interaction (each row must be true):

| Input | Path | Notes |
|---|---|---|
| Pointer or touch | Press and hold the button; a ring fills over the hold time; release early aborts with no effect; at completion the passkey step-up starts, then the value shows | Nothing executes on `pointerdown` except starting the ring (2.5.2). A "Hide now" button undoes after completion. Ring also has a non-animated equivalent (percentage text or bar), so Calm does not remove the feedback. |
| Keyboard, timed | Hold Space or Enter; same ring; `keyup` before completion aborts; ignore `keydown` auto-repeat and measure elapsed time from the first `keydown` | Optional accelerator. |
| Keyboard, not timed (required) | Single press of Enter or Space (fires `click`) opens an inline confirmation "Reveal DATABASE_URL for 10 seconds? [Reveal] [Cancel]"; Reveal starts the passkey step-up | This is the alternative for anyone who cannot hold: switch users, tremor, one-handed use, voice control, and screen readers. |
| Screen reader, voice control, switch | Activation arrives as `click` (my inference: assistive technology commonly synthesises activation instead of a sustained key or pointer hold, so a handler that listens only for hold events would never fire). Verify in the screen reader matrix. | Treat `click` as the confirmation path, never as instant reveal. |
| No reveal at all | "Copy" (with the same step-up) copies to the clipboard without displaying; the CLI `mosshatch pull` is the third route | Keeps secrets out of view for people who have difficulty with timed reading. |

Announcements and focus for the reveal (see also 3.5):

- The control's accessible description says how it works: "Press and hold, or press Enter to choose Reveal." Hold progress is not announced every tick.
- On success a single polite status: "DATABASE_URL revealed for 10 seconds. It hides on its own." The countdown element uses `role="timer"` (ARIA 1.2: "Elements with the role timer have an implicit aria-live value of off"), so it is not read out each second.
- The value sits in a focusable read-only element so a screen reader user can read it by moving to it. The value is never placed in an `aria-live` region, `aria-label`, `title` or the accessibility tree while hidden (non-negotiable 1: no secret values outside the explicit reveal call). If the value is a live region it would be spoken automatically and could be sent to braille or speakers unattended.
- On re-hide, if focus is inside the value element, move focus to the Reveal button and announce "Hidden" so focus does not fall to `<body>`.
- Reveal duration setting in Nest settings: 10 s (default), 30 s, 60 s, 120 s, until hidden. This satisfies 2.2.1 "Adjust" (10x range) provided it is choosable before the first reveal.
- Hold time itself should be configurable or short (about one second) and never require pressure or movement while holding (avoid requiring the pointer to stay inside a tiny circle: 2.5.8 and motor control). I did not verify OS hold-duration accessibility settings on iOS or Android (section 9), so do not rely on them.

### 3.3 Focus management when a panel opens over the scene

- Desktop detail panel next to the scene: the scene stays usable, so this is a non-modal dialog. HTML `<dialog>` opened with `show()` is exposed as `aria-modal="false"`; with `showModal()` it is modal (MDN [S10]: "`<dialog>` elements invoked by the `showModal()` method implicitly have `aria-modal="true"`, whereas `<dialog>` elements invoked by the `show()` method ... are exposed as `[aria-modal="false"]`"). Give it an accessible name (the domain).
- On open, move focus into the panel. APG (Dialog modal pattern, also good advice here) [S8]: for large content "add `tabindex="-1"` to a static element at the top of the dialog, such as the dialog title or first paragraph, and initially focus that element." Use the panel heading. Do not focus a tab in the middle of the tab list.
- Esc closes the panel and returns focus to the tag that opened it. If that tag no longer exists, focus the tag list heading, never `<body>`.
- Mobile bottom sheet: treat as modal (`showModal()`); APG: "Windows under a modal dialog are inert." Mark the scene overlay and header `inert` when a non-`<dialog>` sheet is used (MDN: `inert` on any element; supported Chrome 102, Firefox 112, Safari 15.5 [S27]).
- Tabs inside the panel (Overview, DNS, Nest, Bindings, Gate): APG tabs pattern, Left/Right arrows move between tabs, Home/End optional, automatic activation "as long as their associated tab panels are displayed without noticeable latency" [S8].
- 2.4.11: the panel, bottom bar and any sticky header must not entirely cover the focused tag. Set `scroll-padding` on scroll containers; on desktop the Detail camera view already offsets the creature beside the panel; Esc must reveal what the panel hides (Understanding note: content opened by the user may obscure if "the user can bring the item with focus into view ... without having to navigate back to the user-opened content"). Blur behind glass can push the focus ring under 3:1 (Understanding: it "may separately fail 1.4.11"); use the three-band ring.
- 3.2.1: focusing a tag must not open the panel; Enter or click does.

### 3.4 Roving tabindex for creature tags

APG keyboard-interface algorithm [S8]: "the element that is to be included in the tab sequence has tabindex="0" and all other focusable elements contained in the composite have tabindex="-1"." Arrow keys move the zero; Home and End jump.

Recommendation (judgement, not a spec threshold): with about 12 or fewer tags use ordinary tab stops in Ledger order (simplest, and voice control and switch scanning work without knowing about roving). Above that, put the tags in one labelled group (`role="group"` or a list with a heading), use roving tabindex with arrow keys, Home/End, and provide a "Skip to Ledger" link first in the group. Keep `aria-selected`/`aria-current` out of it unless the tags behave as a listbox. The Ledger (real `<table>`, sortable headers as buttons with `aria-sort`, per APG's sortable-table example [S8]) remains the complete keyboard-friendly alternative.

Accessible names: visible text first (2.5.3): "moonfern.dev, healthy", "hatchkind.studio, needs attention: verification record missing". Do not put only an icon in the name.

### 3.5 Announcing async states (transfer pending, DNS spreading) without noise

Source facts: ARIA 1.2 [S7]: "Elements with the role status have an implicit aria-live value of polite and an implicit aria-atomic value of true."; "Authors SHOULD ensure an element with role status does not receive focus as a result of change in status."; alert: "implicit aria-live value of assertive"; "authors SHOULD NOT require users to close an alert." Technique ARIA22 [S6]: add an explicit `aria-atomic="true"` because `role=status` "is currently not treated as atomic by default in some environments". MDN [S10]: "Establish the live region before updating its content. Start with an empty live region, then allow time for it to be exposed to assistive technologies before updating its content."; `aria-live="assertive"` "should only be used for time-sensitive/critical notifications ... and should only be used sparingly." Understanding 4.1.3 [S5]: the intent is "to make users aware of important changes in content that are not given focus, and to do so in a way that doesn't unnecessarily interrupt their work"; removal of a "busy" message conveys status, so end the wait with visible or hidden text ("system available").

Rules for Mosshatch (synthesis):

1. Mount two empty regions at app start and never unmount them: `<div role="status" aria-atomic="true">` (polite) and `<div role="alert">` (assertive, errors only).
2. Announce transitions, not polls. Because "Statuses come from the adapter, not from timers" (brief 2.6), announce only when the adapter reports a new state. Silence on a poll with no change.
3. One sentence, subject first, plain verbs, no numbers you cannot back up: "moonfern.dev: DNS change is spreading." then "moonfern.dev: DNS change has spread." only after confirmation.
4. Coalesce bursts: wait one short window (for example 1 s) and announce the latest per domain; if more than 3 domains change, announce a summary ("4 domains changed. Open the Ledger.") and let the Ledger carry detail. (Window and count are my proposals, tune in the screen reader pass.)
5. Every announced state also exists as persistent text on the tag, Ledger row and panel, because announcements are ephemeral.
6. Payment failed, passkey rejected, agent-approval needed (money): approval needed gets polite plus a visible badge and an email (Resend), failures needing action get the assertive region once.
7. Never include secret values in any live region.

| Event | Region | Message pattern | Persistent text |
|---|---|---|---|
| Payment confirmed, registration pending | polite | "moonfern.dev: paid. Registering now." | Egg chip "Registering" |
| Registry confirmed | polite | "moonfern.dev is registered." | Tag state "Healthy. Nothing needs you." |
| Payment failed | alert | "Payment for moonfern.dev failed. Check your card and try again." | Inline error with next step |
| Transfer started | polite once | "moonfern.dev: transfer started. It can take days." | Traveling: "Transfer in progress" |
| Transfer confirmed by registry | polite | "moonfern.dev: transfer complete." | Tag state changes |
| DNS write in flight | polite once | "moonfern.dev: DNS change is spreading." | Shedding: "Your DNS change is spreading" |
| Step-up waiting | polite | "Waiting for your passkey." | Visible status text in the panel |
| Reveal started/ended | polite | "DATABASE_URL revealed for 10 seconds." / "Hidden." | Timer text |
| Agent wants approval | polite | "Claude Code wants to hatch hatchkind.studio for $24.99. Approve or decline." | Approval card, badge on Bindings |

### 3.6 Reduced motion and Calm mode

Facts: `prefers-reduced-motion` support 96.45% of global usage (caniuse data updated 2026-09-28; first supported Chrome 74, Firefox 63, Safari 10.1) [S27]. MDN [S10]: "Animations such as scaling or panning large objects can be vestibular motion triggers." That names the camera dolly, fly-to, drift and parallax. W3C techniques for reading the preference in script: SCR40 uses `window.matchMedia("(prefers-reduced-motion: no-preference)")` [S6]. Playwright can emulate it: `page.emulateMedia({ reducedMotion: 'reduce' })` (also `forcedColors` and `contrast: 'more'`) [S22].

EN 301 549 V4.1.1 clause 9.7 (new, not in WCAG 2.2) [S14]: "the web page shall not block the user agent's mode(s) of operation that present the web page according to user preference settings, or explicitly override user preference settings for documented platform accessibility features in these modes of operation, unless this is essential to the information or function of the web page." Note 4 singles out `forced-color-adjust`; Note 5 lists "colour filters, contrast, text size, pointer size, and text cursor".

Pattern:

- Start in Calm when `matchMedia('(prefers-reduced-motion: reduce)').matches` (brief 2.8); subscribe to the `change` event; the header Calm toggle then overrides either way and remembers the choice (localStorage, wrapped in try/catch, is fine for this per-viewer convenience).
- Calm is a real pause, not "less". 2.2.2's sufficient techniques are page-level controls (G4, G186, G191 per Understanding [S5]); C39 and SCR40 are listed as sufficient for 2.3.3 only [S6]. So the control must be in the page, early in DOM order, keyboard operable, `aria-pressed` with a stable label "Calm mode" (APG button: "it is critical the label on a toggle does not change when its state changes" [S8]).
- Render on demand in Calm: no idle animation loop; redraw when state changes or the user acts. This also serves the performance budget.

| Feature (brief section 5/6) | Normal | Calm |
|---|---|---|
| Camera drift, pointer parallax, shake, dolly, fly-to | On, damped | Off; cuts (instant reframe) |
| Fireflies, pollen, burst particles | On | Off |
| Creature idle (breathing, blink, tail sway, wander) | On | Pose held; state shown by static pose plus text and shape |
| Lantern flicker and swing, ambient water ripple | On | Static |
| Hatch ceremony | Full, with one flash below the flash threshold, cancellable with Esc or a Skip button | Short static reveal, no flash, card shown at once |
| Attention pulse rings | Pulse | Static ring (still 3:1) |
| Arrival demo | Plays once, labelled "Demo", pausable, cancels on any input | Not started; shows the end frame |
| Creature tags | Follow creatures, freeze while hover/focus/press | Fixed positions |
| Sound | Off by default; header toggle | Same: off by default, header toggle |

Flash: WCAG general flash = "a pair of opposing changes in relative luminance of 10% or more of the maximum relative luminance (1.0) where the relative luminance of the darker image is below 0.80"; the threshold is "no more than three general flashes ... within any one-second period" or a combined flashing area of no more than "25% of any 10 degree visual field" (roughly a 341 x 256 px rectangle at 1024 x 768) [S1]. The full-screen hatch flash must be a single event and tested by frame capture.

Transparency and contrast preferences: `prefers-reduced-transparency` is experimental and not in Safari (Chrome 118, Firefox behind a flag, Safari false; MDN BCD 8.1.3) [S27], so do not depend on it. Provide: opaque panel fallback in Calm and under `forced-colors: active` (Chrome 89, Firefox 89, Safari 16), and `prefers-contrast: more` (Chrome 96, Firefox 101, Safari 14.1) opaque Night panels with a 1px Shell border at full opacity.

### 3.7 Sound that never carries information alone

- 1.4.2: audio over 3 s that plays automatically needs a pause/stop or volume control; the brief starts sound off, so nothing plays automatically and the header toggle is the control.
- 1.3.3: instructions must not rely solely on sound [S1]. The EAA says service information must be available "via more than one sensory channel" (Annex I Section III(b)(i)) [S11].
- Every cue has a visible twin: hatch crack and chime -> the visible "Hatched" state and status message; purchase chime -> receipt text; lock/unlock clicks -> switch state text; family voices -> decorative only, on "Hear it call" button.
- Toggle: `aria-pressed`, stable label "Sound", off at first load, remembered. No vibration as a substitute (Navigator.vibrate is unsupported in Safari and iOS per MDN BCD [S27]).

### 3.8 Colour-independent state (dots plus text)

1.4.1: "Color is not used as the only visual means of conveying information" [S1]. The state dots (Moss, Lantern, #8fa3c8, Pool, #ff9a7e, #b9a7ff, Shell) are all bright mid-luminance hues, so lightness cannot separate them: measured luminance contrast between pairs is as low as 1.01:1 (needs-attention vs traveling), 1.04:1 (healthy vs traveling), 1.05:1 (healthy vs needs-attention). Section 4 lists all pairs. Therefore:

| State | Text (always shown) | Non-colour cue proposed |
|---|---|---|
| Healthy | "Healthy. Nothing needs you." | Filled circle |
| Drowsy | "Renews in N days" | Half-filled circle |
| Sleeping | "Expired, N days left" (from registry status) | Ring with a small bar (crescent) |
| Shedding | "Your DNS change is spreading" | Wavy ring |
| Armored | "Transfer lock on" | Square with inset |
| Needs attention | the one specific thing to do | Triangle |
| Traveling | "Transfer in progress" | Chevron/arrow |
| Egg | "Registering" | Oval outline |

Shapes are drawn as SVG (no emoji in the UI, brief section 10). In `forced-colors` mode SVG fills should use `currentColor`/system colours and shapes carry the meaning.

### 3.9 Passkeys and 3.3.8

- Understanding 3.3.8 [S5] lists "A website uses WebAuthn so the user can authenticate with their device instead of username/password" as a pass and says OS mechanisms such as "Windows Hello, or Touch ID/Face ID on macOS and iOS" "are not a cognitive function test". Cross-device flows by QR code count as possession, not a cognitive test. WebAuthn L3 s.15 [S28]: authenticators "should offer users more than one user verification method"; RPs "at registration time, SHOULD provide affordances for users to complete future authorization gestures correctly" (name the authenticator); ceremonies "ought to follow [WCAG21]'s Guideline 2.2 Enough Time" with timeout 300000 to 600000 ms, default 300000.
- Where Mosshatch can still fail 3.3.8: account recovery by typed code (must allow paste and `autocomplete="one-time-code"`; "A service that requires manual transcription of a verification code is not compliant."), CAPTCHA on sign-in, any "type these characters" confirmation. Do not add them. Step-up prompts should be started by an explicit button, announce "Waiting for your passkey", and offer Cancel.

### 3.10 Time limits summary

| Limit | Value | Treatment |
|---|---|---|
| Secret auto re-hide | 10 s (brief) | Adjustable set, warning not possible at 10 s; see 3.2 |
| WebAuthn ceremony | 300000 to 600000 ms recommended [S28] | Use 300000 or more |
| Stripe Checkout Session | default 24 h; configurable, "anywhere from 30 minutes to 24 hours after Checkout Session creation" [S29] | Keep long; if it expires, recreate without re-asking data (3.3.7) |
| Agent approval | not specified | Do not auto-expire while the approval card is open; show requested time |
| Session cookie | short-lived (brief) | AAA 2.2.5 (re-authenticate without data loss) is a good target for forms |

## 4. Computed contrast (script output, not memory)

Method: WCAG 2.2 relative-luminance and contrast-ratio definitions read from S1 (`threshold 0.04045`, `(L1 + 0.05) / (L2 + 0.05)`). Ratios are not rounded when compared to thresholds (Understanding 1.4.3: "4.499:1 would not meet the 4.5:1 threshold"). Script: `a11y/contrast.py` (full output `a11y/contrast-output.txt`); tables below were generated by `a11y/mdtables.py`. Palette from the brief. Glass = rgba(11,18,33,.72) alpha-blended over the backdrop in sRGB; the 14 to 20px blur only averages the backdrop, so a flat-colour backdrop is a fair bound. Bloom or specular peaks can push a backdrop toward white, so pure white is the stress case.

| Foreground on background | Ratio | Text 4.5:1 | UI 3:1 | Use |
|---|---|---|---|---|
| Lantern #ffb257 on Night #131a33 | 9.61:1 | pass | pass | Lantern text or ring on the page ground |
| Ink #0c1122 on Lantern #ffb257 | 10.51:1 | pass | pass | Primary button label (Ink on Lantern) |
| Shell #f1ead8 on Night #131a33 | 14.31:1 | pass | pass | Body text on the page ground |
| Shell #f1ead8 on Canopy #16302b | 11.73:1 | pass | pass | Text on foliage tone |
| Lantern #ffb257 on Canopy #16302b | 7.88:1 | pass | pass | Lantern on Canopy |
| Moss #9dbb55 on Night #131a33 | 7.91:1 | pass | pass | Moss text or graphic on Night |
| Pool #3a9a98 on Night #131a33 | 5.11:1 | pass | pass | Pool text or graphic on Night |
| sleeping #8fa3c8 on Night #131a33 | 6.74:1 | pass | pass | Sleeping dot on Night |
| needs-attention #ff9a7e on Night #131a33 | 8.32:1 | pass | pass | Needs-attention dot on Night |
| traveling #b9a7ff on Night #131a33 | 8.20:1 | pass | pass | Traveling dot on Night |
| Ink #0c1122 on Shell #f1ead8 | 15.64:1 | pass | pass | Ink text on a Shell card (paper) |
| Ink #0c1122 on Moss #9dbb55 | 8.64:1 | pass | pass | Ink on Moss fill |
| Ink #0c1122 on Pool #3a9a98 | 5.59:1 | pass | pass | Ink on Pool fill |
| Lantern #ffb257 on Shell #f1ead8 | 1.49:1 | FAIL | FAIL | Lantern focus ring or text on a Shell surface |
| Shell #f1ead8 on Pool #3a9a98 | 2.80:1 | FAIL | FAIL | Shell text on a Pool fill |
| Shell #f1ead8 on Lantern #ffb257 | 1.49:1 | FAIL | FAIL | Shell text on a Lantern fill |

Frosted glass rgba(11,18,33,.72) composited over each backdrop (sRGB blend as browsers do; blur only averages the backdrop):

| Backdrop behind the glass | Composite | Shell text | Lantern (text) | Moss (text) | Pool (text) |
|---|---|---|---|---|---|
| Night #131a33 | rgb(13,20,38) | 15.25:1 pass | 10.25:1 pass | 8.43:1 pass | 5.45:1 pass |
| Canopy #16302b | rgb(14,26,36) | 14.64:1 pass | 9.84:1 pass | 8.09:1 pass | 5.23:1 pass |
| Pool water #3a9a98 | rgb(24,56,66) | 10.38:1 pass | 6.97:1 pass | 5.74:1 pass | 3.71:1 FAIL |
| Moss #9dbb55 | rgb(52,65,48) | 8.97:1 pass | 6.03:1 pass | 4.96:1 pass | 3.21:1 FAIL |
| Lantern halo #ffb257 | rgb(79,63,48) | 8.40:1 pass | 5.64:1 pass | 4.64:1 pass | 3.00:1 FAIL |
| Shell (moon, bright egg) #f1ead8 | rgb(75,78,84) | 6.90:1 pass | 4.64:1 pass | 3.82:1 FAIL | 2.47:1 FAIL |
| Pure white #ffffff | rgb(79,84,95) | 6.29:1 pass | 4.23:1 FAIL | 3.48:1 FAIL | 2.25:1 FAIL |
| Pure black #000000 | rgb(8,13,24) | 16.20:1 pass | 10.88:1 pass | 8.95:1 pass | 5.79:1 pass |

Glass alpha needed so coloured TEXT reaches 4.5:1 (brief alpha is 0.72):

| Text colour | Over Shell-coloured backdrop | Over pure white |
|---|---|---|
| Shell | alpha >= 0.592 | alpha >= 0.628 |
| Lantern | alpha >= 0.712 | alpha >= 0.737 |
| Moss | alpha >= 0.769 | alpha >= 0.790 |
| Pool | alpha >= 0.907 | alpha >= 0.915 |

State dots: contrast against the glass-over-Night panel and pairwise luminance contrast (values under 1.25 mean the hues are not separable by lightness):

| Dot | Colour | vs panel (glass over Night) | vs Night |
|---|---|---|---|
| healthy (Moss) | #9dbb55 | 8.43:1 | 7.91:1 |
| drowsy (Lantern) | #ffb257 | 10.25:1 | 9.61:1 |
| sleeping | #8fa3c8 | 7.18:1 | 6.74:1 |
| shedding (Pool) | #3a9a98 | 5.45:1 | 5.11:1 |
| needs attention | #ff9a7e | 8.87:1 | 8.32:1 |
| traveling | #b9a7ff | 8.75:1 | 8.20:1 |
| egg (Shell) | #f1ead8 | 15.25:1 | 14.31:1 |

Pairs with near-identical lightness (below 1.25:1):

| Pair | Luminance contrast |
|---|---|
| needs attention / traveling | 1.01:1 |
| healthy (Moss) / traveling | 1.04:1 |
| healthy (Moss) / needs attention | 1.05:1 |
| drowsy (Lantern) / needs attention | 1.16:1 |
| drowsy (Lantern) / traveling | 1.17:1 |
| healthy (Moss) / sleeping | 1.17:1 |
| healthy (Moss) / drowsy (Lantern) | 1.22:1 |
| sleeping / traveling | 1.22:1 |
| sleeping / needs attention | 1.23:1 |

Additional computed values (from `a11y/contrast-output.txt`):

- Lantern ring on Shell surface 1.49:1, on white 1.79:1, on a Lantern fill 1.00:1. Ink ring on Shell 15.64:1; Night ring on Shell 14.31:1.
- Three-band focus ring `[Night 2px | Lantern 2px | Night 2px]`: for any solid background the better of Lantern-vs-background and Night-vs-background is at least 3.100:1 (worst sampled background rgb(10,95,230), over a 5-step sRGB cube). It therefore meets 1.4.11 (3:1) on every solid surface in the palette, including Shell cards and the hatchkind.com card.
- A Shell-tinted 1px panel border reaches 3:1 against the glass-over-Night panel only at alpha 0.364 or more (alpha 0.12: 1.35:1, 0.28: 2.27:1, 0.40: 3.37:1). Containers do not need a 3:1 border (1.4.11 covers what identifies a control), but an outlined secondary button whose only affordance is its outline does: use the opaque Shell outline (15.25:1 on glass over Night, 6.29:1 over white).
- Shell text at reduced opacity over glass-over-Night: alpha 0.495 gives 4.5:1 and 0.654 gives 7:1. If a muted text token is added, do not go below alpha 0.6 (6.07:1).

Findings for the token system:

1. Lantern text and Lantern rings are safe on Night, Canopy and glass (9.61, 7.88, 10.25:1). They fail on any Shell surface (1.49:1). The Hatch card and any paper-styled surface must use Ink text (15.64:1) and the three-band ring or an Ink ring.
2. Ink on Lantern for primary buttons is 10.51:1. Ink on Moss 8.64:1 and Ink on Pool 5.59:1 also pass; Shell on Pool is 2.80:1, so no Shell text on Pool fills.
3. Shell text on the frosted glass passes 4.5:1 over every backdrop tested, worst case 6.29:1 over pure white. It does not reach 7:1 (AAA) if the backdrop exceeds roughly grey 230.
4. Coloured text on glass is weaker: Lantern text falls to 4.23:1 over pure white (needs alpha 0.737; brief has 0.72), Moss text to 3.82:1 over a Shell-coloured moon or egg, Pool text to 3.71:1 over Pool water. Rule: Lantern, Moss and Pool are for graphics (3:1) and for text only on solid Night/Canopy panels or on glass with alpha 0.80 or more; the "extension in Lantern" on egg chips should sit on an alpha 0.80 chip, or assert in a test that the scene never renders brighter than Shell behind chips.
5. Dots all clear 3:1 against the panel (5.45 to 15.25:1), but nine pairs of state hues sit within 1.25:1 of each other in lightness, so hue is the only separator: shape and text are mandatory (section 3.8).
6. The scene's own strokes (hatching) are decoration and carry no contrast requirement, but any text on a hatched panel header is measured against the worst background it sits on (Technique F83 is the named failure).

## 5. Target size

| Source | Value | Note |
|---|---|---|
| WCAG 2.2 SC 2.5.8 (AA) | at least 24 x 24 CSS px, else 24 px spacing circle rule, or an equivalent control, inline, user-agent or essential exception | The Ledger row controls are the "Equivalent" for scene tags. Independent of page zoom [S5]. |
| WCAG 2.2 SC 2.5.5 (AAA) | at least 44 x 44 CSS px, exceptions equivalent, inline, user agent, essential | The brief's 44px rule meets this. |
| Apple HIG (iOS, iPadOS) | default control 44x44 pt, minimum 28x28 pt; "about 12 points of padding around elements that include a bezel ... about 24 points of padding ... for elements without a bezel" [S26] | Spacing matters as much as size. |
| Android developers | "of at least 48dpx48dp" touch target size [S26b] | Slightly larger than 44 px on some densities; use 44 CSS px minimum with 8 px gaps and let dense screens use more where cheap. |

Rules: measure the DOM element box (including padding you add for the hit area), not the sprite; keep a gap of at least 8 CSS px between tag hit areas; charms (small orbiting shapes) are not targets, their labels in the panel are; the state dot is inside the tag button, not a separate target.

## 6. Testing

### 6.1 Tool versions (npm registry, queried 2026-09-29)

| Package | Version | Published or last modified (npm registry) | Note |
|---|---|---|---|
| axe-core | 4.13.0 | 2026-08-05 | MPL-2.0. 105 rules: 89 enabled by default, 16 disabled by default; tags counted by `axe.getRules()`. |
| @axe-core/playwright | 4.13.0 | 2026-08-11 | Peer `playwright-core >= 1.0.0`; depends on `axe-core ~4.13.0`. Versioning follows axe-core major.minor, not SemVer. Requires a page from `browser.newContext()` (probe error: "Please use browser.newContext()"). |
| @axe-core/react | 4.13.0 | 2026-09-02 (modified) | Dev-time console reporter; check React version compatibility before adopting (not tested here). |
| @playwright/test / playwright | 1.63.0 | 2026-09-29 | `emulateMedia({ reducedMotion, forcedColors, contrast, colorScheme })`; `toMatchAriaSnapshot()`. |
| jest-axe | 11.0.0 | 2026-07-26 | Pins `axe-core 4.12.1`. Not needed if Playwright runs axe. |
| vitest-axe | 0.1.0 | 2025-01-22 | Stale; prefer Playwright component or page runs. |
| eslint-plugin-jsx-a11y | 6.10.2 | 2024-10-26 | Peer range ends at ESLint `^9`; check against your ESLint major before adding. |
| @guidepup/guidepup | 0.34.0 | 2026-08-31 | Drives real VoiceOver (macOS) and NVDA (Windows) from tests; no JAWS, no iOS VoiceOver, no TalkBack. |
| pa11y | 10.0.0 | 2026-08-28 | LGPL-3.0; uses axe-core 4.13 as one runner. Not needed. |
| lighthouse | 13.5.0 | 2026-09-19 | Uses `axe-core ^4.13.0`; subset of rules. Not needed as a gate. |

### 6.2 What the probe showed (axe-core 4.13.0, headless Chromium with WebGL2, this session)

Page: fixed WebGL2 canvas cleared to white, a frosted-glass panel over it (rgba(11,18,33,.72), blur 16px) with Shell text, a Lantern button, a press-and-hold button with no keyboard path, three 16 px buttons 2 px apart, a low-contrast focus ring, a draggable element with no alternative, and a sticky footer. Output in `a11y/axe/run-output.txt`.

| Run | Result |
|---|---|
| `new AxeBuilder({ page }).analyze()` (defaults) | Violations: `region` only. `target-size` did NOT run although three 16 px targets were present. Incomplete: `color-contrast` (3 nodes). |
| `.withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'])` | `target-size` reported 4 violations ("Target has insufficient size (16px by 16px, should be at least 24px by 24px)"). |
| `.withRules(['target-size'])` | Same 4 violations. |
| `color-contrast` over glass on canvas | Not a pass or a fail: incomplete, message key `elmPartiallyObscuring` ("background color could not be determined because it partially overlaps other elements") and `imgNode`. So contrast over the scene must be proven analytically (section 4) or by screenshot sampling, not by axe. |
| Never reported | Press-and-hold with no keyboard path, drag without alternative, focus ring the colour of the ground, focus hidden under the sticky footer. |

Documentation gap worth knowing: Playwright's official accessibility guide shows `withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])` [S22], which omits `wcag22aa`; with that tag list `target-size` never runs. Also `AxeBuilder.exclude()` "will prevent all rules from running against the specified elements" [S22], so never exclude the overlay.

### 6.3 What automated tools cannot catch (mapped to Mosshatch)

Vendor and government evidence on the ceiling: axe-core README, "you can find on average 57% of WCAG issues automatically" and it returns "incomplete" where it "could not be certain" [S21]. UK GDS audit of 10 tools on a page with 143 known barriers: "a total of 42 were missed by all of the tools" (29%); best tool found 37% (41% counting manual-inspection prompts) [S24b]. Playwright: "many accessibility problems can only be discovered through manual testing" [S22]. WebAIM Million, Feb 2026: 95.9% of home pages had detected WCAG 2 failures; low-contrast text 83.9%, missing alt 53.1%, missing labels 51%, empty links 46.3%, empty buttons 30.6%; pages with ARIA averaged 59.1 errors vs 42 without [S23c].

| Cannot be automated (needs a human or a bespoke test) | Where it hits |
|---|---|
| Keyboard path exists and is usable for hold-to-reveal, sheet, tabs, Ledger bulk actions (2.1.1, 2.5.2) | Nest tab |
| Meaningful focus order and focus return after closing panels (2.4.3, 3.2.1) | All panels |
| Focus indicator exists, is visible, is 3:1, and is not covered by overlays (2.4.7, 1.4.11, 2.4.11) | Tags over the scene |
| Announcement quality: right region, right time, no repetition, no secret in it (4.1.3) | DNS, transfer, approvals |
| Contrast of text over the moving WebGL scene and translucent glass (1.4.3) | Chips, panels |
| Pause, stop, hide for canvas animation, flash rate and area (2.2.2, 2.3.1) | Scene, hatch |
| Whether colour is the only cue (1.4.1) | Dots |
| Dragging, path-based gestures and hold alternatives (2.5.1, 2.5.7) | Any pointer gesture |
| Cognitive authentication tests hidden in recovery flows (3.3.8) | Sign-in, recovery |
| Reading order and label quality (names that make sense, 2.5.3 label in name) | Tags, chips |
| Real assistive technology behaviour and voice control | Everything |
| Whether the Ledger truly matches the Grove | Parity test (3.1) |

### 6.4 Manual keyboard pass (run at every phase gate, 15 minutes per view)

Unplug the mouse. Use Chrome, then Firefox, then Safari. Repeat with `emulateMedia({ reducedMotion: 'reduce' })` and forced colours.

1. First Tab reaches a visible "Skip to main content" link; it works.
2. Tab from the top to the bottom of every view: each stop is visible (three-band ring), in an order matching the Ledger, none hidden behind a sticky bar or panel, no stop on an invisible element, no trap.
3. Every button and link is reachable and activated with Enter (links, buttons) or Space (buttons). Nothing needs a hover or a drag. No single-character shortcut fires while typing in the search input.
4. Search: type a name; eggs and chips appear and are reachable in DOM order; the status region announces the count once; Esc clears.
5. Open a creature tag with Enter: focus moves into the panel heading; Tab cycles within the panel (modal on phones); Esc closes; focus returns to the same tag.
6. Tabs: Left/Right moves between tabs; Tab moves into the tab panel.
7. Hold-to-reveal: hold Space (progress shows, release early aborts); then use the non-timed path (Enter, confirm, passkey, value, countdown, auto re-hide with focus moved to Reveal); copy without reveal works; "Send all visitors home" is reachable.
8. Ledger: sort header buttons, row checkboxes, bulk action bar reachable, results announced once.
9. Calm and Sound toggles: reachable in the first few stops, states announced ("pressed"), label unchanged.
10. Checkout: Hatch sheet Pay button, Stripe redirect, and return page with focus on the heading.
11. Zoom 200% and 400% (320 CSS px wide): no horizontal scroll, no lost controls, tag list layout appears.
12. Windows forced colours (or `forcedColors: 'active'`): focus, borders and state shapes still visible; nothing depends on the glass.

### 6.5 Screen reader and assistive technology matrix

Evidence: WebAIM Screen Reader User Survey #11 (July to August 2026, 1,780 valid responses; "The sample was not controlled and may not represent all screen reader users") [S23a]; #10 (January 2024) [S23b]; GOV.UK Service Manual minimum combinations [S24a]; NVDA download page shows version 2026.2 [S25].

| Measure | Survey #11 (2026) | Survey #10 (2024) |
|---|---|---|
| Primary desktop reader | JAWS 55.0%, NVDA 32.9%, VoiceOver 6.5%, ZoomText/Fusion 2.1%, Orca 1.4%, Narrator 0.4% | JAWS 40.5%, NVDA 37.7%, VoiceOver 9.7% |
| Commonly used | JAWS 69.2%, NVDA 59.3%, VoiceOver 42.0%, Narrator 36.1% | NVDA 65.6%, JAWS 60.5%, VoiceOver 43.9%, Narrator 37.3% |
| Top pairs | JAWS+Chrome 31.2%, NVDA+Chrome 17.3%, JAWS+Edge 17.0%, NVDA+Firefox 9.1%, NVDA+Edge 5.4%, JAWS+Firefox 5.0%, VoiceOver+Safari 4.3% | JAWS+Chrome 24.7%, NVDA+Chrome 21.3%, JAWS+Edge 11.4%, NVDA+Firefox 10.0%, VoiceOver+Safari 7.0% |
| Desktop OS with the primary reader | Windows 90.7%, Mac 6.3%, Linux 1.6% | Windows 86.1% |
| Mobile screen reader use | 91.8% use one; VoiceOver 72.2%, TalkBack 29.5% commonly used; iOS 73.3% primary platform; Safari 56.0%, Chrome 28.2% primary mobile browser | not extracted |

GOV.UK minimum (before public beta): JAWS 2019 or later with Chrome or Edge; NVDA latest with Chrome, Firefox or Edge; VoiceOver on iOS with Safari; TalkBack with Chrome; Windows Magnifier or Apple Zoom; Dragon 15 or later with Chrome. Also recommended: VoiceOver on macOS with Safari, ZoomText, Windows High Contrast, and Firefox with JAWS or NVDA.

Recommended Mosshatch matrix (gates: A = every phase smoke test on the flows touched; B = full pass before launch):

| # | Combination | Why | Gate |
|---|---|---|---|
| 1 | JAWS latest + Chrome (Windows) | Most common pair (31.2%). Full-featured JAWS trial exists ("no feature lock" on Freedom Scientific's page; trial length not stated there, unverified) [S25] | A and B |
| 2 | NVDA 2026.2 + Firefox, and NVDA + Chrome (Windows) | Free; second most common; Firefox pair 9.1%. Automatable with Guidepup (Windows Server 2022/2025 supported per its README) [S30] | A and B |
| 3 | VoiceOver + Safari on iOS (real iPhone) | 72.2% of mobile screen reader users; the bottom sheet, hold gesture and the cross-device passkey flow only show up here | A and B |
| 4 | VoiceOver + Safari on macOS | Guidepup can automate it; Safari backdrop-filter and inert behaviour | B (A for Nest) |
| 5 | TalkBack + Chrome on Android | 29.5% of mobile users | B (A when sheet or gesture code changes) |
| 6 | Voice control: Voice Control (iOS/macOS), Voice Access (Android), Dragon | Labels in name (2.5.3), hold cannot be voiced; must have a spoken activation route | B |
| 7 | Zoom and magnification: 200%/400% browser zoom, Windows Magnifier or Apple Zoom | Reflow, tag list layout | B |
| 8 | Switch or keyboard-only scanning emulation | Same as keyboard pass; non-timed path essential | B |
| 9 | Forced colours (Windows contrast themes), reduced motion, `prefers-contrast: more` | EN 301 549 9.7; Playwright can emulate the media features | A |

Test script per combination: (1) load Find, hear title and landmarks, (2) search a name, hear the count, (3) reach and read an egg chip and a taken-name chip, (4) open the Hatch sheet, read totals, pay (test mode), (5) hear the hatched confirmation, (6) Grove: read tags and the summary bar, (7) open Nest, reveal and hide a value, copy without reveal, (8) trigger a DNS change and hear exactly one "spreading" message, then one completion, (9) approve an agent request with a passkey, (10) toggle Calm and Sound. Record what could not be tested.

### 6.6 Real-device honesty (from the brief)

Headless Chromium here has WebGL2 through SwiftShader (probe: `webgl2 context available in headless chromium: true` with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`). That proves the DOM and axe layers only; it says nothing about real GPU frame times, iOS Safari accessibility behaviour or TalkBack. Say so in every phase report.

## 7. Browser support snapshot for the a11y-relevant features

Sources: caniuse `data.json` (updated 2026-09-28; global usage) and MDN browser-compat-data 8.1.3 (npm, modified 2026-09-24) [S27].

| Feature | First stable support | Global support |
|---|---|---|
| `prefers-reduced-motion` | Chrome 74, Firefox 63, Safari 10.1, iOS 10.3, Edge 79 | 96.45% |
| `prefers-contrast` | Chrome 96, Firefox 101, Safari 14.1, iOS 14.5 | not in caniuse data (BCD only) |
| `forced-colors` | Chrome 89, Firefox 89, Safari 16, iOS 16 | not in caniuse data (BCD only) |
| `prefers-reduced-transparency` | Chrome 118, Edge 118; Firefox behind a flag; Safari and iOS not supported; marked experimental | not in caniuse data |
| `:focus-visible` | Chrome 86, Firefox 85, Safari 15.4 | 95.49% |
| `inert` attribute | Chrome 102, Firefox 112, Safari 15.5 | not in caniuse data (BCD only) |
| `<dialog>` | Chrome 37, Firefox 98, Safari 15.4 | 96.77% |
| `backdrop-filter` (unprefixed) | Chrome 76, Firefox 103, Safari 18 (prefixed earlier) | 96.36% (caniuse counts prefixed) |
| WebGL2 | Chrome 56, Firefox 51, Safari 15 | 96.44% |
| WebAuthn / passkeys | Chrome 67 (108 for passkeys), Firefox 122 for passkeys, Safari 16.1 | 93.51% WebAuthn, 93.87% passkeys |
| `navigator.vibrate` | Chrome 32, Firefox 16; Safari not supported | do not use as a channel |
| `scroll-padding` | Chrome 69, Firefox 68, Safari 14.1 | for 2.4.11 |

## 8. Mosshatch accessibility budget (adoptable checklist)

Gate codes: P0 = plan/design tokens, P1 to P6 = build phases from the brief (a gate applies from that phase on), L = before launch. "Measure" says how the gate is checked; anything marked manual is done by a person and recorded in the phase report. Sources in brackets refer to the Source index.

| ID | Requirement | Measure and threshold | Basis | Gate |
|---|---|---|---|---|
| **Scope and legal** | | | | |
| A-01 | Build target is WCAG 2.2 Level A and AA on every page and state of the complete purchase process (Find, Hatch sheet, Stripe return, hatch, Nest) | Conformance statement per view; no exceptions listed without a reason | S1 5.2.3 | P1 on |
| A-02 | Additionally adopt AAA 2.5.5 (44 x 44 px targets), 2.3.3 (animation can be disabled) and 2.2.5 (re-authenticate without data loss) as design targets | Checked in A-19 (targets) and A-31 to A-36 (motion); A-29 and the session design cover 2.2.5 | S1 | P1 on |
| A-03 | Treat EN 301 549 v3.2.1 as the legal baseline and v4.1.1 (WCAG 2.2 plus clause 9.7 user preferences) as the design target | Clause 9.7 test in A-33 | S13, S14 | P1 on |
| A-04 | Record the EAA decision: entity size test (headcount under 10, turnover or balance sheet at most EUR 2M, linked enterprises), target markets, whether consumers are served; re-run yearly and before EU marketing | Entry in `docs/DECISIONS.md` with what would change it | S11 Art 3(23), 4(5) | P0 |
| A-05 | Publish an accessibility statement and the accessibility information in the Terms (Annex V style) even if exempt, with a working feedback address and a response target | Page exists, reviewed by the lawyer | S11 Annex V | L |
| A-06 | Do not install an accessibility overlay or widget | Dependency and CSP review | S19 | P1 on |
| A-07 | Get an accessibility conformance report (or written statement) from Stripe for Checkout; record the answer or the gap; test the hosted page in the SR matrix | Document filed; unresolved gaps in `DECISIONS.md` | S29, S11 Annex I IV(g) | P2 |
| **Structure and semantics** | | | | |
| A-08 | Canvas is `aria-hidden`, has no children, holds no controls; every scene element has a DOM equivalent | axe `aria-hidden-focus` clean; parity test | S9, S21 | P1 on |
| A-09 | Landmarks (header, main, one h1 per view), skip link, unique `document.title` per view, focus to the view heading on route change | Manual keyboard pass step 1; axe `document-title`, `landmark-one-main`, `page-has-heading-one` | S1 2.4.1, 2.4.2 | P1 on |
| A-10 | Tag, chip and Ledger DOM order is the Ledger sort order; positions via `transform`; nodes are not recreated per frame | Test: focus a tag, run 5 s of animation, focus still on the same node | S1 1.3.2, 2.4.3 | P1 on |
| A-11 | Ledger is a real table with sortable header buttons (`aria-sort`), labelled row checkboxes and bulk actions; it is the complete alternative | Playwright aria snapshot; parity test A-12 | S8 sortable table | P3 |
| A-12 | Grove/Ledger parity: same name, state text, renewal, lock and connection labels for the same fixture | Automated diff, zero mismatches | S1 conforming alternate version | P3 on |
| A-13 | Accessible name contains the visible text and starts with it | axe `label-content-name-mismatch` enabled in the run (experimental) plus manual voice-control check | S1 2.5.3 | P1 on |
| A-14 | Toggles (Calm, Sound) are buttons with `aria-pressed` and a label that does not change with state | Snapshot test | S8 button | P1 |
| **Keyboard and focus** | | | | |
| A-15 | Every action reachable by keyboard; no traps; no single-key shortcuts unless off/remappable/focus-only | Manual pass 3; axe run | S1 2.1.1, 2.1.2, 2.1.4 | P1 on |
| A-16 | Focus indicator is the three-band ring (Night 2px, Lantern 2px, Night 2px) on every interactive element, on every surface | Computed minimum 3.10:1 on any background; visual check on Shell cards; forced-colors check | S1 2.4.7, 1.4.11 | P1 on |
| A-17 | Focus is never entirely covered by sticky bars, sheets or panels; `scroll-padding` set; Esc reveals what a non-modal panel hides | Manual pass 2 and 5 at 1280x800 and 390x844 | S1 2.4.11 | P1 on |
| A-18 | Panels: focus moves in on open, Esc closes, focus returns to the opener or a stable fallback; phone sheet is modal (`showModal()` or `inert` behind) | Manual pass 5; SR matrix | S8 dialog, S10 | P3 on |
| A-19 | Interactive targets are at least 44 x 44 CSS px with at least 8 px between hit areas; 24 x 24 px is the hard floor | Playwright bounding-box assertion on all buttons and links except inline text links; axe `target-size` (needs `wcag22aa` tag) | S1 2.5.8, 2.5.5; S26 | P1 on |
| A-20 | Focus never triggers a change of context (no panel, navigation or form submit on focus) | Manual pass 5 | S1 3.2.1 | P1 on |
| A-21 | Groups over about 12 tags use roving tabindex plus arrow keys, Home and End, with a skip past the group | Manual; keyboard test | S8 keyboard interface | P3 |
| A-22 | Hover content (tags, "The deal") is dismissible with Esc, hoverable and persistent | Manual | S1 1.4.13 | P1 on |
| **Pointer** | | | | |
| A-23 | No feature requires dragging, pinch, path-based or multipoint gestures, or device motion | Design review; grep for pointer-move drag handlers and `deviceorientation` | S1 2.5.1, 2.5.4, 2.5.7 | P1 on |
| A-24 | Nothing executes on pointerdown other than starting a cancellable hold; release before completion aborts; completed actions can be undone (Hide now) | Manual on touch and mouse | S1 2.5.2 | P4 |
| **Hold-to-reveal and time** | | | | |
| A-25 | Hold-to-reveal has a non-timed keyboard/screen-reader path (activate, confirm, step-up) and a copy-without-reveal path; the CLI remains the third path | Manual pass 7; SR matrix | S5 2.1.1 Understanding | P4 |
| A-26 | Hold progress has a non-animated equivalent and is not colour-only | Visual check in Calm | S1 1.4.1 | P4 |
| A-27 | Reveal duration is user-adjustable before first reveal (10 s default; at least 10x range or until hidden); focus is moved to Reveal on re-hide | Manual; test | S1 2.2.1 | P4 |
| A-28 | Secret values never appear in `aria-live` regions, `aria-label`, `title`, tag labels or the DOM while hidden | Unit test on the DOM after render; bundle-secret scan already required by the brief | Brief non-negotiable 1 | P4 |
| A-29 | WebAuthn `timeout` between 300000 and 600000 ms; step-up prompts start from an explicit button and can be cancelled | Code review | S28 15.1 | P2 |
| A-30 | No CAPTCHA, typed code transcription or puzzle in sign-in, step-up or recovery; codes are pasteable and autofillable (`autocomplete="one-time-code"`) | Manual; code review | S5 3.3.8 | P2 |
| **Motion, flash, sound** | | | | |
| A-31 | Calm starts when `prefers-reduced-motion: reduce`; the header Calm control overrides both ways; live-updates on media change; the choice persists | Playwright with `reducedMotion: 'reduce'` and toggle | S6 SCR40, S22 | P1 on |
| A-32 | Calm is a true pause: no rAF loop in idle, no particles, drift, shake, flicker or wandering; state shown by pose plus text plus shape | Frame-count assertion (no draws while idle) and screenshot diff | S1 2.2.2; S5 techniques G4/G186 | P1 on |
| A-33 | The site never overrides user preference settings for documented platform features (colour filters, contrast, text size); `forced-color-adjust` only where essential; forced-colors and `prefers-contrast: more` render usable UIs | Playwright `forcedColors: 'active'`, `contrast: 'more'` screenshots | S14 clause 9.7 | P1 on |
| A-34 | Arrival demo: plays once, labelled "Demo", visible Pause/Skip control, cancels on input, does not type into the real input, does not autoplay in Calm | Manual; automation | S1 2.2.2 | P1 |
| A-35 | Hatch ceremony: one flash, below the general flash threshold; none in Calm; Esc or Skip cancels | Frame-capture analysis: no more than 3 flashes per second, area under 25% of a 10 degree field (341 x 256 px at 1024 x 768) | S1 2.3.1 | P1 |
| A-36 | Camera fly-to and dolly are instant cuts in Calm; no large-scale scaling or panning | Screenshot and timing test | S10 MDN prefers-reduced-motion; S1 2.3.3 | P1 |
| A-37 | Sound is off by default, never starts automatically, is controlled by one header toggle, and every cue has a visible or text twin | Manual; code review | S1 1.4.2, 1.3.3; S11 Annex I III(b)(i) | P1 on |
| **Colour and contrast** | | | | |
| A-38 | All text pairs in the token table meet 4.5:1 (large text 3:1); UI and graphics meet 3:1; a unit test asserts every declared text/background pair | `a11y/contrast.py` logic ported to a CI test; unrounded comparison | S1 1.4.3, 1.4.11 | P0 on |
| A-39 | Lantern text or rings never on Shell surfaces; Shell text never on Pool or Lantern fills; Ink is the text and ring colour on Shell cards | Lint rule on tokens plus screenshot review | Section 4 | P0 on |
| A-40 | Coloured text (Lantern, Moss, Pool) only on solid Night/Canopy or glass with alpha at least 0.80; Pool never as text on glass | Token rule | Section 4 | P0 on |
| A-41 | Scene must not render brighter than Shell behind glass chips (or chips use alpha at least 0.80) | Pixel-sampling test of the backdrop under each chip on the debug states route | Section 4 | P1 |
| A-42 | Every state has text, a shape and a colour; no state relies on hue | Design review; screenshot of all states in grayscale | S1 1.4.1 | P1 on |
| A-43 | Reflow at 320 CSS px and 400% zoom; text resize to 200%; text spacing overrides; no orientation lock | Playwright viewport 320x640; axe `meta-viewport`, `avoid-inline-spacing` | S1 1.4.10, 1.4.4, 1.4.12, 1.3.4 | P1 on |
| A-44 | Opaque panel fallbacks for Calm, forced colours, `prefers-contrast: more` and no `backdrop-filter`; do not depend on `prefers-reduced-transparency` | Media-feature emulation screenshots | S27 | P1 on |
| **Status and forms** | | | | |
| A-45 | One polite `role="status"` (with `aria-atomic="true"`) and one `role="alert"` region mounted at start, initially empty | DOM test on load | S7, S6 ARIA22, S10 | P1 on |
| A-46 | Announce only adapter-confirmed transitions; one sentence; no repeats on unchanged polls; coalesce bursts into a summary above 3 domains | Simulated adapter sequence; assert announcement log; Guidepup spoken-phrase log on NVDA/VoiceOver | S5 4.1.3; brief 2.6 | P3 on |
| A-47 | Every announced state also exists as persistent text on tag, Ledger row and panel | Parity test | S5 4.1.3 | P3 on |
| A-48 | The Hatch sheet is a review step before payment; transfer-out has confirm and cancel; consistent help link; no re-asking of data already given | Manual | S1 3.3.4, 3.2.6, 3.3.7 | P2 on |
| A-49 | Error messages identify the field or action and say how to fix it in text | Manual | S1 3.3.1, 3.3.3 | P2 on |
| **Testing** | | | | |
| A-50 | axe-core 4.13.x via `@axe-core/playwright` on every route, view state and panel tab, at 1280x800 and 390x844, in default, reduced-motion, and forced-colors modes; tags: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa plus best-practice; zero violations; every `incomplete` triaged with a recorded reason | CI job; results attached to the phase report | S21, S22; probe in 6.2 | P1 on |
| A-51 | Explicitly enable `target-size` (via `wcag22aa` tag or `withRules`) and confirm it appears in the "rules run" list | CI assertion that `target-size` is in `passes` or `violations` | Probe 6.2 | P1 on |
| A-52 | Manual keyboard pass (section 6.4) each phase on the views touched, with Chrome, Firefox and Safari | Signed checklist in the phase report | S24 | P1 on |
| A-53 | Screen reader matrix rows 1 to 3 as smoke test each phase; all rows before launch; NVDA and VoiceOver runs automated with Guidepup where possible | Recorded transcripts | S23a, S24a, S30 | P1 on |
| A-54 | Real-user check with at least two disabled people (including one screen reader user and one keyboard-only or switch user) before launch | Session notes; issues triaged | S22 | L |
| A-55 | Each phase report lists what could not be tested (real GPU, real iOS and Android AT, JAWS if unavailable) | Section in the report | Brief section 9 | P1 on |
| A-56 | Emails from Resend (receipts, expiry, transfer and approval notices) have semantic HTML, text alternative and readable contrast | Email render check; contrast test | S11 Annex I III(b)(vii) (electronic information needed in the provision of the service) | P2 on |
| A-57 | Accessibility regression ownership: any change to tag positioning, panels, hold control, live regions or tokens re-runs A-50 and the keyboard pass | PR template checkbox | S1 5.2 (conformance applies to each page state) | P1 on |
| A-58 | Track EN 301 549 citation in the Official Journal and the WCAG 3 draft; review this budget when v4.1.1 is cited | Calendar entry each quarter | S13 | L |

## 9. Unverified, contradicted or out of scope

Unverified (could not be confirmed from a primary source this session):

1. That domain-name registration is an "e-commerce service" under the EAA. My reading of Art 2(2)(f), Art 3(30) and recital 43 says yes; no Commission FAQ, guidance document or case naming domain registration was found (web search was unavailable, and I opened only the sources listed). Treat as "probably in scope for consumers".
2. Whether EN 301 549 v4.1.1 has been cited in the Official Journal after 7 Sep 2026. AccessibleEU (Commission-hosted) said it had not been; I did not read the OJ. Re-check before relying on it.
3. National transposition texts outside Germany (BFSG) and Ireland (S.I. 636/2023): France, Netherlands, Spain, Italy and 21 others not read. Penalty amounts, authorities and micro-enterprise details differ. The German ordinance (BFSGV) e-commerce clause (s.19) and the German federal authority arrangements were listed but not read in full.
4. The monetary value of an Irish "class A fine" (Fines Act 2010) was not looked up.
5. Whether a hold-only keyboard path is a hard 2.1.1 failure in an audit is interpretive; the Understanding text supports treating it as one, and the fix is cheap.
6. That screen readers, voice control and switch access activate hold-style controls through `click` rather than sustained key or pointer events (section 3.2). Inference; verify in the matrix.
7. OS-level hold-duration settings on iOS ("Touch Accommodations") and Android ("Touch & hold delay"): the Apple and Google help pages could not be retrieved, so existence and naming are unverified. Not used as evidence.
8. Stripe Checkout WCAG/EN 301 549 conformance: Stripe's docs say Checkout pages are labelled and accommodate screen reader users, but no conformance report, VPAT or accessibility statement was found (guessed URLs `stripe.com/accessibility`, `stripe.com/legal/accessibility` returned 404). Ask Stripe.
9. JAWS trial length: Freedom Scientific's page says "Full-featured JAWS trial for Windows (no feature lock)" without a duration; the current JAWS version and pricing were not confirmed (the download page returned 403).
10. Whether the US "online-only business" split in Seyfarth's summary reflects current law in every circuit; it is a law firm's characterisation, not a court opinion I read. UsableNet's monthly numbers come from a vendor that sells remediation.
11. Colour-vision-deficiency simulations of the state dots were not run (no primary source for the matrices was opened). Luminance-contrast analysis alone shows hue is the only separator.
12. Real-device behaviour (GPU frame times, iOS Safari and TalkBack with the scene, JAWS) could not be tested here.
13. The WCAG 3 timeline: the draft says "several years of work"; no date.
14. Jurisdictions not researched: UK (Equality Act), Canada (AODA and provincial), Australia, Ontario, and any US state statutes (for example California Unruh) beyond what Seyfarth summarises.
15. A dependency on my chosen 1 s coalescing window, the "about 12 tags" roving-tabindex threshold, the 8 px gap and the 0.80 glass alpha: engineering recommendations, not published thresholds.

Contradictions or conflicts between sources:

- WebAIM #10 (Jan 2024) showed JAWS 40.5% vs NVDA 37.7% as primary; #11 (Jul-Aug 2026) shows JAWS 55.0% vs NVDA 32.9%. Both reported; the sample is uncontrolled and the drop in "other" readers from 12.2% to 5.5% may reflect recruitment.
- W3C says WCAG 2.2 is the latest and encouraged; the EU's legal reference is still WCAG 2.1 (EN 301 549 v3.2.1). Not a contradiction, but a lag; build to 2.2.
- The Playwright guide's recommended tag list (no `wcag22aa`) conflicts with the goal of testing 2.5.8; use the tag list in A-50.

Needs a lawyer or accountant:

- EAA applicability and micro-enterprise status of the operating entity and any parent/partner entities; the yearly re-test and thresholds (Recommendation 2003/361/EC).
- Which Member State authorities apply to a non-EU seller and whether an EU representative or contact is needed for accessibility matters.
- Wording of accessibility information in the Terms, and any accessibility warranties.
- US demand-letter handling, and whether online-only status reduces ADA exposure in the states where customers live.
- Whether reliance on Stripe-hosted Checkout satisfies the payment-accessibility requirement (Annex I IV(g)) for the service as a whole.

## 10. Findings register (complete)

Same rows as the structured summary. "Computed" rows come from `a11y/contrast.py` and the probe in `a11y/axe/`; their source URL is the WCAG definition used. Quotes were checked verbatim against the fetched text (script `a11y/verify_quotes.py`, 0 mismatches).

| ID | Claim | Value | Source URL | Accessed | Conf. | Quote |
|---|---|---|---|---|---|---|
| F01 | WCAG 2.2 is a W3C Recommendation dated 12 December 2024 | 12 Dec 2024 | https://www.w3.org/TR/WCAG22/ | 2026-09-29 | high | "W3C Recommendation 12 December 2024" |
| F02 | WCAG 2.2 adds 9 success criteria to 2.1, does not deprecate 2.1, and content that meets 2.2 also meets 2.1 and 2.0; 4.1.1 Parsing is obsolete | 9 new SCs | https://www.w3.org/WAI/standards-guidelines/wcag/ | 2026-09-29 | high | "WCAG 2.2 adds 9 success criteria. ... content that conforms to WCAG 2.2 also conforms to WCAG 2.1 and WCAG 2.0." |
| F03 | WCAG 2.2 (Oct 2023 text) is ISO/IEC 40500:2025; the Dec 2024 text is expected as ISO/IEC 40500:2026 by late 2026 | ISO/IEC 40500:2025 | https://www.w3.org/WAI/standards-guidelines/wcag/ | 2026-09-29 | high | "WCAG 2.2 is an approved International Organization for Standardization (ISO) standard: ISO/IEC 40500:2025" |
| F04 | WCAG 3.0 is a W3C Working Draft dated 10 September 2026 and explicitly does not replace WCAG 2 | Working Draft 10 Sep 2026 | https://www.w3.org/TR/wcag-3.0/ | 2026-09-29 | high | "WCAG 3 does not replace WCAG 2. WCAG 2 is used around the world and will still be required by different countries for a long time to come." |
| F05 | WCAG 3 draft says it still has several years of work and it is inappropriate to cite it other than as work in progress |  | https://www.w3.org/TR/wcag-3.0/ | 2026-09-29 | high | "it still has several years of work; It is inappropriate to cite this document as other than a work in progress." |
| F06 | EU legal reference for the EAA and WAD remains EN 301 549 v3.2.1 (WCAG 2.1 AA) until v4.1.1 is cited in the Official Journal | v3.2.1 current; v4.1.1 published Sep 2026 | https://accessible-eu-centre.ec.europa.eu/content-corner/news/european-accessibility-standard-en-301-549-has-been-updated-2026-09-07_en | 2026-09-29 | high | "Until the European Commission formally cites EN 301 549 v4.1.1 in the Official Journal of the European Union, the current reference remains EN 301 549 v3.2.1 (2021), which is based on WCAG 2.1 Level AA." |
| F07 | EN 301 549 V4.1.1 (2026-09) aligns clauses 9 to 11 with WCAG 2.2 and gives a presumption of conformity with the EAA only once cited in the OJ | V4.1.1 (2026-09); adopted 24 Aug 2026 | https://www.etsi.org/deliver/etsi_en/301500_301599/301549/04.01.01_60/en_301549v040101p.pdf | 2026-09-29 | high | "the requirements of clauses 9, 10 and 11 have all been updated to align with the WCAG 2.2 recommendation" |
| F08 | EN 301 549 V4.1.1 clause 9.7 forbids web pages from overriding user preference settings for documented platform accessibility features unless essential (mentions forced-color-adjust) | clause 9.7 | https://www.etsi.org/deliver/etsi_en/301500_301599/301549/04.01.01_60/en_301549v040101p.pdf | 2026-09-29 | high | "the web page shall not block the user agent's mode(s) of operation that present the web page according to user preference settings, or explicitly override user preference settings for documented platform accessibility features in these modes of operation, unless this is essential to the information or function of the web page." |
| F09 | WebAuthn Level 3 is a W3C Recommendation (25 August 2026) with an Accessibility Considerations section and a recommended ceremony timeout of 300000 to 600000 ms | 300000-600000 ms | https://www.w3.org/TR/webauthn-3/ | 2026-09-29 | high | "Recommended range: 300000 milliseconds to 600000 milliseconds. Recommended default value: 300000 milliseconds (5 minutes)." |
| F10 | WebAuthn L3: authenticators should offer more than one user verification method and RPs should help users complete future gestures |  | https://www.w3.org/TR/webauthn-3/ | 2026-09-29 | high | "should offer users more than one user verification method" |
| F11 | The EAA national measures apply from 28 June 2025 (Art 31(2)); Art 32 transitional relief covers only earlier contracts and previously used products, so a new service does not appear to benefit (my reading) | 28 Jun 2025 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32019L0882 | 2026-09-29 | medium | "They shall apply those measures from 28 June 2025." |
| F12 | E-commerce services are in the EAA's scope (Art 2(2)(f)); e-commerce is defined as services at a distance through websites at the individual request of a consumer with a view to concluding a consumer contract; recital 43 applies it to the online sale of any product or service | Art 2(2)(f); Art 3(30); recital 43 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32019L0882 | 2026-09-29 | high | "'e-commerce services' means services provided at a distance, through websites and mobile device-based services by electronic means and at the individual request of a consumer with a view to concluding a consumer contract" |
| F13 | A non-EU seller is a 'service provider' if it offers services to consumers in the Union | Art 3(4) | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32019L0882 | 2026-09-29 | high | "'service provider' means any natural or legal person who provides a service on the Union market or makes offers to provide such a service to consumers in the Union" |
| F14 | Only natural persons acting outside trade, business, craft or profession are consumers, so B2B-only customers are outside the EAA | Art 3(22) | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32019L0882 | 2026-09-29 | high | "'consumer' means any natural person who purchases the relevant product or is a recipient of the relevant service for purposes which are outside his trade, business, craft or profession" |
| F15 | Microenterprises providing services are exempt from the EAA accessibility requirements and related obligations; a microenterprise has fewer than 10 persons and turnover or balance sheet not above EUR 2 million | <10 persons and <=EUR 2M; Art 4(5), Art 3(23) | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32019L0882 | 2026-09-29 | high | "Microenterprises providing services shall be exempt from complying with the accessibility requirements referred to in paragraph 3 of this Article and any obligations relating to the compliance with those requirements." |
| F16 | To use the microenterprise exemption an enterprise must genuinely meet Recommendation 2003/361/EC (anti-circumvention), so linked and partner enterprises matter | recital 53 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32019L0882 | 2026-09-29 | high | "For microenterprises and SMEs to benefit from this Directive they must genuinely fulfil the requirements of Commission Recommendation 2003/361/EC" |
| F17 | EAA Annex I Section IV(g)(ii) requires accessible identification, security and payment functionality for e-commerce services | Annex I IV(g)(ii) | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32019L0882 | 2026-09-29 | high | "ensuring the accessibility of the functionality for identification, security and payment when delivered as part of a service instead of a product by making it perceivable, operable, understandable and robust" |
| F18 | Accessibility information must be included in the general terms and conditions (Annex V) | Annex V(1) | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32019L0882 | 2026-09-29 | high | "The service provider shall include the information assessing how the service meets the accessibility requirements referred to in Article 4 in the general terms and conditions, or equivalent document." |
| F19 | EAA enforcement is national: consumers and associations can act through courts or administrative bodies; penalties must be effective, proportionate and dissuasive | Art 29, Art 30 | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32019L0882 | 2026-09-29 | high | "The penalties provided for shall be effective, proportionate and dissuasive." |
| F20 | Germany's BFSG exempts micro-enterprises that provide services | BFSG s.3(3) | https://www.gesetze-im-internet.de/bfsg/__3.html | 2026-09-29 | high | "Absatz 1 gilt nicht für Kleinstunternehmen, die Dienstleistungen anbieten oder erbringen." |
| F21 | Germany: fine up to EUR 100,000 for offering a service in breach of s.14(1) BFSG (up to EUR 10,000 for other listed breaches) | up to EUR 100,000; s.37(1) Nr 8, (2) | https://www.gesetze-im-internet.de/bfsg/__37.html | 2026-09-29 | high | "mit einer Geldbuße bis zu hunderttausend Euro" |
| F22 | Germany: Länder market-surveillance authorities run spot checks without cause, can order services stopped, and consumers or recognised associations can force proceedings | BFSG s.20, s.28(2), s.29(3), s.32 | https://www.gesetze-im-internet.de/bfsg/__29.html | 2026-09-29 | high | "Sie kann insbesondere innerhalb einer von ihr gesetzten Frist anordnen, das Angebot oder die Erbringung der Dienstleistung einzustellen." |
| F23 | Ireland's S.I. 636/2023 exempts services provided by a microenterprise and names the CCPC as compliance authority for e-commerce services | Reg 5(4); Reg 4(2)(g) | https://www.irishstatutebook.ie/eli/2023/si/636/made/en/print | 2026-09-29 | high | "Paragraph (3) and Regulation 14 shall not apply to a service provided by a microenterprise." |
| F24 | Ireland: offences carry on indictment a fine up to EUR 60,000 or up to 18 months imprisonment, or both | EUR 60,000 / 18 months; Reg 32(6) | https://www.irishstatutebook.ie/eli/2023/si/636/made/en/print | 2026-09-29 | high | "on conviction on indictment to a fine not exceeding €60,000 or to imprisonment for a term not exceeding 18 months or to both" |
| F25 | Commission-hosted AccessibleEU (24 Sep 2026): accessibility complaints remain rare despite widespread barriers, which is not evidence that services are accessible |  | https://accessible-eu-centre.ec.europa.eu/content-corner/news/why-accessibility-complaints-remain-rare-despite-widespread-digital-barriers-2026-09-24_en | 2026-09-29 | high | "A lack of complaints should never be taken as evidence that a digital service is accessible." |
| F26 | DOJ has no Title III regulation setting detailed web standards; it applies general nondiscrimination and effective communication provisions |  | https://www.ada.gov/resources/web-guidance/ | 2026-09-29 | high | "The Department of Justice does not have a regulation setting out detailed standards, but the Department's longstanding interpretation of the general nondiscrimination and effective communication provisions applies to web accessibility." |
| F27 | DOJ Interim Final Rule (published 20 Apr 2026) extends ADA Title II web rule compliance to 26 Apr 2027 (population 50,000+) and 26 Apr 2028 (smaller); standard is WCAG 2.1 AA; applies to state and local government only | 26 Apr 2027 / 26 Apr 2028 | https://www.ada.gov/resources/2024-03-08-web-rule/ | 2026-09-29 | high | "extending the compliance date for State and local government entities with a total population of 50,000 or more to April 26, 2027." |
| F28 | Seyfarth: Title III web rulemaking is 'now paused indefinitely'; DOJ's Sep 2025 agenda plans to re-examine Title II/III regulations on a TBD timetable |  | https://www.adatitleiii.com/2026/04/doj-extends-ada-title-ii-website-accessibility-deadlines-for-governmental-entities-but-litigation-and-compliance-risks-remain/ | 2026-09-29 | medium | "(and Title III, now paused indefinitely)" |
| F29 | Federal website-accessibility lawsuits: 3,117 in 2025 (+27% vs 2,452 in 2024), 36% of 8,667 ADA Title III federal filings | 3,117 (2025) | https://www.adatitleiii.com/2026/03/federal-court-website-accessibility-lawsuit-filings-bounce-back-in-2025/ | 2026-09-29 | high | "Plaintiffs filed 3,117 website accessibility lawsuits in federal court in 2025" |
| F30 | Federal ADA Title III filings reached 5,006 in H1 2026, up 9% on H1 2025 (4,575), highest since 2021 | 5,006 (H1 2026) | https://www.adatitleiii.com/2026/09/2026-mid-year-report-ada-title-iii-federal-lawsuit-numbers-are-climbing/ | 2026-09-29 | high | "Halfway into 2026, the ADA Title III plaintiff's bar and their clients have filed 5,006 federal ADA Title III suits in federal court" |
| F31 | Seyfarth: New York federal judges lean toward covering online-only businesses; California appellate courts have held online-only businesses are not covered by the ADA |  | https://www.adatitleiii.com/2026/03/federal-court-website-accessibility-lawsuit-filings-bounce-back-in-2025/ | 2026-09-29 | medium | "both federal and state courts of appeals have reached the conclusion that online only businesses are not covered by the ADA" |
| F32 | UsableNet (vendor) counted 432 new ADA web accessibility lawsuits in August 2026, 134 against defendants using a third-party accessibility widget | 432 (Aug 2026) | https://info.usablenet.com/ada-website-compliance-lawsuit-tracker | 2026-09-29 | medium | "134 defendants were sued despite using a third-party accessibility widget on their sites at the time" |
| F33 | Section 508 applies to federal agencies procuring ICT and incorporates WCAG 2.0 Level AA | WCAG 2.0 AA | https://www.section508.gov/develop/applicability-conformance/ | 2026-09-29 | high | "The Revised 508 Standards incorporate by reference the WCAG 2.0 Level AA Success Criteria" |
| F34 | 2.1.1 Understanding: a key that must be held down for an extended period counts as a specific timing for a keystroke |  | https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html | 2026-09-29 | high | "where a key must be held down for an extended period before the keystroke is registered" |
| F35 | 2.5.2 Understanding describes press-and-hold with release-to-dismiss as an acceptable Up Reversal pattern |  | https://www.w3.org/WAI/WCAG22/Understanding/pointer-cancellation.html | 2026-09-29 | high | "press-and-hold actions such as where a transient popup appears (or a video plays) when the user presses on an object (down-event), but the popup (or video) disappears as soon as the user releases the pointer (up-event)" |
| F36 | 2.5.1 Understanding: long press is an acceptable single-pointer alternative to path-based gestures |  | https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures.html | 2026-09-29 | high | "such as a tap, click, double tap, double click, long press, or click & hold" |
| F37 | 2.2.2 requires a pause/stop/hide mechanism for auto-starting motion over 5 s in parallel with other content; sufficient techniques are G4, G186 and G191 |  | https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html | 2026-09-29 | high | "(1) starts automatically, (2) lasts more than five seconds, and (3) is presented in parallel with other content" |
| F38 | Technique C39 (prefers-reduced-motion in CSS) is sufficient for 2.3.3 (AAA) only, and SCR40 covers the JavaScript equivalent |  | https://www.w3.org/WAI/WCAG22/Techniques/css/C39.html | 2026-09-29 | high | "This technique relates to 2.3.3 Animation from Interactions ( Sufficient )." |
| F39 | 2.4.11 Understanding: sticky footers, sticky headers and non-modal dialogs can obscure focus; blur overlays may fail 1.4.11 for the focus indicator |  | https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html | 2026-09-29 | high | "Typical types of content that can overlap focused items are sticky footers, sticky headers, and non-modal dialogs." |
| F40 | 2.5.8 requires 24 x 24 CSS px targets unless spacing, equivalent-control, inline, user-agent or essential exception applies | 24 CSS px | https://www.w3.org/TR/WCAG22/ | 2026-09-29 | high | "The size of the target for pointer inputs is at least 24 by 24 CSS pixels" |
| F41 | 2.5.5 (AAA) sets 44 x 44 CSS px | 44 CSS px | https://www.w3.org/TR/WCAG22/ | 2026-09-29 | high | "The size of the target for pointer inputs is at least 44 by 44 CSS pixels" |
| F42 | 3.3.8 Understanding lists WebAuthn device authentication as a pass and says OS mechanisms are not a cognitive function test; manual transcription of a code is not compliant |  | https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html | 2026-09-29 | high | "A website uses WebAuthn so the user can authenticate with their device instead of username/password." |
| F43 | 4.1.3 intent: make users aware of important changes not given focus without unnecessarily interrupting |  | https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html | 2026-09-29 | high | "The intent of this success criterion is to make users aware of important changes in content that are not given focus, and to do so in a way that doesn't unnecessarily interrupt their work." |
| F44 | 2.2.1 Understanding: security-motivated limits such as time-limited tokens can be essential and may be exempt, but content-set limits otherwise need turn off / adjust (10x) / extend (20 s warning) |  | https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html | 2026-09-29 | high | "Certain time limits implemented for security reasons, such as time-based / time-limited two-factor authentication tokens, can be considered essential, and may be exempt from this criterion." |
| F45 | General flash threshold: pair of opposing luminance changes of 10% or more with darker image below 0.80; no more than three per second or under 25% of a 10 degree field |  | https://www.w3.org/TR/WCAG22/ | 2026-09-29 | high | "no more than three general flashes and / or no more than three red flashes within any one-second period" |
| F46 | WCAG contrast uses relative luminance threshold 0.04045 and contrast (L1+0.05)/(L2+0.05); computed ratios are not rounded |  | https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html | 2026-09-29 | high | "the computed values should not be rounded (e.g., 4.499:1 would not meet the 4.5:1 threshold)" |
| F47 | A conforming alternate version must provide all of the same information and functionality and be as up to date |  | https://www.w3.org/TR/WCAG22/ | 2026-09-29 | high | "provides all of the same information and functionality in the same human language, and is as up to date as the non-conforming content" |
| F48 | ARIA 1.2: role=status has implicit aria-live polite and aria-atomic true and should not take focus; role=alert is assertive; role=timer has aria-live off |  | https://www.w3.org/TR/wai-aria-1.2/ | 2026-09-29 | high | "Elements with the role status have an implicit aria-live value of polite and an implicit aria-atomic value of true." |
| F49 | Technique ARIA22: add explicit aria-atomic=true to role=status because some environments do not treat it as atomic |  | https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA22.html | 2026-09-29 | high | "since role="status" is currently not treated as atomic by default in some environments, it is advisable to add an explicit aria-atomic="true"" |
| F50 | MDN: establish live regions before updating them; use assertive sparingly |  | https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions | 2026-09-29 | high | "Establish the live region before updating its content. Start with an empty live region, then allow time for it to be exposed to assistive technologies before updating its content." |
| F51 | APG roving tabindex: one composite element has tabindex 0, the rest -1 |  | https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/ | 2026-09-29 | high | "the element that is to be included in the tab sequence has tabindex="0" and all other focusable elements contained in the composite have tabindex="-1"" |
| F52 | APG modal dialog: content beneath is inert; for long content focus a tabindex=-1 static element such as the title |  | https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/ | 2026-09-29 | high | "Windows under a modal dialog are inert." |
| F53 | MDN dialog: showModal() is aria-modal true and show() is non-modal |  | https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog | 2026-09-29 | high | "elements invoked by the showModal() method implicitly have aria-modal="true", whereas <dialog> elements invoked by the show() method or displayed using the open attribute or by changing the default display of a <dialog> are exposed as [aria-modal="false"]" |
| F54 | HTML Standard: canvas fallback content stays focusable and authors should map interactive regions one-to-one to focusable fallback elements |  | https://html.spec.whatwg.org/multipage/canvas.html | 2026-09-29 | high | "authors should have a one-to-one mapping of interactive regions to focusable areas in the fallback content." |
| F55 | APG button: a toggle button's label must not change when its state changes |  | https://www.w3.org/WAI/ARIA/apg/patterns/button/ | 2026-09-29 | high | "it is critical the label on a toggle does not change when its state changes" |
| F56 | MDN: scaling or panning large objects can trigger vestibular disorders |  | https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion | 2026-09-29 | high | "Animations such as scaling or panning large objects can be vestibular motion triggers." |
| F57 | Playwright 1.63 emulateMedia supports reducedMotion, forcedColors, contrast and colorScheme (no reduced-transparency) |  | https://playwright.dev/docs/api/class-page | 2026-09-29 | high | "Emulates 'prefers-reduced-motion' media feature, supported values are 'reduce' , 'no-preference' ." |
| F58 | Apple HIG: avoid requiring specific body movements or positions; offer alternative inputs |  | https://developer.apple.com/tutorials/data/design/human-interface-guidelines/gestures.json | 2026-09-29 | high | "Avoid requiring specific body movements or positions for input." |
| F59 | Apple HIG: iOS default control size 44x44 pt (minimum 28x28 pt); spacing about 12 pt around bezelled controls | 44x44 pt | https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json | 2026-09-29 | high | "Consider spacing between controls as important as size." |
| F60 | Android developers recommend touch targets of at least 48dp x 48dp | 48dp | https://developer.android.com/guide/topics/ui/accessibility/apps | 2026-09-29 | high | "of at least 48dpx48dp" |
| F61 | Apple HIG motion: make motion optional and let people cancel motion |  | https://developer.apple.com/tutorials/data/design/human-interface-guidelines/motion.json | 2026-09-29 | high | "Let people cancel motion." |
| F62 | Computed: Lantern #ffb257 on Night #131a33 = 9.61:1 (passes 4.5:1 text and 3:1 UI) | 9.61:1 | https://www.w3.org/TR/WCAG22/ | 2026-09-29 | high |  |
| F63 | Computed: Ink #0c1122 on Lantern #ffb257 = 10.51:1 | 10.51:1 | https://www.w3.org/TR/WCAG22/ | 2026-09-29 | high |  |
| F64 | Computed: Shell #f1ead8 on Night = 14.31:1; on the glass rgba(11,18,33,.72) over Night 15.25:1; worst case over pure white 6.29:1 (over a Shell-coloured moon 6.90:1) | 14.31:1 / 15.25:1 / 6.29:1 | https://www.w3.org/TR/WCAG22/ | 2026-09-29 | high |  |
| F65 | Computed: Lantern on a Shell surface is 1.49:1 (fails 3:1 and 4.5:1); Shell on Pool is 2.80:1; Ink on Shell is 15.64:1 | 1.49:1 / 2.80:1 / 15.64:1 | https://www.w3.org/TR/WCAG22/ | 2026-09-29 | high |  |
| F66 | Computed: a Night\|Lantern\|Night three-band focus ring has at least 3.10:1 against any sampled solid background | 3.10:1 minimum | https://www.w3.org/TR/WCAG22/ | 2026-09-29 | high |  |
| F67 | Computed: state-dot hues are near-equal in lightness (needs-attention vs traveling 1.01:1; healthy vs traveling 1.04:1), so colour cannot carry state | 1.01:1 to 1.23:1 for 9 pairs | https://www.w3.org/TR/WCAG22/ | 2026-09-29 | high |  |
| F68 | Computed: coloured text on the .72 glass needs alpha 0.712 (Lantern), 0.769 (Moss), 0.907 (Pool) over a Shell-coloured backdrop to reach 4.5:1; Lantern text over glass on pure white is 4.23:1 | 0.712 / 0.769 / 0.907 | https://www.w3.org/TR/WCAG22/ | 2026-09-29 | high |  |
| F69 | axe-core 4.13.0 was published 2026-08-05; it has 105 rules of which 89 are enabled by default and 16 disabled | 105 rules; 89 enabled | https://www.npmjs.com/package/axe-core | 2026-09-29 | high |  |
| F70 | Only one axe rule (target-size) maps to a WCAG 2.2 success criterion (2.5.8) and it is disabled by default; a default AxeBuilder run did not report three 16 px targets | wcag22aa: 1 rule; enabled=false | https://www.npmjs.com/package/axe-core | 2026-09-29 | high |  |
| F71 | Playwright's accessibility guide example tags omit wcag22aa, so target-size does not run with that example |  | https://playwright.dev/docs/accessibility-testing | 2026-09-29 | high | "you would use the tags wcag2a , wcag2aa , wcag21a , and wcag21aa" |
| F72 | axe-core colour-contrast returns incomplete (not pass/fail) for text over a glass panel above a WebGL canvas | incomplete (3 nodes) | https://www.npmjs.com/package/axe-core | 2026-09-29 | high | "Element's background color could not be determined because it partially overlaps other elements" |
| F73 | axe-core vendor claim: finds on average 57% of WCAG issues automatically and marks uncertain results as incomplete | 57% | https://www.npmjs.com/package/axe-core | 2026-09-29 | medium | "on average 57% of WCAG issues automatically" |
| F74 | UK GDS tool audit: 42 of 143 planted barriers were missed by all 10 automated tools (29%) | 42 of 143 (2017) | https://accessibility.blog.gov.uk/2017/02/24/what-we-found-when-we-tested-tools-on-the-worlds-least-accessible-webpage/ | 2026-09-29 | medium | "Of the 143 barriers we created, a total of 42 were missed by all of the tools we tested." |
| F75 | Playwright docs: automated tests detect some problems but many can only be found by manual testing |  | https://playwright.dev/docs/accessibility-testing | 2026-09-29 | high | "But many accessibility problems can only be discovered through manual testing." |
| F76 | @axe-core/playwright 4.13.0 (2026-08-11) requires pages created from browser.newContext() and depends on axe-core ~4.13.0 | 4.13.0 | https://www.npmjs.com/package/@axe-core/playwright | 2026-09-29 | high | "Please use browser.newContext()" |
| F77 | WebAIM Million (Feb 2026): 95.9% of home pages had detected WCAG 2 failures; low-contrast text on 83.9%; pages with ARIA averaged 59.1 errors vs 42 | 95.9% | https://webaim.org/projects/million/ | 2026-09-29 | high | "95.9% of home pages had detected WCAG 2 failures." |
| F78 | Guidepup 0.34.0 automates VoiceOver on macOS and NVDA on Windows only | 0.34.0 | https://www.npmjs.com/package/@guidepup/guidepup | 2026-09-29 | high | "VoiceOver on MacOS ... NVDA on Windows ... with a single API" |
| F79 | eslint-plugin-jsx-a11y 6.10.2 (2024-10-26) has an ESLint peer range ending at ^9 | peer eslint ^3 \|\| ... \|\| ^9 | https://www.npmjs.com/package/eslint-plugin-jsx-a11y | 2026-09-29 | high |  |
| F80 | WebAIM #11 (Jul-Aug 2026, n=1780): primary desktop screen reader JAWS 55.0%, NVDA 32.9%, VoiceOver 6.5% | JAWS 55.0% / NVDA 32.9% / VO 6.5% | https://webaim.org/projects/screenreadersurvey11/ | 2026-09-29 | high | "JAWS \| 975 \| 55.0%" |
| F81 | WebAIM #11 top screen reader and browser pairs: JAWS+Chrome 31.2%, NVDA+Chrome 17.3%, JAWS+Edge 17.0%, NVDA+Firefox 9.1%, VoiceOver+Safari 4.3% | 31.2% top pair | https://webaim.org/projects/screenreadersurvey11/ | 2026-09-29 | high | "JAWS with Chrome \| 549 \| 31.2%" |
| F82 | WebAIM #11 mobile: 91.8% use a mobile screen reader; VoiceOver 72.2% and TalkBack 29.5% commonly used; iOS 73.3% primary platform | VoiceOver 72.2% / TalkBack 29.5% | https://webaim.org/projects/screenreadersurvey11/ | 2026-09-29 | high | "VoiceOver \| 72.2%" |
| F83 | WebAIM #10 (Jan 2024) for comparison: JAWS 40.5%, NVDA 37.7%, VoiceOver 9.7% primary | JAWS 40.5% / NVDA 37.7% | https://webaim.org/projects/screenreadersurvey10/ | 2026-09-29 | high | "NVDA \| 577 \| 37.7%" |
| F84 | GOV.UK minimum assistive technology combinations: JAWS+Chrome/Edge, NVDA+Chrome/Firefox/Edge, VoiceOver iOS+Safari, TalkBack+Chrome, magnifier, Dragon |  | https://www.gov.uk/service-manual/technology/testing-with-assistive-technologies | 2026-09-29 | high | "your service must work with at least the following combinations of assistive technologies and browsers before it goes into public beta" |
| F85 | NVDA current version on the NV Access download page is 2026.2; JAWS offers a 'Full-featured JAWS trial for Windows (no feature lock)' | NVDA 2026.2 | https://www.nvaccess.org/download/ | 2026-09-29 | high | "NVDA version 2026.2" |
| F86 | Global support (caniuse data updated 2026-09-28): prefers-reduced-motion 96.45% (Chrome 74, Firefox 63, Safari 10.1) | 96.45% | https://raw.githubusercontent.com/Fyrd/caniuse/main/data.json | 2026-09-29 | high |  |
| F87 | MDN browser-compat-data 8.1.3: prefers-reduced-transparency is experimental (Chrome 118, Firefox flag only, Safari no); forced-colors Chrome 89, Firefox 89, Safari 16; prefers-contrast Chrome 96, Firefox 101, Safari 14.1; inert Chrome 102, Firefox 112, Safari 15.5 | prefers-reduced-transparency: no Safari | https://www.npmjs.com/package/@mdn/browser-compat-data | 2026-09-29 | high |  |
| F88 | Stripe docs say Checkout pages have labeled controls and accommodate customers who use screen readers, but give no WCAG conformance claim |  | https://docs.stripe.com/payments/checkout/how-checkout-works?payment-ui=stripe-hosted | 2026-09-29 | medium | "They also accommodate customers who might have accessibility needs, such as those who use screen readers." |
| F89 | A Stripe Checkout Session expires after 24 hours by default and can be set from 30 minutes to 24 hours |  | https://docs.stripe.com/payments/checkout/how-checkout-works?payment-ui=stripe-hosted | 2026-09-29 | high | "It can be anywhere from 30 minutes to 24 hours after" |
| F90 | Playwright provides toMatchAriaSnapshot for asserting the accessibility tree, usable for Grove/Ledger parity |  | https://playwright.dev/docs/aria-snapshots | 2026-09-29 | high | "aria snapshots provide a YAML representation of the accessibility tree of a page" |
| F91 | Using ARIA note is a Discontinued Draft (24 Feb 2026); W3C points to the APG |  | https://www.w3.org/TR/using-aria/ | 2026-09-29 | high | "Using ARIA is a Discontinued Draft." |

## 11. Source index (all accessed 2026-09-29)

| ID | Source | URL |
|---|---|---|
| S1 | WCAG 2.2 (W3C Recommendation, 12 Dec 2024) | https://www.w3.org/TR/WCAG22/ |
| S2 | WCAG 3.0 (Working Draft, 10 Sep 2026) | https://www.w3.org/TR/wcag-3.0/ |
| S3 | WAI: WCAG 2 Overview (updated 17 Sep 2026) | https://www.w3.org/WAI/standards-guidelines/wcag/ |
| S4 | WAI: What's new in WCAG 2.2 | https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/ |
| S5 | Understanding WCAG 2.2 pages read: keyboard, pointer-gestures, pointer-cancellation, dragging-movements, target-size-minimum, target-size-enhanced, accessible-authentication-minimum, status-messages, pause-stop-hide, animation-from-interactions, focus-not-obscured-minimum, focus-visible, content-on-hover-or-focus, non-text-contrast, contrast-minimum, timing-adjustable, use-of-color, audio-control, sensory-characteristics, label-in-name, motion-actuation, no-keyboard-trap, focus-order, consistent-help, redundant-entry, three-flashes-or-below-threshold, reflow | https://www.w3.org/WAI/WCAG22/Understanding/ (append `<slug>.html`) |
| S6 | WCAG 2.2 Techniques: C39, SCR40, ARIA22, ARIA23, ARIA19, G219, F83 | https://www.w3.org/WAI/WCAG22/Techniques/css/C39.html ; .../client-side-script/SCR40.html ; .../aria/ARIA22.html ; .../failures/F83.html |
| S7 | WAI-ARIA 1.2 (Recommendation 6 Jun 2023) | https://www.w3.org/TR/wai-aria-1.2/ |
| S8 | ARIA Authoring Practices Guide: keyboard interface, dialog (modal), button, tabs, sortable table, alert, toolbar | https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/ ; .../patterns/dialog-modal/ ; .../patterns/button/ ; .../patterns/tabs/ ; .../patterns/table/examples/sortable-table/ |
| S9 | HTML Standard, canvas element | https://html.spec.whatwg.org/multipage/canvas.html |
| S10 | MDN: ARIA live regions; dialog element; inert; prefers-reduced-motion; prefers-reduced-transparency; aria-live | https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions ; .../HTML/Reference/Elements/dialog ; .../CSS/@media/prefers-reduced-motion |
| S11 | Directive (EU) 2019/882 (EAA), EUR-Lex consolidated text (read via headless Chromium) | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32019L0882 |
| S12 | European Commission: European Accessibility Act page | https://commission.europa.eu/strategy-and-policy/policies/justice-and-fundamental-rights/disability/european-accessibility-act-eaa_en |
| S13 | AccessibleEU: "The European accessibility standard EN 301 549 has been updated" (7 Sep 2026) | https://accessible-eu-centre.ec.europa.eu/content-corner/news/european-accessibility-standard-en-301-549-has-been-updated-2026-09-07_en |
| S13a | AccessibleEU: "Why accessibility complaints remain rare..." (24 Sep 2026) | https://accessible-eu-centre.ec.europa.eu/content-corner/news/why-accessibility-complaints-remain-rare-despite-widespread-digital-barriers-2026-09-24_en |
| S14 | ETSI EN 301 549 V4.1.1 (2026-09) PDF, 276 pages; folder listing dated 2026-09-02 | https://www.etsi.org/deliver/etsi_en/301500_301599/301549/04.01.01_60/en_301549v040101p.pdf |
| S15 | German BFSG ss.1, 2, 3, 4, 14, 20, 28, 29, 32, 33, 37 and BFSGV toc, ss.1, 12 (gesetze-im-internet.de) | https://www.gesetze-im-internet.de/bfsg/__3.html (and __37, __29, __28, __32, __20 ...) |
| S16 | Ireland S.I. No. 636/2023, European Union (Accessibility Requirements of Products and Services) Regulations 2023 | https://www.irishstatutebook.ie/eli/2023/si/636/made/en/print |
| S17 | ADA.gov: Guidance on Web Accessibility and the ADA; Title II web rule page (IFR of 20 Apr 2026) | https://www.ada.gov/resources/web-guidance/ ; https://www.ada.gov/resources/2024-03-08-web-rule/ |
| S18 | Seyfarth ADA Title III blog: 2026 mid-year report (9 Sep 2026); website filings in 2025 (25 Mar 2026); DOJ Title II extension (20 Apr 2026); DOJ regulatory agenda (Oct 2025) | https://www.adatitleiii.com/2026/09/2026-mid-year-report-ada-title-iii-federal-lawsuit-numbers-are-climbing/ ; .../2026/03/federal-court-website-accessibility-lawsuit-filings-bounce-back-in-2025/ ; .../2026/04/doj-extends-ada-title-ii-website-accessibility-deadlines-for-governmental-entities-but-litigation-and-compliance-risks-remain/ ; .../2025/10/doj-to-re-examine-all-ada-title-ii-and-iii-regulations-on-a-tbd-timetable/ |
| S19 | UsableNet ADA lawsuit tracker (Aug 2026) and 2026 midyear report page | https://info.usablenet.com/ada-website-compliance-lawsuit-tracker ; https://info.usablenet.com/2026-midyear-report |
| S20 | Section508.gov: applicability and conformance; laws and policies | https://www.section508.gov/develop/applicability-conformance/ ; https://www.section508.gov/manage/laws-and-policies/ |
| S21 | axe-core 4.13.0 (npm registry, README, `axe.getRules()`), @axe-core/playwright 4.13.0, other npm packages, plus this session's probe | https://www.npmjs.com/package/axe-core ; https://www.npmjs.com/package/@axe-core/playwright ; local `a11y/axe/` |
| S22 | Playwright docs: accessibility testing; ARIA snapshots; Page.emulateMedia | https://playwright.dev/docs/accessibility-testing ; https://playwright.dev/docs/aria-snapshots ; https://playwright.dev/docs/api/class-page |
| S23a | WebAIM Screen Reader User Survey #11 (Jul-Aug 2026) | https://webaim.org/projects/screenreadersurvey11/ |
| S23b | WebAIM Screen Reader User Survey #10 (Jan 2024) | https://webaim.org/projects/screenreadersurvey10/ |
| S23c | The WebAIM Million (Feb 2026 data) | https://webaim.org/projects/million/ |
| S24a | GOV.UK Service Manual: Testing with assistive technologies | https://www.gov.uk/service-manual/technology/testing-with-assistive-technologies |
| S24b | GDS Accessibility blog: tools audit (24 Feb 2017) | https://accessibility.blog.gov.uk/2017/02/24/what-we-found-when-we-tested-tools-on-the-worlds-least-accessible-webpage/ |
| S25 | NV Access download page (NVDA 2026.2); Freedom Scientific JAWS page (via headless Chromium) | https://www.nvaccess.org/download/ ; https://www.freedomscientific.com/products/software/jaws/ |
| S26 | Apple Human Interface Guidelines JSON: accessibility, gestures, motion | https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json (and gestures.json, motion.json) |
| S26b | Android Developers: Make apps more accessible | https://developer.android.com/guide/topics/ui/accessibility/apps |
| S27 | caniuse `data.json` (updated 2026-09-28) and MDN browser-compat-data 8.1.3 (npm, modified 2026-09-24) | https://raw.githubusercontent.com/Fyrd/caniuse/main/data.json ; https://www.npmjs.com/package/@mdn/browser-compat-data |
| S28 | Web Authentication Level 3 (Recommendation 25 Aug 2026) | https://www.w3.org/TR/webauthn-3/ |
| S29 | Stripe docs, Checkout how it works (read through the Stripe documentation search tool) | https://docs.stripe.com/payments/checkout/how-checkout-works?payment-ui=stripe-hosted |
| S30 | Guidepup (npm README) | https://www.npmjs.com/package/@guidepup/guidepup |
| S31 | Using ARIA (Discontinued Draft, 24 Feb 2026) | https://www.w3.org/TR/using-aria/ |

Local artefacts (all under `working-directory/research/a11y/`): `contrast.py`, `contrast-output.txt`, `contrast-tables.md`, `mdtables.py`, `axe/test.html`, `axe/run.js`, `axe/run-output.txt`, `findings_src.py`, `findings.json`, `verify_quotes.py`, `raw/` (fetched pages as text).
