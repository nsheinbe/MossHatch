# Secure agent DNS and owner access: review evidence

[Draft PR #45](https://github.com/nsheinbe/MossHatch/pull/45) targets the owner-selected base `claude/vigilant-ritchie-8vinxb` (`689ea51`). Production is on `main` (`e311dae`), 64 commits ahead. Nothing in this work has been merged, deployed or exercised against a real customer's DNS. No owner factors, production credentials, grants, purchases or production migrations were created. Read-only Vercel metadata confirmed both production projects; direct public HTTP checks from this environment were blocked with 403, so no fresh public health result is claimed.

## Implemented behavior

- Full representable user-managed record inventory includes CAA, unknown record types, child NS and TTL. Unchanged opaque RDATA is preserved; opaque edits are refused. Provider-generated apex SOA/NS are outside the user-managed inventory. Unsupported fields, incomplete pages, ambiguous multi-string TXT or unavailable TTL fidelity fail closed instead of discarding data. SystemDNS refuses state it cannot represent.
- DNS hashes use framed canonical JSON and include TTL. Browser, direct agent DNS and owner recipe writes use the existing shared DNS executor. It commits the complete before/intended state and operation receipt before any provider write, rechecks ownership, account/session/grant state and upstream state, then reads back.
- Openprovider still lacks compare-and-swap and requires separate remove/add calls. Any submitted write failure can be partial or uncertain. Nothing automatically resends or overwrites the zone with an old snapshot. Pending/unknown receipts survive retention sweeps and block further writes until reconciliation. Reading history performs a read-only provider observation; an exact intended state can settle the receipt. A before/partial observation cannot prove a timed-out request will never finish and remains blocked for operator/provider-terminal reconciliation.
- Provider acceptance/read-back, authoritative DNS visibility, and propagation sampling are distinct response fields. Provider read-back does not prove an authoritative response or global propagation; those are labelled `not_checked`/`not_sampled`. Rollback is a new approved write and cannot undo cached answers, lost mail or third-party side effects.
- Deletions, all TXT verification-like content, production-looking hosts, MX/SRV/CNAME/NS dependencies and DNSSEC/CAA/service records trigger conservative classification. Passkey approval binds exact state and changes; grants remain per-domain/operation, short-lived and revocable. Unknown upstream changes invalidate an approval.
- `nameservers.propose` is an explicit **one-domain** capability exposed through MCP and REST. Registry delegation is distinct from an NS record in the zone. Plans include source inventory and current provider-reported security state. Agents cannot approve/execute delegation. Custom/glue changes and migration execution remain blocked pending destination authorization, complete inventory and actual parent DS/destination DNSKEY/signature transition verification. A client `target_signed` assertion grants no authority.
- DNSSEC read models are provider-aware; Openprovider requires DNSKEY material rather than generic DS input. DNSSEC mutations remain gated until they have a durable exact-change/unknown-outcome workflow. An old committed action cannot bypass this gate. No resolver or live signed transition is claimed complete.
- Agent-started DNS recipes remain gated pending a durable grant-bound queued-job approval path. Direct DNS proposals provide the supported narrow route. This prevents queued recipes from surviving grant revocation.
- Existing passkeys and recovery were improved instead of introducing a second authentication system. Login and step-up recheck live credentials after verification. Recovery codes remain hashed and single-use, attempts limited, and recovery holds/sessions preserved. UI cancellation/replacement and repeated clicks are covered.
- Owner-facing DNS values use escaped text and preserve full review content, TTL and relevant RR fields. The compact DNS panel was inspected in a real browser before and after styling on desktop and phone. See [screenshots](evidence/dns-ui/README.md).

## Verification matrix

All API/database tests use isolated PostgreSQL databases and synthetic identities. Provider tests use documented or historical recorded fixtures, never current sandbox writes. Exact final commands/counts are recorded below.

| Requirement | Evidence suites |
|---|---|
| CAA/unknown/child NS/TTL preservation, incomplete inventory, hash framing, malicious content | registrar `dns.test`, Openprovider `dns-fidelity.test`, SystemDNS tests; API `agents/dns-security.test` |
| Partial write, timeout, no blind retry, stale/out-of-band changes, operation retention/read-only reconcile | registrar fidelity tests; `domain-mgmt/dns.test`, `agents/dns-write.test`, `agents/dns-security.test` |
| Tenant/domain isolation, wrong agent, replay, stale/expired approvals and grants | scope/security matrices; `agents` approval/DNS/security tests; OAuth lifetime/security tests |
| Audience, PKCE, refresh reuse, explicit incremental consent | OAuth protocol/session/lifetime suites; bindings/device; MCP tests |
| DNSSEC mismatch/unknown state, nameserver parity and denied legacy bypass | nameserver proposal/security/management tests; registrar signed delegation denial; scoped MCP/REST matrix |
| Recovery replay, credential revocation race, secret redaction | auth/login-races/recovery/recovery-replay; stepup/credential-race; RPC tests |
| Cancellation, repeated UI actions, exact approval, phone accessibility | owner-security and sensitive-screens Playwright tests with virtual passkeys, axe and mocked/real local API paths |
| Existing retail production safety | separate detached production-source run: **30 files, 270 tests passed**; [launch verdict](retail-launch-verdict-2026-10-09.md) |

Historical Openprovider shared contract replay is still exercised. Its old lifecycle fixture contains a signed-delegation bypass now forbidden; the test explicitly stops at that safety gate and labels the remaining historical exchanges unverified. This is not a fresh provider certification. Live-sandbox tests remain skipped because no authorized sandbox credentials/domain-impact scope were supplied.

## Final local verification (2026-10-09)

All implementation modules were frozen before the final integrated run. Commands ran from `/workspace/MossHatch` with `npm_config_cache=/tmp/mosshatch-npm-cache`, `MH_PG_BIN=/tmp/mosshatch-pg-client/bin`, and (for browser checks) `MH_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`.

| Command/check | Final result |
|---|---|
| `npm ci --ignore-scripts` | Final local clean install passed: 115 packages in 2 seconds. |
| `npm test` | **135 files passed, 1 skipped; 1,405 tests passed, 119 skipped; zero failed**. Started 14:07:40 UTC, 194.59 seconds. |
| `npm run typecheck` | All configured workspace TypeScript checks passed. |
| `npm run build` | Passed, including API bundle, client secret scan and size budgets. Initial JS **91.8 kB gzip**, below 130 kB hard budget. |
| `node scripts/build-registrar.mjs` | Registrar RPC bundle built successfully. |
| `npm run build:cards` | Passed; 9 pages, no script, clean secret scan, link and size checks. |
| `MH_PERF=1 npx vitest run packages/api/src/ops/engine.test.ts` | **22 passed**, 3.35 seconds in the final isolated rerun at 14:12:31 UTC, including enabled performance bounds. |
| `node scripts/check-supply-chain.mjs` | Passed. |
| `npm audit --audit-level=low` | **0 vulnerabilities** after the source-map-js lockfile patch. |
| `npm run check:st` | **155/155** defined/due security IDs covered by the repository checker. |
| `git diff --check` | Passed. |
| `node scripts/cloud-check.mjs` | Passed with the documented local overrides; real loopback PostgreSQL and Chromium page launch confirmed. |

The 119 skipped cases include the unauthorized live sandbox suite and contract cases excluded by adapter/tags. They are **not** counted as provider proof. No lint command exists. Prior failed runs included missing local PostgreSQL/cache/browser setup and test fixtures expecting old unsafe behavior. One integrated run overlapped final file edits; the frozen run above supersedes it. The legacy detector fixtures now insert historical actions directly instead of trying to create newly forbidden DNSSEC actions.

The separate agent security review found and prompted fixes for DNSSEC mutation durability, grant revocation on queued DNS recipes, session/credential races, stale exact approval content and uncertain-write messaging. After its targeted checks (including 58 DNS/recipe/display tests), it found no remaining definite unsafe write path in its reviewed scope and marked this ready for draft review subject to integrated verification. This is an agent code review, not a security certification or live integration validation.

Local raw logs remain in `/tmp/mosshatch-frozen-tests.log`, `/tmp/mosshatch-frozen-typecheck.log`, `/tmp/mosshatch-frozen-build.log`, `/tmp/mosshatch-frozen-registrar-build.log`, `/tmp/mosshatch-final-cards-favicon-build.log` and `/tmp/mosshatch-frozen-perf.log`. Browser checks use virtual authenticators and local fake effects. Production 27 and public 5 cases passed in `/tmp/mosshatch-final-public-browser.log`; development 13 passed on fresh port 5189 in `/tmp/mosshatch-final-dev-browser.log`; cards 7 passed in `/tmp/mosshatch-final-cards-browser.log`. Publish and invite each passed on isolated ports 5184/5186 (2 cases, 212.83 seconds) in `/tmp/mosshatch-publish-invite-verification.log`. The original static run's two failures were resolved: a reused dev server lacked fake lookup data, and the separate cards origin lacked a favicon. No assertions were weakened. Animated grove controls are activated by keyboard in the account/publish tests instead of waiting indefinitely for motion to stop. The full account run passed 25/26 cases in 13.5 minutes; its sole failure was an obsolete unquoted-text locator after the exact quoted DNS display change. After changing that assertion to require the full quoted value, the **entire sensitive-screen file passed 15/15** in 1.9 minutes, including cancellation and repeated-click single execution. The other 25 successful account cases required no feature changes. This verifies **all 26 account cases**, and **all 80 browser cases across final project/file runs**; it is not a claim of one uninterrupted 80-case invocation. Raw account logs: `/tmp/mosshatch-account-final.log` and `/tmp/mosshatch-sensitive-final.log`.

Temporary browser configs import the committed project settings and select separate test-owned servers, preventing one runner from closing another's listener. Their commands and log hashes are preserved in the machine-readable evidence. Normal reproduction is `npx playwright test` on fresh reserved listeners with the documented local browser override. A final clean install and workspace doctor passed after all browser runners finished. No source or dependency changes followed that install.

GitHub CI on `72c1cf0` independently passed clean `npm ci`, audit, typecheck, unit/performance tests, security IDs, web/cards builds and pinned Chromium installation; the browser step was still running at the last check. This is not a claim that the final PR head has completed CI. See [machine-readable evidence](evidence/secure-agent-dns-checks.json).

## Release gates and limitations

1. Integrate this draft with current production in a separate reviewed change. Preserve the newer main account/consent/DNS features and coordinate open Claude work; do not merge the old base over production.
2. Review/apply the new migrations only in an authorized release: `0998_nameserver_proposals.sql` and `1130_dns_reconciliation.sql`. They were applied only to synthetic local databases here.
3. Hash format changes invalidate pending legacy approvals. Explicitly void/reissue old DNS and recipe proposals, and reconcile unresolved legacy snapshots before enabling writes. Do not reinterpret old hashes as approved new state.
4. Rehearse complete Openprovider record inventory and TTL handling, remove/add partial errors, timeout-after-acceptance, out-of-band mutations, read-back lag, and provider-terminal outcome resolution in an explicitly authorized isolated sandbox. No real domains may be affected by that rehearsal.
5. Nameserver migration and DNSSEC mutation require additional implementation and authorization: authenticated destination inventory/provider access, actual validated parent DS and destination DNSKEY/RRSIG evidence, supported staged transition/TTL waits, durable receipts and recovery. Public scans are never a full inventory. Keep source records and custom/glue gates intact.
6. Verify real-device owner passkeys/recovery and the external MCP client's OAuth round trip in a controlled rollout. Tests use virtual authenticators and mocked external effects. Agents never receive owner factors or registrar root credentials.
7. Run CI on the integrated production branch with the pinned Playwright browser. This container uses installed Chromium 151 because pinned Chromium downloads were policy-blocked; the saved environment template was not changed.
8. Keep public-sales activation separate. [Retail verdict](retail-launch-verdict-2026-10-09.md) remains HOLD; [economics](retail-unit-economics-2026-10-09.md) includes a possible below-cost `.studio` scenario and a proposed, unimplemented contribution floor. No live pricing or sales gates were changed.

Owner instructions: [OWNER-ACCESS.md](OWNER-ACCESS.md). Reproducible environment setup and exact container/template distinction: [CLOUD-WORKSPACE.md](CLOUD-WORKSPACE.md).

## Official technical sources consulted

- [Openprovider current OpenAPI](https://developer.openprovider.com/data/swagger.json): record payload fields and zone enumeration.
- [Openprovider DNSSEC updates/transfers](https://support.openprovider.eu/hc/en-us/articles/216648828-DNSSEC-Updates-and-transfers): supported staged key transitions rather than a client assertion.
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization): resource/audience and explicit scope negotiation.
- [OAuth Security BCP, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html): PKCE, replay/refresh protections and least privilege.
