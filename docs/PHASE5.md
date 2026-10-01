# Phase 5 report: transfers and agents

Status: built and tested in process against a real PostgreSQL 16 (local, Node 22.22.2), with the Rescue, Gate, Visitors, approval card and connected-app consent screens in the web app. **No transfer has ever reached a registrar**: there are no OpenSRS credentials, and Horizon cannot run transfers anyway, so every transfer statement below is about `MockRegistrarPort` and the OpenSRS adapter code that has never met a response. Stripe (test or live), GitHub secret scanning and every real MCP or OAuth client were never called or connected; payments ran against FakeStripe, and the MCP and OAuth tests are our own client. You waived the phase gates on 2026-09-30 (D-050); nothing that ran only against a fake is called verified here.

A third round of review fixes landed after this report was first written, followed by two race fixes; "Round 3 fixes" below lists them with their tests and the counts measured after them. Everywhere else, the test counts and findings describe the tree at commit `ce79de0`.

## What shipped

- **Rescue, transfer in** (`packages/api/src/transfers`, migration 0900; `apps/web/src/ui/Rescue.tsx`): the pre-transfer check runs cheapest first (already here, a live transfer of the name, the registrar's own check, the ten-year cap, then DNSSEC) and each refusal carries a plain sentence and, for the 60-day rules, the date they lift. Sanctions screening and velocity limits apply (a new account may start 5 transfers a day, own target). The registrant email confirms the transfer before any payment (`POST /api/v1/transfers/:id/confirm`; a 30-minute code, 5 tries; an unconfirmed transfer expires after a day and its code is wiped). Checkout authorises and never saves the card. The authorization code exists only for the one registrar call: the operation moves from intent to sent in the same transaction that wipes the stored code. Upstream status is read every 5 minutes. **The transfer shows complete only when the adapter reports `completed` and the name reads back as ours**, and the payment is captured after that, or 48 hours before the card hold ends if the transfer is still pending, and refunded in full if the transfer then fails (D-039). Cancel works before confirmation and while pending upstream (`CANCEL_TRANSFER` first, then the hold), and never after completion. Timing copy follows D-037.
- **The Gate, transfer out** (`transfers/gate.ts`, `GET /api/v1/domains/:id/gate`; `apps/web/src/ui/GateTab.tsx`): unlock and code issue behind step-up, approval at the gaining side by the provider's email, detection through the transfer poll, and release of the domain (cause `transferred_out`) only once the adapter no longer shows it. The 60-day rules block with their lift dates; a payment dispute or an account under review never blocks unlock or code release; `.io` codes come from registrar support with a 5-day due date. The operator's denial function (`denyTransferAway`) accepts only Transfer Policy reasons, never non-payment, opens the ticket for Tucows and emails the reason; it has no route or screen.
- **Two workers on one transfer**: every transfer and order state write is conditional on the state its worker read; a write that touches no row loses and rolls back (`transfers/driver.ts`).
- **Agent requests and approvals** (`packages/api/src/agents`, migration 0950): `register.propose` and `renew.propose` create a pending request with a closed, typed parameter set and a reservation against the binding's spend cap, kept by database triggers; 3 pending per binding, 10 per user, 5 an hour per binding and 30 a day per user; expiry after 72 hours, never after the binding. Approval is the `agent.purchase.approve` passkey step-up bound to the request's parameters, quote hash and terms hash, with typed confirmation above a threshold, on a binding's first approval and for a new extension, and `frame-ancestors 'none'` on the approval route. Approval creates an order in `checkout_open` and charges nothing; the Checkout URL goes only to the approving session; Pay now re-checks the signed quote and terms. The agent sees `approved_awaiting_payment`, `payment_authorized`, `registering`, `registered`, never "paid" before "registered". Capture moves the reservation to spent (D-045). A kill switch (`agent_purchases_paused`) stops proposals, approvals and orders.
- **Agent DNS** (`agents/dns.ts`): an agent write of a sensitive record becomes a pending approval (`dns.sensitive.approve`) that applies exactly the signed zone; a plain record applies at once.
- **REST for agents** (`/api/v1/agent/*`, bearer only): domains, DNS, Nest names, secret read and write, transfer status, proposals and scope requests. Agents cannot start, confirm or cancel a transfer (D-046).
- **MCP** (`packages/api/src/mcp`, `POST /mcp`): an in-repo stateless JSON-RPC 2.0 handler targeting the 2026-07-28 revision, answering 2025-era clients per request (D-041). The Origin allow-list and the token check run before any method; tools are listed by the binding's scopes; `secrets_get` is never marked read-only; tool descriptions are static and hostile strings in results are cleaned and framed as data; scope-denied bursts are audited and alert; a burst of bad tokens raises an alarm without denying a valid token.
- **OAuth authorization server for MCP** (`packages/api/src/oauth`): RFC 8414 and RFC 9728 metadata, Client ID Metadata Documents with dynamic client registration as the fallback, PKCE S256 only, a consent screen approved with the `agent.token.create` passkey, short access tokens bound to a binding, rotating refresh tokens (reuse revokes the family), revocation, `iss` in responses (RFC 9207). Errors follow RFC 6749 (D-042). The metadata fetcher has an SSRF guard that checks the address it connects to, a size limit, a timeout and per-URL and per-host fetch limits.
- **Secret-scanning receiver** (`agents/scanning.ts`, `POST /api/v1/hooks/github-secret-scanning`): verifies GitHub's ECDSA signature, revokes a reported token once, emails the owner once and answers with hashes only.
- **Visitors** (`agents/visitors.ts`, `agents/sendhome.ts`; `apps/web/src/ui/Visitors.tsx`): every binding and connected app with its facts; "Send all visitors home" revokes every binding and declines pending requests in one transaction; the owner sets the amount above which an approval needs the typed domain (default USD 50). The approval card (`ui/ApprovalCard.tsx`) and the consent screen (`ui/OAuthConsent.tsx`).
- **Velocity limits for agents** (C-24): the new-account limits that bind a person's registrations bind an agent's proposals too, and again at order time.

## Measured

| Item | Result |
|---|---|
| Phase 5 unit and database tests (`npx vitest run` on the paths below, 2026-09-30 about 17:47 UTC, code as at commit `ce79de0`) | 96 passed, 0 failed, 0 skipped |
| `packages/api/src/transfers` | 30 (gate 8, guards 8, interleave 2, rescue 9, review 3) |
| `packages/api/src/agents` | 28 (approvals 15, review 6, scanning 2, session 1, walk 4) |
| `packages/api/src/mcp` | 12 (mcp 9, review 3) |
| `packages/api/src/oauth` | 18 (oauth 8, review 10) |
| `apps/web/src/lib/transfers.test.ts` | 8 |
| Transfer race | `transfers/rescue.test.ts` and `transfers/interleave.test.ts` passed 10 runs out of 10 in a row here; the builder reported 20 of 20 |
| Cross-cutting re-runs | `security/matrix.test.ts` 14, `foundation.test.ts` 14: all pass |
| Lazy chunks (`npm run build`) | Rescue 2.9, GateTab 1.5, Visitors 3.7, ApprovalCard 2.3, OAuthConsent 1.8, transfers 2.5, visitors 1.5 kB gzip; initial JS 87.7 kB (limit 130) |
| Playwright | Not run for this report. The Phase 5 browser specs are `e2e/nest-rescue-account.spec.ts` (Rescue through completion, then the Gate's 60-day lock), `e2e/visitors.account.spec.ts` and `e2e/sensitive-screens.account.spec.ts` |

## Exit criteria

| Criterion | State |
|---|---|
| No transfer is shown as complete before the adapter confirms | Met against fakes only (`transfers/rescue.test.ts` "authorize, submit, pending, then completed only when the registrar reports it and the name reads back as ours"; `apps/web/src/lib/transfers.test.ts` "only state 'completed' with completed=true reads as moved"). The adapter is `MockRegistrarPort` |
| ST-34, ST-35, ST-61, ST-68, ST-73 to ST-84, ST-124, ST-126, ST-131, ST-133, ST-136 pass | Met against fakes only: all 21 have a named passing test, against `MockRegistrarPort`, FakeStripe, test-made GitHub keys and our own MCP client. ST-126's DNSSEC refusal depends on a lookup only tests supply (Not proven) |
| A scripted agent session proposes a purchase, waits, is approved with a passkey, is paid by the human on Stripe test-mode Checkout, registers in the sandbox and only then captures | Met against fakes only (`agents/session.test.ts`). It ran against FakeStripe and the mock registrar, not Stripe test mode and not Horizon |
| The cross-tenant matrix re-runs over bindings, approvals and transfers, and the route walk over the MCP and agent routes | Met (`agents/walk.test.ts`, `security/matrix.test.ts`, the cross-tenant test in `transfers/gate.test.ts`) |
| Compliance rows C-01 to C-06, C-08 to C-10, C-23, C-24, C-55 built or deferred in writing | **Not met** (table below; you have approved no deferral) |

## Security tests due in this phase

Paths are relative to `packages/api/src` unless they start with `apps/` or `e2e/`.

| ST | Test | State |
|---|---|---|
| ST-34 | `mcp/mcp.test.ts` "tools/list and secret tools"; `mcp/review.test.ts` "secrets_get returns the stored value exactly" | Passes |
| ST-35 | `mcp/mcp.test.ts` "an agent's write to prod keeps the prior version, emails at once and can be restored" (over MCP and the CLI push route); `bindings/bindings.test.ts`; `recipes/recipes.test.ts` | Passes |
| ST-61 | `agents/approvals.test.ts` "approval races leave one terminal state and at most one order" | Passes |
| ST-68 | `agents/scanning.test.ts` "the secret-scanning receiver revokes a reported token once and emails the owner" (2 tests) | Passes against keys made in the test; GitHub never delivered |
| ST-73 | `agents/approvals.test.ts` "a bearer token cannot approve, exceed its cap or reach /actions/*" | Passes |
| ST-74 | `agents/approvals.test.ts` "concurrent proposals never exceed the cap or the pending limits; lowering the cap keeps what exists"; round 3: `agents/lockorder.test.ts`, `agents/approval-expiry.test.ts`, `agents/order-expiry-race.test.ts` | Passes |
| ST-75 | `agents/approvals.test.ts` "duplicates reserve nothing; reservations return on decline, expiry, void and failure"; `agents/review.test.ts` | Passes |
| ST-76 | `agents/approvals.test.ts` "approval alone charges nothing; no Checkout URL reaches a bearer; a total above the tax ceiling voids" | Passes against FakeStripe |
| ST-77 | `agents/approvals.test.ts` "state order, price rise voids, approval after expiry fails"; `agents/review.test.ts` (Pay now re-check) | Passes against FakeStripe |
| ST-78 | `agents/approvals.test.ts` "hostile names, request text and unknown params never reach the card or email"; `oauth/review.test.ts` (text-direction tricks) | Passes |
| ST-79 | `agents/approvals.test.ts` "one assertion approves one request; a replayed action fails" | Passes |
| ST-80 | `agents/approvals.test.ts` "typed confirmation and frame-ancestors" | Passes |
| ST-81 | `mcp/mcp.test.ts` "tool output is data; descriptions are static" | Passes |
| ST-82 | `mcp/mcp.test.ts` "scope-denied bursts are audited and raise an alert" | Passes |
| ST-83 | `mcp/mcp.test.ts` "authorized by the binding's scopes, never the server's; other audiences refused"; round 3: `oauth/grant-bounds.test.ts` (a `/mcp` grant is refused on every other bearer route) | Passes |
| ST-84 | `mcp/mcp.test.ts` "the Origin allow-list and the token check run before the handler"; `oauth/oauth.test.ts` "no client uses another's consent; an unregistered redirect is never followed"; `oauth/review.test.ts`; `mcp/review.test.ts`; round 3: `oauth/grant-bounds.test.ts` (a consent cannot be redeemed at `POST /bindings`) | Passes |
| ST-124 | `transfers/gate.test.ts` "transfer-out and code issue return 403 step_up_required without a committed action" | Passes |
| ST-126 | `transfers/guards.test.ts` (7 tests); `apps/web/src/lib/transfers.test.ts` "pre-check reasons" | Passes against the mock and a test DNSSEC lookup; see Not proven |
| ST-131 | `mcp/mcp.test.ts` "an agent write of a sensitive record gets a pending approval and no write"; round 3: `agents/dns-write.test.ts`, `agents/dns-decline-race.test.ts` | Passes |
| ST-133 | `agents/approvals.test.ts` "the new-account limits bind a scripted bulk registration by agents"; `agents/review.test.ts` (kill switch) | Passes |
| ST-136 | `mcp/mcp.test.ts` "a burst of bad tokens from the connector range does not deny a valid token"; `mcp/review.test.ts`; `oauth/review.test.ts` | Passes |
| ST-91 re-run | `agents/walk.test.ts` "cross-tenant matrix over bindings, approvals and transfers"; `security/matrix.test.ts`; `transfers/gate.test.ts` | Passes |
| ST-67 re-run | `agents/walk.test.ts` "route walk over the MCP and agent routes"; `foundation.test.ts`; `security/matrix.test.ts` | Passes |
| ST-22 (Phase 3, extended to transfer in) | `transfers/guards.test.ts` "a transfer authorization code canary appears in no job payload, audit row, log, email, error or database column" | Passes |

## Compliance rows for this phase

Built means code and tests exist for the row's "How Mosshatch meets it" cell; Partly built means some of it; Counsel means the row cannot close until counsel answers, and the note says what exists.

| Row | State |
|---|---|
| C-01 transfer-policy profile | Built: `tld_policy` holds add-years, lock days, owner-confirm days, the registry window and the longest seen per extension, and `transfers/policy.ts` reads them; TAC rules are not presented as ICANN law |
| C-02 only the registrant approves | Built; Counsel. Unlock and code issue need the owner's passkey, transfer routes are session only and an agent token cannot start one (`transfers/guards.test.ts`). Approving or declining an outbound transfer happens on OpenSRS's email page, outside Mosshatch. Counsel question 2 and OpenSRS question 11 are open |
| C-03 lock and code | Built: self-service since Phase 3; the Gate shows an `.io` support request with its 5-day due date (`transfers/gate.test.ts`) |
| C-04 not more restrictive, never gated on billing | Built; Counsel. Contact and nameserver changes use the same step-up (Phase 3); a dispute or review never blocks unlock or code release (`transfers/gate.test.ts`). Counsel question 2 is open |
| C-05 denial reasons | Partly built: `denyTransferAway` accepts only Transfer Policy reasons, refuses non-payment and emails the reason (`transfers/gate.test.ts`). There is no console screen or route; an operator calls the function |
| C-06 60-day rules and timing | Built: computed from dates and shown with the lift date; the registry window and the longest seen are stored apart; timing copy per D-037 |
| C-08 FOA | Counsel. Inbound: an authenticated registrant-email confirmation is stored before payment (`transfers/guards.test.ts`), and the stage email says when the provider will email the owner (`transfers/rescue.test.ts`). Who sends the Losing FOA is OpenSRS question 11, unanswered |
| C-09 TDRP and TEAC | Partly built: a transfer log of who, when and how (ids and codes) kept 15 months (`transfers/store.ts`). TEAC contacts and response times belong in the OpenSRS contract, which is unsigned; the help text on the registrant route is not written |
| C-10 TAC-style behaviour | Built, with two differences: the code is re-randomised 24 hours after issue (Phase 3), stricter than the row's 14 days; and the notice carries a freeze link, which locks the domain and replaces the code, instead of an invalidate link bound to one code |
| C-23 dispute lock | Built: Phase 3 lock, now part of the state every agent client sees (`agents/walk.test.ts`) |
| C-24 velocity for agents | Built (ST-133; proposal limits per binding and per user; the kill switch) |
| C-55 accessibility | Partly built: axe WCAG 2.2 AA in the Rescue, Visitors and sensitive-screen browser specs (not run for this report). Manual keyboard and screen-reader passes have not been done |

No row is deferred: you have approved no deferral.

## Review findings fixed in this phase's modules

Other agents reviewed these modules adversarially; each finding was reproduced by a failing test before its fix. Tests are in `packages/api/src` unless a path says otherwise.

| Module | Finding | Fix and test |
|---|---|---|
| Transfers | Two workers could write transfer states out of order | Every state write is conditional on the state read; `transfers/interleave.test.ts` runs both orders deterministically |
| Transfers | A transfer whose capture failed was no longer polled, and its pay-link email claimed a registration | Still polled, so a NACK ends it; the email says transfer; `transfers/review.test.ts` |
| Transfers | A transfer that completed while its capture had failed got no domain row or completion email | Both happen at once; `transfers/review.test.ts` |
| Transfers | Cancelling right after paying on Checkout, before the payment was recorded, left the card hold | The hold is released; `transfers/review.test.ts` |
| Orders | The capture-failed ladder could charge any saved card off-session | Only the order's own saved card or a same-domain mandate within its price ceiling, and never for an agent-approved order (D-040) |
| Agents | Pay now after an approval did not re-check the signed quote and terms | It refuses a higher quote or changed terms and releases the reservation; `agents/review.test.ts` |
| Agents | A proposal repeated after its twin expired, before the sweeper ran, returned 500 | It becomes a new pending request with one reservation; `agents/review.test.ts` |
| Agents | The `agent_purchases_paused` kill switch was not read on the agent purchase paths | Proposals, approvals and orders refuse while it is set; `agents/review.test.ts` |
| Auth | Undoing a recovery did not revoke the agent and CLI tokens it had enabled | They are revoked; `auth/recovery.test.ts` "undoing a recovery also revokes agent and CLI tokens it enabled" |
| OAuth | An authorization code presented twice at once could be exchanged twice | One exchange wins and the grant it produced is revoked; `oauth/review.test.ts` |
| OAuth | The metadata fetcher could be pointed at internal addresses by DNS rebinding, read without a size limit, follow redirects and hang | It checks the address it connects to, refuses link-local, site-local and NAT64 IPv6, stops at the size limit, treats a redirect as failure and times out; fetches are limited per URL and per host; `oauth/review.test.ts` |
| OAuth | Rate limits keyed on the address throttled every client in a shared range | The token endpoint keys on address range and credential; the numbers are own targets (Decisions); `oauth/review.test.ts` |
| OAuth | A client-reported name could carry bidi overrides and zero-width characters onto the consent screen | They are stripped; `oauth/review.test.ts` |
| MCP | A JSON-RPC notification (no id, or a null id) could run `tools/call` | A notification runs nothing; `mcp/review.test.ts` |
| MCP | `secrets_get` altered values with carriage returns, zero-width, bidi or decomposed characters | Values round-trip unchanged while other strings are still cleaned; `mcp/review.test.ts` |
| MCP | JWT-shaped bad bearer tokens were not counted toward the bad-token alarm | They are counted; `mcp/review.test.ts` |
| Web | A new token on the Visitors screen could be announced by a live region | Shown once and never inside a live region; `e2e/sensitive-screens.account.spec.ts` (not run for this report) |

The lead reports that the second round, over four modules, fixed 21 findings and refuted 11; I did not check the refutations.

## Round 3 fixes

The third review round landed in commit `c580b74` (2026-09-30, 19:46 UTC). Review of that commit found two races, fixed afterwards in the working tree. For the two races, the agent who fixed them reports that every new test failed before its fix. For the six earlier findings, the commit records only that the deadlock was reproduced before its fix. I did not run any test against the unfixed code; I ran them all after the fixes (counts below). Every test ran against `MockRegistrarPort`, FakeStripe and our own OAuth client; no provider was called. Paths are relative to `packages/api/src`.

| Finding | Fix | Test |
|---|---|---|
| An approved OAuth consent could be redeemed as a plain token at `POST /bindings`. The consent screen signs `agent.token.create`, and `/bindings` accepted that action and minted a bearer token with no client and no audience | `/bindings` refuses an action that carries a route (409 `action_unavailable`) before spending it, so the consent can still be approved at its own route, which issues the grant bound to its client and resource | `oauth/grant-bounds.test.ts` "ST-84 review: an approved OAuth consent cannot be redeemed as a plain token at POST /bindings" |
| An access token minted for `/mcp` was accepted on the REST bearer routes | Audience binding (RFC 8707): the router refuses a token with an `audience` (401 `invalid_token`) on every route whose declared resource differs; migration 0965 returns the audience from the pre-authentication lookup. Bindings-tab and CLI tokens have no audience and are unchanged | `oauth/grant-bounds.test.ts` "ST-83 review (RFC 8707)" (3 tests, one a walk over every route) |
| Revoke-all could deadlock with decline, approval and the reservation-release trigger: revoke-all locked bindings then requests, and the others locked requests then bindings | One lock order everywhere: device grants first, then the user's agent lock, agent requests by id, bindings by id, refresh tokens (`bindings/tokens.ts` `revokeAllBindings`) | `agents/lockorder.test.ts`: 16 rounds of revoke-all racing declines, two approvals and the sweeper; no server error, every request ends in a terminal state, and each binding's reserved amount equals what its approved requests hold |
| A completed recovery left approved device grants and open OAuth consents claimable, so a later device poll or code exchange could mint a token | Completing a recovery denies approved device grants and pending or approved consents, before the bindings are revoked (`auth/recovery.ts`) | `auth/recovery.test.ts` "ST-48 review: completing a recovery denies approved device grants and open OAuth consents, so a later device poll gets no token" |
| An approved purchase whose order was never made (the order path failed after the approval, or nobody pressed Pay now) held its spend-cap reservation forever | An approval now expires 72 hours after it was given (`APPROVAL_TTL_MS`, equal to `REQUEST_TTL_MS`; the plan names no figure, D-054). From then Pay now answers 409 `request_expired`, and the sweeper, 10 minutes later, expires the request (`approval_expired`) and releases the reservation. An approval whose order exists is never expired this way | `agents/approval-expiry.test.ts` (ST-74, ST-75) |
| The agent DNS path did not use the DNS tab's write safety (snapshot and intent committed before the registrar call), so a write whose outcome was unknown could leave no snapshot to roll back to | Agent writes, direct or approved, go through `writeZoneLocked`: the pre-write snapshot and the intent row commit before the registrar is called. An unknown outcome answers 502 `outcome_unknown`, keeps the snapshot (`write_state` `unknown`), is audited as `dns.write_outcome_unknown`, tells the owner the change may have landed, and can be rolled back from the DNS tab; a retry cannot write over it | `agents/dns-write.test.ts` (ST-131, 5 tests) |
| Race, found after `c580b74`: the owner could decline a sensitive DNS change while its approval was writing the zone | In the transaction that commits the pre-write snapshot, the approval takes the user's agent lock, then the request, then the binding, and moves the request from pending to approved before the registrar is called. A decline that lands first wins and nothing is written; a later one gets 409 and the write completes (snapshot applied, request completed). When the registrar's outcome is unknown the request stays `approved` and agents see "approved", not "applied" (the existing test in `agents/dns-write.test.ts` that expected `pending` was updated). A write the registrar refuses now fails the request (`write_refused`), so the agent can propose again | `agents/dns-decline-race.test.ts` (3 tests, one per interleaving, each set up with gates rather than timing); `agents/dns-write.test.ts` |
| Race, found after `c580b74`: Pay now could make an order for an approval the sweeper was expiring at that moment | Pay now re-checks the approval and creates the order while holding the request row lock, which the sweeper also takes, so an expired approval never yields an order and an approval with an order never loses its reservation. Approval expiry now applies to purchases (`register`, `renew`) only; an approved DNS change is never expired by it. Trade-off: Pay now holds one extra database connection while the order is made | `agents/order-expiry-race.test.ts` (2 tests, interleaved with gates) |

The same commit also carried fixes outside this phase's modules: a legal hold on `transfer_log` (migration 0946); Dashboard refunds of renewals reaching the ledger (`domains/dashboard-refund.test.ts`); mandates kept 3 years after the last renewal charge (migration 0670, `domains/mandate-retention.test.ts`, D-055); web fixes named in its commit message (the step-up dialog can no longer run a new request with an older signed action; approval cards sign the scopes shown); CSP violation reporting and account closure, export and erasure (`docs/PHASE4.md`, `docs/PHASE6.md`).

| Item (run 2026-09-30 about 20:11 to 20:13 UTC, working tree with the race fixes) | Result |
|---|---|
| `npx vitest run packages/api/src/agents packages/api/src/security` | 12 files, 55 passed, 0 failed. Agents 40: approvals 15, review 6, dns-write 5, walk 4, dns-decline-race 3, order-expiry-race 2, scanning 2, approval-expiry 1, lockorder 1, session 1. Security 15: matrix 14, vault-canary 1 |
| `packages/api/src/oauth` | 22 passed: grant-bounds 4, oauth 8, review 10 |
| `auth/recovery.test.ts` | 20 passed |
| `packages/api/src/mcp`, `recipes`, `domain-mgmt`, `bindings` | 10 files, 136 passed |
| `npm run typecheck` | Clean |
| Whole unit and database suite | 1186 passing at `c580b74`, as its commit message reports; I did not re-run the whole suite after the race fixes |

None of the six findings is open.

## Deviations from the plan

- **Transfer-in capture** (D-039): captured on adapter-confirmed completion, or 48 hours before the card hold ends while still pending, then refunded in full on failure. D-002 and PLAN 4.3b said capture at submission.
- **Transfer routes** differ from the PLAN 4.5 list (`POST /transfers/in/check`, `POST /transfers/in`, `GET /transfers/{id}`, `DELETE /transfers/{id}`): start is `POST /api/v1/transfers` and runs the pre-check itself (no separate check route); an extra `POST /api/v1/transfers/:id/confirm` takes the registrant-email code before any payment (C-08, ST-126); cancel is `POST /api/v1/transfers/:id/cancel`; the Gate is read at `GET /api/v1/domains/:id/gate`. Transfer out uses the Phase 3 unlock and code routes.
- **MCP without the SDK** (D-041): an in-repo JSON-RPC handler instead of `@modelcontextprotocol/server` 2.x (D-013, D-019).
- **OAuth error bodies** (D-042): RFC 6749 `{"error": "..."}` on the authorization-server endpoints instead of the house `{error:{code}}`.
- **Spend is consumed at capture** (D-045), not moved to spent at approval (PLAN 4.3b).
- **Off-session charges in the capture-failed ladder** (D-040): narrower than "a saved payment method".
- **Routes outside `/api/`**: the OAuth metadata at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource[/mcp]` sit outside `/api/`, where PLAN 4.3b allows only `/mcp`. RFC 8414 and RFC 9728 fix those paths.
- **Agents and transfers** (D-046): agents have no path to start a transfer, as PLAN 4.4 and 4.5 say; they can read transfer status.

## Not proven, and why

- **OpenSRS transfers**: never called. Horizon cannot run a transfer (OpenSRS knowledge base 201000063316). Every response attribute name of `CHECK_TRANSFER`, the transfer-in status and `GET_TRANSFERS_AWAY` is marked UNVERIFIED in `packages/registrar/src/opensrs/adapter.ts`, as is the mapping of `CHECK_TRANSFER` reasons. The first real transfer in either direction is the Phase 6 live rehearsal.
- **DNSSEC before a transfer in**: the check reads a `DnssecLookup` port that only tests supply. No RDAP client is built or installed at boot, so in any deployment the answer is "could not tell", and the transfer proceeds recorded as unchecked. ST-126's refusal of a signed name is proven only with the test lookup.
- **Stripe**: Checkout for agent-approved orders and for transfer holds, early capture near the hold's end and refunds ran against FakeStripe only. The exit criterion's Stripe test-mode run has not happened.
- **MCP clients**: no real client has connected. The 2026-07-28 shapes of `server/discover`, `resultType` and the `ttlMs` and `cacheScope` fields come from the research dossier and are unverified (`mcp/server.ts`). Which clients speak 2026-07-28 (D-019) is still untested.
- **OAuth clients**: no real client has registered, fetched a Client ID Metadata Document or completed a grant.
- **GitHub secret scanning**: not enrolled; the header names, the key document and the response labels follow GitHub's documentation only.
- **Email**: approval, leak, transfer and grant emails went to the fake transport.
- **Residual risk the plan states**: an agent driving a person's signed-in browser is not stopped by any of this.

## Runbooks and drills

| Runbook | Written | Rehearsed |
|---|---|---|
| Account takeover through recovery abuse (`docs/runbooks/account-takeover-recovery-abuse.md`) | Yes | No. The drill on a founder-owned test account in staging is owed (no staging exists) |
| Agent or CLI token leak (`docs/runbooks/agent-token-leak.md`) | Yes | Only in vitest with keys made in the test (ST-68, logged in the runbook); never against GitHub |
| Stop a hostile transfer (`docs/runbooks/stop-hostile-transfer.md`, Phase 3) | Yes | Against the mock's transfer-away simulator only |

## Decisions needed

1. **Stripe account.** A test-mode key and webhook secret so the scripted agent purchase and the transfer-in hold can run on real Stripe test-mode Checkout.
2. **OpenSRS activation** after counsel's review of the MSA, and the written answers in PLAN 4.1, question 11 above all (outbound approve or decline, who sends the Losing FOA, `.io` codes). Transfers stay unproven until the Phase 6 live rehearsal.
3. **Rate limits for the OAuth server** (D-056). Sign off on the own-target numbers or change them: authorize 60 per source network (/24, or /48 for IPv6) per 10 minutes; client registration 20 per source network per hour; metadata-document fetches 3 per URL and 30 per host per 10 minutes; the token endpoint 120 a minute per source network and credential.
4. **Compliance.** Build or approve deferring C-05 (a console screen for denials), C-09 (TEAC contacts in the contract and the registrant help text) and the C-55 manual passes. Nothing is deferred without your written approval.
5. **Counsel.** Question 2 (passkey gating and I.A.5.3, for C-02 and C-04) and the Losing FOA sender (C-08).
