# Phase 3 report: my domains

Status: built and tested against a real PostgreSQL 16, with the web app on real data. **No OpenSRS or Horizon response has ever been seen**: there are no credentials. Every registrar statement below is about `MockRegistrarPort` (the `mock:opensrs` profile) or the OpenSRS adapter run against hand-written fixtures labelled `source: "documented"`. Stripe, Resend and AWS KMS were never called either; Stripe claims are about the port and FakeStripe at the pinned API version `2026-08-26.dahlia`.

## What shipped

- **Registrar module** (`packages/registrar`, `packages/api/src/registrar-rpc`; no migration): `RegistrarPort` extended (lock, nameservers, one-time transfer codes that are never stored or read back, replace-all DNS correct under whole-zone and per-type overwrite, DS records, contact changes that report an ICANN trade, transfers away, Stop, auto-renew and `let_expire`, inventory, redemption and restore, balance). `MockRegistrarPort` models each with fault injection and an out-of-band simulator for the detector. The OpenSRS adapter speaks the XML envelope with MD5 signing through an allow-list of commands, a velocity fuse and a kill switch; it runs the shared contract suite against the fake Horizon transport. The signed RPC (`web` to `registrar`) checks HMAC, time window, single-use nonce and a command allow-list; `web` never holds the reseller key.
- **Domains core** (`packages/api/src/domains`, 0550): state derived from adapter data; sync; renewal terms and orders (charge at E-10, before the registrar); the notice ledger (E-43, E-32, C-8 = E-18, E-7, E+1, E+7/21/35, price changes); opt-in mandates signed with a passkey; decline ladder C, C+3, C+6; upstream retries every 15 minutes for 24 hours then hourly to E-1, then refund; the sell gate and balance job; reconciliation and the unattributed-change detector; nightly posture; release with the 30-day hold; refunds with per-TLD windows and the cap; the dispute overlay.
- **Domain management** (`packages/api/src/domain-mgmt`, 0650): unlock, transfer code and re-lock behind step-up; 24-hour code re-randomise; `transfer.poll` with needs-attention and Stop; nameserver and DS changes (DS blocks a move to unsigned DNS); contact changes with Change of Registrant, the 60-day lock and verification; registrant verification with day-10 reminder and day-15 hold; DNS with per-domain lock, sensitive-record classification, snapshots and rollback; the dispute lock.
- **Web** (`apps/web/src`): the Grove and Ledger on real data; the domain panel (Overview and DNS tabs), transfer code shown once, Stop, DNSSEC, nameservers, contact change, registrant verification, Renew now, refund.
- **Phase 3 finish (this pass, migration 0700)**:
  - `bootFromEnv` installs the domains services (`installDomainsFromEnv`) and chooses the registrar from `MH_REGISTRAR_MODE`: the mock, or the signed RPC client (a sandbox or live process without `REGISTRAR_RPC_URL`/`REGISTRAR_RPC_SECRET` answers `registrar_rpc_not_configured`, never the mock). A boot test calls every job and route registrar in the source after boot and fails if any job kind, schedule or dead-letter default appears that boot did not install.
  - Saved cards (C-31, C-38): the checkout auto-renew box (unticked, separate from the terms, with its own authorisation hash) is the only thing that sends `setup_future_usage=off_session`; only such a card is ever charged off-session; a card saved for an order that ended without a name is detached (`card.detach_sweep`). Renew now with no saved card, or when the bank wants authentication, opens a hosted Checkout for the same renewal order (automatic capture; the registrar is called only after the payment); the return page reconciles it without waiting for the webhook, and ticking the authorisation first lets that Checkout save the card for auto-renew (the only way to save one after a purchase without the box). `payment_method.automatically_updated` records the update and emails the person with the one-click turn-off link; a new card brand needs a fresh passkey signature before any charge.
  - Mandate rules: an automatic charge waits until a pre-charge notice for that charge is at least 7 days old (Visa; the C-8 notice gives 8); a mandate above its price cap or needing re-consent can be signed again without turning it off first; every email about an automatic charge must carry the turn-off link (the template schema refuses one without it); the renewal receipt carries the authorisation terms and the link.
  - Registrant verification starts at registration (C-16): the 15-day clock is created in the same transaction as the domain row. It was built but never started.
  - Public pages under the strict CSP: `/fees.html` (prices, late renewal, restore, refund windows, announced price changes, the notice schedule, the deletion timeline, auto-renew, `.ai` and `.io` rules, the planned registrar of record and the complaints path) and `/commitments.html` rewritten for live sales (who sees a search, no registration on search, no bulk RDAP). A test holds every price and date on the fee page to the price table and the notice code.
  - `.ai` and `.io` registry terms (`/legal/tld-addendum-ai.html`, `/legal/tld-addendum-io.html`) are versioned documents accepted at checkout and stored as `tld_addendum` consents; an order without them is refused.
  - Fixed: `buildQuote` refused a `.ai` restore (the 2-year minimum was applied to a restore); the release test fixture updated to the real vault and cards tables.

## Measured

| Item | Result |
|---|---|
| Unit and database tests (`npx vitest run`, whole repo, 2026-09-30 15:50 UTC) | 959 passed, 44 skipped, 4 failed; all 4 in modules other agents are still building (`bindings`, `ops/kms-reconcile`). Phase 3 suites: 478 passed, 44 skipped, 0 failed |
| Initial JS / engine chunk / domain panel | 86.9 kB / 149.1 kB (unchanged) / 9.2 kB gzip (limits 130 / 150 / lazy) |
| New Phase 3 finish tests | `domains/cards.test.ts` 15, `domains/fees-page.test.ts` 7, `boot.test.ts` +3; browser: domain management, refund, fee page and addenda |
| Playwright | account 4/4, prod 12/12 (including the fee page and addenda, axe at desktop and phone), public, dev and cards passing; the `publish` project (another agent's, in progress) failed in the last all-projects run |

## Exit criteria

| Criterion | State |
|---|---|
| Shared adapter contract suite passes against `MockRegistrar` and Horizon, real responses recorded and replayed in CI | Half met. Passes against the mock and against the fake Horizon transport with documented fixtures. **No Horizon response was ever recorded**: no credentials exist |
| Every creature state reachable from adapter fixtures | Met against the mock (`domains/state.ts`, sync tests) |
| Renewal notices at E-43, E-32, C-8 and E+1 sent from the jobs table in staging | Met on a simulated clock against real PostgreSQL (`domains/notices.test.ts`); not run in a staging deployment |
| Detector fires within its cadence on a simulated change | Met against the mock's out-of-band simulator (ST-114) |
| OpenSRS key rotation drill rehearsed against Horizon | **Owed.** Rehearsed only against the fake transport (ST-116); runbook written |
| Cross-tenant matrix re-runs on the domain routes | Met (`security/matrix.test.ts` passes over every route, including the Phase 3 finish routes) |

| ST | Test |
|---|---|
| ST-22 | `registrar/src/opensrs/st22.test.ts`, `api/src/domain-mgmt/security.test.ts` |
| ST-60 | `api/src/domains/detector.test.ts` |
| ST-94, ST-95, ST-96 | `api/src/domains/release.test.ts` |
| ST-101, ST-110 | `api/src/domains/renewals.test.ts` |
| ST-102 | `api/src/domains/disputes.test.ts` |
| ST-107 | `registrar/src/opensrs/opensrs.test.ts`, `registrar/src/contract.test.ts` |
| ST-108, ST-109 | `api/src/domains/gate.test.ts` |
| ST-113 | `api/src/domains/posture.test.ts`, `api/src/boot.test.ts` (probe installed by boot) |
| ST-114 | `api/src/domains/detector.test.ts` |
| ST-115 | `registrar/src/opensrs/opensrs.test.ts`, `api/src/domain-mgmt/security.test.ts` |
| ST-116 | `registrar/src/opensrs/opensrs.test.ts` (fake transport only; the Horizon drill is owed) |
| ST-117, ST-118 | `api/src/registrar-rpc/registrar-rpc.test.ts`, `api/src/boot.test.ts` (no mock fallback) |
| ST-119 | **Owed**: manual checklist (provider 2FA, recovery email, incident contact, written answers). No provider account exists |
| ST-120, ST-122, ST-123 | `api/src/domain-mgmt/security.test.ts`; browser: `e2e/account.spec.ts` (code shown once, re-hidden, axe on the code box) |
| ST-121 | `api/src/domain-mgmt/management.test.ts`; browser: contact change |
| ST-125, ST-148 | `api/src/domain-mgmt/transfer.test.ts`; browser: Stop through the mock's transfer-away simulator |
| ST-127, ST-128 | `api/src/domain-mgmt/dns.test.ts`; browser: DNS add and roll back |
| ST-91 re-run | `api/src/security/matrix.test.ts` (domain routes covered; see above) |

## Compliance rows for this phase

Built means code and tests exist. Text owed means the words are drafts awaiting counsel.

| Row | State |
|---|---|
| C-03 lock and code | Built: self-service unlock and one-time code; `.io` codes by the registrar's support with a 5-day promise and a ticket |
| C-07 Change of Registrant | Built: warns first, both parties approve, 60-day lock, verification restarts |
| C-13 registrar of record | Built on `/fees.html`, `/commitments.html` and the checkout link, stated as "planned" because the OpenSRS agreement is unsigned. The legal-document agent's `legal/registrant-rights.html` does not name it yet |
| C-16 registrant verification | Built; started at registration from this pass. The OpenSRS verification-status events and the sender of record are unverified |
| C-20 DS records | Built (add, remove, block NS to unsigned). IPv6 glue not offered; the OpenSRS DNSSEC fee conflict is unanswered, so DNSSEC is not advertised |
| C-23 dispute lock | Built |
| C-26 ERRP notices | Built and published on `/fees.html`; Q5 (notices for auto-renewed names) open, so both are sent |
| C-27 fee page | Built (`/fees.html`), linked from checkout and the search note. The legal-document agent's `legal/fees.html` is a placeholder and does not link it yet; the registration agreement link is owed to that page's owner |
| C-28 deletion and auto-renew policy | Built on `/fees.html` (day 41 to 45 range). The 45-day deletion after account closure is stated but account closure itself is Phase 4 |
| C-29 refund windows | Built (policy table, cap, renewal refund deletes after confirmation); browser refund test |
| C-30 renew only after payment | Built, including the Checkout path |
| C-31 consent | Built: unticked box beside the price, own text hash, passkey mandate, `setup_future_usage` only when ticked, card detached when the order ends. Text owed |
| C-32 notice windows | Built: E-43, E-32, C-8, E+1, and the 7-day minimum before a charge |
| C-33 price cap and changes | Built: cap, hold, re-sign without turning off, 21-day reminder, receipt with terms and cancel link |
| C-34 one-click cancel | Built: dashboard, agent capability, and every automatic-charge email (enforced by the template schema) |
| C-38 Visa stored credential | Built: separate consent panel, C-8 notice, decline ladder, card updater, authentication_required back on-session |
| C-53 search notice | Built: search note and commitments page state what happens when sales are on. Counsel wording owed (Q14) |
| C-55 accessibility | axe WCAG 2.2 AA clean on every new view in the browser tests. Manual keyboard and screen-reader passes owed |
| C-59 `.ai` | Built: 2-year minimum in quote and checkout, addendum accepted per order, no refund. Launch still gated on a real OpenSRS test |
| C-60 `.io` | Built: registry terms and sovereignty note accepted per order, no refund, DNSSEC unsupported. Nameserver-count validation relies on the existing two-nameserver rule |
| C-61 premium | Built: price guard and search show premium as not sold |
| C-62 RDAP | Met by design: no RDAP client exists (a test checks the source); availability comes from the registrar's check with per-address and daily limits. The daily ceiling with OpenSRS is unagreed (Q1) |

No row is deferred. Rows that still need counsel text or an upstream answer are marked above.

## Not proven, and why

- **OpenSRS / Horizon: no response ever seen.** Items marked UNVERIFIED in `packages/registrar/src`: the `domain_auth_info` accepted format (`authcode.ts`); the OPS XML element names (`opensrs/xml.ts`); the `registry_*` date format; whether `LOOKUP` carries `is_registry_premium`; whether `GET_PRICE` is per year or per term; owner-contact attribute names and whether admin, billing and tech are optional; order-id attribute names; 480 versus 404 for a deleted name; `reg_username` (the claim rule depends on it); phone normalisation; `balance`/`hold_balance`; `op_type`/`assign_ns`; the `GET_DNSSEC_INFO` command and the DS write shape; `MODIFY data=contact_info`; `GET_TRANSFERS_AWAY` field names; whether `auto_renew=0` with `let_expire=0` is valid; every `CHECK_TRANSFER` field and reason mapping; `GET_DOMAINS_BY_EXPIREDATE` paging; the expiry after a restore (mock); the 14 allow-list entries marked action-only and one unverified command; whole-zone versus per-type DNS overwrite.
- **Stripe**: `setup_future_usage` in Checkout, the attach-on-authorisation timing, the error for an unattached card off-session (the fake uses `payment_method_not_attached`), `payment_method.automatically_updated` payload shape (`previous_attributes.card`), Checkout for renewals, and cancel-of-authorisation all rest on documentation and FakeStripe. The Phase 3 exit asked for a Stripe sandbox test of authorisation cancel: owed.
- **End-user interface probe**: the web-side probe checks only that the login page redirects; the plan's test-profile login needs a credential only the `registrar` project may hold.
- **Staging**: notices, the detector cadence and the posture job ran on a simulated clock, not a deployed cron.
- **Resend, AWS KMS, Neon**: unchanged from Phase 2; local PostgreSQL only.

## Drills and runbooks owed

| Drill | State |
|---|---|
| OpenSRS key rotation against Horizon (pause, generate, update, redeploy, smoke `GET_BALANCE`, lift) | Owed; `docs/runbooks/registrar-credential-exposure.md` has the steps and an empty drill log |
| Registrar outage | Runbook written: `docs/runbooks/registrar-outage.md` |
| Stop a hostile transfer | Runbook written: `docs/runbooks/stop-hostile-transfer.md`; product path covered by ST-125 and the browser test |
| Stripe sandbox authorisation-cancel check | Owed (no Stripe account) |

## Found while finishing

- Bugs fixed: `.ai` restore could not be priced; registrant verification was never started at registration; a renewal paid on Checkout had no reconcile path without the webhook; the fee page's scrollable table was not keyboard reachable (axe `scrollable-region-focusable`).
- Other agents' work in progress at the time of the last run: `npm run typecheck` fails in `packages/api/src/agents/requests.ts` (2 errors) and 4 tests fail in `bindings` and `ops/kms-reconcile`. None of them is Phase 3 code. The boot completeness test will fail again if a later module registers a job without wiring it into `bootFromEnv`, which is its purpose.

## Decisions needed

1. OpenSRS activation, Horizon credentials and the written answers in PLAN 4.1, so the adapter can be recorded against real responses and the rotation drill run.
2. A Stripe test-mode key for the saved-card and renewal Checkout paths.
3. Counsel: the auto-renew authorisation text, the fee page and the `.ai`/`.io` addenda.
