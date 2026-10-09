# DNS boundary follow-up

This review branch starts at PR46 head `285137c2554bda6d1caed7ac080d9ea490a6c401` and preserves PR46, PR45, main and their original branches. Automatic Vercel deployment is disabled for `codex/mosshatch-dns-boundaries-20261009` in all three project configurations.

Three concrete code defects were found during local release review:

- A successful registrar replacement followed by a failed independent DNS read could mark the receipt refused. The executor now remembers acceptance and retains an unknown outcome, visible receipt and linked approval until read-only reconciliation resolves it. Genuine pre-write refusal behavior remains.
- Owner DNS approval acquired another runtime connection while holding the DNS transaction and advisory lock. It now passes the current tenant-scoped client to the step-up gate, preserving the gate's action, session, expiry and hold checks. The default standalone gate still opens its own tenant transaction.
- Queued owner recipes checked only approval consent after their final DNS read. They now recheck full queued authority, including the applying session and connection liveness, on the existing intent transaction client. Already-dispatched provider results remain; later DNS effects stop and terminal redelivery cannot repeat them.

## Focused validation

Pinned Vitest 5.0.2, Node24 and a fresh isolated loopback PostgreSQL instance were used with synthetic users, virtual passkeys and fake providers. No hosted database, provider credential or DNS service was used.

- 142 tests passed: DNS security30, agent DNS writes5, step-up43, queued authorization38 and recipes26.
- Eight new regressions were proven failing against the original faulty condition/calls and passing with the fixes. They cover three post-acceptance read failures, concurrent owner approval with a one-connection pool, and final provider/DNS-read boundaries crossed by disconnection or applying-session logout.
- API workspace typecheck, all155 security-ID checks and `git diff --check` passed.
- Independent cross-review of both repairs found no additional blocker in the changed scope.

The exact original PR46 head already passed CI37961630392. Its broad suites were not rerun locally. New-branch CI is a separate result and must be checked before merging.

## Release remains gated

The reviewed migration and pause SQL bytes are unchanged. Migrations0998/1130 and the three registrar/order/purchase pause flags remain unapproved and unexecuted. Pausing can delay renewals and transfers. Keep the existing restricted-release runbook and separate owner approval; this source repair grants no infrastructure authority.

On 2026-10-09 at18:33:44 UTC, permitted anonymous GETs returned HTTP200 for the production home page, `/api/v1/session` and both OAuth metadata endpoints. The public session response was `signedIn:false, live_gate:true`. This resolves the earlier public network-read limitation only; it does not verify this candidate deployment, an authenticated owner flow or a live provider integration.

No merge, deployment, hosted migration/setting, credential/grant creation, factor enrollment, email, paid generation, purchase or DNS mutation was performed. RallyGlow mutations remain paused.
