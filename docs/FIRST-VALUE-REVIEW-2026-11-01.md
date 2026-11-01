# First value and page clarity review — 2026-11-01

## Delivery and reconciliation

Continues `local/waitlist-draft-preservation`, retaining commit `b7d7947a84761bb5cba824162ae964165913f625` and its tested, memory-only waitlist draft. No competing candidate branch, history rewrite, publication or remote merge.

Fetched GitHub `main` at `e821115b12812b0991e4b75dae914a1515ce912a` before editing. The local checkout has older/squashed history; comparing ancestry alone overstates the source differences. A direct tree comparison found new Domain Connect, analytics and cron work on main. Find, its styles and the existing preview journey were identical; WaitlistForm differed only by the retained draft patch. No other agent's implementation was edited.

To reconcile safely under the no-merge instruction, archived fetched main to `/workspace/mosshatch-first-value/integration`, copied the unchanged locked dependencies, and applied only the two local UX patches. This is a disposable validation snapshot, not another development branch. The patches apply cleanly. It passed its own typecheck, production build, affected unit/integration tests and browser checks. This does not update the candidate's ancestry or claim a remote merge.

## Demonstrated friction and changes

- On the 390 × 844 opening screen, CSS hid the explanation that visitors can search and preview without an account. The page prominently offered the waitlist but did not explain the immediate search-to-creature action.
- A lookup returning six `unknown` results said **“0 potential matches found”** next to the input, while its failure explanation was farther down the scrollable panel. A failed check looked like a completed search with no matches.
- A successful search gave only a count, without an immediate next-step instruction.

Find now explains **search or describe an idea → choose a match → preview its creature**, with no account or payment required in preview mode. This guidance remains visible on phones and describes the search input for assistive technology. The input has a concrete example. Failed checks say availability is unconfirmed and keep the entered name; the existing error and retry control sit beside the search status. Successful checks explain choosing a match or keeping a shortlist. Live mode instead guides the visitor to review price and registration steps.

Preserved: invite-only purchase access, dated sample prices, no reservation claims, existing ideas/shortlist/preview behavior, registration policy and the earlier waitlist fix. No provider integration, persistence, pricing, legal text or API change was added.

## Page coverage ledger

**B** = exercised in a local browser using fixtures or static local HTML during this pass. **S** = inspected in source; authenticated/live behavior was not independently exercised in this pass. B does not mean real provider success. Static public pages were visited at 1280 × 844 and 390 × 844, with headings, leading copy, actions and overflow recorded. WCAG 2.2 AA checks cover all 25 public HTML pages through the repository suite plus the supplementary audit.

| Page or surface | Purpose/current state and next action | Recovery/limitation | Coverage |
|---|---|---|---|
| Find: opening, named search, results | Search a domain; preview is labelled; now explains choosing a match and the lack of required setup | Pending checks disable Search; failed checks retain the name and expose retry without a misleading zero-match success | B; fixed |
| Find: describe an idea, alternatives, shortlist | Generate names locally, check them, retain a shortlist; prices remain reference prices | Brief stays off the network; shortlist is not a cart/reservation; unknown checks are explicit | B; existing conversion test |
| Lightweight/no-WebGL Find | Same useful search and preview sheet without the animated scene | Animated hatch limitation is explained by the existing preview action | B |
| Hatch sheet | Selected name, reference prices, privacy, ownership preview, practice-only notice | Keep exploring returns to the same name; invited sign-in keeps context; no anonymous purchase action | B |
| Creature card | Creature portrait, traits, practice/registered distinction; download or hatch another | Download does not register/reserve; registered setup depends on account data | B for practice; S for registered setup |
| My grove: empty/sample | Empty state invites Find a name or a sample grove; samples explicitly are not owned domains | Owned-domain load failure has text but no inline retry; leave/reopen is currently needed | B for empty/sample; S for owned/error |
| Waitlist dialog | Early access request, consent, no domain reservation | Error text and retry; entered details survive dismissal, cleared on success/reload | B; prior fix retained |
| `/waitlist` | Plain form with required consent and privacy explanation | Native validation and endpoint error path; modal draft behavior does not imply persistence for this separate HTML form | B static; S submission |
| `/waitlist-sent` | Request received, email confirmation still needed; preparation checklist and return link | Does not claim confirmed delivery or registration; check spam/try later | B static |
| `/waitlist-privacy` | Explains collected details, retention and leaving | Explicitly a draft awaiting counsel; not approved by this pass | B |
| Sign-in, `/invite`, email code, recovery codes | Passkey sign-in or invited signup; clear code and recovery-code steps | Signup/sign-in state and selected name retained; account recovery available | B for invite journey; S for all recovery variants |
| Account, passkeys | Signed-in identity, credentials, connected apps, export/closure and sign-out | Notices explain failures; adding credentials requires existing passkey | S |
| Recover account, recovery hold | Distinguishes saved recovery code from email-only waiting path | Explains waiting periods, holds and cancellation; does not promise instant recovery | S |
| Export/close account | Export excludes secret values; closure explains effects and pending-operation blockers | Preparation status and passkey approval; destructive action stays explicit | S |
| Checkout/contact | Review quote/terms, enter registrant details, then secure payment | Quote expiry/load failure offers refresh; session interruption retains contact draft | S; no payment attempted |
| `/checkout/return` | Distinguishes payment/registration progress from confirmed ownership | Refresh error does not claim failure; explicit retry/sign-in | S |
| `/checkout/cancelled`, checkout resume | Explains unfinished payment; resume same attempt or choose another name | Existing idempotent resume; expired order can be checked again | S |
| Ledger | Charges, refunds and renewals with amounts/statuses | Refund explicitly warns of domain deletion; generic load message lacks inline retry | S |
| Domain overview/checklist | Domain identity/state, contact verification, connection and renewal next steps | Checklist currently equates recorded DNS work/external nameservers with connection; see recommendation below | S |
| DNS, history, nameservers, DNSSEC | Current records, where DNS is hosted, sensitive changes, restore history | Warns when hosted elsewhere; passkey/rollback controls explain consequences | S |
| Connect recipes | Hosting/mail/database recipes, proposed changes and provider prerequisites | Sensitive changes need passkey; provider failures and stale records explained | S |
| Connect presets and verification (new on main) | Preset → plan → approval/apply → DNS verification | Feature flags default off; capability not equivalent to deployment readiness; verification shown separately from overview checklist | S, plus local unit tests |
| Domain Connect consent (new on main) | Provider/service request, proposed record changes, confirm/cancel | Sign-in/approval errors explained; no provider redirects followed in this pass | S |
| Nest/reveal | Environment-scoped secret names, encrypted values, CLI usage | Passkey before reveal; timed re-hide; no real secret read in this pass | S |
| Gate/transfer code | Lock state, whether transfer is possible, code and transfer timing | Specific blockers and hostile-transfer stop; initial load error has no inline retry | S |
| Transfer in (Rescue) | Bring an owned domain, auth code, cost/time expectations | States registry confirmation may take days; no transfer attempted | S |
| Public card controls | Publish/unpublish a creature; indexability is explicit | Ineligible state is generic; no publication attempted | S |
| Connected apps, tokens, waiting approvals | Configure assistant access, inspect actions, approve/reject requests | Pause/revoke and passkey controls; scopes/costs described | S |
| `/device` and OAuth consent | Approve a sign-in or app connection deliberately started elsewhere | Shows verified vs app-reported facts; sign-in/passkey/deny paths | S |
| `/how-it-works` | Explains the domain/creature proposition, today's preview and next action | Separates exploration from invite-only purchase and external hosting | B |
| `/assistants` | Concrete setup instructions and example requests | Instructions alone do not prove current external assistant authentication; no assistant service called | B |
| `/fees`, `/commitments` | Dated prices, renewals, commitments | Draft labels remain; price values unchanged and not externally reverified | B |
| `/report`, `/security` | Purpose, contact destination and what information to provide | No report/email submitted; delivery not verified | B |
| `/legal/` | Document index and draft state | “Sells nothing yet” conflicts with later repository records of invite-only live sales; owner/counsel must reconcile before release | B; retained unchanged |
| Terms, privacy, registration agreement, auto-renew authorisation | Named document and draft status; read before consent | Drafts/placeholder content is a release gate, not completed legal review | B |
| Acceptable use, abuse/DMCA, legal process, refunds | Policy scope and draft state | Some pages describe what they will cover rather than final policy; requires owner/counsel | B |
| Registrant rights, accessibility, cookies | Rights, accessibility limits and storage information | Main's analytics/cookie changes preserved; no legal edits | B |
| `.ai` and `.io` addenda | Extension-specific terms and limitations | Explicit preview draft notices; unchanged | B |
| 404 and 500 | Missing page or server error; return, retry/status/support | 500's broad “domains and payments are not affected” statement is source copy, not independently established during an incident | B |
| Hatchkind gallery, card, about and missing-card pages | Script-free public creature presentation; report links and sample-build labels | Publishing requires explicit eligibility/approval; no public card host contacted | S (`apps/cards/src/render.ts`) |

Source-only rows remain review/verification work. This ledger is not an assertion that every authenticated failure state or external integration passed.

## Vision versus implemented capability

The original plan's status table still says no application exists, so it is not a reliable completion ledger. Its phase scopes describe a deterministic living creature for a domain, secure domain operations, a Nest for secrets, agent-assisted operations and public cards. Source and later handoffs implement substantial portions of that vision: procedural traits/portraits, state derivation, signup and checkout, DNS/transfer/renewal controls, encrypted secrets, passkey approvals, CLI/MCP surfaces and card generation. This is more than a decorative shell.

Main additionally implements reviewed Domain Connect plans, presets, DNS verification and an AI proposal port. The latter is not proof of a usable model integration: `packages/api/src/connect/propose.ts` requires an injected `connectModel`; the repository injects it in tests, not in `boot.ts`, and feature flags default off. No paid model/provider calls were made here.

**One high-value follow-on: a goal-based, verified domain setup journey.** Let an owner choose “website” or “email,” carry that goal into the existing Connect recipe/preset, and return to Overview with the exact pending, verified or failed DNS state and a concrete next action. `DomainChecklist.tsx` currently sets connection completion from `connected_at` or external nameservers and sends the user to DNS; `ConnectPresets.tsx` already polls `verify_state`, backed by `packages/api/src/connect/verify.ts`. Joining these existing pieces would close a real capability gap between buying a name and knowing that its intended setup works. Use verified DNS evidence for DNS completion; never label a website/email service working unless that separate outcome is actually checked. Do not bypass approvals, invent provider success or build another generic checklist. This recommendation is not implemented by this patch.

## Evidence and release boundaries

Evidence root: `/workspace/mosshatch-first-value/`. `before.log` reproduces missing guidance and misleading results on the original candidate. `after.log` covers the changed journey and retained draft at desktop/mobile. Screenshots include opening, pending, failed and recovered results. `page-audit/` contains the 25-page inventories and screenshots; `page-audit.log` records the supplementary audit. `integration-*.log` records checks against fetched main plus the local patches. `invite-browser.log` records the additional ideas/invite journeys.

The candidate passes 104 targeted tests, four desktop/mobile browser cases, workspace typecheck, production build and the 155-ID security check. The combined snapshot passes typecheck/build, 151 targeted tests, 16 journey/browser scenarios and two supplementary public-page audit runs. Initial JS is 109.8 kB gzip on the candidate, 110.9 kB on the combined snapshot: the latter exceeds the 110 kB soft target but passes the 130 kB hard limit. Treat that as an integration follow-up, not a claim that all budgets have headroom. Full repository/CI suites, real devices/Safari and live providers are not certified by these local runs.

Integration must apply the waitlist commit and this UX commit onto current main, rather than merge the older candidate history wholesale. Re-fetch and check for newer changes first; the clean application here is proven only against `e821115`. Run required CI and review the intended six-file cumulative diff. Publishing a branch/PR, merging and deploying require separate authorization. No feature flags, provider keys or live purchase gates should be changed by integrating these UX patches.

Legal drafts, remaining live lifecycle/transfer rehearsals, mail delivery, payment/tax configuration and broader operational readiness remain separate release gates. No hosted DB, production application, paid provider, customer data, external message or transaction was accessed or created in this pass.
