# Dedicated MossHatch cloud workspace

This environment is for one project's synthetic local tests. The production port is `/workspace/MossHatch-production-port`, branch `codex/production-secure-agent-dns`, based on `main` at `e311dae06f75d41131f92d4421355a3934b9bcda`. The original PR 45 worktree remains `/workspace/MossHatch`; do not switch or overwrite it. Read [port scope and production relationship](SECURE-DNS-PRODUCTION-PORT.md).

No `AGENTS.md` or applicable `.agents/skills` was present in either checkout. Repository instructions are in `docs/BUILD-CONTRACT.md`, `docs/PLAN.md` and current main's handoff. The user's current no-merge/no-deploy instruction overrides historical standing release instructions.

## Setup

Use Node 24/npm, the committed lockfile and disabled install scripts. The home directory is read-only, so select a writable cache. Commands below use only synthetic local resources:

```sh
cd /workspace/MossHatch-production-port
export npm_config_cache=/tmp/mosshatch-npm-cache
npm ci --ignore-scripts
sh scripts/cloud-test-db.sh start
export MH_PG_BIN=/tmp/mosshatch-pg-client/bin
export MH_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
node scripts/cloud-check.mjs
```

The PostgreSQL 16 helper binds only `127.0.0.1:54329`, preserves its named container and never deletes volumes. Tests clone unique databases from a migration-content-keyed template. Synthetic trust authentication is local testing configuration, not a production recommendation. The doctor refuses non-loopback test database URLs and prints variable names only.

This image provides Docker but no native PostgreSQL clients. Version-compatible restore tools were copied from the existing test container:

```sh
mkdir -p /tmp/mosshatch-pg-client/bin
docker cp mosshatch-security-tests:/usr/lib/postgresql/16/bin/pg_dump /tmp/mosshatch-pg-client/bin/pg_dump
docker cp mosshatch-security-tests:/usr/lib/postgresql/16/bin/pg_restore /tmp/mosshatch-pg-client/bin/pg_restore
```

CI uses its normal PostgreSQL client path when `MH_PG_BIN` is unset. Pinned Playwright Chromium downloads were denied by this environment's network policy; no policy was changed. Local checks explicitly use installed Chromium 151.0.7922.173. CI retains Playwright 1.56.1's pinned Chromium. Fonts are committed; normal builds do not need font regeneration.

## Verification

```sh
node scripts/check-supply-chain.mjs
npm audit --audit-level=low
npm run typecheck
npm test
MH_PERF=1 npx vitest run packages/api/src/ops/engine.test.ts
npm run check:st
npm run build
node scripts/build-registrar.mjs
npm run build:cards
npx playwright test
git diff --check
```

No lint script exists. The typechecks, supply-chain/security-ID checks, tests and build scans are the defined checks. Production main already contains the source-map-js 1.2.2 patch; this port adds no dependency or lockfile change.

Default browser config uses ports 4173/4175/5173/5174/5176 and reuses listeners. In a shared workspace, use test-owned fresh ports with a temporary config importing the committed project settings, absolute working/test directories, and only the selected servers/projects. Keep `MH_FAKE_LOOKUP=1` for the dev fixture. Parameterized browser tests must use the configured base URL, never silently fall back to an older worktree's server. Each account server creates its own synthetic database and fake Stripe/registrar/mail services. Do not use provider credentials to repair a fixture failure.

No live-preflight, go-live-db, owner invite/enrollment, deployment or sandbox mutation command is part of setup. No production secret is needed. Local caches, test dependencies, clients and database resources were installed only in this container. The saved environment template was **not** changed; reproducing it later requires Node 24, PostgreSQL 16 with clients and a policy-approved browser in that template.

The three project `vercel.json` files disable automatic Git deployments for this exact review branch. This source guard is not a change to live project settings. CI builds/tests only; no deployment or production migration workflow is dispatched.
