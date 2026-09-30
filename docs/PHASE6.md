# Phase 6 report: hatchkind.com and launch

Status: the publish flow, the static cards site, the pre-rendered public pages, `security.txt`, the error pages, a static status page and drafts of the fourteen legal documents are built and tested in process (real PostgreSQL 16, Node 22.22.2). **Nothing live has happened**: no penetration test, no live rehearsal, no Stripe live-mode checklist, no beta, no whole-system tabletop, and counsel has approved none of the documents. Vercel Blob, the Vercel deploy hook and Google Web Risk were never called; card storage, site rebuilds and threat-list lookups ran against in-repo fakes. The cards and web headers were checked against local static servers, not a Vercel deployment. You waived the phase gates on 2026-09-30 (D-050); this report still marks as unproven everything that ran only against a fake.

## What shipped

- **Publish flow** (`packages/api/src/publish`, migrations 1000 and 1005): publishing is a `card.publish` passkey step-up bound to the uploaded file and the listing choice. The browser renders the creature and uploads a PNG; the server parses it strictly (type, size up to 180,000 bytes, dimensions, colour type, interlace, CRCs, trailing bytes, animation, a decompression bomb) and re-encodes it to IHDR, IDAT and IEND only. A card stores the re-encoded portrait, the traits computed from the name and the hatch date, and no free text. At prepare, a name screen refuses brand look-alikes and mixed scripts, and the Web Risk check refuses flagged names and fails closed when the service is down. Unpublishing is free and purges the portrait at once; an unknown, foreign or already-unpublished card gives the same 404. A take-down holds until support reinstates it (1005); repeat take-downs end a person's publishing; a daily re-scan takes down a card that turns up on a threat list. Publishing, unpublishing and each take-down queue a cards-site rebuild through a Vercel deploy hook.
- **The export** (`GET /api/v1/cards/public`): the public fields only, paged, read through a view of published, unreleased, not-taken-down cards by a separate database role, and only with the build's key (`CARDS_EXPORT_KEY`, at least 32 characters).
- **hatchkind.com** (`apps/cards`, its own Vercel project): a static site generated from the export, every page followed, newest first; outside production it builds from sample fixtures, and `MH_CARDS_PRODUCTION=1` makes a missing export URL a build failure (D-049). Pages: the gallery (opted-in cards only), one page per card, about, 404 and 500, `robots.txt`, a sitemap of opted-in cards and `/.well-known/security.txt`. No script at all; the CSP has no `script-src`; no cookies; `Referrer-Policy: no-referrer`. The portrait on the site is an SVG computed from the name; uploaded pixels are never served (D-043). A card is `noindex` until its owner opts in (D-035) and carries no outbound links.
- **Public pages on mosshatch.com**: 13 pages (the legal index and eight legal documents, the security policy, the report page, 404 and 500) are generated from fragments in `apps/web/pages` into `apps/web/public`, and the build fails if the committed output is stale (D-048). The Phase 3 fee and commitments pages and five earlier legal documents stay hand-written in `apps/web/public`. Every draft page carries a "Draft awaiting counsel" banner. `sitemap.xml` (19 indexable pages) and `robots.txt` are written at build.
- **Legal document set** (C-72): all fourteen documents exist as files, each marked as a draft counsel has not approved, and each is published as a `document_versions` row keyed by the file's SHA-256 (`packages/api/src/account/documents.ts`).
- **`security.txt`** (RFC 9116) on both origins, pointing to the security policy page (a draft with a safe-harbour statement).
- **Status page** (`status/`): two static files with no script and a README naming hosts other than Vercel and AWS. It is not hosted anywhere.
- **Money compliance built in the Phase 3 pass** that closes Phase 6 rows: the dispute-rate alarm (the own 0.5% target pages, then the Stripe, Visa and Mastercard tiers), per-operation Stripe Products and descriptor suffixes, the tax-region gate, the sales ledger with nexus alerts at 60% and 80%, and the retention purge (`stripe/disputes.ts`, `orders/tax.ts`, `ops/retention.ts`, migration 0750).

## Measured

| Item | Result |
|---|---|
| Phase 6 unit and database tests (`npx vitest run`, 2026-09-30 about 17:47 UTC, code as at commit `ce79de0`) | 31 passed, 0 failed, 0 skipped: `packages/api/src/publish` 19 (publish 11, review 6, legal 2), `apps/cards` 7 (generate 4, render 3), `scripts/public-pages.test.ts` 5 |
| Money-compliance tests behind C-19, C-40, C-43 | 31 passed: `stripe/compliance.test.ts` 10, `orders/tax.test.ts` 9, `ops/retention.test.ts` 4, `ops/kms-reconcile.test.ts` 8 |
| Cross-cutting re-runs | `security/matrix.test.ts` 14, `foundation.test.ts` 14, `boot.test.ts` 8: all pass |
| Cards build (`npm run build:cards`, sample fixtures) | 9 pages, no script, secret scan clean, links and budgets pass; stylesheet 2.30 kB (0.93 kB gzip); pages 1.4 to 2.4 kB each |
| Web build (`npm run build`) | public pages current; sitemap 19 pages; initial JS 87.7 kB gzip (limit 130) |
| Playwright | Not run for this report. The Phase 6 specs are `e2e/cards.spec.ts`, `e2e/publish.spec.ts` and `e2e/public.spec.ts` |

## Exit criteria

| Criterion | State |
|---|---|
| ST-145 passes | Met against fakes only: unit and database tests pass with in-memory card storage and a fake Web Risk; the browser specs run against local static servers and were not run for this report |
| The whole suite, ST-01 to ST-155, is green or waived in writing | **Not met.** `scripts/check-st-ids.mjs` confirms all 155 ids are due in a phase. No test names ST-153 or ST-154 (not tested), and ST-119 is a manual checklist that is owed. ST-21, ST-139 and ST-140 are CI checks (`scripts/scan.test.ts`, `scripts/check-supply-chain.mjs`) that do not carry the id in a test name. Many ids pass only against fakes (see each phase report). Nothing is waived in writing |
| Every row tagged P6 is closed, every Counsel Y row is answered or accepted in writing, and no row is closed for the first time in Phase 6 unless tagged P6 | **Not met** (table below) |
| Penetration-test findings closed or accepted in writing | **Not met.** No penetration test has been commissioned |
| 14 days of the beta without an unresolved `outcome_unknown`, with clean reconciliation and no unacknowledged S1 alert | **Not met.** No beta; no live registration has happened |
| This report lists each unknown from the written questions in PLAN 4.1 as verified or still open | Met: all 18 are open (table below) |

### Phase 6 scope that is not done

| Item | State |
|---|---|
| Whole-system tabletop | Not done |
| Legal documents in place | Drafts only; counsel has approved none |
| `security.txt` checked on a real deployment (D-032) | Not done; tested against the committed files and a local server |
| External penetration test with retest | Not done |
| Live rehearsal with founder-owned names (buy `.dev` and `.com`, refund, forced timeout, mandate renewal, lock, DNS, transfer out and back, restore, the dispute runbook) | Not done: no OpenSRS account, no Stripe account |
| Stripe live-mode parity checklist | Not done |
| Egress decision (D-005) and OpenSRS IP rules; Neon Scale; break-glass role tested; on-call sheet; status page hosted; backup drill result; Node 24 confirmed | Not done. CI runs Node 24; the tests here ran on Node 22.22.2 |
| Invite-only beta (30 days, allow-list, 5 registrations a day) | Not started |

## Security tests due in this phase

| ST | Test | State |
|---|---|---|
| ST-145 | `packages/api/src/publish/publish.test.ts` "card portrait intake", "publish flow", "the public view and the cards role" (11 tests); `apps/cards/src/render.test.ts` "cards carry no free text or outbound links" (3); `e2e/cards.spec.ts` "the cards origin sets no cookies, runs no script and requests nothing from another origin" and "a card shows the name as text with no outbound link"; `e2e/publish.spec.ts` "publish a card with a passkey, see it in the export, and take it down" | Unit and database tests pass; browser specs not run for this report |
| ST-95 re-run | `publish/publish.test.ts` "the cards role reads only published, unreleased, not-taken-down cards, through the view, with no owner fields" | Passes |
| ST-14 (cards origin) | `e2e/cards.spec.ts` "cards headers on page, stylesheet, image and text routes" | Browser spec against a local server; not run for this report |

## Compliance rows for this phase

Built means code and tests exist for the row's "How Mosshatch meets it" cell; Partly built means some of it; Not built means none; Counsel means the row cannot close until counsel or an accountant answers, and the note says what exists.

| Row | State |
|---|---|
| C-13 registrar of record | Partly built; Counsel. The public-page footer says Mosshatch is a reseller and links `/legal/registrant-rights.html`, which names the planned registrar (Tucows, IANA 69), links ICANN's lookup and the Registrants' Benefits and Responsibilities. The app's own footer links Legal but does not name the registrar. Wording awaits counsel |
| C-17 registrar RDAP | Not built: an upstream duty. Checking OpenSRS's RDAP output and agreeing how disclosure requests reach Mosshatch are owed |
| C-19 retention | Built; Counsel. The purge honours `retain_until` and `legal_hold`, webhook payloads are nulled at 30 and 90 days and rows deleted at 180 (`ops/retention.test.ts`). The schedule itself awaits counsel (question 9) |
| C-21 abuse contact | Partly built. `/report.html` needs no sign-in and is linked from the home page (`e2e/public.spec.ts`), but reports go by email link, not a web form; the `abuse@` mailbox does not exist yet; there is no path to ask the registrar for a hold |
| C-22 authorities' on-call route | Not built: a contract term with the registrar and a runbook for registrar-directed holds and legal requests; neither exists |
| C-35 EU withdrawal | Counsel. Non-US billing addresses are refused by the tax-region gate, so nothing more is needed for a US launch |
| C-40 disputes | Partly built. The 0.5% own target pages, then Stripe's 0.75% review, VAMP and ECM tiers; one descriptor prefix with per-operation suffixes; Radar rules as documented config (`stripe/compliance.test.ts`). The automatic dispute evidence pack is not built |
| C-43 nexus ledger | Built; Counsel. Rolling 12-month gross and transaction counts per state with alerts at 60% and 80% (`orders/tax.test.ts`). The accountant has not mapped home-state presence |
| C-46, C-47 other tax regimes | Counsel. Blocked at launch by the tax-region gate |
| C-48 GDPR | Counsel. A privacy notice draft exists; the data map and processing record do not |
| C-50 PII protection and runbooks | Partly built. Contacts are encrypted per field (Phase 2), but still pass through the runtime role, not `mh_contacts`. Runbooks exist for Stripe, the registrar and KMS; the whole-system runbook does not; none has been rehearsed on staging |
| C-51 NIS2 | Counsel. Engages only with EU customers |
| C-52 CCPA | Counsel. The year-end threshold record is not built |
| C-54 EAA | Counsel. An accessibility statement draft exists; the EAA decision is not recorded in `DECISIONS.md` |
| C-55 accessibility | Partly built. axe WCAG 2.2 AA runs over the public pages and cards at desktop and phone sizes (specs not run for this report); manual keyboard and screen-reader passes have not been done |
| C-56 ADA | Counsel. The accessibility statement draft exists; no demand-letter process or insurance decision |
| C-64 DMCA safe harbour | Not built. No designated agent is registered with the Copyright Office (yours to file); the abuse and DMCA procedure is a draft |
| C-65 DSA | Counsel. The report page is a contact point; receipts are not logged because reports arrive by email |
| C-66 take-down | Built; Counsel. Unpublish-and-purge first, take-downs hold until support reinstates, repeat take-downs end publishing, `abuse_reports` and audit rows record decisions (`publish/review.test.ts`, `publish/publish.test.ts`). The site rebuild goes through a deploy hook that has never been called |
| C-67 card abuse contact | Partly built; Counsel. Every card page links to `mosshatch.com/report.html#cards`, which needs no sign-in and names `abuse@` and `dmca@`; reports go by email, not a form, and neither mailbox exists yet |
| C-68 publish screening | Built against a fake: the name screen and the daily re-scan are tested; the Web Risk adapter has never been called |
| C-69 trade marks | Counsel. Complaints use the take-down route; clearance of both names is not done |
| C-70 personal data in names | Partly built; Counsel. Publishing is the owner's choice and unpublish purges at once; unpublishing on account closure waits for closure itself, which is not built |
| C-71 indexing | Built: `noindex` until the owner opts in, and only opted-in cards in the gallery and sitemap. It uses a robots meta tag, not the `X-Robots-Tag` header the row names; cards have no outbound links, so no interstitial is needed |
| C-72 document set | Counsel. All fourteen exist as versioned drafts |
| C-73 legal process for secrets | Counsel. An outline page only |

No row is deferred: you have approved no deferral.

## Unknowns from the written questions (PLAN 4.1)

No OpenSRS account exists, so none has been answered.

| # | Question | State |
|---|---|---|
| 1 | Lookup rate limits and the excessive-use fee | Open. The search budget uses own numbers |
| 2 | Allow-list rules beyond five | Open. D-005 not executed |
| 3 | Add-grace length and refund rule per extension; the AGP cap | Open. Refund windows are the plan's table |
| 4 | A duplicate or retried `SW_REGISTER`; order lookup by our reference | Open. The order machine never resends and reconciles by polling, proven against the mock |
| 5 | `.ai` and `.io`: public contacts, transfers, codes; an `.ai` test | Open |
| 6 | Who sends verification and expiry emails, in whose branding, when | Open. Mosshatch sends its own set regardless (C-26) |
| 7 | Auction opt-out; exact grace, nameserver-switch and release dates | Open |
| 8 | Notice dates of the `.studio` and `.com` increases | Open |
| 9 | Which data-processing addendum applies | Open |
| 10 | Change-of-registrant handling | Open. Built to the Transfer Policy text against the mock |
| 11 | Outbound approve, decline or cancel; the Losing FOA sender; `.io` codes; registrar hold | Open |
| 12 | Volume-tier timing; promotions on API orders | Open |
| 13 | Deposit terms on closure | Open |
| 14 | ACH for a new API reseller, ceilings, wire, card top-up limits | Open |
| 15 | Default redaction for US registrants in RDAP and WHOIS, in writing | Open. The "WHOIS privacy: Free" copy depends on it (D-020) |
| 16 | Manual review or KYC before API access | Open |
| 17 | Switching off the Manage Web Interface; hiding `.io` codes; support's checks; MFA | Open. The end-user probe checks only that the login page redirects |
| 18 | DNSSEC fee through the API | Open. DNSSEC is not advertised |

## Review findings fixed in this phase's modules

Other agents reviewed these modules adversarially; each finding was reproduced by a failing test before its fix.

| Module | Finding | Fix and test |
|---|---|---|
| Publish | Replaying one `card.publish` action concurrently could delete the live card's portrait | The losing request never deletes it; `publish/review.test.ts` |
| Publish | An owner could republish a taken-down card, at prepare or with an action committed before the take-down, or after unpublishing it first | A take-down holds until support reinstates (1005); `publish/review.test.ts` (2 tests) |
| Publish | The export listed unlisted cards to anyone | Only the build's key reads it, uncached; `publish/review.test.ts` |
| Publish | The export and the daily re-scan stopped at the first 5,000 and 10,000 cards | Both page through every card; `publish/review.test.ts` (2 tests) |
| Cards | The site served the uploaded pixels | The portrait is computed from the name and a missing upload cannot fail the build (D-043); `apps/cards/src/generate.test.ts` |
| Cards | A card gone from the export left its portrait in the output | Every build starts from an empty output; `generate.test.ts` |
| Cards | Names differing only by `.` and `-` collided on one page | Each gets its own page; `generate.test.ts` |
| Cards | The build read one page of the export, or ran without the key | It follows every page and stops without the key; `generate.test.ts` |
| Web | The card listing choice could change while the passkey signed it, and a take-down (409) was not explained | Locked while signing and explained; `e2e/sensitive-screens.account.spec.ts` (not run for this report) |

## Deviations from the plan

- **Card portraits** (D-043): hatchkind.com shows an SVG computed from the name; the uploaded snapshot PNG is still validated, re-encoded and stored, but never served. Assumption 15 and the plan's `snapshot_ref` had the snapshot as the card image; threat row 42 allows only computed traits and the name.
- **Link previews**: `og:image` points at that SVG. Many link-preview services do not render SVG (Decisions).
- **Public pages** (D-048): generated from `apps/web/pages` and committed, with a staleness check in the build, rather than rendered at deploy.
- **Cards project** (D-049): production is detected by `MH_CARDS_PRODUCTION`, set only in the cards project, not by `VERCEL_ENV`.
- **Indexing** (C-71): a robots meta tag instead of the `X-Robots-Tag` header.
- **Abuse reports** (C-21, C-65, C-67): an email link on a no-sign-in page instead of a form, so receipts are not logged by the system.

## Not proven, and why

- **Vercel Blob, the Vercel deploy hook and Google Web Risk**: never called. Their request shapes are marked unverified in `publish/storage.ts` and `publish/screen.ts`.
- **Deployed headers and `security.txt`**: checked against local static servers (`e2e/serve-cards.mjs`, `e2e/serve-dist.mjs`), not Vercel; whether Vercel serves `/.well-known/security.txt` as committed is unverified (D-032).
- **The status page**: not hosted; its independence from Vercel and AWS is a README instruction.
- **Every live path**: OpenSRS, Stripe live mode, production KMS keys and real email have never been used, so the plan's main Phase 6 risk (first live use at public launch) is untouched.
- **Neon**: the lead reports migrations only through 0650 on the Neon project, so 0750 to 1005 have never run there; the deployed preview API answers 503 `not_configured` by design.

## Runbooks and drills

| Runbook or drill | Written | Rehearsed |
|---|---|---|
| Whole-system incident runbook (C-50 template) | No | No |
| Whole-system tabletop | Not applicable | No |
| Registrar-directed holds and legal requests (C-22) | No | No |
| Card take-down | As the draft procedure (`/legal/abuse-dmca.html`), not as a runbook | No |
| Restore drill (`docs/runbooks/restore-drill-log.md`) | Yes | One synthetic local run (Phase 2); no Neon branch, bucket or AWS KMS |
| Stripe webhook-secret roll, registrar key rotation, KMS compromise, account takeover, agent token leak, registrar outage, hostile transfer | Yes (Phases 2 to 5) | None on staging; the KMS drill and the token-leak drill ran only in CI against fakes |

## Decisions needed

1. **Resend sending domain** for Mosshatch, so receipts, notices and the abuse, security and DMCA mailboxes can exist.
2. **Stripe account** (you are creating it): a test-mode key first, then the live-mode parity checklist.
3. **OpenSRS activation** after counsel's review of the MSA, and **an AWS account** for KMS, the anchor bucket and CloudTrail. Both gate the live rehearsal.
4. **Tax-region gate on renewals and pay links**: when a region is turned off, should renewals and pay links for existing names be refused too? Recommendation: yes for new charges.
5. **Dispute alarm**: the own 0.5% target pages as S1, and an unacknowledged S1 can start auto-safe mode (D-028). Confirm or raise the threshold.
6. **Link previews**: accept the SVG card image, or add a raster image for previews.
7. **Penetration test and retest** (D-032): commission it; nothing in this report replaces it.
8. **Compliance**: you have approved no deferral. Not built: C-17, C-22, C-64. Partly built: C-13, C-21, C-40, C-50, C-55, C-67, C-70. Every Counsel row above needs an answer or your written acceptance.
9. **Counsel**: the fourteen draft documents, the RAA 3.7.4 question, the DMCA agent (C-64), the DSA (C-65), trade-mark clearance (C-69), privacy, tax and NIS2 (C-35, C-46 to C-48, C-51), CCPA (C-52), the EAA (C-54) and the registrar on-call route (C-22).
10. **Rotate the two Neon role passwords** that appeared in tool output.
11. **Delete the remote leak-test branch.**
