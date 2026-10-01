# Build contract for Phases 3 to 6 (read before touching code)

Goal: the remaining phases of `docs/PLAN.md` section 5 (Phases 3 to 6); your brief names your module and the exact plan sections, proven by tests against a real PostgreSQL.
Spec sources: PLAN.md 4.3b (Order state machine, Jobs, Environments), 4.4 (Data model), 4.5 (API, step-up, sessions, recovery, rate limits), 4.6 (threat model rows), section 5 Phase 2 exit list. Read the parts named in your brief.

## Run it
- `scripts/pg-local.sh start` (PostgreSQL 16 on 127.0.0.1:54329). Tests create isolated databases from a migrated template: `createTestApp()` from `@mosshatch/api/testing` gives `{db, ctx, clock, email, router, call()}`.
- `npx vitest run packages/api/src/<module>` and `npm run typecheck` (root) must both pass. Do not run git commands (the lead commits). Do not edit files outside your module directory except: your own migration files, your own `export` line in `packages/api/src/index.ts`, and `packages/api/src/routes.ts` registration (add one line). If you find a bug in a foundation file (`http/`, `audit.ts`, `ratelimit.ts`, `email.ts`, `webauthn.ts`, `kms.ts`, `ports.ts`, `packages/db`), fix it minimally and say so in your final report.
- Node 22, TypeScript with `.ts` import extensions, ESM, `noUncheckedIndexedAccess`. No new dependencies without saying why; allowed already: pg, zod 4, @simplewebauthn/server 14, stripe 22.

## Foundation you can rely on
- `packages/db`: migrations in `packages/db/migrations/NNNN_name.sql` (applied in order). **Migration numbers** (use only your range; never edit an existing migration): used so far 0001-0650. Phase 3 finish 0700-0749; vault 0800-0849; tokens, bindings and CLI 0850-0899; transfers 0900-0949; agents, approvals, MCP and OAuth 0950-0999; publish and hatchkind 1000-1049. A migration may only add or alter; never edit 0001-0007 (report what you need instead, or `alter` in your own file). Tables and RLS are in 0002-0007; read them.
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


## Rules added for Phases 3 to 6
- The user said on 2026-09-30 "go all out and just finish this. make it excellent": build every phase without waiting at phase gates. That waives the stop-and-wait, never the honesty rules: nothing unverified is claimed verified.
- No live credentials exist for OpenSRS, AWS KMS, Stripe or Resend. Build the port, the real adapter code (never called), and a faithful fake; label replay fixtures `source: "documented"`; list every unverified API detail in your report.
- The user has NOT approved any compliance deferral. Rows tagged for your phase in docs/COMPLIANCE.md are built, or listed as unbuilt in your report.
- Several agents work at once. Touch shared files (`routes.ts`, `index.ts`, `security/matrix.test.ts`, `stepup/*.test.ts`, `mail/templates.ts`, `boot.ts`) only by adding lines, never by rewriting others' lines. If another agent's in-progress change breaks a test outside your module, say so in your report instead of "fixing" their code.
- The cross-tenant matrix (ST-91) and the route walk (ST-67) must pass over every route you add, generated from the route table.
- Web work: keep the store contract (only calm, sound, rehideSeconds persist; no secret or fetched value persisted), the strict CSP, and the budgets (initial JS hard 130 kB gz; the engine chunk is at 149.1 of 150 kB gz: never add to it; new UI goes in lazy chunks). axe WCAG 2.2 AA clean on every new view.
