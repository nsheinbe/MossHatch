# Mosshatch plan

Last updated 2026-09-29. Companion files: `docs/DECISIONS.md` (one entry per decision) and `docs/research/` (the evidence: one dossier per topic plus the notes from the independent verifier who tried to refute it).

## Status

| Phase | State | Notes |
|---|---|---|
| 0 Plan | **Complete, waiting for your "go"** | Research, plan, decisions. No application code exists |
| 1 The place (no backend) | Not started | Starts after "go" and the answers to the open decisions that touch it |
| 2 Accounts and money | Not started | Blocked on: registrar, fee, payment path, entity and counsel decisions |
| 3 My domains | Not started | |
| 4 The Nest | Not started | |
| 5 Transfers and agents | Not started | |
| 6 hatchkind.com and launch | Not started | |

## What Phase 0 found, in one page

1. **Registrar.** Use **OpenSRS (Tucows)** first: the only candidate whose published contract is written for resale, with wholesale prices published for all six extensions and a sandbox. Fallback **CentralNic Reseller**. Details and the full comparison are in 4.1. The main costs are operational: an XML API, an IP allow-list, no idempotency key, replace-all DNS.
2. **Price.** The USD 1.50 placeholder fails. Recommended: USD 4 per domain-year where wholesale is under USD 50 a year, USD 9 above. That makes `.com` USD 19.25 against about USD 11 at retail registrars: Mosshatch will not be the cheapest, and the plan says so plainly (4.2).
3. **Payments.** Register while the money is only authorized, then capture. Cancelling an authorization is free; a refund keeps Stripe's fee. This departs from the brief's `payment_intent.succeeded` gate (D-002) and carries one open legal question: whether an authorization hold is the "reasonable assurance of payment" that RAA 3.7.4 requires; if not, the fallback is capture-then-refund at a cost of about USD 0.90 per failed registration.
4. **`.ai` and `.io` need care.** `.ai` has a two-year minimum (USD 222 wholesale at first charge), no privacy service, public contacts, and is absent from the OpenSRS sandbox. `.io`'s future is uncertain and it also has no privacy service. Both are built as creatures from day one but sold only after tests and disclosures (D-006).
5. **Stack.** Confirmed with changes: Vercel **Pro** is required (Hobby forbids commercial use); Drizzle's `neon-http` driver cannot do transactions, so use `node-postgres`; session cookies must be `SameSite=Lax` (Strict breaks the return from Stripe); Node 24; TypeScript 7 through an alias; AWS KMS for the vault (4.3a).
6. **Security.** A written threat model with 27 rows and 41 named security tests (4.6). Honest limit: the vault is not zero-knowledge; a full compromise of the production project exposes what it can decrypt until the key is disabled.
7. **Compliance.** ICANN's new transfer rules (the TAC, no lock after registrant change) were adopted by the Board on 2026-06-07 but have **no effective date**; build to today's policy. Launch United States only until tax registrations exist. A checklist of about 60 obligations is in 4.7 with the questions for counsel.
8. **Names.** No blocking trademark conflict found for Mosshatch or Hatchkind; CROSSHATCH (Class 42) is the closest collision and HATCH is crowded, so a professional clearance is needed. `hatchkind.com` as the public card host is workable under strict conditions (4.8).
9. **Feasibility of the scene.** A procedural WebGL2 scene fits the budgets: the measured lazily loaded scene chunk is 134 kB gzip, first paint can be real HTML, and deterministic screenshot tests work in this container. What cannot be verified here (real GPUs, Safari, thermals) is listed in 4.10.
10. **Research quality.** 37 research dossiers were followed by 39 independent verification passes, each by an agent instructed to refute the load-bearing claims by re-fetching the primary sources. They recorded more than 230 claims as corrected, refuted or unverifiable (for example: the Namecheap `.studio` price basis; the ERRP start date; the `.ai` two-year minimum date; Porkbun's API quotes; the Transfer Policy status), all collected in `docs/research/verification-digest.md`, and every correction is applied. The search tool's 200-call budget ran out early, so most later work used direct fetches; sites that blocked access were not worked around and the affected claims are marked unverified.

## Open decisions (eight, each with my recommendation)

| # | Decision | Recommendation | Entry |
|---|---|---|---|
| 1 | Registrar | OpenSRS primary, CentralNic fallback. Before paying the USD 95 activation fee, send OpenSRS the written questions in 4.1 and have counsel read the MSA | D-001 |
| 2 | Fee and positioning | USD 4 standard, USD 9 for wholesale of USD 50 or more; accept that Mosshatch is honest, not cheapest | D-003 |
| 3 | Payment path | Authorize, register, capture (departs from the brief); counsel to confirm the RAA 3.7.4 reading | D-002 |
| 4 | Launch scope | United States, USD, cards and wallets; `.com`, `.dev`, `.app` first; `.studio` after the fee decision; `.io` and `.ai` gated | D-006 |
| 5 | Registrar egress | Vercel Static IPs (USD 100 a month) for the one registrar project, or a self-run fixed-address gateway | D-005 |
| 6 | Counsel and accountant | Engage both before Phase 2; the priority questions are in 4.7; include trademark clearance for both names | D-007, D-012 |
| 7 | Product departures from the brief | Single-activation path for hold-to-reveal (D-010); agent-gated sensitive DNS changes (D-011); an owner-chosen, not default, security delay on transfer-out; the Gate is built on what the upstream allows (D-009) | D-009, D-010, D-011 |
| 8 | Nest trust model | Server-side decryption with AWS KMS, not zero-knowledge; client-held-key tier later | D-004 |

Accounts and spend that only you can open: an entity or sole-proprietor identity; OpenSRS (USD 95); Vercel Pro; a Neon project; an AWS account for KMS; Stripe; Resend; the sending-domain DNS at your current registrar. None is needed until Phase 2, except Vercel Pro for any deployment.

## Assumptions (veto any of these)

**Business and legal**
1. Mosshatch contracts as a company or sole proprietor (upstream contracts and Stripe need a legal identity), and a lawyer and an accountant are engaged (D-007).
2. Launch is United States only, USD only, cards and wallets only; no ACH, no Link until its capture window is documented (D-006).
3. The customer is always the registrant of record; Mosshatch never registers a name in its own name for someone else (D-020).
4. No promotional first-year prices at launch; "renews at" is read from the registrar's renewal price, and if register and renew prices differ both are shown at the same size (D-003).
5. Registrar-side auto-renew is off; Mosshatch drives renewal; a name never silently rolls over (D-008).
6. "WHOIS privacy: Free" means default redaction under the Registration Data Policy for the gTLDs; `.ai` and `.io` disclose what they expose (D-020).
7. Both domains you named (`mosshatch.com`, `hatchkind.com`) are yours: public RDAP shows only the registrar and the creation time (2026-09-29 17:48 UTC), and neither can leave the current registrar before about 2026-11-28.

**Technology**
8. Node 24.x, npm workspaces, Vite 8, React 19, three 0.186, TypeScript 7 via the alias; versions are re-verified at the start of Phase 1 (D-013).
9. One region: Vercel `iad1`, Neon `aws-us-east-1`, AWS KMS us-east-1. A Neon region cannot be changed later (D-014).
10. Vercel Pro from the first deployment (Hobby is non-commercial); Neon Launch until real customer money, then Scale (D-014).
11. Session idle 15 minutes and absolute 8 hours; step-up challenges live 120 seconds; the recovery design in 4.5 (D-016).
12. Strict CSP without nonces; Trusted Types in Report-Only first; no service worker in Phase 1 (D-015).
13. Fonts: Young Serif 400 and Atkinson Hyperlegible Next (variable, weights 400 to 700), self-hosted and subset, both SIL OFL 1.1 (measured 38.8 kB total).
14. At most 24 individually animated creatures in the Grove; more render as instanced silhouettes and appear in the Ledger (D-018).
15. The audit chain head is anchored daily to a store outside the database; the mechanism is chosen in Phase 2. Card snapshots are small PNGs stored outside the main database; the store is chosen in Phase 6.
16. A `?debug=states` route ships only in non-production builds.

**Process**
17. Commits stay local on `claude/vigilant-ritchie-8vinxb`; no push or pull request until you ask. The container is ephemeral, so ask for a push whenever you want the docs kept elsewhere (D-022).
18. Your brief is not committed to the repository unless you want it there.
19. Where a real value is unknown in the prototype (price, date, status), the UI shows a labelled placeholder ("sample price"); the product calls the adapter (brief section 0).

---

## 4. Phase 0 findings

Each subsection answers one of the eight deliverables in the brief's Phase 0. Numbers carry their source in the text or in `docs/research/`; anything unverified says so.
### 4.1 Registrar comparison (live-verified 2026-09-29)

**How this was done.** Nine providers got a full dossier (resale terms, all thirteen `RegistrarAdapter` methods, sandbox, rate limits, wholesale prices for the six launch extensions, lifecycle and transfer behaviour), and each dossier was then attacked by independent verifiers who re-fetched the primary sources. Nine more routes were screened. The verifiers changed the outcome in several places (for example Porkbun's API quotes `.io` and `.studio` at their renewal prices, not the promotional prices on its website; the Namecheap `.studio` price basis was wrong; Dynadot has a REST v1 that is not labelled beta). Everything below uses the verified value. Full evidence is in `docs/research/reg-*.md` and the `*.verify-*.md` files.

**Recommendation.**
- **Primary: OpenSRS (Tucows Domains Inc., IANA 69), Essential tier.** It is the only candidate whose published contract is written for resale ("wishes to use, resell and/or provision the Tucows Services for itself and the benefit its own Users", MSA preamble), whose end customer is the registrant of record, that needs no ICANN accreditation, that publishes wholesale prices for all six extensions, and that has a sandbox (Horizon). Signup is self-serve: a $95 one-time activation fee that converts to account credit, a prepaid USD balance, no monthly fee, no minimums.
- **Fallback: CentralNic Reseller (Key-Systems GmbH, IANA 269),** upgradeable if it quotes acceptable prices. It has an explicit Wholesale MSA plus Reseller Schedule, a modern REST API (OpenAPI, 287 operations, live since 2026-07-28) and an OT&E sandbox, but only `.com` is publicly priced (USD 18.33 at Basic Plus, 13.82 at Elite Plus), it wants a EUR 75 prepay, and its reseller duties are heavy.
- **Cost benchmark, not a fallback yet: Dynadot / Global Domain Group (IANA 3956).** Free, application-gated Reseller Program and the lowest list prices of any provider with an explicit program (`.com` 10.88), but the paper is one-sided (Dynadot ToU s3.1(d) requires that its terms prevail over the reseller's own customer agreement, which conflicts with Mosshatch owning its customer contract), the API is documented as beta, and `.dev` and `.app` are missing from its own list of API-supported TLDs. Worth a written clarification and a sandbox test before Phase 3, because per-TLD routing to a cheaper provider is possible through the adapter.
- **Not chosen:** Porkbun (best API ergonomics, but no reseller program and its API document says it "does not establish a reseller relationship"; no API for lock, auth code or transfer-out; USD 100 per-order cap breaks `.ai`), Namecheap (no program, binding terms unreadable, no wholesale tier, no auth-code or transfer-out API), Gandi (no wholesale list: a new reseller pays retail, `.com` renews at USD 38.38), Name.com (retail cost basis, reseller liability uncapped), NameSilo (reseller terms only visible after login), ResellerClub (its own site and prices were unreachable), AWS Route 53 Domains (no sandbox, default quota of 20 domains), GoDaddy (operative reseller terms unreadable), Cloudflare and Vercel (terms bar resale).

**Comparison (prices in USD per year; register equals renew unless noted; promotional first-year prices excluded because they would break "renews the same").**

| | OpenSRS Essential | CentralNic Reseller | Dynadot (reseller) | Porkbun | Namecheap (retail register price; renewals are higher) |
|---|---|---|---|---|---|
| Resale permitted | Yes, explicit (MSA) | Yes, explicit (MSA 5.2, Reseller Schedule) | Yes, explicit Reseller Program; one-sided paper | Conditional; no program, duties fall on the account holder | Support pages say yes; binding ToS unread |
| Joining | $95 credited; prepaid | EUR 75 prepay; signed schedules | Free, application (often instant) | Account; prepaid credit | Balance / spend gate; IPv4 allow-list |
| API | XML over HTTPS, port 55443, MD5 signature | REST OpenAPI plus legacy HTTPS | REST v2 (beta-labelled) and REST v1 (103 commands) | REST JSON v3.44 | XML |
| Adapter gaps | One lookup per call; DNS replace-all (no CAA, no TTL); no idempotency key (reconcile with `GET_ORDERS_BY_DOMAIN`); outbound transfer approved by email, not API | No webhooks, no idempotency key; 1 command per second | DNS has no record IDs; no idempotency key; `.dev`/`.app` not in API TLD list | No API for lock, auth code, transfer-out; $100 order cap | No auth code, no transfer-out, replace-all DNS, no webhooks, no idempotency |
| Sandbox | Horizon; $5,000 test credit; cannot simulate transfers or redemption; `.ai` absent | OT&E; same operations, different behaviour; bi-weekly maintenance | `api-sandbox.dynadot.com`; webhooks not testable | Free; keys need no account; transfers complete instantly | Separate account |
| Egress | Live IP allow-list, max 5 rules (/25 to /32) | Not stated | Not needed for reseller REST since 2025-10-09 | Per-key IP scoping optional | IPv4 allow-list required |
| Webhooks | HMAC-signed plus poll | None (poll `GET /event`) | 11 events, no retry policy documented | Signed webhooks in sandbox | None |
| Rate limits | Unpublished; lookups "may be rate-limited ... excessive use may result in a fee" | 1 command per second | 60 requests per minute, 1 thread; bulk search 5 names, 1,000 per day | 1 create per second; 25-name bulk check | Sources conflict: 20 or 50 per minute |
| `.com` | 14.50 (15.25 from 2026-11-01) | 18.33 / 13.82 | 10.88 | 11.08 | 11.28 retail |
| `.ai` | 111 (2-year minimum; 222 at first charge) | not public | 85.60 (2-year minimum) | 82.70 (2-year cost 165.40; refused by the $100 cap) | 89.98 retail |
| `.dev` | 17 | not public | 12.50 | 12.87 | 10.98 retail |
| `.io` | 60 | not public | 53.50 | 51.80 (API quote) | 34.98 retail |
| `.app` | 21 | not public | 14.50 | 14.93 | 10.98 retail |
| `.studio` | 42 (51 from 2026-10-06) | not public | 33.39 | 32.44 (API quote) | 39.98 (KB, rising to 51.48 on 2026-10-06) |
| WHOIS privacy | Default redaction under the Registration Data Policy; paid add-on USD 3 exists; not available for `.ai` or `.io` (and `.ai` shows contacts) | Not verified | Free, on by default | Free | Free, but API default is off (`WGEnabled=No`) |
| Verdict | **Primary** | **Fallback** | Cost benchmark | Reject as base; useful sandbox reference | Reject as base |

OpenSRS volume tiers (spend and registrations per year, reviewed each January, effective 1 April): Advanced USD 2,000 and 100 registrations or transfers takes `.com` to 13.50; Premium USD 50,000 and 500 to 12.50; Enterprise USD 100,000 and 1,000 to 11.50. The lowest available price always applies and promotions do not stack.

**Other routes screened** (`docs/research/reg-screen-others.md`): eNom (Tucows) is the same wholesale price table with a USD 195 enrollment fee (shown as USD 50 on the day) and no benefit over OpenSRS; AWS Route 53 Domains explicitly treats a party registering domains for third parties as an ICANN reseller (agreement s3.12) and supports all six TLDs, but has no sandbox, a default quota of 20 domains and no wholesale discount (`.com` 16, `.ai` 137 with a 2-year minimum and no privacy); GoDaddy has an OTE sandbox and a reseller plan sold to "select businesses", but its API terms and Reseller Agreement returned 403, so the resale clauses are unread; Cloudflare's registration API is beta with no renewals or transfers and its agreement bars selling access; Vercel's terms ban resale; Spaceship, Epik and Internet.bs could not be evaluated (bot protection or egress policy). Becoming an accredited registrar instead costs USD 3,500 to apply and USD 4,000 a year, plus roughly USD 70,000 of evidenced liquid capital, data escrow, RDAP and separate onboarding with each registry: a long-run option only.

**What the OpenSRS contract means for the product.**
- Price changes need 30 days' notice (Appendix A) but Tucows may adjust prices when ICANN or registry fees change, and premium fees "without notice". Two changes were already scheduled on the day of research: `.studio` +USD 9 on 2026-10-06 and `.com` +USD 0.75 on 2026-11-01. The flat-fee model must absorb the timing gap; renewal prices are shown with "may change with notice" and a 60-day customer notice policy (see the fee section).
- Tucows has broad suspension and termination rights, liability is capped and the customer's remedy is limited to a sole remedy (MSA 21.4 to 21.6); an ICANN-policy violation can end the agreement immediately (3.9); the agreement cannot be assigned without consent (23.4), which matters for any future sale or financing. Counsel must read the MSA before signing.
- Unrenewed names can be auctioned or parked by Tucows around day 41 to 45 and "parked pages" may show pay-per-click advertising (MSA Section 8): Mosshatch renews before expiry and must ask in writing whether a reseller can opt out.
- The deposit is non-refundable on account closure (KB) although MSA 21.6 mentions return of unused deposit; keep the prepaid float small and alert on `GET_BALANCE` (insufficient funds force orders into a pending queue).
- Static egress: the live API needs an allow-listed IP. Vercel Static IPs cost USD 100 per month per project on Pro; alternatives are recorded in D-005.
- Not verifiable without an account: real rate limits and the lookup fee, the add-grace-period length and refund rule per TLD, what happens on a duplicate `SW_REGISTER`, `.ai` and `.io` behaviour (`.ai` is not in Horizon). These are the written questions to ask before paying the activation fee:
1. What are the lookup rate limits, and what is the "excessive use" fee (MSA 3.2 and 12.11)? Showing eggs needs up to six lookups per settled search.
2. Is there any way to call the live API without an allow-listed address, or with more than five rules?
3. What are the add-grace-period length and refund rule for each of the six extensions, and what is the reseller's monthly cap under the AGP Limits Policy?
4. What does a duplicate or retried `SW_REGISTER` return, and is there an order lookup by our own reference?
5. `.ai` and `.io`: which contacts appear publicly, how are transfers and auth codes handled, and can `.ai` be tested before going live?
6. Who sends the ICANN-required registrant verification and expiry emails for reseller domains, in whose branding and on what schedule (OpenSRS documents 90, 60, 30 and 5 days before and 3 and 10 days after expiry)? Mosshatch must avoid duplicates and must not miss the mandatory ones.
7. Can a reseller opt out of the expired-domain auction (from day 41 to 45) and of parked pages with advertising (MSA Section 8), and what are the exact dates of expiry grace, nameserver switch and release?
8. When were the `.studio` (+USD 9, 2026-10-06) and `.com` (+USD 0.75, 2026-11-01) increases first notified, and is the 30-day notice in Appendix A honoured per change?
9. Which data-processing addendum applies today (the published one dates from 2018 and refers to Privacy Shield)?
10. How is a change of registrant handled (Designated Agent default, contact-privacy exemption, the 60-day lock), and does it match the February 2024 Transfer Policy?
11. Can an outbound transfer be declined or cancelled through the API, and how are `.io` codes requested?
12. Volume-tier promotion timing (reviewed in January, effective 1 April) and whether promotions apply to API orders.
13. Deposit terms: the knowledge base says the deposit is non-refundable on closure while MSA 21.6 mentions return of unused deposit.
### 4.2 Unit economics

**Finding.** The USD 1.50 flat fee in the brief does not survive contact with Stripe, refunds, disputes and renewal cycles. At OpenSRS Essential wholesale, USD 1.50 gives USD 0.09 to 0.30 of expected contribution per domain-year on `.com`, `.dev` and `.app`, and loses USD 1.04 on `.studio`, USD 2.99 on `.io` and USD 6.02 on `.ai`. A single flat fee also has a structural problem: Stripe's 2.9% scales with the ticket, so the fee that is right for a USD 15 name under-recovers on a USD 222 `.ai` order (Stripe alone takes USD 6.85 of it). The model, its inputs and its outputs are in `docs/research/unit-economics.py` and `docs/research/unit-economics-output.md`; it is an analysis script, not application code.

**Verified inputs.**

| Input | Value | Source (accessed 2026-09-29) |
|---|---|---|
| Stripe card fee | 2.9% + USD 0.30 domestic; +1.5% international card; +1% only if currency conversion is needed; Apple Pay, Google Pay and Link cards the same; hosted Checkout adds no fee | stripe.com/pricing; verified by re-fetch |
| Refund | Free to issue; the original fee is not returned | stripe.com/pricing FAQ |
| Dispute | USD 15 when received (never returned) plus USD 15 if countered (returned only on a win) | stripe.com/pricing; a lost, countered dispute on a USD 10 order costs USD 30.59 in fees and reverses the USD 10 |
| Radar | Lite included; Standard USD 0.05 per screened transaction | stripe.com/radar/pricing |
| Stripe Tax | 0.5% per transaction through Checkout where registered, or USD 0.50 through the API; break-even USD 100 tax-inclusive | stripe.com/pricing; verifier correction |
| Card programs | Visa VAMP excessive ratio 1.5% in the US since 2026-04-01 with a 1,500-event floor; the Non-compliant tier at 5 events and 0.5% is reachable at launch volume and may carry fees; Stripe's own review is the practical constraint (0.75% "excessive" line) | Stripe monitoring-programs page, Visa VAMP fact sheet |
| Wholesale | OpenSRS Essential: `.com` 15.25 (from 2026-11-01), `.dev` 17, `.app` 21, `.studio` 51 (from 2026-10-06), `.io` 60, `.ai` 111 with a 2-year minimum (222 at first charge) | opensrs.com/domains/pricing and /tld-price-changes |
| Funding | Card or PayPal deposits at OpenSRS carry a 3% fee that is a gross-up (deposit / 0.97, about +3.09%); ACH is US and Canada only | opensrs.com/payment-terms |
| Payouts | First payout typically 7 to 14 days; risk-based reserves possible; no numeric policy published | Stripe payout docs |

Effective Stripe cost on a domestic card order: USD 15 costs 4.90%, USD 20 4.40%, USD 25 4.10%, USD 60 3.40%, USD 115 3.16%, USD 226 3.03%. International cards add 1.5 points. All money is computed in integer cents or `Decimal`: binary floating point gives 15 x 0.029 + 0.30 = 0.7349999 (0.73) where Stripe charges USD 0.74.

**Assumptions in the model (no published base rate exists; every one is labelled in the script and can be changed).** International cards 15% of orders; refunds 3% of first orders and 0.5% of renewals; failed registrations 1% (authorization voided, no Stripe fee); disputes 0.5% of first orders and 1.0% of renewals with 70% lost after countering; upstream recovery of the wholesale cost on a cancelled gTLD registration 90% (add-grace refund, capped by the AGP Limits Policy), 0% for `.io` and `.ai`; renewals are final upstream (0% recovery); support cost USD 1.50 per refund, USD 5 per dispute, USD 2 per failed registration; no sales tax registrations at launch. Published digital-goods dispute rates from vendors range from 0.26% to 3.62% with no dataset behind them, so treat the dispute rate as the softest input.

**Expected contribution per domain-year (USD), first order, OpenSRS Essential.**

| Extension | Years per order | Wholesale per year | F = 2 | F = 3 | F = 4 | F = 6 | F = 8 | F = 10 |
|---|---|---|---|---|---|---|---|---|
| `.com` | 1 | 15.25 | 0.77 | 1.69 | 2.62 | 4.47 | 6.32 | 8.17 |
| `.dev` | 1 | 17.00 | 0.70 | 1.63 | 2.55 | 4.40 | 6.25 | 8.10 |
| `.app` | 1 | 21.00 | 0.55 | 1.48 | 2.40 | 4.25 | 6.10 | 7.95 |
| `.studio` | 1 | 51.00 | -0.57 | 0.35 | 1.28 | 3.13 | 4.98 | 6.83 |
| `.io` | 1 | 60.00 | -2.53 | -1.60 | -0.68 | 1.17 | 3.02 | 4.87 |
| `.ai` | 2 | 111.00 | -5.56 | -4.63 | -3.71 | -1.86 | -0.01 | 1.85 |

**Flat fee needed for a target expected contribution per domain-year** (first order / renewal): for zero contribution `.com` 1.25 / 1.50, `.ai` 8.25 / 5.75, `.io` 4.75 / 3.50; for USD 1.50 `.com` and `.dev` 3.00, `.app` 3.25, `.studio` 4.25, `.io` 6.50, `.ai` 9.75; for USD 2.50 `.com` 4.00, `.studio` 5.50, `.io` 7.50, `.ai` 10.75. The same run on Dynadot's list prices needs USD 0.25 to 1.75 less on each extension but does not change the shape.

**Sensitivity** (fee USD 4 for `.com` and `.app`, USD 9 for `.studio`, `.io`, `.ai`; USD per domain-year):

| Case | `.com` | `.app` | `.studio` | `.io` | `.ai` |
|---|---|---|---|---|---|
| Base case | 2.62 | 2.40 | 5.91 | 3.95 | 0.92 |
| Disputes 1.0% (first) / 2.0% (renewal) | 2.40 | 2.16 | 5.54 | 3.56 | 0.42 |
| Disputes 2.0% / 3.0% (Stripe would intervene) | 1.96 | 1.68 | 4.82 | 2.77 | -0.57 |
| Refunds 8% of first orders | 2.27 | 2.02 | 5.13 | 0.42 | -5.12 |
| All cards international | 2.37 | 2.09 | 5.15 | 3.08 | -0.59 |
| Stripe Tax on every order | 2.52 | 2.28 | 5.62 | 3.62 | 0.35 |
| No upstream refund on cancel (AGP pool exhausted) | 2.21 | 1.83 | 4.53 | 3.95 | 0.92 |

A single lost dispute costs the wholesale price plus fees plus USD 30, roughly ten to thirty times the contribution of the order it belongs to, so the plan treats dispute prevention (clear descriptor, receipts, refund policy, Radar, passkey-approved renewals) as a margin control and not only a risk control. `.io` and `.ai` refunds are unrecoverable upstream, which is why the table shows them collapsing at 8% refunds.

**Recommended fee structure (decision D-003).**
- **Standard fee USD 4.00 per domain-year** on any extension whose wholesale is under USD 50 a year (`.com`, `.dev`, `.app`); **large-ticket fee USD 9.00 per domain-year** at or above USD 50 (`.studio` after 2026-10-06, `.io`, `.ai`). The same fee applies to registration, renewal and transfer-in. Restores pass through the published upstream restore fee plus the same fee. WHOIS privacy is not a line item.
- Resulting first-order prices at November 2026 wholesale: `.com` USD 19.25, `.dev` 21.00, `.app` 25.00, `.studio` 60.00, `.io` 69.00, `.ai` USD 240.00 for the mandatory two years (USD 120 a year). The Hatch sheet shows "Registry and registrar cost + Mosshatch fee = price" and "Renews at" at the same size, and for `.ai` the first row reads "First 2 years (minimum)" because the registry allows no shorter term.
- **Mosshatch will not be the cheapest.** Public retail renewals on the day of research were `.com` 10.46 to 11.08, `.studio` 31.20 to 33.39, `.io` 50.00 to 53.50 and `.ai` 80.00 to 85.60 at Cloudflare, Porkbun and Dynadot. The positioning has to rest on the honest, itemized price and the product, not on price. Two levers exist: OpenSRS volume tiers (Advanced needs USD 2,000 of spend and 100 registrations a year and takes USD 1 off `.com`; Enterprise USD 3 to 12 off) and per-extension routing to a cheaper provider once the adapter layer is proven (for example Dynadot's `.studio` at 33.39).
- Alternatives considered: one flat fee of USD 4 (sell `.com`, `.dev`, `.app` only; `.studio` earns 1.28, `.io` loses 0.68, `.ai` loses 3.71); one flat fee of USD 9 for everything (`.com` becomes USD 24.25, uncompetitive); a percentage fee (rejected: it is not a flat fee and hides the card cost).
- `.ai` should not go on sale until the OpenSRS `.ai` path has been tested (not available in Horizon), the two-year and two-year-transfer charges are confirmed with `get_price`, and the public-contact exposure (no privacy service) is disclosed at the point of sale.

**How renewals are charged.**
1. Auto-renew is opt-in, never pre-checked, and is a passkey-signed mandate with a price ceiling (compliance details in section 4.7).
2. The charge is an off-session PaymentIntent on the saved card at charge date C, about ten days before expiry E (notices at E-43, E-32 and C-8; decline ladder at C, C+3 and C+6 with at least seven days to pay by other means). Card authentication failures (`authentication_required`) email an on-session pay link.
3. **Charge first, renew upstream second.** Renewals are final at OpenSRS ("cannot be cancelled under any circumstances"), so the upstream call happens only after the charge succeeds, out of a prepaid balance kept at roughly the next 45 days of wholesale renewals and funded by ACH to avoid the 3.09% card gross-up.
4. Wholesale price changes pass through: registry increases are announced months ahead (`.com` 6 months) but OpenSRS gives only 30 days, so the renewal quote shown in the panel is refreshed daily and any change is emailed at least 30 days before a charge it affects. The flat fee itself is fixed for a term already quoted and changes only with 60 days' notice.

**Fixed costs (infrastructure only; excludes labour, counsel, accounting, insurance and any Stripe Tax Complete plan at USD 90 a month).** Lean scenario about USD 70 a month (Vercel Pro USD 20, Neon usage about USD 25, AWS KMS about USD 4, a small fixed-IP gateway about USD 6 and USD 15 for domains and monitoring; Neon, gateway and monitoring figures are our own estimates). With Vercel Static IPs (USD 100 a month) and Resend Pro (USD 20) about USD 184 a month. At an expected contribution of USD 2.50 per domain-year that is 28 to 74 domain-years a month to cover infrastructure alone, and the OpenSRS activation fee is a one-time USD 95.

### 4.3 Architecture

Stack verdicts first (4.3a), then the architecture that follows from them (4.3b).
### 4.3a Stack verdicts (confirm or challenge)

Versions are the `latest` npm tags on 2026-09-29 unless stated; every entry is backed by `docs/research/tech-*.md` and its verification notes.

| Brief choice | Verdict | What the research says and what changes |
|---|---|---|
| Vite + React + TypeScript | **Confirm, with a toolchain note** | Vite 8.3.1 (Rolldown and Oxc; there is no Rollup or esbuild in the default build), `@vitejs/plugin-react` 6.1.1 (peer `vite ^8`), React 19.3.0, TypeScript 7.0.2 (native compiler, no stable JS API). `typescript-eslint` peers `typescript <6.1.0`, so install TS through Microsoft's documented alias (`typescript` to `@typescript/typescript6`, `@typescript/native` to `typescript@^7`). Tested: `tsc` 7 and 6, Vite build, Vitest 5, ESLint 10, `drizzle-kit generate`, size-limit all pass on Node 24.21 and 26.10. Clean install of 35 packages: 494 packages, no peer conflicts |
| three.js used imperatively, WebGL2 | **Confirm** | three 0.186.1 (ESM-only, cadence slowed to about 70 days). WebGL2 is 96.4% of global usage (caniuse-db 2026-09-28; floors iOS Safari 15, Chrome Android 58). `WebGPURenderer` is still experimental and does not support custom `ShaderMaterial`, so it cannot be the sole target. Watch: `Clock` is deprecated (use `Timer`); `ColorManagement` on by default; `ShaderMaterial` must include `colorspace_fragment` itself. three does not declare `sideEffects: false` and a bare `WebGLRenderer` is 128 kB gzip, so tree shaking helps little: budget for a lazily loaded scene chunk |
| Zustand as bridge | **Confirm** | 5.0.15, declares `sideEffects: false`, about 0.6 kB |
| Vercel functions | **Confirm, on Pro** | Hobby is contractually personal and non-commercial and its definition of commercial includes "requesting or processing payment from visitors": Pro is required (USD 20 per month with one deploying seat and USD 20 usage credit). Use Node.js Fluid functions, Node 24.x (Node 20 is disabled for new deployments on 2026-10-01), not Edge. Limits on Pro: 300 s default and 800 s maximum duration, 4.5 MB body. No SLA on Pro (Enterprise 99.99%); 133 status incidents in the last 12 months, including an iad1 outage on 2026-05-08 that hit Functions, Queues and Workflow. Runtime logs are kept 1 day on Pro, so audit evidence must live in the database, not in Vercel logs |
| Durable `jobs` table plus cron | **Confirm** | Cron on Pro can run every minute (100 jobs per project, UTC, production only, `Authorization: Bearer $CRON_SECRET`) but delivery is "best effort": it can be duplicated or silently missed and failed runs are not retried. A Postgres table claimed with `FOR UPDATE SKIP LOCKED` plus a one-minute sweeper matches Vercel's own guidance. Vercel Queues is beta and the Workflow SDK has no GA announcement: keep them off the money path |
| Neon Postgres with Drizzle | **Confirm, with a driver change** | Drizzle's `neon-http` driver still has no interactive transactions (`db.transaction()` throws in drizzle-orm 0.45.3 and 1.0.0-rc.4), which the order ledger and audit writes need. Neon recommends `node-postgres` over TCP with a pool and `attachDatabasePool` on Vercel Fluid: use that (or the WebSocket `neon-serverless` driver). Region: Neon `aws-us-east-1` pairs with Vercel `iad1`, and a Neon region can never be changed. Create the runtime role with SQL: roles made in the Console, API or CLI (including `neondb_owner`) are `neon_superuser` with BYPASSRLS and can write any table regardless of REVOKEs. `drizzle-orm` must be at least 0.45.2 (CVE-2026-39356, SQL injection through dynamic identifiers). The Drizzle 0.45 migrator skips out-of-order migrations, so migration files need monotonic timestamps. Plans: Launch (usage-based, PITR 7 days, billing support only) is fine for Phases 1 to 3; the 30-day PITR, IP allow-list and SOC 2 report access are Scale features, so plan Scale before real customer money |
| SimpleWebAuthn | **Confirm** | `@simplewebauthn/server` 14.0.3, `/browser` 14.0.0, Node 22 or later. WebAuthn Level 3 became a W3C Recommendation on 2026-08-25. The library is stateless: a valid assertion verified twice in the research harness passed both times at counter 0, so replay defence is ours (single-use challenges). Set `userVerification: 'required'` explicitly (the library default is `'preferred'`) |
| Stripe Checkout (hosted) | **Confirm; change the payment gate** | stripe-node 22.6.2 pins API `2026-08-26.dahlia`: pin the package and pass `apiVersion` explicitly, and set it on the webhook endpoint. See D-002: authorize, register, then capture, instead of registering after `payment_intent.succeeded` |
| Resend | **Confirm** | Free 3,000 per month and 100 per day; Pro USD 20 for 50,000; 10 requests per second; `Idempotency-Key` on send (24 h). Content, metadata and logs are kept 30 days in the US whatever region you choose, so never put secrets, tokens or approval links in an email. Resend auto-revokes exposed `re_` keys (GitHub secret-scanning partner since 2026-07-16). Domain quota: Free 3, Pro 10 |
| A cloud KMS | **AWS KMS** | Symmetric AES-256 keys in us-east-1, one KEK per environment, reached through Vercel OIDC federation (`AssumeRoleWithWebIdentity`), no static keys. Only AWS documents IAM and key-policy conditions on the encryption context and has a server-side `ReEncrypt`. About USD 3 to 9 per month at 1,000 secrets (USD 1 per key-month plus USD 0.03 per 10,000 requests; the rotation surcharge takes three keys from USD 3 to about USD 9 by year three). GCP Cloud KMS is the runner-up; Azure Key Vault Standard has no AAD; Vercel's own KMS is signing-only and beta |
| Strict CSP, no third-party scripts | **Confirm, and a working policy exists** | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests; report-uri /api/csp-report; report-to csp`. No nonce, no `unsafe-inline`, no `unsafe-eval`; verified in Chromium 141 with Vite 8.3.1, React 19.3.0 and three 0.186.1. Traps: `form-action 'self'` blocks Stripe's form-POST-then-303 pattern (use `fetch` then `location.assign(url)`); `connect-src` needs `blob:` once GLB models load; `@react-three/drei` defaults load from CDNs that this CSP blocks; Trusted Types is feasible, roll out as Report-Only first |
| Self-hosted fonts | **Confirm** | Young Serif and Atkinson Hyperlegible are SIL OFL 1.1 with no Reserved Font Name, so self-hosting and subsetting are allowed. Measured subset: 38.8 kB WOFF2 for both, 36% under Google's prebuilt latin pair. Ship the OFL text |
| Test that fails the build if a secret reaches the bundle | **Confirm; a prototype exists** | Vite exposes only `VITE_*` and has no other leak check. The prototype scanner (356 lines, Node built-ins only) found 41 of 43 planted fakes in minified output and 43 of 43 where source names are visible, with zero false positives across 59 real `dist/` directories; it runs in tens of milliseconds. Limits: it cannot find an unknown-format secret in a local variable of a built bundle, so it is one layer, and server-only variable names and values are also searched in `dist/` |
| Session in HttpOnly, SameSite cookies | **Confirm, `Lax`** | A `SameSite=Strict` cookie is not sent on any request of a cross-site-initiated navigation (verified in Chromium; RFC 6265bis), so the return from Stripe would look logged out. Use a `__Host-` `Secure; HttpOnly; Path=/; SameSite=Lax` cookie, CSRF defence by `Sec-Fetch-Site`, `Origin`, JSON content type and a custom header, and passkey-bound approvals for money and secrets |
| MCP server | **Confirm; target the 2026-07-28 spec** | Stateless Streamable HTTP, `@modelcontextprotocol/server` 2.2.0 (the v1 `@modelcontextprotocol/sdk` 1.31.0 is legacy), SDK handler performs no Origin or auth checks, so we add them. Claude Code, Cursor and VS Code accept a static bearer header; claude.ai and Desktop need OAuth. Elicitation is not a control, so "needs human approval" is server-enforced (`pending_approval` plus a first-party passkey page) |
| Repository tooling | **npm workspaces, Node 24** | The toolset's combined engine floor is Node 22.19 or later. npm 11.19 and 12.1 block dependency install scripts by default: the scaffold needs an explicit `allowScripts` policy. Vercel's default install for a `package-lock.json` project is `npm install`, so set `installCommand` to `npm ci`. Do not install `@vercel/node` (its pinned transitive dependencies carry advisories; fetch handlers need no types package) and add an npm `overrides` entry for `drizzle-kit`'s `@esbuild-kit` esbuild: the validated pin set has 0 vulnerabilities |

### 4.3b Architecture

#### Repository layout (Phase 1 scaffold)

```
apps/web            Vite + React + TypeScript. React owns the overlay only.
  src/world/        three.js, imperative: renderer, camera rig, sky, pool, trees, lanterns,
                    particles, creatures/, shaders/*.glsl, snapshot.ts, quality.ts
  src/store/        Zustand. View state only (see "The store contract" below)
  src/ui/           header, find, hatch sheet, detail panel tabs, ledger, rescue, fallback
  src/audio/        WebAudio synthesis, off by default
apps/cards          hatchkind.com: static/SSR public pages (separate origin, no cookies)
packages/core       Pure TypeScript shared by server and client: deriveTraits(), deriveCreatureState(),
                    money, pricing, recipes schema, scope vocabulary. No I/O, no secrets.
packages/registrar  RegistrarAdapter interface, MockRegistrar, contract test suite, real adapters
packages/db         Drizzle schema, migrations, roles and grants
packages/api        Vercel functions (route handlers), auth, step-up, orders, jobs, webhooks
packages/cli        `mosshatch` CLI
packages/mcp        MCP server (Streamable HTTP) sharing handlers with the REST API
e2e/                Playwright + axe
docs/               PLAN.md, DECISIONS.md, research/
```

Workspace tooling and exact versions are pinned in Phase 1 from the verified table in the plan.

#### The store contract ("the creature is a view, never a vault")

- The Zustand store holds only: current view, selected domain id, camera goal, calm/sound flags, a list of `CreatureView` objects, and transient UI flags. `CreatureView` is `{ domain, state, armored, sentence, charms: {service, label}[], secretCount: number, ageDays }`.
- There is no field anywhere in the store, in props passed to `world/`, or in any event the world emits that can hold a secret value. A `SecretValue` type exists only in the reveal component and is `never` in the store's type (a compile-time test asserts the store's state type has no `string` field named like `value`, `secret`, `token`, `plaintext`).
- The reveal component keeps the plaintext in a `useRef`-backed buffer scoped to that component, renders it into a single DOM node, and on hide (button release, 10 s timer, blur, route change, `visibilitychange`) removes the node and drops the reference. JavaScript strings cannot be zeroed, so this is best effort and the plan says so plainly.
- The reveal request is a POST with `Cache-Control: no-store`; the service worker (if any) has an explicit deny rule for `/api/*`.

#### RegistrarAdapter: what the sketched interface is missing

The sketch in the brief covers the happy path. The product also needs these, so the interface in Phase 1 is a superset. Each is exercised by MockRegistrar and by the shared contract tests.

| Addition | Why the product needs it |
|---|---|
| `setNameservers(domain, ns[])` | "Changing nameservers" is a step-up action in the non-negotiables, so there must be a method to gate |
| `setWhoisPrivacy(domain, on)` and `setAutoRenew(domain, on)` | Overview tab switches. Registrar-side auto-renew stays off; renewal is driven by Mosshatch so that price and consent are ours |
| `restore(domain)` | Redemption-period restore for the "Sleeping" state |
| `cancelTransfer(id)` | The Gate ceremony says "cancel any time" and Rescue needs cancel |
| `getTransferOutStatus(domain)` | Transfer-out is initiated elsewhere; Traveling must be derived from the adapter |
| `capabilities()` | `{ dnsHosting, webhooks, idempotentRegister, sandbox, tacModel }` so the app degrades explicitly instead of guessing |
| Typed errors | `RegistrarError { retryable, outcomeUnknown, code }`. `outcomeUnknown` (timeout after submit) forces the order into reconciliation by polling, never a blind retry |
| `Availability.kind` | `available`, `taken`, `premium`, `reserved`, `unknown` with an optional price; the UI must never show "available" for `unknown` |
| `Money` | `{ minor: bigint, currency }`; no floating point anywhere in pricing |

Rules for every adapter: (1) `register` and `renew` are at-most-once per `idempotencyKey`; where the provider has no native idempotency the adapter pre-checks `getDomain` and consults our order ledger before any write; (2) every response is normalized to Mosshatch's `DomainStatus`, and the raw registry status codes are passed through untouched for display; (3) no adapter method returns before the provider has actually accepted the request; anything asynchronous returns a handle that `get*` can poll.

#### Order state machine (register, renew, transfer-in)

Every transition is written to `order_events` with its cause. Nothing moves on a timer alone; timers only trigger a re-check against Stripe or the adapter. The payment path is **authorize, register, then capture** (decision D-002), which changes the brief's gate from "verified `payment_intent.succeeded`" to "verified `requires_capture`"; `payment_intent.succeeded` then marks the order paid.

```
draft ──▶ checkout_open ──▶ authorized ──▶ registering ──▶ registered ──▶ captured (paid)
              │                 │              │
              ▼                 ▼              ▼
        checkout_expired   payment_failed   registration_failed ──▶ voided (authorization cancelled, no fee kept)
                                               │
                                               ▼
                                        outcome_unknown ──(poll adapter by idempotency reference)──▶ registered | registration_failed
                                        paid_before_registration ──▶ register-or-refund path (unexpected capture)
```

- **Why not the brief's order.** A refund does not return Stripe's processing fee (2.9% + USD 0.30), while cancelling an uncaptured authorization is free and is not reported to the card networks as fraud. Registration is the step that can fail, so it happens while the money is only held. Hosted Checkout supports this with `payment_intent_data.capture_method=manual` for cards, Apple Pay, Google Pay and Link; ACH does not support manual capture and is disabled. The default hold is seven days (Visa merchant-initiated 4 days 18 hours); an uncaptured PaymentIntent auto-cancels at seven days.
- **Guards the verifier found missing from the first design, now requirements.** (1) Fulfilment is driven by webhooks and also by the success page calling the same idempotent reconcile after checking that the Checkout Session belongs to the signed-in user's order. (2) Two payable Sessions for one order (a second tab, a retry) are prevented: the `authorized` transition must match the order's current session and attempt, expire the other Session (expiry fails if the customer just paid) and cancel any extra PaymentIntent. (3) An unexpected capture (`payment_intent.succeeded` while the order is `authorized` or `registering`, for example a Dashboard capture) goes to `paid_before_registration`, which registers or refunds, and the PaymentIntent is re-fetched before any cancel call. (4) After a 500 from Stripe on capture, `GET` the PaymentIntent and, if it is still `requires_capture`, capture with a **new** idempotency key (Stripe replays cached 500s under the same key). (5) `capture_before` is nullable on cards and absent for Link; use a fallback deadline of authorization plus four days and keep Link off until its window is documented. (6) The Session pins its payment methods explicitly so Dashboard changes cannot add auto-capture methods. (7) Stripe Tax computes tax in Checkout from an address entered after approval, so an agent approval binds the subtotal plus a tax ceiling (or collects the address first); the authorized amount must not be compared for equality with a pre-Checkout estimate. (8) Cancelling a Checkout-created PaymentIntent is documented inconsistently (the Session page says expire the Session instead), so the cancel step is sandbox-tested in Phase 2 before it is relied on.
- `checkout_open` freezes a quote with an expiry (default 30 minutes). At fulfilment the quote is re-fetched; if the total has risen by any amount the order is voided and the person is told, so no one is ever charged more than the total shown.
- `outcome_unknown` is the dangerous one (timeout after the registrar may have accepted). Resolution is by polling `getDomain` and the provider's order lookup using the idempotency reference (`GET_ORDERS_BY_DOMAIN` at OpenSRS) on a backoff schedule, up to a bounded window, then human review with the authorization untouched.
- Renewals and transfers-in reuse the same machine. Renewal charging differs: charge first (off-session PaymentIntent, captured immediately because the mandate is the authorization), then renew upstream, because renewals are final at the registrar.
- Stripe API writes carry idempotency keys `order:<id>:<op>`; idempotency keys live 24 hours. The stripe-node package is pinned and the API version is set explicitly on both the client and the webhook endpoint.

#### Jobs

A `jobs` table plus a one-minute cron tick. A tick claims work with `FOR UPDATE SKIP LOCKED`, runs each job with a deadline, records attempts with exponential backoff, and dead-letters after `max_attempts`. Webhook handlers enqueue and then call the tick opportunistically (`waitUntil`) so latency is normally seconds rather than a minute. Job kinds: `order.fulfil`, `order.reconcile`, `domain.sync`, `transfer.poll`, `dns.verify`, `renewal.notice`, `renewal.charge`, `expiry.notice`, `agent_request.expire`, `email.send`, `audit.anchor`, `webhook.replay`. Payloads carry ids only. Vercel cron is best-effort (duplicated or missed runs are possible and failed runs are not retried), so correctness lives in the table: every job is idempotent and claimable by any tick.

#### Creature state derivation (pure function in `packages/core`)

`deriveCreatureState(snapshot, jobs, orders, now)` returns `{ mood, armored, sentence, reason, action?, asOf, source }`. Precedence, highest first:

1. **egg**: an order for this name is authorized or registering, or the adapter reports the domain as pending registration.
2. **traveling**: a non-terminal transfer exists in either direction, or the adapter reports `pendingTransfer`.
3. **sleeping**: adapter status is expired, in auto-renew grace, redemption, or pending delete. The sentence states which stage and the date the next stage begins, from registry data.
4. **needs attention**: one specific blocking item, in this order: payment failed on a renewal, registrant email unverified with the verification deadline near or passed, registry or registrar hold status, missing verification record for a wired service, sync error older than 15 minutes ("We cannot confirm this domain's state right now").
5. **shedding**: a DNS write intent that is not yet visible at the authoritative nameservers.
6. **drowsy**: inside the renewal window (default 30 days) with no blocking item.
7. **thriving**: none of the above.

`armored` is an independent overlay driven by the lock flag; registry-imposed locks (for example a post-registration or post-transfer lock) show the plate with a different sentence ("Locked by the registry until 12 Nov") because the person cannot toggle them.

Every result carries `asOf` and `source` (`adapter`, `job`, `order`); the panel prints "Confirmed by the registrar 4 minutes ago". If `synced_at` is older than the staleness bound, the sentence says the state could not be confirmed instead of guessing.

#### Secrets: envelope encryption design (Phase 4)

- **Key service.** AWS KMS, symmetric `SYMMETRIC_DEFAULT` keys, single Region us-east-1 (Vercel `iad1`), one KEK per environment (production, staging, development). Vercel functions authenticate by OIDC federation (`AssumeRoleWithWebIdentity`); there are no static AWS keys anywhere. The role trust policy is pinned to the Vercel Team issuer and to `sub = owner:<team>:project:<project>:environment:production` (and must check `oidc.vercel.com:aud` if the project is ever left on the shared global issuer, which AWS now requires).
- **Per-secret data key.** Each secret write calls `GenerateDataKey` (AES_256) with `EncryptionContext = { app, env, owner_id, secret_id }`, using opaque ids only because the context is logged in plaintext in CloudTrail. The value is encrypted locally with AES-256-GCM using a fresh random 96-bit nonce and AAD that binds domain, secret, version and environment. One data key encrypts one value, so NIST's 2^32 invocation limit is irrelevant. The wrapped key, nonce, ciphertext and tag go to `secret_versions`; the plaintext data key is zeroed after use. Nothing is cached.
- **Simpler variant to decide in Phase 4.** For values up to 4,096 bytes, direct `kms:Encrypt` and `Decrypt` with the same encryption context costs the same number of KMS requests as `GenerateDataKey` plus `Decrypt`, removes local crypto handling and keeps `ReEncrypt`, at the price of a hard 4 KB ceiling and plaintext travelling to KMS over TLS. The brief specifies a per-secret data key, so that stays the default.
- **Rotation and re-wrap.** `ReEncrypt` re-wraps stored data keys (and can change the encryption context) server-side without touching values. Automatic KEK rotation adds a surcharge (USD 1 per month after each of the first two rotations), so the honest cost of three keys is about USD 9 a month by year three, not USD 3.
- **Blast radius, stated plainly.** Anyone who can run code in the production Vercel project can call `Decrypt` for any wrapped key they can read. KMS does not prevent that; it gives revocation, an independent audit trail (CloudTrail) and makes a database-only leak useless. Hardening: Vercel Deployment Policies restrict which repositories and deployment mechanisms can deploy to production; optional Static IPs enable an `aws:SourceIp` condition; alarms on Decrypt volume and unexpected principals. **Emergency stop:** remove the trust policy or identity provider, or `DisableKey`; AWS's "revoke active sessions" does not deny sessions assumed after the revocation, so it is not the primary stop.
- **Not verifiable without a live account:** KMS latency from Vercel (benchmark from an `iad1` function in Phase 4), whether Vercel can revoke an issued OIDC token, and team-slug reuse behaviour.

#### Egress to the registrar

OpenSRS accepts live API calls only from allow-listed addresses (at most five rules, /25 to /32). Vercel functions have no fixed egress by default; Vercel Static IPs cost USD 100 per month per project on Pro and are project-wide. Recommended: put every registrar-calling function in one Vercel project with Static IPs (decision D-005), keep the registrar credentials only in that project as Secret-type variables, and treat the allow-list as a second factor for the credentials: a leaked key is useless off those addresses. A small self-run gateway on a fixed address is the cheaper alternative if the USD 100 matters more than the operational burden.

#### Availability search at scale

- RDAP and DNS can only prove a name is **taken**. An RDAP 404 or a DNS NXDOMAIN also occurs for registry-reserved names (observed live for `example.dev`, `example.app`, `example.studio`) and NXDOMAIN occurs for registered names on hold. Only the registrar's EPP-backed check is authoritative, and OpenSRS mandates its own lookup (rate-limited, and "excessive use may result in a fee"). Premium names look taken unless the premium tier is enabled on the account.
- No registry publishes a numeric RDAP limit and all restrict high-volume automated querying (Google bans it outright; Verisign and Identity Digital restrict using the data to drive it). Identity Digital answered HTTP 429 to 5 of 13 test requests. RDAP therefore stays off the per-keystroke path and is never used to declare a name available.
- Design: debounce to settled input; one server call fanning out to the six extensions. The Find view shows one egg per **available** extension, so the registrar's check runs on every settled query (up to six lookups; OpenSRS accepts one name per call and may charge for excessive use), trimmed by a cache ("taken" for hours, "not proven taken" for at most five minutes; SOA negative TTLs are 300 to 3,600 seconds) and by an RDAP pre-filter that is used only at low volume and only ever to mark a name taken. The chip price comes from a quote call, and the authoritative check runs again at checkout. ASCII labels only in the first release (IDN and homograph handling later). Search text is not stored beyond the cache.
- **Front-running commitments to publish:** never register, reserve or hold a name because it was searched; never sell or share search data; no durable storage of search text; a plain-language notice at the search box; name every party that sees queries. (ICANN SAC 022 and 024 found no proven case; the one documented registrar practice was Network Solutions' four-day hold on searched names, settled in 2009.)

#### DNS changes and the Shedding state

A registrar API "success" is not propagation (Porkbun explicitly accepts writes for zones nobody queries; Route 53 only claims INSYNC across its own servers). Shedding therefore lasts until, in order: (a) the adapter accepted the write; (b) every authoritative nameserver answers the desired record set (recursion off, authoritative flag set); (c) sampled Cloudflare and Google DNS-over-HTTPS answers match on N consecutive samples. Remaining TTL is not a countdown (the same resolver returned 206, 2823, 2909, 2700 and 3230 seconds for one name), so it is used only as an upper bound: `max(old TTL, SOA negative TTL)`. Never probe a name at public resolvers before it is written (negative caching, RFC 2308). For `.dev` and `.app`, which are HSTS-preloaded, "spread" also requires a valid certificate. Whether Vercel functions may send raw UDP/53 is undocumented; if not, step (b) runs from the fixed-address gateway or is replaced by DoH-to-authoritative checks. When a domain's nameservers are not the registrar's, the DNS tab is read-only and says where DNS is hosted.

#### The Gate with a wholesale upstream

The brief's Gate ceremony (passkey step-up, cooling-off, cancel any time) meets the upstream's real mechanics. With OpenSRS there is no API to start or approve an outbound transfer: the person unlocks the name and takes the authorization code from Mosshatch, the gaining registrar starts the transfer, and OpenSRS emails the registrant a link to approve or decline, with silence for five days counting as approval. Mosshatch therefore (1) performs unlock and code issue behind the step-up, (2) shows the code once, (3) derives Traveling from `GET_TRANSFERS_AWAY` and the domain's `transfer_away_in_progress` flag, never from a timer, and (4) treats "cancel" as re-locking and issuing a new code until the code is used, and afterwards as declining in OpenSRS's email, which the panel says plainly. The optional security delay (D-009) is an owner-set setting, not a default. `.io` codes are issued by OpenSRS support, so the `.io` Gate is a request that waits on a person. Each of these is a written question to OpenSRS (4.1).

### 4.4 Data model

#### Data model (refined)

Conventions: every table has `id uuid` (v7, time-ordered), `created_at`, `updated_at` unless append-only. Money is integer minor units plus an ISO currency code, never floats. All timestamps `timestamptz`, UTC. Secret-bearing columns are the only ones holding ciphertext, and only `secret_versions` has them.

| Table | Purpose | Key columns and rules |
|---|---|---|
| `users` | Account | `email` (citext, unique), `email_verified_at`, `billing_country`, `terms_version`, `terms_accepted_at`, `status`, `deleted_at` |
| `passkeys` | WebAuthn credentials | `user_id`, `credential_id` (unique), `public_key`, `sign_count`, `transports`, `backup_eligible`, `backup_state`, `label`, `last_used_at`, `revoked_at` |
| `sessions` | Server sessions | `id_hash` (SHA-256 of cookie value), `user_id`, `expires_at`, `idle_expires_at`, `ua_hash`; the cookie is `__Host-` prefixed, HttpOnly, Secure, SameSite=Lax |
| `webauthn_challenges` | One-time ceremony state | `purpose` (register, login, stepup), `challenge`, `action_id` (nullable), `expires_at`, `consumed_at` |
| `actions` | Step-up bound actions | `user_id`, `type` (reveal_secret, set_nameservers, unlock_domain, transfer_out, approve_agent_purchase, create_binding, widen_binding), `params_hash` (SHA-256 of canonical JSON), `resource_id`, `state` (prepared, committed, expired), `expires_at` (60 s), `committed_at`. The WebAuthn challenge is `H(action.id, type, params_hash, nonce)`, so an assertion cannot be replayed for another action |
| `recovery_codes` | Passkey-loss recovery | `user_id`, `code_hash`, `used_at` |
| `contacts` | Registrant contact | `user_id`, encrypted PII columns, `email_verified_at`, `verification_deadline_at` (ICANN 15-day verification, see Compliance) |
| `domains` | Owned domain | `user_id`, `fqdn_ascii` (unique), `tld`, `registrar` (adapter id), `registrar_ref`, `state` (mirror of adapter status), `registered_at`, `registry_created_at` (moss age; true age for transfers), `expires_at`, `locked`, `whois_privacy`, `auto_renew` (opt-in, default false), `nameservers[]`, `registry_statuses[]`, `dns_hosted_here bool`, `synced_at`, `sync_error`. Species, palette and traits are NOT stored; they are recomputed from the name |
| `orders` | Money-spending intents | `user_id`, `kind` (register, renew, transfer_in, restore), `fqdn_ascii`, `years`, `state`, `idempotency_key` (unique per user), `quote` jsonb (wholesale, renewal wholesale, flat fee, tax, total, currency, quoted_at, expires_at), `stripe_checkout_session_id`, `stripe_payment_intent_id`, `attempt`, `capture_before`, `registrar_order_ref`, `agent_request_id`, `failure_code` |
| `order_events` | Append-only order transitions | `order_id`, `from_state`, `to_state`, `cause` (webhook, job, user, agent), `stripe_event_id`, `detail` |
| `payments` | Mirror of Stripe money movement | `order_id`, `stripe_payment_intent_id`, `amount`, `currency`, `status`, `captured_at`, `refunded_amount`, `dispute_state`. No card data, ever |
| `stripe_customers` | Link | `user_id`, `stripe_customer_id` |
| `webhook_events` | Dedupe and replay | `provider`, `event_id` (unique with provider), `type`, `received_at`, `processed_at`, `error` |
| `jobs` | Durable work queue | `kind`, `run_at`, `state` (queued, running, done, failed, dead), `attempts`, `max_attempts`, `locked_until`, `dedupe_key` (unique), `payload` jsonb (ids only, never secrets), `last_error` |
| `transfers` | Transfer in and out | `domain_id`, `direction`, `state`, `registrar_transfer_ref`, `submitted_at`, `expected_by`, `last_polled_at`, `tac_issued_at`, `cancel_deadline_at`, `terminal_reason` |
| `dns_records` | Cache of registrar-hosted DNS | `domain_id`, `adapter_record_id`, `type`, `name`, `value`, `ttl`, `priority`, `source` (user, recipe, agent), `sync_state` (synced, pending_write, pending_delete, drift, error), `last_verified_at` |
| `dns_write_intents` | In-flight DNS changes | `domain_id`, `op`, `record`, `state` (submitted, applied, visible_at_authoritative, failed), `job_id`. Drives the Shedding state |
| `connections` | Services wired to a domain | `domain_id`, `service` (vercel, neon, resend, ...), `external_ref`, `status`, `recipe_application_id` |
| `recipe_applications` | Wire-it history | `domain_id`, `recipe_id`, `recipe_version`, `plan` jsonb (records and variable names, no values), `state`, `applied_by` |
| `secrets` | Secret identity (no value) | `domain_id`, `env` (dev, preview, prod), `name`; unique on the triple; `current_version_id` |
| `secret_versions` | Ciphertext | `secret_id`, `version`, `ciphertext`, `nonce`, `wrapped_dek`, `kek_ref`, `aad_hash`, `created_by_kind`, `created_by_id`, `destroyed_at`. AAD binds domain, secret, version and env |
| `bindings` | Agent and CLI tokens | `user_id`, `kind` (agent, cli), `name`, `token_prefix`, `token_hash` (unique), `scopes` jsonb (capability, resource, env), `spend_cap_minor`, `expires_at`, `revoked_at`, `last_used_at`, `created_by_action_id` |
| `agent_requests` | Pending approvals | `binding_id`, `kind` (register, renew, transfer_in), `params` jsonb, `quoted_minor`, `state` (pending, approved, declined, expired, executed, failed), `decided_by_action_id`, `order_id`, `expires_at` |
| `audit_log` | Append-only, hash chained | `seq` (bigserial per chain), `chain_id` (per user), `at`, `actor_kind` (user, agent, cli, system), `actor_id`, `action`, `resource_kind`, `resource_id`, `ip_prefix_hash`, `ua_hash`, `detail` jsonb (no values), `prev_hash`, `hash`. App role has INSERT and SELECT only; a trigger rejects UPDATE and DELETE; the chain head is anchored daily outside the database |
| `cards` | Published creature cards | `domain_id`, `slug`, `published_at`, `unpublished_at`, `snapshot_ref`, `takedown_state`. Private by default; the public site reads a view exposing only published rows |
| `renewal_mandates` | Opt-in auto-renew consent | `domain_id`, `user_id`, `stripe_payment_method_ref`, `price_ceiling_minor`, `signed_action_id` (passkey-signed), `charge_days_before_expiry`, `revoked_at`, `next_charge_at` |
| `notices` | Compliance notice ledger (ERRP expiry notices, verification reminders, price-change notices) | `kind`, `domain_id`, `user_id`, `sent_at`, `template_version`, `email_log_id`; retained for the period the compliance checklist sets |
| `abuse_reports` | Inbound abuse and takedown queue | `target_kind` (domain, card), `reporter_ref`, `state`, `resolution`, `actioned_at` |
| `email_log` | Idempotent mail | `kind`, `dedupe_key` (unique), `user_id`, `provider_message_id` |

Design notes:
- The creature is a pure function of (domain name, adapter snapshot, jobs, orders); no table stores "creature state". `packages/core` exports `deriveCreatureState()` and `deriveTraits()` and is imported by both the server and the world module.
- `domains.state`, `expires_at`, `locked`, `nameservers` and `registry_statuses` are caches of adapter truth with `synced_at`. The UI shows "confirmed by registrar 3 minutes ago" from `synced_at`, and never advances a state on its own.
- Names of secrets are plaintext metadata (the creature knows how many). Secret values exist in plaintext only inside a request handler during reveal, write, or CLI pull, and in the caller's memory.

### 4.5 API, CLI and MCP surface

One handler layer serves three front doors: the web app (cookie session), the REST API and CLI (bearer token), and MCP (bearer token). Authorization is always decided server-side from the principal and the requested (capability, resource, environment); no client-side check counts.

**Principals.** `user-session` (browser, passkey-authenticated), `cli-binding` (created by device flow, approved with a passkey), `agent-binding` (created in the Bindings tab, passkey to create or widen). A binding can never complete or start a passkey ceremony; endpoints under `/actions/*` reject bearer tokens outright.

**Step-up protocol (applies to every action in non-negotiable 2).** Seven action ids cover the brief: `secret.reveal`, `domain.nameservers.change`, `domain.unlock`, `domain.transfer_out`, `agent.purchase.approve`, `agent.token.create`, `agent.token.widen`. Narrowing a token is free. Two more are added as decisions D-009 and D-011: `domain.contact.change` (ICANN Transfer Policy I.A.5.3 forbids an unlock or auth-code mechanism "more restrictive than the mechanisms used for changing any aspect of the Registered Name Holder's contact or name server information", so contact edits get the same gate) and, for agents and recipes only, sensitive DNS record changes.
1. `POST /api/v1/actions/prepare {type, params}` normalizes the parameters and returns `{action_id, webauthn_options}`. The challenge is `SHA-256(JCS{action, params_hash, user, session, nonce, exp})`, single use, 120 seconds.
2. The browser performs `navigator.credentials.get()` with `userVerification: "required"`.
3. `POST /api/v1/actions/{id}/commit {assertion}` atomically consumes the challenge **before** verification, verifies with SimpleWebAuthn (checking both `verified` and `userVerified`, attestation `none`), then executes the action in the same transaction after re-checking current state. The library is stateless (a valid assertion verified twice in the research harness passed both times), so single-use consumption is ours to enforce. There is no reusable "elevated session", so a stolen cookie cannot ride an earlier step-up.
4. `signCount` is stored but enforced only for credentials with backup-eligible bit 0 (synced passkeys commonly report 0). Backup-eligible and backup-state bits are tracked to detect "only one device-bound credential" and a backup-state flip from 1 to 0.
5. Agent and CLI tokens can never start or complete a ceremony: `/actions/*` rejects bearer tokens outright.

**Sessions and recovery.** Opaque 256-bit session token in a non-persistent `__Host-` cookie (`Secure; HttpOnly; Path=/; SameSite=Lax`; not Strict, see Stack verdicts), server-side session table storing a hash. Idle timeout 15 minutes and absolute 8 hours (the first draft's 30 minutes and 12 hours met NIST AAL2 but exceeded OWASP's ranges for high-value applications). Recovery: at least two credentials are required at sign-up (or a clear warning), ten single-use recovery codes of at least 64 bits are issued and shown once, and an emailed code (valid at most 24 hours) works together with a code or a second credential. An email-only recovery path exists as a last resort and is deliberately slow: a 72-hour cooling-off that is cancelled by any legitimate sign-in, notification to every verified channel, revocation of all sessions, credentials and bindings on completion, and a 72-hour hold on the nine step-up actions (kept inside ICANN's five-calendar-day window; counsel to confirm). Sync-provider takeover is real (NIST 800-63B-4 Appendix B; Unit 42, 3 August 2026: malware on a Windows endpoint can take over accounts protected by Google-synced passkeys, and the Silver and Golden variants defeat user verification for synced credentials), so an opt-in **hardened mode** requires device-bound (backup-eligible 0) credentials with direct attestation for security keys, keeps no weaker fallback, and notifies on every credential change.

**REST (v1), grouped.**

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register/options`, `/auth/register/verify`, `/auth/login/options`, `/auth/login/verify`, `/auth/logout`; `GET /me`; passkey list, add, revoke; recovery-code issue and use |
| Search and quote | `GET /search?name=&tlds=` (unauthenticated, rate limited, cached); `GET /quote?domain=&years=` |
| Orders | `POST /orders` (idempotency key required) returns a Stripe Checkout URL; `GET /orders/{id}`; `POST /webhooks/stripe` |
| Domains | `GET /domains`; `GET /domains/{fqdn}`; `PATCH /domains/{fqdn}` for lock, privacy, auto-renew (unlock is a step-up action); `POST /domains/{fqdn}/renew`; `POST /domains/{fqdn}/nameservers` (step-up) |
| DNS | `GET/POST /domains/{fqdn}/dns`, `PATCH/DELETE /domains/{fqdn}/dns/{id}`; responses carry `sync_state` |
| Nest | `GET /domains/{fqdn}/nest?env=` (names, versions, counts, connections; never values); `PUT /domains/{fqdn}/secrets/{env}/{name}`; `DELETE`; `POST /secrets/{id}/reveal` (step-up, `no-store`); `GET /domains/{fqdn}/audit` |
| Recipes | `GET /recipes`; `POST /domains/{fqdn}/recipes/{id}/plan` (dry run: exact records and variable names); `POST .../apply` |
| Connections | `GET /domains/{fqdn}/connections`; `DELETE /connections/{id}` |
| Bindings | `GET/POST /bindings` (create is step-up); `DELETE /bindings/{id}`; `POST /bindings/revoke-all`; `GET /bindings/{id}/activity` |
| Approvals | `GET /approvals`; `POST /approvals/{id}/decide` (approve is step-up) |
| Transfers | `POST /transfers/in/check`; `POST /transfers/in`; `GET /transfers/{id}`; `POST /domains/{fqdn}/transfer-out` (step-up); `DELETE /transfers/{id}` (cancel) |
| Cards | `GET /cards`; `POST /cards/{fqdn}/publish`; `DELETE /cards/{fqdn}/publish` |
| Device flow | `POST /oauth/device/code`, `POST /oauth/token`, `POST /oauth/device/approve` (web, step-up) |
| Cron and jobs | `GET /api/cron/tick` (bearer `CRON_SECRET` only) |

**Scope vocabulary.** `capability:resource:env` with wildcard only on resource, never on capability or env. Capabilities: `domains.read`, `dns.read`, `dns.write`, `nest.names`, `secrets.read`, `secrets.write`, `recipes.plan`, `recipes.apply`, `register.propose`, `renew.propose`, `transfer.status`. Examples: `dns.write:example.com`, `secrets.read:example.com:dev`, `register.propose:*` with `spend_cap`. Production secrets need an explicit `:prod` scope; a binding that lacks it gets 403, not an empty list. Agents have no capability that executes a purchase: `*.propose` creates an `agent_requests` row and a notification, and only a passkey-approved human decision creates the order.

**CLI (`mosshatch`).** `login` (RFC 8628 device flow; the approval page requires a passkey), `logout`, `whoami`, `domains`, `pull <domain> --env <env>` (writes a `.env`-style file only when `--out` is given, otherwise prints to stdout with a warning when stdout is a terminal), `push <domain> --env <env> [file]`, `run <domain> --env <env> -- <cmd>` (injects into the child process environment only, forwards signals, returns the child's exit code, never writes a file). Tokens are stored in the OS keychain through `@napi-rs/keyring` (keytar was last released in 2022), pinned to the Secret Service store on Linux with the failure caught on every call, and otherwise fall back loudly, not silently, to a mode-0600 file. Never accept a token on the command line. The device-flow approval page shows the device, network address and time, requires a passkey and uses short code lifetimes (device-code phishing is a documented attack). `run` uses a deny-list of dangerous variable names (for example `LD_PRELOAD`, `NODE_OPTIONS`), forwards signals, returns the child's exit code (128 plus the signal number) and masks output that matches injected values. Honest limit, stated in `--help`: environment variables are readable by same-user processes and by root.

**MCP.** Target the 2026-07-28 specification (stateless: no `initialize`, single POST endpoint) with `@modelcontextprotocol/server` 2.2.0; the SDK handler does no Origin or authorization checks, so we add an Origin allow-list and token validation in front of it. Streamable HTTP endpoint `/mcp`, bearer binding token (Claude Code, Cursor and VS Code accept a static `Authorization` header; claude.ai and Desktop connectors need OAuth, so an OAuth authorization server with Client ID Metadata Documents and a DCR fallback is a Phase 5 follow-up). Tools mirror scopes: `search_names`, `get_quote`, `list_domains`, `get_domain`, `dns_list`, `dns_upsert`, `nest_names`, `secrets_get` (only with scope), `secrets_set`, `recipe_plan`, `recipe_apply`, `propose_registration`, `propose_renewal`, `transfer_status`. Tool results never include secret values unless the binding has the matching `secrets.read` scope; `propose_*` returns `{status: "pending_human_approval", approval_id}` and never a receipt. Tool annotations set `readOnlyHint` and `destructiveHint` accurately, and **no tool that can return a secret value is ever marked read-only** (VS Code and Anthropic's directory rules skip confirmation for read-only tools). "Needs human approval" is enforced by the server (a `pending_approval` result plus a first-party passkey page), never by MCP elicitation, which Claude Code lets a hook auto-answer and which legacy clients cannot receive. Rate limits key on the token id, not the IP address: claude.ai connector traffic shares one address range. Descriptions are static strings we author (no user-controlled text in tool descriptions), and tool outputs that echo user-supplied strings (domain names, record values) are marked as data.

**Tokens.** Format `mh_<kind>_<32 base62 characters>+<CRC32>` (kinds `live`, `test`, `cli`), so leaks are recognisable to scanners; register the prefix with GitHub's secret-scanning partner programme (email secret-scanning@github.com; custom patterns only detect leaks in your own repositories). Stored as SHA-256 of the token (adequate for at least 128 bits of randomness), compared in constant time, looked up by an indexed prefix, shown once. Scopes, expiry (short default, enforced maximum) and revocation are checked in the database on every request; there are no long-lived self-contained JWTs. Idempotency keys are required on every mutating endpoint that can spend money.

### 4.6 Threat model

**Method.** List assets, trust boundaries and adversaries; then for each required area give the attack, the preventive mitigation, the detection and response, and the security test (`ST-nn`) that proves it. Mitigations are requirements on later phases, not aspirations. Residual risk is stated where it exists.

**Assets, most sensitive first.**
1. Secret plaintext (customer API keys, database URLs) and the KMS permission to unwrap data keys.
2. Control of customers' domains: registrar API credentials, transfer authorization codes, nameserver settings.
3. Authenticators and sessions: passkey credential records, session cookies, recovery codes.
4. Agent and CLI bearer tokens.
5. Payment flow integrity: prices, order state, Stripe webhook secret and API keys.
6. Registrant PII (contact data) and audit log integrity.

**Trust boundaries.** Browser (untrusted) to Vercel functions; functions to Neon; functions to KMS; functions to the registrar API; functions to Stripe and Resend; public internet to `hatchkind.com` (separate registrable domain, separate deployment, no cookies, read-only database view); agents and the CLI to the API with bearer tokens (untrusted principals, server-side scope enforcement).

**Adversaries.** Unauthenticated internet attacker; an authenticated customer attacking another tenant; a phisher or session thief; a compromised or prompt-injected agent holding a valid token; a malicious dependency or CI compromise; a compromised registrar account or registrar-side social engineering; an insider with database access; an XSS attacker.

| # | Area | Attack | Preventive mitigation | Detection and response | Test |
|---|---|---|---|---|---|
| 1 | Secrets at rest | Database dump or backup exfiltration | Only `secret_versions` holds ciphertext; per-secret AES-256-GCM data key wrapped by the KMS key; AAD binds domain, secret, version and env so a ciphertext cannot be moved between rows; no plaintext ever written to the database | Alert on bulk reads of `secret_versions` by any role other than the vault role | ST-01, ST-02 |
| 2 | Secrets, KMS | Attacker with code execution in a function (or a stolen cloud identity) calls KMS Decrypt for many wrapped keys | No static cloud keys: the function authenticates by short-lived OIDC federation; KMS key policy conditions the role on the production project and environment claims; separate key and role for `prod` secrets; decrypt only with matching encryption context; per-request decrypt count capped in the vault module | Alarm on Decrypt volume and on Decrypt from unexpected principals; a documented emergency procedure disables the key and rotates. **Residual risk, stated plainly:** the service can decrypt what it serves, so full server compromise exposes secrets until the key is disabled. The vault is not zero-knowledge, because agents, the CLI and wire-it recipes require server-side decryption. A client-held-key tier (passkey PRF) is recorded as a later hardening option | ST-03, ST-04 |
| 3 | Secrets in transit and caches | Secret cached by browser, CDN, service worker or proxy; secret in URL, referrer or history | Reveal is `POST` only, response `Cache-Control: no-store, private`, `Pragma: no-cache`; no secret in any URL or query string; no service-worker handler for `/api/*`; `Referrer-Policy: no-referrer` on app pages | Automated check of headers on every secret-bearing route | ST-05 |
| 4 | Secrets in logs, errors and telemetry | Plaintext appears in server logs, error reports, analytics, Stripe metadata, email, audit rows or the Zustand store | Secret routes never log bodies; structured logging with an allow-list of fields; error handler strips bodies; no third-party analytics or error SDK that captures request bodies; emails and Stripe metadata are built from typed templates that cannot contain vault types; the `SecretValue` type cannot be assigned to a store field | Canary test: seed a known canary secret, run the full end-to-end suite, then grep logs, audit rows, store snapshots, network HARs and the client bundle for the canary; it may appear only in the reveal response body | ST-06, ST-07 |
| 5 | Reveal abuse | Stolen session reveals everything; scripted bulk reveal | Each reveal needs its own step-up bound to `(secret_id, env)`; one secret per assertion; per-user and per-secret rate limits; reveal is disabled for 24 hours after a new passkey or recovery event | Every reveal writes an audit row and sends a notification email ("Secret DATABASE_URL (prod) was revealed from Chrome on Mac at 10:02"); anomaly alert on more than N reveals per hour | ST-08, ST-09 |
| 6 | Agent tokens | Token leaked in a repo, a log, or a prompt; token used beyond intent | High-entropy token with recognizable prefix (`mh_live_...`) so leak scanners can find it; stored as SHA-256 hash only; shown once; scopes are (capability, domain, env); default expiry short, maximum enforced; revocation is a database check on every request (no long-lived self-contained JWT); per-token rate limit; production secrets need explicit `:prod` scope; unknown scopes fail closed | Register the prefix with secret-scanning programs so leaked tokens are auto-revoked; notify on first use from a new network; "Send all visitors home" revokes every binding in one transaction | ST-10, ST-11, ST-12 |
| 7 | Agent purchase, escalation | Agent or an injected prompt buys domains, widens its own scope, or approves itself | Agents have no purchase capability, only `*.propose`; a proposal creates a pending request; approval is a passkey step-up bound to the exact domain, years, price and payment method; `/actions/*` rejects bearer tokens; spend cap limits the sum of pending plus approved proposals; creating or widening a binding is a step-up | Approval notification carries the server-rendered request; expiry of unanswered requests; audit trail links binding, request, action and order | ST-13, ST-14 |
| 8 | MCP and prompt injection | Hostile text in a domain name, DNS record or tool output steers a connected agent to call dangerous tools | Tool descriptions are static; tool outputs mark user-supplied strings as data; dangerous tools are absent unless scoped; nothing an agent can call reveals a secret without the matching scope or spends money | Audit every tool call with binding id; alert on scope-denied bursts | ST-15 |
| 9 | Account takeover, phishing | Credential phishing, password stuffing, SIM-swap | No passwords and no SMS. Passkeys are origin-bound; `userVerification: required`; RP ID is the apex | Notify on new-device sign-in; list active sessions and passkeys with revoke | ST-16 |
| 10 | Account takeover, recovery | Attacker abuses recovery to add their own passkey | Recovery codes are hashed and single-use; email recovery starts a 72-hour delay with notifications to every verified channel and a cancel link; completing recovery revokes all sessions and bindings and starts a 72-hour hold on the nine step-up actions; adding a passkey is itself a step-up | Alert on recovery started; limit recovery attempts | ST-17 |
| 11 | Session theft | Cookie stolen by malware or XSS | `__Host-` cookie, HttpOnly, Secure, SameSite=Lax; idle 15 minutes and absolute 8 hours; server-side session table with hash of the id; sensitive actions never rely on the session alone | Anomaly on user-agent change; revoke-all | ST-18 |
| 12 | Synced-passkey compromise | Attacker who owns the person's Apple or Google account obtains the synced passkey, or malware defeats user verification for a synced credential (Unit 42, 2026-08-03) | Show backup-eligible status; opt-in hardened mode requiring device-bound credentials (backup-eligible 0) with attestation for security keys and no weaker fallback; notify on every credential change | Residual risk accepted and documented; user verification alone is not a second factor against this class | ST-19 |
| 13 | Registrar-account compromise | Theft of the reseller API credentials (the crown jewels: they can move every domain) | Credentials only in Secret-type platform variables in the one project that has Static IPs, never in the repo, logs or client; provider-side IP allow-listing (OpenSRS live API accepts at most five allow-listed ranges), so a leaked key is useless off those addresses; Vercel Deployment Policies limit who can deploy to production; least-privilege sub-user if the provider offers one; provider account has hardware-key 2FA and a shared-nothing recovery email; sandbox and production credentials are distinct; a global kill switch disables adapter writes | **Unattributed-change detector:** a job diffs the registrar's view (lock, nameservers, transfer status, TAC issuance) against committed `actions` rows and alerts on any change we cannot explain; daily inventory reconciliation; registry lock where the TLD supports it for the highest-value names | ST-20, ST-21 |
| 14 | Registrar-side social engineering | Attacker persuades the upstream provider's support to change the account | Prefer a provider with written reseller account protection; keep contact channels and account recovery details unpublished; document an incident contact with the provider | Reconciliation (row 13) is the safety net | ST-21 |
| 15 | Hostile nameserver change or unlock | Attacker with a live session redirects the domain or unlocks it for transfer | Nameserver change, unlock, transfer-out and TAC retrieval are step-ups; default lock on for every new domain; every such event emails the account with a "this was not me, freeze" link that locks the domain and revokes sessions and bindings; transfer-out has a confirmation window inside the limits ICANN allows (see Compliance) | Alert and audit; reconciliation detector | ST-22, ST-23 |
| 16 | Hostile DNS record changes | MX or apex changes intercept email or traffic; dangling records enable subdomain takeover; a recipe writes outside its plan | Recipes come from a versioned, code-reviewed registry, never from user or agent input; the applied change set must equal the previewed plan (checked server-side by hash); **proposed extension of step-up:** changes to `MX`, `NS`, `DS`, apex `A/AAAA/CNAME`, and SPF/DMARC TXT made by an agent or recipe need a human approval (recorded as decision D-011); removing a connection lists records that would dangle | Drift detection compares the registrar's live records against the cache and flags unexpected changes | ST-24, ST-25 |
| 17 | XSS on a page that renders secrets | Injected script reads a revealed value or tricks the person into approving an attacker's action | No third-party scripts; strict CSP with no `unsafe-inline` for scripts and no `unsafe-eval`; Trusted Types enforced if feasible with the chosen libraries; a lint rule bans `dangerouslySetInnerHTML` and string-built HTML; all user-controlled strings render as text nodes; the reveal node exists only during reveal; dependency pinning and audit (see 22). WebAuthn cannot show what an action is, so the action summary shown before the prompt is rendered from the server-prepared canonical params, and the notification email is the out-of-band check. **Residual risk:** an attacker with script execution can still socially steer a person; that is why prevention (CSP, no third-party code) is the main control | CSP violation reports; email notification on every high-risk action | ST-26, ST-27 |
| 18 | Clipboard and shoulder surfing | Copied secret stays on the clipboard; value visible on screen | Hold-to-reveal re-hides at 10 seconds and on blur or route change; "Copy" clears the clipboard only if the clipboard still contains our value and permission to read it was granted, otherwise it says plainly that it could not clear it and does not overwrite the person's newer copy | None; documented as best effort | ST-28 |
| 19 | Tenant isolation | IDOR: one customer reads or changes another's domain, secret or binding | Every repository function takes the authenticated principal and scopes by owner; opaque identifiers; Postgres row-level security as defense in depth via a per-transaction user setting; the vault module uses a separate database role with column-level grants | Negative tests for every route with a second user | ST-29 |
| 20 | Payment and order abuse | Client tampers with price; replayed or forged webhook; double submission; card testing; refund abuse | Price is computed server-side from a frozen, expiring quote; the client sends only a domain, years and an idempotency key; Stripe webhooks verified by signature and deduplicated by event id; order state moves only on verified events; verified email required before checkout; per-user and per-IP limits on order creation; Radar on; AGP deletions tracked against the ICANN add-grace limits | Daily Stripe-to-orders reconciliation; alert on mismatch | ST-30, ST-31, ST-32 |
| 21 | Webhook and cron endpoints | Public endpoints invoked by an attacker | `/webhooks/stripe` requires a valid signature; `/api/cron/tick` requires the cron bearer secret and is idempotent; both reject other methods | Alert on repeated failures | ST-33 |
| 22 | Supply chain and CI | Malicious package, install script, or pipeline takeover | Lockfile with `npm ci`; install scripts disabled by default; provenance and audit in CI; dependency updates delayed and reviewed; third-party scripts blocked by CSP; GitHub Actions pinned by commit; least-privilege deploy tokens; protected branches and required review; push protection for secrets | `npm audit` and a bundle scan in CI | ST-34, ST-35 |
| 23 | Insider and operator access | Staff read customer secrets or alter the audit trail | No operator path to plaintext; production database access is break-glass and logged; the audit table is insert-only for the application role and hash-chained; the chain head is anchored daily outside the database | Chain verification job; alert on gaps | ST-36 |
| 24 | Public gallery abuse (`hatchkind.com`) | Cards used for phishing lures, brand impersonation or spam; leaking owner data | Cards exist only for domains registered through Mosshatch and only after the owner publishes; a card contains computed traits and the domain string as text, never free text; no outbound links; a separate origin with no cookies and a read-only database view; takedown and abuse contact; block list for known brands and homoglyphs | Abuse queue; unpublish on report | ST-37 |
| 24b | Abusive registration through our own API | Bulk or malicious registrations by new accounts or by agents (ICANN's DNS Abuse PDP names unrestricted API access for new customers as a top gap) | Per-account and per-agent velocity and spend limits, verified email before checkout, extra limits for new accounts, OFAC list screening at checkout, an abuse contact with a documented takedown path (the registrar stays liable for its reseller) | Abuse queue; suspend on report | ST-41 |
| 25 | Availability and cost abuse | Flooding search to exhaust the registrar quota or run up cost | Search results cached; per-IP and global rate limits; RDAP pre-filter so most keystrokes never reach the registrar; circuit breaker with a plain-language degraded mode | Budget and quota alarms | ST-38 |
| 26 | Email as an attack channel | Spoofed "Mosshatch" mail; approval-bypass links | SPF, DKIM and strict DMARC on the sending domain; emails link only to the fixed origin and never contain secrets, tokens, or a one-click approval (approval always needs sign-in and a passkey) | DMARC reports | ST-39 |
| 27 | Time-of-check races | Step-up assertion reused, or action parameters changed between prepare and commit | Challenge derived from the canonical params hash and nonce; single use; 60 second life; commit re-derives and compares; the action executes in the same transaction that consumes the challenge | Audit rows record prepare and commit times | ST-40 |

**Security test catalogue.** Each `ST-nn` becomes an automated test where it can be (unit, integration or end-to-end) and a manual checklist item where it cannot. ST-01 wrong-AAD decrypt fails; ST-02 tampered ciphertext fails; ST-03 KMS policy denies wrong principal (verified in a staging account); ST-04 decrypt-volume alarm fires; ST-05 headers on secret routes; ST-06 canary secret absent from logs, audit, store and bundle; ST-07 bundle secret scan; ST-08 reveal without step-up returns 403; ST-09 reveal hold after recovery; ST-10 token stored hashed; ST-11 scope matrix (token x route x env); ST-12 revoke-all; ST-13 bearer token rejected on `/actions/*`; ST-14 agent cannot approve or exceed cap; ST-15 hostile strings in tool outputs are marked as data; ST-16 login is origin-bound (wrong origin fails); ST-17 recovery delay and holds; ST-18 cookie flags; ST-19 backup-eligible flag surfaced; ST-20 credentials absent from repo, logs and bundle; ST-21 unattributed-change detector fires on a simulated out-of-band change; ST-22 step-up required on unlock, nameservers, transfer-out, TAC; ST-23 notification and freeze link work; ST-24 recipe plan hash equals applied set; ST-25 sensitive DNS types need approval from agents; ST-26 CSP present and violation-free in the end-to-end run; ST-27 no `dangerouslySetInnerHTML`; ST-28 clipboard behaviour; ST-29 cross-tenant matrix; ST-30 client-supplied price ignored; ST-31 webhook signature and replay; ST-32 idempotent double submit; ST-33 cron and webhook authentication; ST-34 install scripts disabled and audit clean; ST-35 lockfile integrity; ST-36 audit chain verification and insert-only grants; ST-37 gallery exposes only published cards; ST-38 rate limits and circuit breaker; ST-39 email authentication records; ST-40 step-up replay and parameter tampering fail; ST-41 velocity limits and screening block a scripted bulk registration.

### 4.7 Compliance checklist

The full checklist has 63 rows and lives in `docs/COMPLIANCE.md` (each row: requirement with version or date, who owes it, how Mosshatch meets it, phase, whether counsel must confirm, and the source). Summary by area:

| Area | Rows | IDs |
|---|---|---|
| Transfers and locks | 10 | C-01 to C-10 |
| Registrant data, RDAP and verification | 10 | C-11 to C-20 |
| Abuse, disputes and sanctions | 5 | C-21 to C-25 |
| Lifecycle, renewal and refunds | 5 | C-26 to C-30 |
| Consumer law | 6 | C-31 to C-36 |
| Payments and card networks | 5 | C-37 to C-41 |
| Tax | 6 | C-42 to C-47 |
| Privacy and security law | 6 | C-48 to C-53 |
| Accessibility | 3 | C-54 to C-56 |
| Per-TLD rules | 7 | C-57 to C-63 |

#### Orientation

This section consolidates the verified Phase 0 compliance research as of 2026-09-29 for a US launch on Stripe hosted Checkout, with OpenSRS/Tucows assumed as the upstream registrar and .com .dev .app .studio .io .ai as the starting TLDs. Duties fall into three groups. First, duties on the ICANN-accredited upstream registrar, which Mosshatch does not perform but must verify and feed with data and actions (RDAP, verification enforcement, TEAC, UDRP locks). Second, duties Mosshatch takes on by contract as a reseller, because RAA 3.12 makes the registrar answer to ICANN for its resellers and requires a written flow-down (registration agreement content, fee and notice disclosure, sponsor identification, abuse handling, records). Third, duties that bind Mosshatch directly as a business under US, EU, UK and card-network rules (auto-renewal consent, tax, sanctions, privacy, PCI, accessibility). ICANN's regime reaches only gTLDs (.com .dev .app .studio): .ai and .io are ccTLDs outside the RAA, the Registration Data Policy, the Transfer Policy, ERRP, the AGP Limits Policy and URS, so their rules come from the registry's own terms and the upstream contract, and most of those are unpublished or unverified. Verifier corrections are applied throughout, and where a fact is unverified the row says so. This is research, not legal advice: the Counsel column and the question list mark what needs a lawyer or accountant.


#### Questions for a lawyer or accountant

Ordered by what blocks the most work first: items 1 to 5 shape the Phase 2 to 5 design for a US launch, items 6 to 10 must be answered before the first paid sale, and items 11 to 15 gate enabling non-US customers or carry lower risk. The rows they touch are in brackets.

1. **Upstream reseller agreement (lawyer; C-11, C-12).** Question: "Please review the OpenSRS Master Services Agreement, the standalone Master Domain Registration Agreement and the May 2018 Data Processing Addendum against RAA 3.12.1-3.12.7, RAA 3.18, the ERRP, the Accuracy Specification and our checklist. Which clauses leave Mosshatch owing something it cannot perform, and are the sole-remedy clause (21.6), the indemnity (22.1), immediate termination for an ICANN-policy breach (3.9), unilateral amendment (23.3), the assignment bar (23.4) and the absence of a wind-down duty (17.4) acceptable for a business whose customers own their names?" Why it matters: RAA 3.12 makes Tucows answer to ICANN for us, so it will push duties down, and the only exit is an ICANN transfer-out of every domain.
2. **Transfer Policy I.A.5.3 against passkey gating (lawyer; C-02, C-04).** Question: "Does gating the transfer code, unlock and outbound-transfer approval behind a WebAuthn step-up comply with Transfer Policy I.A.5.3 ('not more restrictive than the mechanisms used for changing any aspect of the Registered Name Holder's contact or name server information') if contact and nameserver edits use the same step-up? May we add any security delay, or the brief's 'cooling-off', before release given the 5-calendar-day limit in I.A.5.1-5.2 and I.A.3.10, and can an agent token ever be a 'designated representative' under I.A.1.1?" Why it matters: it shapes the Gate in Phase 5, and a breach is ICANN Compliance exposure for Tucows and a breach of our reseller contract.
3. **Payment assurance and seller of record (lawyer; C-39, C-41).** Question: "Does a Stripe authorisation hold on a manually captured PaymentIntent count as 'reasonable assurance of payment' under RAA 3.7.4 for Tucows, or must we capture before the EPP create and refund on failure? Separately, are we the seller of record rather than a payment facilitator under Stripe's restricted-business terms, given wholesale-plus-flat-fee pricing and any prepaid agent balance?" Why it matters: it decides the Phase 2 order state machine, whether every failed registration costs the Stripe fee, and whether Stripe approves the account; no card-network guidance on a high ratio of cancelled authorisations was found.
4. **Auto-renewal consent and notice mechanics (lawyer; C-31 to C-34, C-38).** Question: "Is a user-verified WebAuthn assertion plus a stored terms hash sufficient express informed consent under ROSCA, California BPC 17602, Vermont 2454a, New York GBL 527-a, Virginia 59.1-207.46 and Minnesota 325G? With the charge at E-10 and notices at about E-43, E-32, 8 days before the charge and E+1, does each state's window hold; can the opt-in confirmation serve as the notice when fewer than 35 days remain; do Colorado, Illinois and Massachusetts add duties; do these laws protect business buyers; and what do Mastercard's recurring rules and Visa Table 5-22's regional scope require?" Why it matters: every annual renewal for every US customer runs through it; California's rules apply to renewals since 1 Jul 2025 and New York's since 5 Nov 2025, and the FTC rule is not in force but ROSCA is.
5. **ERRP notices for auto-renewed names (lawyer; C-26).** Question: "Are the two ERRP pre-expiry notices (about one month and one week before expiry) owed for auto-renew domains that renew successfully before expiry, given ERRP's unconditional 'any gTLD registration' wording, our charge at E-10 and OpenSRS's own auto-renew job about 30 days out? How is 'within five days' after expiry measured?" Why it matters: no ICANN guidance exists; sending both anyway is cheap but changes the mail cadence, and ICANN Compliance reaches us through Tucows.
6. **US state nexus and registration (accountant; C-42, C-43).** Question: "In which states does Mosshatch have physical presence today (founders, contractors, hosted infrastructure, agent activity), which states should we register in and when, given at least 23 gross-receipts states, the 200-transaction prong in about 16 jurisdictions and a $15 average order, and do we need zero returns or voluntary registration before the first sale? How do Washington B&O and Texas franchise-tax nexus apply?" Why it matters: nexus can arrive at about $3,000 of revenue in some states, and Stripe Tax silently returns zero tax where no registration exists.
7. **Taxability, principal or agent, resale certificates (accountant; C-44, C-45).** Question: "Is registration, renewal and transfer of a domain name taxable in each state as it comes into scope (consumer and business), which Stripe product tax code applies to each, is Mosshatch principal (tax on the full price) or agent, and which resale certificate does the upstream require?" Why it matters: no state revenue-department page names domain registrations and Stripe has no domain tax code, so a default code risks over- or under-collecting.
8. **Data-protection roles and paper (lawyer; C-48, C-49).** Question: "Is Mosshatch a controller, joint controller or processor relative to Tucows, the registry and the escrow agent for registrant data? How should the RAA 3.7.7.5 'consent' be worded against GDPR Art 6 bases; is the May 2018 Tucows DPA adequate or must we negotiate a new DPA and SCC modules; and do we need EU and UK representatives for a US-only launch when a registrant may live in the EU or UK?" Why it matters: RDP s7 makes registry transfers conditional on DPAs, and this paperwork gates collecting registrant data in Phase 2.
9. **Retention against erasure (lawyer; C-19).** Question: "Which retention periods can we rely on after an erasure request: RDP 15 months, RAA term plus 2 years, 180-day logs, OpenSRS's 3-year records, California's 3-year consent evidence and 10-year EU VAT evidence? Does a contractual duty qualify under GDPR Art 17(3)(b), or must we ask Tucows for an ICANN data-retention waiver?" Why it matters: the clocks conflict, and the Phase 2 deletion job needs one schedule.
10. **OFAC scope (lawyer; C-25).** Question: "What is Mosshatch's OFAC status (jurisdiction unknown)? What screening (name, organisation, country; at signup, contact change and payment) and country blocks are required, may we serve customers in Iran, Cuba, North Korea or occupied Ukrainian regions, and how can we freeze or deny a transfer-out for a sanctioned holder when the Transfer Policy has no sanctions-based denial reason?" Why it matters: sanctions liability is strict, ICANN gives no cover, and the design belongs in Phase 2.
11. **EU and UK withdrawal right (lawyer; C-35).** Question: "For CRD Art. 16(a) and UK CCR reg. 36, is a domain registration or renewal a service 'fully performed' at registration? What proportionate amount may we keep after a 14-day withdrawal that falls outside the 5-day registry window (who bears the sunk .io and .ai cost), and what express-request and acknowledgement wording is valid?" Why it matters: it decides the EU and UK refund promise and gates enabling those markets; Gandi's contract treats the service as executed with a waiver, the Commission's guidance says a terms clause alone may not suffice, so both positions are contestable.
12. **EU and UK VAT classification (VAT advisor; C-46).** Question: "Is a domain registration an electronically supplied service under Regulation 282/2011 Art. 7 and Annex I, and a digital service for UK VAT, for consumers and for businesses? If yes, which Member State for Non-Union OSS and what B2B evidence standard (VIES or HMRC valid only)?" Why it matters: it decides whether EU and UK consumer sales need registration at all; no Commission, VAT Committee or HMRC text names domains.
13. **NIS2 reach (lawyer; C-51).** Question: "Does a US reseller storefront count as an 'entity providing domain name registration services' under NIS2 Art 6(22) in the Member States where customers live, is an Art 26(3) representative required, and which national regime applies?" Why it matters: the definition names resellers and applies regardless of size, with 72-hour access replies; national transposition is unverified.
14. **Public commitments and terms wording (lawyer; C-29, C-36, C-53, C-60).** Question: "Please review the wording of the no-front-running and no-sale-of-search-data commitments (they must stay true while the registrar and registries see queries), the renewal-refund-deletes-the-domain term, the .io and .ai non-refundable and sovereignty disclosures, and the 'one flat fee, no upsells' claim once tax is added." Why it matters: deceptive-claim and unfair-terms exposure, and the brief promises honest money.
15. **Accessibility scope (lawyer; C-54, C-56).** Question: "Is Mosshatch a microenterprise under Recommendation 2003/361/EC in each target market (counting owner-managers, partner and linked enterprises), does domain registration count as an EAA e-commerce service, and what is our US demand-letter process and insurance stance?" Why it matters: the EAA exemption ends on growth, a voluntary accessibility statement is cheap, and US web-accessibility suits are rising.


#### Dates and watch list

Dated events that could change the plan, earliest first; items without a date are marked TBC. Vendor-runtime dates that are not compliance are left out.

| Date | Event | Effect on Mosshatch | Source |
|---|---|---|---|
| 2026-09-28 (just passed) | DNS Abuse Mitigation PDP 1 public comment closed (Initial Report 18 Aug 2026); Board delivery expected Jul 2027. Stripe Service Terms sections were also modified this day and not diffed. | Registrars may have to run Associated Domain Checks and may rely on a reseller for steps while staying responsible, so expect abuse-handling clauses in the upstream contract. Re-read Stripe's terms before applying. | RDO verify-skeptic (missed 1); SFEE s7 |
| 2026-10-05 to 2026-10-07, then 2026-10-17 to 2026-10-22 | ICANN87 in Bali (Prep Week 5-7 Oct; a Pre-ICANN87 policy briefing should precede it). | First public chance to see a Transfer Policy implementation timeline or IRT; also watch the DNS Abuse PDP and privacy/proxy status. A published date starts ICANN's at-least-six-month notice window. | ITP verify-skeptic (F.4) |
| 2026-10-06 | .studio wholesale rise: OpenSRS Essential $42 to $51; a third-party tracker shows +29.0% at the registry (masked, unverified). | Effective-dated price table; existing .studio renewals above a mandate's price cap need passkey re-approval and a price-change notice (California: 7 to 30 days before). | TLD s1; OSRS s5, s9 |
| About 2026-10 | SSAD Supplemental Recommendations public comment expected (Board delivery about Mar 2027); RDRS extended to Dec 2027 and still voluntary. | Possible future disclosure duties; none binding in Phase 0. | RDO verify-skeptic (missed 10) |
| 2026-11-01 | .com wholesale $10.26 to $10.97 (announced 2026-04-23; OpenSRS Essential $14.50 to $15.25). | Renewal quotes and notices after this date show the new price; re-quote at capture. | TLD s2.1 +V; OSRS s5 |
| 2026-11-30 | EN 301 549 v4.1.1 national dates as reported by the verifier: doa 30 Nov 2026, dop/e 31 May 2027, dow 31 May 2028. | No change to the WCAG 2.2 AA target; a presumption of conformity arises only once the standard is cited in the Official Journal. | A11Y verify-skeptic (missed 4) |
| 2027-01-01 | EU ViDA changes (SME-scheme interaction, OSS refund procedures); further Single VAT Registration changes essentially 1 Jul 2028. | Only if EU consumers are enabled; no change found to non-Union eligibility. | TAX s4 |
| 2027-01-02 | Spain Royal Decree 707/2026 on cognitive accessibility reportedly in force (AccessibleEU summary only; scope for a domain shop unknown). | Only if Spain is a target market. | A11Y verify-skeptic (missed 3) |
| 2027-01-19 | .io wholesale +12.0% (third-party tracker, masked, unverified). | Price table; no registry notice period was found for .io. | TLD s1 |
| Each January and at launch | OFAC civil penalty amounts are inflation-adjusted (eCFR shows $377,700 as the latest); CCPA dollar thresholds reset in odd years (next 2027). | Re-check both before launch and yearly. | RDO F47, F53 |
| About Apr 2027 | Expect Verisign's next .com price notice about 6 months before the pricing year starting 2027-10-26 (contract ceiling about $11.74). | Price table; multi-year prepay as a price lock. | TLD s2.1 +V |
| Spring 2027 | UK DMCCA subscription regime expected (government expectation; regulations not made): reminders before 12-month renewals and a 14-day cooling-off after auto-renewal. | Only for UK customers; extend the 5-day renewal refund to 14 days when made. | LCL s2.4 |
| Q3 2027 | ICANN privacy/proxy accreditation programme projected completion (Sep 2026 scorecard). | Relevant only if Mosshatch ever offers or distributes privacy/proxy; none in v1. | RDO verify-skeptic (row 36) |
| 2028 or later | Transfer Policy Review implementation (TAC, 720-hour locks, no CoR lock): ICANN's 21 Sep 2026 scorecard says "Implementation Start TBC"; comparable adoption-to-effect lags were 4 to 6 years; Mar 2027 is only a floor. | Keep lock, TAC and notice settings in config; early TAC-style behaviour is compatible either way. | ITP verify-skeptic (B4, B8, F3) |
| TBC | Registration Data Policy urgent-request provisions (s3.8, 3.9, 10.7) take effect when ICANN implements a requestor-authentication consensus policy. | Registrar response times (2 hours acknowledgement, 24 hours, 72 hours maximum) would need a route to Mosshatch. | RDO F12 |
| TBC | FTC negative-option rulemaking: ANPRM 13 Mar 2026, comments closed 13 Apr 2026, no NPRM; the 2026 agenda entry (RIN 3084-AB84) is at prerule stage with staff review of comments listed for 07/2026. | An NPRM would revisit notice and cancel rules; until then ROSCA, the FTC Act and state laws bind. | LCL s2.1 +V |
| TBC | ICANN FY27 registrar fee vote not found; the $0.20 transaction fee is budgeted unchanged. | If not ratified, the fee may be folded into registry wholesale; the amount is unchanged. | TLD verify-skeptic (5) |
| TBC | NIS2 national transposition and enforcement; EAA transposition gaps (Commission v Bulgaria, C-646/24); Digital Fairness Act status. | Relevant only when EU customers are enabled. | RDO s9; LCL s8; A11Y verify-skeptic (missed 7) |
| TBC | EU-US DPF appeal C-703/25 P (Latombe v Commission) pending; a 4 Jun 2026 order in the case was not read. | Keep SCCs as the base and recheck before launch. | RDO F45 +V |
| TBC | Chagos and .io: treaty not in force; the UK said on 22-23 Sep 2026 it will rework it; IANA record unchanged since 2023-01-18; current ISO 3166 status unchecked. | Any retirement gives a 5-year window (maximum 10); keep the purchase-time disclosure and revisit long prepay. | TLD s2.4 +V |
| TBC | ERRP/EDDP policy status report (public comment 15 May to 30 Jun 2025): outcome not found. | A change could alter the reseller-website duties in ERRP 4.1.2 and 4.2.3. | RDO verify-skeptic (missed 12) |
| Quarterly | Diff ICANN's consensus-policies page, RAA global amendments (none after 5 Apr 2024), OFAC programme list, DPF status and upstream notices. | Standing compliance-review task. | RDO s7 (item 14), C13 |


#### Where the research disagrees with the brief or with common belief

- **Transfer-out "cooling-off" (brief, Gate).** Transfer Policy I.A.5.1-5.2 caps a code or unlock request at 5 calendar days, I.A.5.3 bars a mechanism more restrictive than contact or nameserver edits, and the .com pending window is 5 calendar days, so a long cooling-off is not available and a short security delay is a counsel question. The upstream also constrains "cancel any time": OpenSRS has no API to start or approve an outbound transfer, and the registrant approves through OpenSRS emails.
- **Registrar call "only after a verified payment_intent.succeeded" (brief).** The order-flow research recommends authorise, register, then capture (cancelling is free and unreported to card networks, while refunds keep Stripe's fee) and gating on a verified requires_capture state; the registrar-data research reads RAA 3.7.4 as needing the charge first. Unresolved (question 3), and it cannot cover asynchronous registrations.
- **"WHOIS privacy free" (brief).** For gTLDs personal data is redacted by default under the Registration Data Policy rather than sold as a paid add-on, so the promise is honest once the upstream confirms default redaction at no charge, although OpenSRS still lists privacy at $3 a year. .ai and .io differ: OpenSRS offers no privacy for either and .ai shows contacts in WHOIS.
- **"No pre-checked boxes" against a default transfer lock.** A default clientTransferProhibited at registration is allowed only with express consent in the registration agreement (I.A.5.1), so make it a clause accepted with the terms, not a pre-ticked box.
- **The reformed Transfer Policy is not in force.** Blogs that say the TAC took effect on 19 Nov 2024 conflict with ICANN's own pages: only the 21 Feb 2024 policy is in force, the reform was adopted on 7 Jun 2026 with no effective date, and the planning date is 2028 or later (Mar 2027 is a floor, not a forecast). The 2024 update was also not terminology-only: it removed the Administrative Contact as an approver and added the I.A.2.1.1 carve-out and new AuthInfo duties (I.A.5.7, I.A.6.1).
- **ERRP is not new in 2025.** Its duties have bound registrars since 31 Aug 2013; only the terminology revision had the 21 Aug 2025 deadline.
- **RAA facts.** The text in force is 21 Jan 2024, "Reseller" is section 1.26 (one dossier said 1.24), and no global amendment exists after 5 Apr 2024.
- **"Click-to-cancel is the law".** It is not: the 8th Circuit vacated the 2024 amendments on 8 Jul 2025, the old rule was restored on 12 Feb 2026, and only an ANPRM is open. ROSCA and state laws bind, and New York's law is in force (since 5 Nov 2025), not pending.
- **Nexus rules of thumb.** "$100,000 or 200 transactions" is stale in NC and ME; Kansas counts gross receipts (at least 23 such states, not 22); Washington's WAC does mention domain registration (no taxability holding); Register-for-me needs a US bank account only in states that charge fees or require banking details.
- **EU withdrawal.** The research inference that an EU consumer "probably can withdraw" is unsupported either way; market practice (Gandi) is the opposite with a waiver, and both are contestable.
- **Stripe numbers.** "Network programmes are unreachable at launch" holds only for the Excessive tiers (Visa's Non-compliant tier of 5 events and 0.5% is reachable); "never use the Tax API" fails above a $100 tax-inclusive order; a lost countered $10 dispute is a $40.00 balance debit and a $30.59 net loss, not $40.59 plus $10; float arithmetic gives $0.73 where Stripe charges $0.74 at $15, so use integer cents.
- **Availability checks.** RDAP 404 or NXDOMAIN does not mean a name is available; registry RDAP terms restrict high-volume automated use; and OpenSRS's contract mandates Tucows' lookup with an unquantified excessive-use fee.
- **Retention.** "Sponsorship plus 2 years" is not the whole rule: 15 months for the defined RDP data set, the RAA term plus 2 years for records, 180 days for logs, and 3 years in the OpenSRS MSA.
- **Names in Mosshatch's own name.** OpenSRS MSA 3.10 does not itself require the customer to be the registrant (that comes from the MDRA, RAA and RDP), but the customer must be the registrant, and holding names for customers would make Mosshatch a Proxy Service.
- **EAA micro-enterprise exemption.** It is not lost "as soon as" a threshold is passed; the Recommendation 2003/361/EC test uses two consecutive periods and counts owner-managers, partners and linked enterprises.
- **Per-TLD surprises.** The .ai 2-year minimum predates the 2026-03-05 price step, and expired .ai names now go to a registry auction through Namecheap, not Dynadot; .io sovereignty has stalled rather than advanced, so near-term loss is unlikely but the question stays open indefinitely.

### 4.8 Names: trademark knockout and the hatchkind.com proposal

This is research, not legal advice. A real clearance search by a trademark attorney must follow before anything is spent on the brand.

**What was queried (2026-09-29).** USPTO Trademark Search (its own JSON API, through headless Chromium), EUIPO eSearch plus, TMview (143 million marks across 81 offices, including the UK, WIPO, Canada, Australia, Japan and China; feed dates vary by office, and CNIPA, India and a few others are weeks or months stale) and, for Mosshatch, the WIPO Global Brand Database. Not queried: the UK IPO directly (its Cloudflare challenge host is blocked by egress policy; UK marks were read through the TMview GB feed), the WIPO database for Hatchkind (a captcha loop), and most of the open web (the search tool budget of 200 calls was exhausted early, so open-web coverage is thin and marked as such).

| | MOSSHATCH | HATCHKIND |
|---|---|---|
| Identical or near-identical marks | None found (also Moss Hatch, Mosshatched; exact, contains, wildcard, fuzzy and phonetic modes) | None found. Closest: HATCHKINZ (US Reg. 7054458, plush toys, Class 28) and two dead HATCHKINS filings. "Hatch Kind" and "Hatchkinds" return nothing |
| Closest collision | **CROSSHATCH** (Olympus Technologies Inc., US Reg. 7836851, Class 42 data-storage and API software as a service, also WO 1766322): two letters different and rhymes. The company's own site says it shut down in July 2025, so practical risk is lower but the registration is live | The wider word HATCH is crowded: 23 solo HATCH marks in Classes 9, 35, 36, 42 and 45 in the US (18 registered, 5 pending) and about 60 more live marks containing HATCH; 2025 to 2026 filings include HATCH LABS (Classes 35, 36, 42, 45) and HATCHIFY (an AI-agent software as a service, filed 2026-08-11) |
| Class for domain registration | **Class 45.** USPTO ID Manual 13-2026 lists "Domain name registration services" in Class 045 and notes that resellers may use that wording. Class 42 covers the software as a service, hosting, vault and authentication. Class 9 covers the downloadable CLI | same |
| Risk read | Class 45 low; Class 42 medium (CROSSHATCH plus crowded formatives); Classes 9, 35, 36 and 38 low. **No blocker found; proceed to professional clearance** | Medium: "Hatch" is crowded; needs counsel |
| Other formatives | MOSS: Nufin GmbH (fintech software as a service, Classes 9, 35, 38, 42) and Polyarc (creature VR game, Classes 9 and 41). Avoid "Moss" or "Hatch" alone as a product or feature name | |
| Meaning | Coined compound of moss and hatch; not in Wiktionary | |

**The two domains.** RDAP shows `mosshatch.com` and `hatchkind.com` were both created 2026-09-29 at 17:48:38 UTC (about 75 minutes before the check), expire 2027-09-29, sit at NameCheap, Inc. (IANA 1068) with status `client transfer prohibited`, use the registrar's default name servers and forwarding MX and SPF, have no DMARC and no DNSSEC, and point at parked pages. The registrant is not in public RDAP, so ownership by the user cannot be verified from public data; it is consistent with what the brief states. Consequences: both are "New Domains" (under 30 days) in Cloudflare Gateway's category until about 2026-10-29, and ICANN lets the registrar deny a transfer within 60 days of creation (for `.com` the registry blocks it), so neither can move to another registrar before about 2026-11-28. Both labels are unregistered under `.net`, `.org`, `.io`, `.ai`, `.dev`, `.app` and `.studio` (RDAP 404; `.co` has no usable RDAP). Package and handle names for `mosshatch` on npm, PyPI, crates.io, RubyGems, NuGet, YouTube, TikTok, X, Bluesky and the Play Store looked free; GitHub, Instagram and the npm scope could not be verified.

**Proposal: `hatchkind.com` as the public gallery and share-card host, at `hatchkind.com/<domain>`. Recommendation: yes, as a separate registrable domain, under conditions.**
- It is cross-site and cross-origin from `mosshatch.com`, so cookies, storage and passkeys are isolated. But path URLs put every card in one origin, so the host must be **credential-free, cookie-free and read-only**: a separate deployment with its own database role that can see only a view of published cards.
- The real risk is user-generated content: cards display arbitrary domain names, which invites phishing lures and brand impersonation. Gate publishing (passkey step-up, a Web Risk check, a typosquat and homoglyph screen), render names as plain text and never as links, show punycode, set `noindex` by default, and provide a report link, a DMCA agent and an EU DSA Article 16 notice-and-action route. Cards are only ever for domains registered through Mosshatch and contain computed traits, never free text.
- `hatchkind.com` sends no email: `v=spf1 -all`, a null MX and a DMARC `p=reject`. Mosshatch mail is sent from a `mosshatch.com` subdomain.
- Passkeys are bound to the RP ID `mosshatch.com`; `hatchkind.com` has no sign-in. If it ever needs one, use a redirect login (Related Origin Requests exist but are limited to five labels).
- Make the share host a configuration value so that a rename is a redirect, not a rewrite, and do not build public brand equity in HATCHKIND until counsel has cleared it (decision D-012).

### 4.9 Reference-site study (2026-09-29)

None of the four is a registrar. They are a sports and party-game site (rallywild.com), two mahjong game sites (airmahjong.com and lightningdragon.com) and a food-ordering prototype (puestofijo.com). The brief's statement that "these sites share" one place is only verifiable per site; no site links to a sibling. What they do share is a construction style: procedural three.js (r170 to r186) with zero binary assets, Vercel hosting, prerendered HTML and synthesized WebAudio. That is the same shape as the Mosshatch plan, and rallywild.com's privacy page names Vercel, Neon, Resend and Stripe.

| Site | What it proves | Weight and stack | Best idea to adopt | What to avoid |
|---|---|---|---|---|
| rallywild.com | A live 3D scene as hero background, playable with no account (only a two-checkbox age and safety dialog), short punchy copy, a purpose-built failure screen | Vite, vanilla TypeScript, three r170, no React; about 400 kB over 36 requests to a live hero; audio synthesized, no files | Prerendered readable HTML first; an inline classic-script "boot sentinel" that separates "no WebGL" from "the chunk did not arrive" and self-heals; adaptive quality tiers; sound only after a gesture; native `details` and `dialog` | Canvas with no text alternative; the WebGL-missing screen is a dead end; brand and codename split; fixed mobile layout clips a card at 390 x 844; sound settings not persisted |
| airmahjong.com | "Play before signup" (guests play with an optional name), a lesson route that works without WebGL, three in-brand no-WebGL messages (desktop, iOS, script failure) with exits | Lobby 24 requests, about 631 kB (a 302 kB hero photo is the bulk); three r170 (141 kB brotli) only on game routes; every asset served `max-age=0` | An ambient hero with Pause and Replay controls that honours reduced motion and Save-Data; a sound comfort dialog with separate levels; 44 px targets and 3 px focus rings | No `<main>` or skip link; canvas without a text alternative; no caching on hashed assets |
| lightningdragon.com | A tiered hero: blurred placeholder, then baked still, then 2D ambience, then live 3D behind a capability gate and a frame-time watchdog, so the 138 kB brotli three chunk never loads on phones or reduced-motion | Desktop lobby 21 requests, about 343 kB; mobile 322 kB; reduced motion 278 kB; no JavaScript 17 kB | The tiered hero; an inline sentinel and inline-CSS panel that says why 3D is missing and offers exits that still work | Everything client-rendered (empty root, no `<h1>` in the served HTML); server room created before the WebGL check; no skip link; only HSTS as a security header |
| puestofijo.com | A scroll story over a full-viewport procedural street scene with one strongly named place; reservation needs only a first name; a whole 3D city generated in code (608 kB JavaScript raw, about 158 kB on the wire, lazy after hydration, no model or texture downloads) | Next.js prerender on Vercel; 0.69 MB over 28 requests by 10 s; fonts are 46% of transfer | A story that reads as real DOM copy over the scene; honouring reduced motion in both CSS and JavaScript | A fabricated "N watching" counter (`viewerOpens + 3`, fallback 21); horizontal overflow at 390 px; hero copy held for a 4.5 s intro; no-JavaScript users stuck on a veil; no in-brand WebGL-unavailable message |

**Patterns Mosshatch adopts.** (1) A real-HTML first paint of the Find page: `<h1>`, the search field and the price list are static HTML and CSS, so the no-JavaScript and no-WebGL pages are the same page. (2) A tiered hero: live scene on capable devices behind a capability gate and a frame-time watchdog, a baked still and 2D ambience otherwise, and never a blank screen. (3) An inline classic-script boot sentinel with three in-brand messages (no WebGL2, iOS-specific, script failure) that each keep a working plain search and price list. (4) Adaptive quality tiers and a persisted Calm setting. (5) Sound only after a gesture, with a comfort dialog and a persisted toggle. (6) Pause and Replay on the Arrival demo, honouring reduced motion and Save-Data. (7) Real landmarks: `<main>`, a skip link, one `<h1>`, native `details` and `dialog`. (8) Immutable caching for hashed assets, which all four sites got wrong. (9) No invented counters and no copy held behind an intro. (10) A 390 px overflow check in the end-to-end suite.

### 4.10 Performance and accessibility budgets, and the test plan

#### Performance budget

Numbers marked (measured) come from a build made in this session (Vite 8.3.1, React 19.3.0, zustand 5.0.15, three 0.186.1; see `docs/research/measure-bundle-size.md`); (sourced) numbers come from the cited vendor or standards text; (own target) numbers are our choice and are not claimed as facts. Frame times cannot be measured meaningfully in this container (software rendering), so CI enforces structural budgets and real-device frame times are a manual protocol.

| Budget | Value | Basis |
|---|---|---|
| Frame time | 16.7 ms (60 fps) target on a mid-range phone; a 30 fps quality tier at 33.3 ms | Brief; WebKit halves `requestAnimationFrame` under Low Power Mode and aggressive thermal mitigation, so a 30 fps tier must exist (sourced) |
| Adaptive resolution | Step DPR down when the frame average exceeds about 22 ms; cap DPR at 1.75 | Brief; about 1.0 to 1.25 megapixels of drawing buffer on a phone at the cap (sourced arithmetic) |
| Draw calls | at most 60 in any view (`renderer.info.render.calls`) | Brief. Plan: sky 1, pool 1, ground 1, merged trees 2, props 2, grass 1, lanterns 3 plus halos 1, fireflies 1, pollen 1, bursts 1, eggs up to 6, wisps 1, and **one merged mesh per creature** (per-part matrices in a uniform array driven in the vertex shader), with at most 24 individually animated creatures in the Grove; more domains render as instanced distant silhouettes and appear in the Ledger. Arm's guidance is under 500 draw calls natively, so 60 leaves headroom (sourced) |
| Fill rate | overdraw at most 2.5x; MSAA off as an engineering judgement (Arm recommends 4x MSAA on tile-based GPUs, so both are tested on real devices); no `discard`; no blending on full-screen layers; hatching computed only on geometry, not as a post-process | Arm mobile guidance (sourced). A screen-space hatching shader is fill-rate bound, so this is the main risk |
| Initial JavaScript (gzip) | target 110 kB, hard 130 kB | Measured shell (React + zustand) 68.7 kB gzip; the lazily loaded scene chunk is 134.9 kB gzip, of which 128.4 kB is the unshakeable `WebGLRenderer` core |
| Scene chunk (lazy, gzip) | hard 150 kB | Measured 134.4 to 134.9 kB with the planned import set |
| Passkey chunk (lazy, gzip) | hard 5 kB | Measured 3.1 kB |
| Total JavaScript (gzip) | target 270 kB, hard 300 kB | Measured 206.6 kB with the shell, three and WebAuthn, before app code and shaders |
| Fonts | at most 45 kB WOFF2 for both families | Measured subset: Young Serif 18.4 kB + Atkinson Hyperlegible Next variable (wght 400 to 700) 20.4 kB = 38.8 kB |
| First paint | Real content (hero line, search field, price list) is static HTML and CSS that paints before the scene chunk is requested | Measured in headless Chromium with simulated Slow 4G and 4x CPU: FCP 0.82 s with the lazy split versus 1.96 s with a static bundle; the scene chunk was requested after FCP in 45 of 45 runs |
| Long tasks | no single task over 50 ms after first paint outside shader compilation; compile via `compileAsync` | Own target |
| Idle cost | Ledger view renders at a reduced rate; hidden tab renders nothing | Brief |
| Memory / triangles | 24 animated creatures and all props under 150k triangles | Own target; verified on the debug route with `renderer.info` |

#### Accessibility budget

Target: **WCAG 2.2 Level AA** (W3C Recommendation; ISO/IEC 40500:2025). WCAG 3 is still a Working Draft. The full 58-gate checklist is in `docs/research/tech-a11y-standards.md` section 8; the gates that shape the design:

- **Contrast (computed with a script, not estimated):** Lantern on Night 9.61:1; Ink on Lantern 10.51:1; Shell on Night 14.31:1; Shell on the frosted panel at least 6.29:1 even over pure white. **Failing pairs to avoid:** Lantern on Shell 1.49:1 and Shell on Pool 2.80:1. Focus ring is three-banded (Night, Lantern, Night) so it holds at least 3.10:1 on any background.
- **State colour is never alone.** The state hues have almost identical lightness (needs-attention against traveling is 1.01:1), so every state needs a shape and text as well as a dot.
- **Hold-to-reveal.** WCAG's Understanding text for 2.1.1 names "a key must be held down for an extended period" as a failing timing. The plan therefore ships hold-to-reveal as an enhancement and always offers a single-activation path (activate, confirm, reveal), which is how the keyboard and switch-access route works. This departs from the brief's "hold Space/Enter" wording and is recorded as decision D-010.
- **Auto re-hide after 10 seconds** is a time limit (2.2.1): it is adjustable (up to 10x), and the revealed value is never placed in a live region.
- **Motion.** `prefers-reduced-motion` starts Calm; Calm is also an in-page control and a real pause (2.2.2). The Arrival demo plays once and can be paused.
- **Targets** are 44 px, which exceeds the 24 px minimum of 2.5.8. The Ledger is not cited as the 2.5.8 "Equivalent" exception, because that exception needs the alternative control on the same page; the 44 px rule carries it.
- **Canvas.** Every chip, tag and control is a real button or link; the Ledger is the full table alternative; status changes go through polite live regions, with no announcements for ambient animation.
- **European Accessibility Act.** An online domain shop selling to EU consumers is very likely an in-scope e-commerce service, but microenterprises (fewer than 10 staff and turnover or balance sheet at most EUR 2M) providing services are exempt (Art. 4(5)). Launch-stage Mosshatch is probably exempt and the exemption ends as it grows: counsel to confirm.
- **Tooling limits.** axe-core 4.13.0 has 105 rules; only `target-size` maps to a WCAG 2.2 criterion and it is off by default, so tests enable it and the `wcag22aa` tag explicitly. Text over the WebGL canvas comes back as "incomplete", not pass, so those cases are listed for manual review. Automated tools cannot judge hold, drag, focus-obscured or announcement quality.
- **Screen-reader matrix** (WebAIM survey #11, July to August 2026, n=1,780): JAWS with Chrome first (31.2% of primary pairs), NVDA, VoiceOver on Safari; mobile VoiceOver and TalkBack.

#### Test plan

| Layer | What | Tooling and rules |
|---|---|---|
| Unit | `deriveTraits` golden tests (same domain gives the same creature in browser and Node), `deriveCreatureState` precedence table, money math (integer minor units, no floats), scope matrix, envelope encryption (wrong AAD fails, tampered ciphertext fails, re-wrap keeps plaintext), step-up challenge derivation, audit hash chain | Vitest; property tests for the order machine |
| Contract | One shared adapter contract suite run against `MockRegistrar` and the chosen provider's sandbox | Sandbox limits are recorded per provider (OpenSRS Horizon cannot simulate transfers, redemption or `.ai`) |
| Integration | Postgres on a Neon branch or local; Stripe test mode with the Stripe CLI forwarding webhooks; duplicate, out-of-order and replayed webhooks; registrar timeout (`outcome_unknown`); quote changed at fulfilment | Runtime DB role created with SQL, not the console owner role (which bypasses row-level security) |
| End to end | Playwright against the built app with WebGL on: every creature state (`?debug=states`) and every view at desktop and phone sizes; console and page errors fail the test | Pin `@playwright/test` 1.56.1 (matches the preinstalled Chromium 141 build) or pass `executablePath`; never run `playwright install`; never pass `--disable-gpu`; pass `--enable-unsafe-swiftshader` |
| Visual regression | Deterministic screenshots via `?t=` (frozen time uniform), `?seed=` (seeded RNG) and an on-demand render loop; byte-identical across 5 launches in the verified experiment | `toHaveScreenshot` with `scale: 'device'` and `threshold: 0` (the defaults hide real changes); `page.clock` is not deterministic enough; pin GL flags because they change 0.1% of pixels |
| Accessibility | axe via `@axe-core/playwright` with `wcag22aa` and `target-size` enabled; scripted tab-order snapshots; manual keyboard pass and screen-reader pass per phase | Text over the canvas is reviewed manually |
| Security | Every `ST-nn` in the threat model; the canary-secret test; the bundle secret scan; CSP violation-free run; header checks | The scan script and its 17 tests were prototyped in this session (`docs/research/measure-secret-scan.md`) and adopted in Phase 4 |
| Performance | Bundle size (size-limit), draw calls and triangles on the debug route, first-paint order, lazy-chunk timing | Structural budgets in CI; frame times only on real devices |
| Real-device pass (manual) | 60-second frame-time capture, five-minute thermal soak, touch feel, Safari/iOS behaviour | Device list agreed in Phase 1; results reported per phase |

#### What cannot be verified in this container

Real-device GPU behaviour and shader precision on Mali, Adreno and Apple GPUs; thermal throttling and battery; Safari and iOS WebGL (no WebKit installed; Playwright's WebKit is not Safari); touch feel; audio output; WebGPU (no adapter); cross-machine pixel identity; live calls to any registrar sandbox, Stripe, Resend, KMS or Neon (no credentials exist in this session); Vercel behaviour (nothing was deployed). Every number in this plan is either labelled as measured here, sourced from a dated page, or labelled as our own target.

### 4.11 Research limits

The search tool had a 200-call budget that ran out early in the session; later research used direct fetches of primary pages, and every dossier says which sources it could not reach. Blocked or unreachable and not worked around: Namecheap and ResellerClub legal and pricing pages (Cloudflare challenge whose challenge host is blocked by egress policy), the UK IPO trade mark search, the W3C site behind Cloudflare (substituted with the W3C GitHub mirror), Mastercard's rulebook, GoDaddy's API terms, `domains.opensrs.com`, some tax-authority pages (Australia, India), GitHub HTML pages (this session is bound to its configured repository), and several vendor pricing pages behind bot checks. No credentials for any provider exist in this session, so **no live API call was made to a registrar, Stripe, Resend, KMS, Neon or Vercel**, and nothing was deployed. Where a verifier could not confirm a claim it is marked unverifiable in the dossier and in `docs/research/verification-digest.md`.

---

## 5. Phases 1 to 6: scope, exit criteria, risks

Every phase ends with the report the brief requires: what shipped, what is still rough, screenshots of the states touched, test results, and the decisions needed. Nothing from Phase 2 onward starts before the plan is approved, and each phase waits for "go".

### Phase 1: the place (no backend)

**Scope.** Vite app and workspace scaffold; design tokens; the hatch shader (three ink layers in screen space, moss overlay, rim light, speckle, desaturation, sleep dimming, attention pulse, shedding band, fog, sway); sky dome; pool with ripples; merged trees, stones and grass; lanterns with flicker; fireflies and burst particles; goal-and-damp camera with the four views and fit-to-aspect; four creature families built from primitives plus the two palette reuses; all eight states; Find view with eggs, sleepers, struck-through chips, alternatives and "The deal"; the Arrival demo; the Hatch sequence and the card snapshot; WebAudio sound; Calm mode; the WebGL fallback page; mobile layout; `MockRegistrar` with deterministic availability and prices labelled "sample price"; `?debug=states`.

**Also in Phase 1 because they gate everything later:** `packages/core` (`deriveTraits`, `deriveCreatureState`, money), the store contract with its compile-time test, the CSP and header baseline, the bundle-size and draw-call budget checks in CI, and the Playwright + axe harness.

**Exit criteria.** Budgets in the Performance section met on the debug route (draw calls, initial JS, DPR step-down works); zero console errors; axe clean on every view; keyboard pass done; the same domain hatches the same creature in the browser and in Node (golden test); first paint shows real content before the scene loads; the fallback page works with WebGL disabled and with JavaScript disabled.

**Main risks.** Fill-rate of the full-screen hatch on phones (mitigation: hatch only on geometry, cheap sky and pool, adaptive DPR, quality tiers); draw-call budget with many creatures (mitigation: one merged mesh per creature driven by per-part matrices in the vertex shader, and a cap on animated creatures in the Grove); shader precision differences on mobile (mitigation: hash functions that avoid large `sin` arguments, real-device pass listed as not testable here).

### Phase 2: accounts and money

**Scope.** Neon schema and migrations; passkey sign-up, sign-in, recovery; step-up (`actions` prepare and commit); Stripe test-mode Checkout; verified webhooks; the order state machine and idempotency; `MockRegistrar` behind the real machine; receipts through Resend; the jobs table and cron tick; the audit log with hash chain; rate limits.
**Exit criteria.** Order machine tests including duplicate webhooks, out-of-order events, registrar timeout (`outcome_unknown`), and quote-changed-at-fulfilment; the price shown equals the amount charged in every test; ST-08, ST-13, ST-16 to ST-18, ST-22, ST-30 to ST-33, ST-36, ST-40 pass.

### Phase 3: my domains

**Scope.** Grove and Ledger bound to real data; Overview and DNS tabs; the first real adapter against the chosen provider's sandbox; state derived from adapter data; sync, expiry and renewal jobs and emails; opt-in auto-renew with off-session charging; drift detection.
**Exit criteria.** The shared adapter contract suite passes against `MockRegistrar` and the provider sandbox; every creature state is reachable from adapter fixtures; renewal notices meet the ICANN schedule; the unattributed-change detector runs.

### Phase 4: the Nest

**Scope.** KMS-backed envelope encryption, secrets CRUD by environment, hold-to-reveal with step-up and re-hide, audit trail, notification on reveal, wire-it recipes for hosting, Postgres and email, the CLI (`login`, `pull`, `push`, `run`), and the bundle-secret scan.
**Exit criteria.** ST-01 to ST-07, ST-09, ST-24, ST-28; canary test green; the recipe preview equals what is applied; the CLI works against staging with the device flow.

### Phase 5: transfers and agents

**Scope.** Rescue (transfer in) and the Gate (transfer out) on the honest transfer state machine, built on what the upstream allows (with OpenSRS: unlock and code issue by API, transfer start by the gaining registrar, approval by email; see 4.3b); scoped agent and CLI bindings; the visitor experience; approval flow; MCP server and REST; "Send all visitors home".
**Exit criteria.** No transfer is shown as complete before the adapter confirms; ST-10 to ST-15, ST-23, ST-25; a scripted agent session proposes a purchase, waits, is approved with a passkey, and produces a real (sandbox) hatch.

### Phase 6: hatchkind.com and launch

**Scope.** Publish flow, public gallery and card pages on the separate origin; static pre-render of the Find page and public pages; sitemap; status and error pages; runbooks (incident, registrar outage, key compromise, Stripe dispute); launch checklist; a full security review pass against this threat model; legal documents in place.
**Exit criteria.** ST-37 and ST-38; all launch-checklist items in Compliance closed or explicitly accepted; a rehearsed key-compromise drill.

## 6. Evidence index

All files are in `docs/research/` (start with its `README.md`). Every dossier was followed by at least one independent verification pass; corrections are collected in `docs/research/verification-digest.md`. Research date: 2026-09-29.

| Topic | Dossier | Used in |
|---|---|---|
| OpenSRS (Tucows) reseller platform | `reg-opensrs.md` | 4.1, D-001 |
| CentralNic Reseller (Key-Systems) | `reg-centralnic.md` | 4.1, D-001 |
| Dynadot / Global Domain Group reseller program | `reg-dynadot.md` (+ legal and tech verify notes) | 4.1 |
| Porkbun | `reg-porkbun.md` (+ verify notes) | 4.1 |
| Namecheap | `reg-namecheap.md` (+ tech verify notes) | 4.1 |
| Gandi, Name.com, NameSilo, ResellerClub | `reg-gandi.md`, `reg-namecom.md`, `reg-namesilo.md`, `reg-resellerclub.md` | 4.1 |
| Nine other routes screened; becoming accredited | `reg-screen-others.md` | 4.1 |
| Registry facts for the six extensions (operators, wholesale, `.io` status, lifecycle) | `tld-registry-facts.md` | 4.1, 4.2, D-006 |
| Type-ahead availability, RDAP limits, front-running | `availability-at-scale.md` | 4.3b, D-017 |
| Stripe fees, disputes, card programs, restricted businesses | `stripe-fees.md` | 4.2 |
| Stripe order flow, manual capture, webhooks, renewals, tax in Checkout | `stripe-order-flow.md` | 4.3b, D-002 |
| Sales tax, VAT, GST, merchant-of-record options | `tax-vat.md` | 4.7, D-006 |
| Unit-economics model and its output | `unit-economics.py`, `unit-economics-output.md` | 4.2, D-003 |
| ICANN Transfer Policy and its reform | `icann-transfer-policy.md` | 4.7, D-009 |
| Registrar obligations flowing to resellers, registrant data, abuse, privacy law | `registrar-data-obligations.md` | 4.7, D-020 |
| Lifecycle, renewal, refunds, auto-renewal law | `lifecycle-and-consumer-law.md` | 4.7, D-008 |
| Toolchain versions, compatibility, audit | `tech-npm-versions.md` | 4.3a, D-013 |
| Bundle-size measurement | `measure-bundle-size.md` | 4.10 |
| Client-bundle secret scan prototype | `measure-secret-scan.md` | 4.3a, 4.10 |
| Vercel platform | `tech-vercel-platform.md` | 4.3a, D-014 |
| Neon, Drizzle, Resend, Postgres patterns | `tech-neon-drizzle-resend.md` | 4.3a, D-014 |
| KMS and envelope encryption | `tech-kms-envelope-encryption.md` | 4.3b, D-004 |
| WebAuthn, step-up, recovery | `tech-webauthn-passkeys.md` | 4.5, D-016 |
| WebGL2, three.js, mobile GPU limits | `tech-webgl-three.md` | 4.3a, 4.10, D-018 |
| Accessibility standards, contrast, EAA | `tech-a11y-standards.md` | 4.10 |
| Fonts, CSP, headers, cookies | `tech-fonts-csp-headers.md` | 4.3a, D-015 |
| MCP, CLI, tokens | `tech-mcp-cli-agent-surface.md` | 4.5, D-019 |
| Wire-it recipes, DNS propagation | `tech-wire-it-recipes.md` | 4.3b, Phase 4 |
| Headless Chromium and Playwright with WebGL2 | `measure-playwright-webgl.md` | 4.10, D-021 |
| Trade mark knockout, both names | `tm-mosshatch.md`, `tm-hatchkind.md` | 4.8, D-012 |
| Reference sites | `ref-rallywild.md`, `ref-airmahjong.md`, `ref-lightningdragon.md`, `ref-puestofijo.md` | 4.9 |
| All verifier corrections | `verification-digest.md` | throughout |
