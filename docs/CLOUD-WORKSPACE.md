# Dedicated MossHatch cloud workspace

This setup is for synthetic local development in the one-project cloud workspace. It does not configure production, grant access to external DNS, or modify the saved cloud environment template.

## Checkout and isolation

Worktree: `/workspace/MossHatch`; remote: `nsheinbe/MossHatch`. This task's feature branch is `codex/secure-agent-dns-owner-auth`, based on the explicitly selected `claude/vigilant-ritchie-8vinxb` at `689ea51d348a3e74b72fb745cb9e5ed6fc944c52`.

Read-only deployment metadata on 2026-10-09 confirms both `mosshatch.com` and `mosshatch-registrar.vercel.app` use `main` at `e311dae06f75d41131f92d4421355a3934b9bcda`, 64 commits ahead of this base. This draft requires a separate reviewed integration with production; it is not a production-ready replacement. PRs 41 and 42 already changed related account, DNS and consent UI on main. Open Claude PR 7 also touches shared UI/router files. No worker branch was overwritten.

No `AGENTS.md` or `.agents/skills` exists in the selected checkout or main; `/workspace/.agents` is empty. The repository's actual instructions are `docs/BUILD-CONTRACT.md` and relevant `docs/PLAN.md` sections. Later main's handoff was inspected for overlap; this task's explicit no-merge/no-deploy instruction overrides its historical standing release instruction.

## Reproduce locally without production secrets

Node 24 (CI's version; repository engine is >=22) and npm with `package-lock.json`. Keep `.npmrc`'s `ignore-scripts=true`. The container's home directory is read-only, so use a writable cache:

```sh
export npm_config_cache=/tmp/mosshatch-npm-cache
npm ci --ignore-scripts
sh scripts/cloud-test-db.sh start
export MH_PG_BIN=/tmp/mosshatch-pg-client/bin
export MH_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
node scripts/cloud-check.mjs
```

The database helper binds PostgreSQL 16 to **127.0.0.1:54329 only** with synthetic test authentication. It preserves the named container on stop and never deletes volumes. It is not a production database configuration. Tests clone uniquely named databases from a template keyed by migration content. No production migration or customer data is used.

The cloud image has Docker but lacks native PostgreSQL executables. Restore tests also need version-compatible `pg_dump` and `pg_restore`. For this task these were copied from the pinned local PostgreSQL test container into `/tmp` (their shared libraries are available in this image):

```sh
mkdir -p /tmp/mosshatch-pg-client/bin
docker cp mosshatch-security-tests:/usr/lib/postgresql/16/bin/pg_dump /tmp/mosshatch-pg-client/bin/pg_dump
docker cp mosshatch-security-tests:/usr/lib/postgresql/16/bin/pg_restore /tmp/mosshatch-pg-client/bin/pg_restore
```

`MH_PG_BIN` is optional. CI retains `/usr/lib/postgresql/16/bin`. Existing `scripts/pg-local.sh` remains available for a root-enabled image with native PostgreSQL.

The pinned Playwright Chromium download returned HTTP 403 `Domain forbidden` for both download domains. No network policy was changed. Installed `/usr/bin/chromium` 151.0.7922.173 passed a real launch/page smoke check and is used only when explicitly selected by `MH_CHROMIUM_EXECUTABLE_PATH`. This differs from Playwright 1.56.1's pinned Chromium 141; CI must still run its pinned browser. FFmpeg 7.1.5 and `pyftsubset` are present; fonts are already committed, so normal builds do not require regeneration.

## Checks

```sh
node scripts/check-supply-chain.mjs
npm audit --audit-level=low --cache /tmp/mosshatch-npm-cache
npm run typecheck
npm test
MH_PERF=1 npx vitest run packages/api/src/ops/engine.test.ts
npm run check:st
npm run build
npm run build:cards
npx playwright test
```

There is no `lint` script in this repository. TypeScript, supply-chain checks, security-test coverage checks, tests and builds are the defined checks; an absent lint command is not reported as a passing lint run. Final measured results are in `docs/SECURE-AGENT-DNS-VERIFICATION.md`.

The first test attempt ran before PostgreSQL finished starting and failed with `ECONNREFUSED`; it was not evidence of code correctness. The workspace doctor now checks database readiness and both restore tools before a verification pass. The first npm audit found a high-severity `source-map-js` advisory; the lockfile is patched narrowly from 1.2.1 to 1.2.2 and the final audit is rerun.

## Variable names, isolation and saved template

`cloud-check.mjs` prints matching **variable names only**, never values, URLs or credentials. It refuses to probe a non-loopback `TEST_DATABASE_URL`. This task began without production database, registrar, Stripe, AWS, RPC or Resend variables. Test variables are `TEST_DATABASE_URL`, `MH_PG_BIN`, `MH_CHROMIUM_EXECUTABLE_PATH`, optional `MH_PERF`, and the synthetic settings created by `scripts/e2e-server.mjs` (`MH_MODE=local`, fake Stripe/registrar and recording email).

No registrar login, owner factor, grant, live API key or production secret is required or added. Do not run live-preflight, go-live-db, invite, provider sandbox mutation, or deployment scripts as part of environment setup.

**Container versus saved environment:** dependencies, caches, test PostgreSQL and copied test clients were installed only in this task container. The saved environment template has not been changed. To make future environments reproducible, the owner should place Node 24/npm, Docker or native PostgreSQL 16 plus its clients, and a policy-approved Playwright browser in that template. This PR provides the project-scoped checks and instructions; it does not claim the template has been provisioned.

## Draft branch publication

All three project `vercel.json` files disable automatic Git deployments for the exact review branch `codex/secure-agent-dns-owner-auth`, using [Vercel’s documented branch control](https://vercel.com/docs/project-configuration/git-configuration). This is a source-controlled branch guard, not a live project setting change. Other branches retain their existing deployment behavior. GitHub CI only builds/tests; database and npm release workflows are manual. No deployment workflow is dispatched.
