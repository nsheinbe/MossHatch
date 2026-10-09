# Queued provider authorization handoff

Recorded 2026-10-09 at 15:48 UTC. This is a handoff for review, not authorization to contact another worker, merge, deploy, migrate production, create credentials/grants, purchase domains or call live providers.

## Saved work and status

- Draft [PR 46](https://github.com/nsheinbe/MossHatch/pull/46), branch `codex/production-secure-agent-dns`, worktree `/workspace/MossHatch-production-port`.
- **Queued-job source issue fixed:** implementation commit `e7b0d1692640e0e21060395b06fbf53c5169ee10`, already pushed. Its parent `65a69bb50417929e05df3ff9b2dd70d3ae3bbc03` is the reviewed production DNS/owner-access port. This handoff commit changes documentation only.
- Production/main remains `e311dae06f75d41131f92d4421355a3934b9bcda`; both production aliases were verified there, with zero deployments from this review branch. All three exact-branch deployment guards remain.
- Original [PR 45](https://github.com/nsheinbe/MossHatch/pull/45), worktree `/workspace/MossHatch`, remains untouched at `afe9ced52244585cd539c38b58a19cf7766f3b3f` on its selected Claude base. Preserve all existing worktrees and the local PostgreSQL container.

The fix binds the original planner and applying actor to the immutable plan/job and rechecks live grants, expiry, pause/revocation, scopes, owner, domain and connection/credential ownership before effects. It checks again after credential decryption and before a secret transaction commits after encryption and pointer/audit signing. Missing/changed authorization fails closed. Normal OAuth refresh and plan-only proposals remain valid. Failed/completed application redelivery cannot restart effects. A dispatched remote request may still complete; its known result is retained and later effects stop. No new migration, dependency or UI change is included in this follow-up.

## Exact verification state

At implementation commit `e7b0d16`:

- Local full suite: **1,621 passed, 119 skipped; 164 files passed, one skipped; 124.00 seconds**.
- Isolated performance suite: **22 passed; 3.88 seconds**.
- Focused authorization regressions: **34 passed**, plus **26 existing recipe and 26 existing vault tests**. Includes post-enqueue revoke/pause/expiry/narrowing, both actors, tenant isolation, OAuth rotation, KMS race barriers, partial effects and redelivery.
- All workspace typechecks, web/API/registrar/cards builds, supply-chain checks, **155/155 security IDs**, and audit (**zero vulnerabilities**) passed. No lint script exists. Independent implementation and test reviews reported no blocking defect in this scope.
- **Final implementation CI was still pending at handoff recording:** [push run 37952198981](https://github.com/nsheinbe/MossHatch/actions/runs/37952198981) and [PR run 37952207524](https://github.com/nsheinbe/MossHatch/actions/runs/37952207524), both exact head `e7b0d16`, attempt 1. Both passed all preceding checks and were running the full Playwright suite, with no failed steps reported. Read their terminal conclusions and logs before claiming final CI success. The PR body may contain a newer terminal update.
- This documentation-only handoff does not claim a new full test run. Any CI on its new head is separate; inspect the PR's latest checks.

The parent `65a69bb` separately passed 1,587 unit tests, 22 performance tests and all 88 browser cases in both CI runs. Its 88 unique local browser cases used Chromium 151; one initial loaded animation timeout passed unchanged on a focused rerun. Those results do not substitute for the follow-up's CI. Current tests use isolated PostgreSQL, fake providers and virtual authenticators; live sandbox work remains unrun.

Local evidence is preserved at `/tmp/mosshatch-queued-auth-evidence.json` (counts and log hashes), `/tmp/mosshatch-queued-auth-review.md`, and `/tmp/mosshatch-queued-final-*.log`. Parent evidence is `/tmp/mosshatch-production-port-evidence.json`. These temporary artifacts may not survive an environment replacement; committed source/tests/docs and linked GitHub CI are the durable handoff.

## Resume safely

Use this dedicated environment only. No production secret is needed. Node 24/npm and the committed lockfile are required. See [cloud setup](CLOUD-WORKSPACE.md) for restore-client installation and browser/port caveats.

```sh
cd /workspace/MossHatch-production-port
git status --short
git log -3 --oneline
export npm_config_cache=/tmp/mosshatch-npm-cache
npm ci --ignore-scripts
sh scripts/cloud-test-db.sh start
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres
export MH_PG_BIN=/tmp/mosshatch-pg-client/bin
export MH_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
node scripts/cloud-check.mjs
npx vitest run packages/api/src/recipes/queued-authorization.test.ts
```

Do not rerun already-passing checks merely to consume time. If code changes, use the complete checks in [cloud setup](CLOUD-WORKSPACE.md), including typechecks, full unit/performance suites, builds and browser checks. Avoid sharing fixture server ports with the original worktree. This image blocked pinned browser downloads; local Chromium is an explicit substitute, while CI uses its pinned browser. Do not change network policy or use live credentials to repair fixture failures.

## Remaining gates

1. Inspect both implementation CI runs and any later-head checks, record exact terminal results in PR 46, and resolve actual failures before review completion. Keep the PR a draft; no merge/deployment authorization exists.
2. Before any separately authorized rollout, inventory old recipe plans/jobs and recreate those without authorization snapshots. Do not backfill authority, revive terminal failures or retry uncertain provider effects blindly.
3. Authorized real-provider sandbox validation, real-device owner passkey/recovery acceptance and external OAuth round trips remain unproven. Revocation and provider calls are not atomic.
4. Nameserver execution, custom/glue and DS/DNSKEY mutations stay blocked until complete authorized inventories, actual parent DS/destination DNSKEY/signature verification and a durable supported transition exist. Agent DNS recipes remain gated.
5. Keep retail **HOLD** and the waitlist/public-sales posture. No pricing or contribution-floor change is implemented.

Read [owner setup](OWNER-ACCESS.md), [port decisions](SECURE-DNS-PRODUCTION-PORT.md) and [release gates](PRODUCTION-RELEASE-GATES.md) before continuing. No live-provider integration or global propagation guarantee is established by these fixture tests.
