# Restricted DNS and owner-access release

Status: prepared for owner approval; **not executed**. This is the release procedure for [PR 46](https://github.com/nsheinbe/MossHatch/pull/46), based on production `e311dae06f75d41131f92d4421355a3934b9bcda`. The owner has authorized finishing, merging and deploying when ready. That authorization explicitly excludes unconfirmed production migrations and security-sensitive setting changes. Approval of the exact package below is the remaining owner decision; it does not authorize a public retail launch, provider tests, credentials, grants, factor enrollment or DNS changes.

## Exact approval package and impact

Target only Neon project `frosty-river-45238500`, branch `br-square-bread-b7vin3u3`, database `mosshatch`.

1. Set existing flags `registrar_writes_paused`, `orders_paused` and `agent_purchases_paused` from `false` to `true`, recording `updated_by='secure-dns-restricted-release'` and the update timestamp. Update only those three existing rows; abort if any row is missing or has a non-boolean value. A verified retry preserves already-true rows and their timestamps. Keep them paused after deployment. Reopening needs a separate decision. The exact transaction is [secure-dns-pause.sql](sql/secure-dns-pause.sql).
2. Apply only `0998_nameserver_proposals.sql` and `1130_dns_reconciliation.sql`, with their migration-ledger entries, using [secure-dns-migrations.sql](sql/secure-dns-migrations.sql) as one transaction. Do not run the general go-live script: it also publishes legal documents. Do not apply other pending migrations.

`0998` expands the existing request-kind check to allow `nameservers_change`; it grants no capability and enables no nameserver execution. There were zero request rows at the read-only check.

`1130` adds six DNS receipt fields: nullable `state_format`, `intended_records`, `agent_request_id` (foreign key), `observed_hash`, `observed_at`, and non-null `reconciliation_state` defaulting to `unresolved`. It adds checks and the partial `dns_snapshots_unresolved` index on `domain_id` for `write_state IN ('pending','unknown')`. Existing receipts retain all their old data, with five new NULL fields and `reconciliation_state='unresolved'`. In particular, no old receipt is marked `complete-v1`: an old incomplete inventory must never acquire rollback authority by backfill.

No customer row, record, TTL, credential, grant, price or payment is deleted or rewritten. Eight existing DNS receipts are preserved. DDL takes table locks; use a one-second lock timeout and a 30-second statement timeout, abort on contention, and inspect before retrying. The small observed row count does not promise a duration or eliminate concurrent activity.

The pause blocks DNS writes through the shared browser/MCP/REST executor, new orders and agent purchase proposals, and registrar registration/renewal/transfer dispatch. **It also delays renewals and transfers**, so recheck deadlines before setting it and monitor while it stays on. It cannot cancel an already-dispatched provider request. Read-only reconciliation and financial completion/recovery may continue. These flags are not a universal provider shutdown: existing owner-authorized recipes can still perform Vercel/Resend preparation and the hardened Neon integration can operate under existing grants. No new provider capability is enabled by this release.

Nameserver execution, custom nameservers/glue, DS/DNSKEY changes and agent DNS recipes remain blocked in code. Retail remains HOLD. Auth/UI changes retain existing factors and tighten races, cancellation and repeated actions; they add no TOTP or enrollment requirement.

## Verified starting point

On 2026-10-09 at 16:22, 16:40 and 16:43 UTC, read-only repeatable-read transactions confirmed:

- Both migrations are absent; the 38 recorded filenames match the production baseline. Check filename sets, not the largest migration number: these additions sort below the already-applied `1220`.
- All three pause flags are currently false. DNS receipts: eight total, zero pending and zero unknown. Agent requests: zero.
- Active recipe plans, queued/running recipe applications and connection checks: zero. No legacy authority needs backfilling or queued work needs replaying.
- No live unreleased domain expires within 30 days. The observed order states were one captured registration and two expired checkouts; these are not an outstanding registration dispatch.
- No active inbound or outbound transfers and no running jobs. The follow-up included `transfer_in.*` jobs and all order states, not just registration jobs.
- Row security was inactive for the queried aggregate tables, so zeros are not the result of tenant filtering. No names, customer records, credentials or connection strings were returned.

The [machine-readable readiness record](../evidence/production-port-dns/release-readiness-2026-10-09.json) preserves these observations and their limits.

The [read-only catalogue check](sql/secure-dns-catalogue-readonly.sql), run inside a read-only transaction on production, matched the rehearsed baseline SHA-256 `dd1bc9403915be1233fdf071bec790591ce496e7be9eb20a2ec4c9a6ddf28899`. The migration transaction checks the complete ledger filename set and the two affected tables' columns, constraints, indexes, RLS and policies. It validates the final catalogue and unchanged table ACLs before commit, and rejects drift instead of silently repairing it.

## Rehearsal and artifact pins

Fourteen [local rehearsal checks](../evidence/production-port-dns/migration-rehearsal.jsonl) passed against PostgreSQL 16, rebuilding only seven uniquely named local scratch databases from the exact main migrations. They cover eight synthetic receipts with CAA, unknown records and TTL; original-row/hash/timestamp preservation; new checks and foreign key; valid partial index; repeated application; partial direct-runner recovery; atomic connector rollback; competing advisory locks; ledger/catalogue drift; and exact three-flag pause/retry/failure behavior. Scratch databases created by the rehearsal were removed; existing resources and shared roles were preserved.

Reproduce in the dedicated cloud workspace, with its existing loopback PostgreSQL:

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres node docs/evidence/production-port-dns/rehearse-release.mjs
```

The script rejects another database URL and changed migration/runner bytes. It creates local fixture users and grants only inside its disposable databases; it never calls a provider. These results do not establish live-provider behavior.

| Reviewed artifact | SHA-256 |
| --- | --- |
| Three-flag pause SQL | `d61f3ba775f1faeb840324a7da815dbe4e0238059c86e7e4abeed992e593e5fa` |
| Two-migration transaction | `c1d48fc12d184a77d11c41743d5593c2e7b4686731883ba02a83be69538c6ea7` |
| Original `0998` | `1856d191e54cfd8cfcf3483be607dd2c80706c73c510e3d910c115faea573a92` |
| Original `1130` | `2ec9c61122ff2e32819c26e4690b3c979800631814e8a721aa88a8f0db799b80` |

Execute each approved SQL file as a single statement inside the connector's transaction; do not split dollar-quoted blocks on semicolons. Recheck these digests before execution. The existing application source was fully verified at `3280902`: 1,621 unit tests, 22 isolated performance tests and 88 browser tests, plus typechecks, builds, supply-chain and security-ID checks. This release preparation adds only runbooks and evidence, not application behavior. Record the final review commit and its own CI status in the PR.

Vercel production aliases still point to `e311dae`: web deployment `dpl_4u8PhPH2WDGGmT8d9PLcgQoXZJen`, registrar deployment `dpl_GTuoePKw5FuJspAmqWZ6i8qPbbKU`. Projects are respectively `prj_R1HZBGGMawLICQ3xkbfo28sETQ7v` and `prj_zJtdKG0psjlaE2BJSskxMO4391AM`, team `team_qxpNXfBGSsHy99tHQ9J0ugL1`.

A narrowly projected Vercel metadata read, with decryption disabled, found no project-level `MH_MODE`, `MH_INVITE_ONLY` or `MH_LIVE_GATE` override on the web project. Reading only the identified nonsecret `MH_REGISTRAR_MODE` entry returned `live`. Production source defaults therefore imply production mode and invite/live gates on; this is configuration inference, not a new runtime observation. Registrar settings exist as Vercel sensitive entries and their values were not readable. No setting was changed, unrelated value retained, or secret exported. Public HTTP checks from this environment failed (DNS resolution/tool access), so a fresh rendered-page/runtime verification remains a deployment acceptance check. The proposed database pauses enforce the restricted release independently of invite-gate inference.

## Sequence after exact approval

1. Confirm the approved candidate SHA, main/base SHA, both project IDs and production aliases. If main or the candidate changed, review that difference before proceeding. Preserve PR 45, the Claude branch, all worktrees and existing resources. Confirm final candidate CI and local migration-rehearsal evidence.
2. Re-run the same narrow read-only ledger, constraint, receipt, job and deadline checks. Stop for schema drift, new in-flight/unknown work, urgent renewal/transfer obligations or unapproved migrations; do not delete, backfill, cancel or retry customer work to make the check green.
3. Execute the approved three-row pause transaction. Verify exactly three rows are true. Let already-running application requests drain (the web function allows up to 800 seconds); inspect active work again after that interval. A quiet receipt/job table alone cannot establish a remote provider's terminal outcome. Investigate any ambiguous operation without repeating its write.
4. Apply only the reviewed two-migration transaction, taking advisory lock `727001`, the same lock used by the existing migrator. The ledger and schema must agree before a skipped migration is considered applied. Verify constraints, the valid partial index, the two ledger entries and preserved legacy receipts afterward. Preserve raw SQL files; do not rewrite already-recorded migrations or mask drift with `IF NOT EXISTS`.
5. Merge the approved PR only after successful schema verification. Main is connected to production Git deployment; merging earlier could deploy queries against missing columns. Track both web and registrar builds through READY, and verify the actual Git SHA behind both production aliases. Do not promote an unrelated preview or silently change environment settings. Branch guards prevent feature-branch deployments; they do not block main.
6. Verify public pages, anonymous `/api/v1/session` (including `live_gate`), OAuth discovery, expected unauthenticated access denial and ordinary health through a permitted read-only path. Do not call cron manually or create grants, enroll factors, send mail, purchase domains or exercise provider writes as a smoke test. Re-read the three pause flags and schema. If these checks cannot be made, report deployment as unverified and keep restrictions in place.
7. Ask the owner to use an existing passkey for the first bounded real-device acceptance check while restrictions remain: sign in, inspect Account and Connected apps, and cancel/retry a harmless prompt. Enrollment, recovery initiation, factor removal, session revocation, grant creation and sensitive actions are outside this check. Virtual-authenticator results remain fixture evidence until real-device behavior is observed. Broader rollout and provider validation remain separate decisions.

## Failure and rollback

An error or timeout does not authorize repeating a provider write or assuming migration failure. For the single-transaction migration package, inspect the ledger and catalog with a read-only query before retrying: both migrations should commit together or neither should. If using the existing direct migrator with an already-approved session-affine owner connection instead, each file commits separately; successful `0998` can remain when `1130` fails. Re-running the pinned two-file directory skips recorded migrations. Never obtain or create credentials merely to use this alternative.

If a deployment fails or acceptance exposes a regression, keep the three flags paused and restore both known preceding production deployments above through Vercel's supported rollback. Do not undo either additive migration, delete receipts, clear ledger rows, restore old grant authority or reopen flags. Old application code can ignore the new columns and accepts the old request kinds. Inspect any nameserver proposal created by the new version; it remains non-executable. Rollback restores source behavior, not remote effects or cached DNS answers. Vercel rollback changes automatic production-assignment behavior; check and explicitly review the next promotion instead of assuming a later push will restore it.

Retain the final candidate and deployed SHA, deployment IDs, exact SQL digest, applied ledger names, flag values, aggregate checks, test results and any acceptance failures. No global DNS propagation, live-provider compatibility or real-device security guarantee follows from local tests or a READY deployment.
