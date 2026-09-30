# Phase 2 report: accounts and money

Status: backend built and tested against a real PostgreSQL 16; the web app has the sign-up, passkey, contact, acceptance and Checkout screens. Waiting for your "go" before Phase 3. Stripe, Resend, AWS KMS and OpenSRS were never called: every claim about them below is about the port and a faithful fake.

## What shipped
- **Schema** (`packages/db/migrations`, 0001 to 0400): about 45 tables, per-user row-level security (forced, fails closed), an append-only audit log (triggers refuse update, delete and truncate even for the owner), definer functions for the few pre-sign-in lookups, and a migrator plus per-test isolated databases.
- **Auth** (`packages/api/src/auth`): emailed-code sign-up, passkey registration and login (ES256 and RS256 only, user verification required, backup-eligible bits tracked, hardened mode), sessions (`__Host-` cookie, 15-minute idle and 8-hour absolute limits, revoke-all), recovery codes, both recovery paths with holds, notification addresses, protective email links (GET shows, POST acts), freeze.
- **Step-up** (`stepup`): prepare and commit for the 13 action ids with a 120-second single-use challenge bound to the parameters; the gate; full assertion evidence stored on every committed action.
- **Registrar and pricing**: `MockRegistrarPort` with the OpenSRS profile and 11 fault modes, a reusable contract suite, effective-dated wholesale prices, the D-003 fee bands (the plan's first-order prices reproduce exactly), search and quote routes with a shared lookup budget, the mode guard, sanctions screening and velocity limits.
- **Orders and payments** (`orders`, `stripe`): authorize, register, then capture; every state and guard in the plan; write-ahead operations so one register is sent however many workers race; outcome-unknown reconciliation; the capture-failed ladder; verified webhooks with a two-secret roll; a faithful fake Stripe.
- **Jobs and operations** (`jobs`, `ops`, `mail`, `support`): claim/lease engine with priorities, heartbeat and dead-man's switch, audit anchoring and verification, restore drill, external DNS and expiry checks, email transport and the SPF/DKIM/DMARC gate, metadata-only support tooling, runbooks and the erasure design.
- **Cross-cutting checks** (`security`): the cross-tenant matrix generated from the route table, the same matrix with RLS switched off, direct-SQL RLS checks on every tenant table, principal walks, and the canary walk.
- **Web app**: sign-up with a passkey, sign-in, recovery codes shown once, registrant contact form, explicit acceptance of the two documents (not pre-checked), pay on Stripe, an order page that reconciles and hatches the creature only after the name is registered. Without a connected backend the app stays the Phase 1 practice place.

## Measured
| Item | Result |
|---|---|
| Unit and database tests | 450 passing, 1 skipped (a sandbox-only registrar test) |
| End-to-end (Playwright) | prod 10, dev 9, account flow 1 |
| Initial JS / scene chunk | 78.1 kB / 149.1 kB gzip (limits 130 / 150) |
| ST-105, 10,000 queued jobs | `order.fulfil` claimed in under 500 ms behind the backlog |
| ST-134 | 10,000 labels from 200 addresses stay inside the lookup budget; all 300 checkout checks succeed |
| Race tests | ST-103 and the capture race ran 40+ times without a failure after one real bug was fixed (below) |

## A real bug the stress runs found
Two workers could both send a capture when one had read the PaymentIntent just before the other finished. Stripe rejects the second call, but the ledger got a second operation and the order could flip to `capture_failed` and page. Fixed: a succeeded capture is never repeated and the order row is locked and re-checked before a capture operation opens.

## Exit criteria
| Criterion | State |
|---|---|
| Order machine tests (duplicate and out-of-order webhooks, timeout, two workers, two customers, quote change, authorization window) | Met against FakeStripe and MockRegistrarPort |
| Price shown equals amount charged | Met (tests and the account flow) |
| Restore drill recorded | Run locally with real `pg_dump`/`pg_restore` (synthetic; no Neon branch, no bucket); a line is in `docs/runbooks/restore-drill-log.md`. The 4-hour/8-hour targets are unproven on Neon |
| Webhook-secret roll drill | Code and test for two secrets and the overlap; the staging drill is owed |
| ST-16, 41-59, 67, 91-93, 97-100, 103-106, 111, 112, 132, 134, 135, 137, 138, 142-144, 146, 147, 149-152, 155 | Each has a named test that passes. Three rest on things I could not touch: ST-111/112 use a fake resolver and stored expectations (live DNS and who owns the two domains are unverifiable from here), ST-138 monitors a local tick, ST-152 is a synthetic local restore |
| Cross-tenant matrix over every route | Met (generated; a mutation test confirmed it fails when an ownership filter is removed) |

## Compliance rows for this phase
Built means code and tests exist; Text owed means the mechanism works but the words are a draft awaiting counsel.

| Row | State |
|---|---|
| C-01 transfer-policy profile | `tld_policy` seeded; transfer behaviour arrives in Phases 3 and 5 |
| C-12, C-14 assent | Built: explicit acceptance of the two documents by hash, stored per order with retention 7 years (my assumption). Text owed: both documents are draft placeholders |
| C-13 registrar-of-record footer | Not built (the page footer and support page). Phase 6 also lists it |
| C-15 contact form | Built: RDP fields, phone required, registrant email must be a verified address |
| C-18 no privacy product | Met by design; the sentence is in the agreement draft |
| C-19 retention | `retain_until` and `legal_hold` columns exist; the purge job is the ledger half only |
| C-25 sanctions | Mechanism built with a fixture list. No real OFAC list is loaded |
| C-27 fee page | Not built as a page. The price breakdown shows at checkout |
| C-28, C-29 deletion and refund windows | Not built in copy; the refund cap and windows are in the machine |
| C-30 renew only after payment | The order machine charges before any upstream call; renewals themselves are Phase 3 |
| C-36 price disclosure | Year-1 and renewal price shown at equal size; the "then $Y on [date]" line is owed |
| C-37 SAQ A | Met by design (redirect to Stripe, strict CSP, no card fields); the annual attestation is yours |
| C-39, C-40 Stripe application, VAMP | Owed: the application text and the dispute-rate alarm at 0.5% are not built |
| C-41 authorize, register, capture | Built and tested; the counsel question on RAA 3.7.4 is open |
| C-42, C-43, C-44 tax | `tax_regions` and `sales_ledger` tables exist; the server-side gate, non-US block and ledger job are not built |
| C-45 resale certificate | Counsel (P0) |
| C-48, C-49 GDPR, DPAs | Counsel and paperwork; not code |
| C-50 PII encryption | Built for contacts and registrar-profile passwords (per-field envelopes, own KMS key in production). The separate database role (`mh_contacts`) exists but the contacts still go through the runtime role |
| C-55 accessibility | axe WCAG 2.2 AA in every flow; manual keyboard and screen-reader passes owed |
| C-57, C-58 registry addenda | Text owed; HTTPS note at checkout for .dev and .app not built |
| C-61 premium not sold | Built (price guard refuses premium) |
| C-63 price table | Built |
| C-72 document set | 2 of 14 exist as drafts with version hashes |

Rows not built or only partly built need your written approval to defer. My recommendation: approve deferring C-13, C-27, C-28, C-29, C-36's date line, C-39, C-40, C-42 to C-44 and the rest of C-72 to Phase 3 and Phase 6, because they need either counsel text or live data, and build the tax gate (C-42) before any live sale.

## Not proven, and why
- Stripe (Checkout, PaymentIntent cancel of a Checkout-created intent, capture windows, cached-500 replay, Tax): fake only.
- Resend delivery, SPF/DKIM/DMARC on the real sending domain: fake only.
- AWS KMS HMAC and PII keys, the write-once anchor bucket, CloudTrail: not built. **Production refuses to boot** until they exist.
- OpenSRS: never called. Prices are the plan's numbers; `GET_PRICE`, ICANN-fee inclusion and `.ai` at 2 x 111 are unverified.
- Real browsers' WebAuthn beyond Chromium's virtual authenticator.
- A Neon database: everything ran on local PostgreSQL 16.

## Decisions needed
1. Approve or veto the deferrals above.
2. Connect accounts: create a Neon project, a Stripe test-mode key and webhook secret, and a Resend key, and set them on the Vercel project. Until then the deployed preview stays a practice place. Say which of those you want me to set up with the tools connected here (Neon, Stripe and Resend are available), and I will ask before creating anything.
3. Counsel: the two document drafts and the RAA 3.7.4 question.
