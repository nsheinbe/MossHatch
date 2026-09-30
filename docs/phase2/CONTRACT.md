# Phase 2 build contract (read before touching code)

Goal: the accounts-and-money backend of `docs/PLAN.md` section 5 "Phase 2", proven by tests against a real PostgreSQL.
Spec sources: PLAN.md 4.3b (Order state machine, Jobs, Environments), 4.4 (Data model), 4.5 (API, step-up, sessions, recovery, rate limits), 4.6 (threat model rows), section 5 Phase 2 exit list. Read the parts named in your brief.

## Run it
- `scripts/pg-local.sh start` (PostgreSQL 16 on 127.0.0.1:54329). Tests create isolated databases from a migrated template: `createTestApp()` from `@mosshatch/api/testing` gives `{db, ctx, clock, email, router, call()}`.
- `npx vitest run packages/api/src/<module>` and `npm run typecheck` (root) must both pass. Do not run git commands (the lead commits). Do not edit files outside your module directory except: your own migration files, your own `export` line in `packages/api/src/index.ts`, and `packages/api/src/routes.ts` registration (add one line). If you find a bug in a foundation file (`http/`, `audit.ts`, `ratelimit.ts`, `email.ts`, `webauthn.ts`, `kms.ts`, `ports.ts`, `packages/db`), fix it minimally and say so in your final report.
- Node 22, TypeScript with `.ts` import extensions, ESM, `noUncheckedIndexedAccess`. No new dependencies without saying why; allowed already: pg, zod 4, @simplewebauthn/server 14, stripe 22.

## Foundation you can rely on
- `packages/db`: migrations in `packages/db/migrations/NNNN_name.sql` (applied in order). **Your migration numbers**: auth 0100-0199, stepup 0200-0299, orders/registrar 0300-0399, ops 0400-0499. A migration may only add or alter; never edit 0001-0007 (report what you need instead, or `alter` in your own file). Tables and RLS are in 0002-0007; read them.
- Tenancy: `withUser(pool, userId, fn)` sets `app.user_id` for the transaction; RLS fails closed when unset. Pre-auth lookups use the SECURITY DEFINER functions in 0007 (`auth_*`); add your own definer functions in your migration when a pre-auth path needs one (pinned `search_path`, `revoke all from public`, grant to `mh_runtime, mh_cron`). Cross-tenant/system work (webhooks, jobs, sweepers) uses `ctx.cron` (BYPASSRLS role). **A request handler acting for a user must use `ctx.runtime` + `withUser`.**
- Router: `Router.add(route)` with `principals` (deny by default), `stepUp`, `verify` for webhooks. Handlers return `json(data, status)`. Errors: `throw new HttpError(status, code)`. Cookie routes get the CSRF guard automatically. Session helpers in `http/session.ts`. Bearer tokens: `util/token.ts`.
- `appendAudit(ctx, client, entry)` inside the caller's transaction; entries hold opaque ids and counts only, never values or names or tokens. `hit()` rate limits. `sendMail(client, ctx.email, msg)` is idempotent by `dedupeKey`. `webauthn.ts` has the SimpleWebAuthn wrappers; `testing/authenticator.ts` is a virtual authenticator.
- Jobs: `registerJob({kind, priority, maxRuntimeSec, handler})` and `enqueue(client, {...})` in `jobs/registry.ts`. The engine (claim/lease/tick) is the `ops` module's.
- Money is `bigint` minor units in code; `pg` returns bigint columns as strings, so wrap with `BigInt()`.
- Registrar: `@mosshatch/registrar/port` types (`RegistrarPort`). The Phase 1 `MockRegistrar` (UI sample prices) stays as is.

## Rules that apply to every module
1. Every state change is a conditional update (`WHERE id=$1 AND state=$expected`), and code handles "zero rows" as the loser of a race.
2. No secret, token, authorization code, full email address or free text in logs, audit `detail`, job payloads or error messages. Use ids.
3. Unowned and nonexistent resources return the same status, headers and body through one code path (404).
4. Every route declares its principals. Cookie mutations are protected by the router's CSRF guard; do not bypass it except ceremony endpoints that carry their own token (`csrf: "none"` with justification in a comment).
5. Tests prove the exit criteria named in your brief, including the adversarial cases; name each test with its `ST-nn` id. A test that only checks the happy path does not count. If something cannot be proven in this container (real Stripe, Resend, AWS KMS, OpenSRS), build the port and a faithful fake, say so in the report, and never claim it verified.
6. Keep copy plain, active voice, sentence case, no apologies in errors; error bodies are `{error:{code}}`.
7. Final report (your last message): files added, migrations, exported routes, tests added with ST ids and pass counts, deviations from the plan with reasons, what remains unproven. Keep it under 400 words.
