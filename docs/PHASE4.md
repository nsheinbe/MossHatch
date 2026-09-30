# Phase 4 report: the Nest

Status: built and tested in process against a real PostgreSQL 16 (local, Node 22.22.2), with the Nest tab and the device approval page in the web app. **AWS KMS and CloudTrail were never called**: no AWS account exists, so every key-policy, IAM, trust-policy and CloudTrail statement below is about the local KMS fake, the trust-policy evaluator in `vault/kms/trust.ts` and a fake trail. The Vercel, Neon and Resend recipe providers were never called. The CLI was never published and never run against a deployment. The paid independent review of the vault and the step-up path (D-032) has not happened. You waived the phase gates on 2026-09-30 (D-050); the honesty rules still hold, so nothing that ran only against a fake is called verified.

## What shipped

- **Vault** (`packages/api/src/vault`, migrations 0800 and 0805): one data key per value from `GenerateDataKey`, AES-256-GCM with a fresh random 96-bit nonce and a 16-byte tag checked on both sides, and AAD built as RFC 8785 canonical JSON of the row identity, including the KEK class (D-047). Two KEK classes: `vault-prod` for `prod` and `vault-nonprod` for `dev` and `preview`, chosen from the stored environment. Values are capped at 16 KiB (413). The pointer MAC is a KMS HMAC over the secret's identity, its current version and a fresh nonce, and a trigger refuses any MAC the database has held before (0805). Secrets CRUD by environment, versions and restore; delete nulls the ciphertext and wrapped key of every version at once; a re-wrap job with compare-and-set; every KMS error fails closed with 503 `vault_unavailable`.
- **KMS ports**: a local fake that enforces the encryption context, disable and explicit deny; an AWS KMS adapter over the JSON protocol with its own SigV4 signer (`vault/kms/aws.ts`, never called and not yet wired into boot; the signer matches the AWS `get-vanilla` test vector and nothing else); the trust-policy evaluator for the OIDC role.
- **Reveal** (`vault/reveal.ts`): a `secret.reveal` step-up (prepare and commit), then one reveal within 60 seconds of the commit (own target, inside the 120-second action life), single use. Every vault route answers `no-store`. The audit row (ids only) commits before KMS is called; the reveal sends the notification email; limits of 3 a minute per secret and 5 a minute and 30 an hour per user.
- **Bearer read** (`POST /api/v1/domains/{fqdn}/secrets/{env}/read`): scope required, `:prod` named explicitly, a missing scope is 403 and never an empty list, one audit row per secret before decrypt; per token, 20 reads a minute, 500 a day and 6 an hour on `prod`; an hourly digest email.
- **Alarms and the compromise drill** (`vault/alarms.ts`, `vault/drill.ts`, `ops/kms-reconcile.ts`): Decrypt-volume and secret-diversity alarms; the reconcile matches one audit row to one Decrypt, runs every 5 minutes from a cursor, pages within 15 minutes and pages when it cannot read the trail; auto-deny on an unaudited Decrypt; the timed drill (revoke and deny, disable, scope from the trail, per-customer list, notices, new keys, re-encrypt, retire, lift).
- **Stored provider credentials** (`vault/connections.ts`): Vercel, Neon and Resend credentials through the same envelope; only the `recipe.apply` and `connection.check` jobs decrypt them; disconnect destroys them.
- **Tokens and bindings** (`packages/api/src/bindings`, migration 0850): tokens stored as SHA-256, shown once, refused after 30 days unused; the scope grammar and parser; the lint that refuses `secrets.read` with `dns.write`; the widening classifier (narrowing is free, anything else goes to `agent.token.widen`, a bearer PATCH is refused); single revoke and `POST /api/v1/bindings/revoke-all` in one transaction; push of many values, all or nothing, with reserved names refused.
- **Device flow** (RFC 8628): a 256-bit device code and an `XXXX-XXXX` user code; the approval page needs the typed code and a `device.approve` passkey and ignores a code in the URL; 600-second life, `slow_down`, one-time use; wrong-code limits per account and per address; the grant email goes to every notification address with a revoke link; 60-minute access tokens and rotating refresh tokens (reuse revokes the family; 30-day idle); per-account and global kill switches. A CLI grant is capped to `dev` and `preview`.
- **CLI** (`packages/cli`): `login`, `logout`, `whoami`, `pull`, `push` and `run`, bundled into one file (`dist/mosshatch.mjs`) with its SHA-256 beside it and no dependencies. Tokens go to the OS keychain only when `@napi-rs/keyring` is installed beside the CLI; a plain install keeps them in a 0600 file and warns every time it writes it (see Decisions). Refreshes run under a lock file. `pull` needs `--out` or `--stdout`, and `--out` refuses symlinks and paths under `.git`. The dotenv writer quotes every value in the first form common readers load unchanged (D-044); `--format shell` single-quotes. `run` injects values into the child only, returns its exit code, strips `MOSSHATCH_TOKEN` and masks values when output is not a terminal. The publish workflow (`.github/workflows/cli-publish.yml`) runs only on manual dispatch from a `cli-v*` tag, with npm trusted publishing and provenance. It has never run: no such tag exists.
- **Wire-it recipes** (`packages/api/src/recipes`): a versioned registry for hosting on Vercel, Postgres on Neon and email on Resend. A plan is previewed first. A human-started plan with a sensitive record, or with a billable or unknown-cost step, needs one approval that binds the plan hash; the applied set must equal the previewed hash. DNS writes take the domain-management snapshot before the registrar call. A dangling-target scan flags a host answering with the provider's not-found page; disconnecting removes the recipe's records and destroys the credential. Real provider adapters exist (`recipes/providers.ts`) and are installed only in staging and production; every test uses fakes.
- **Web** (`apps/web/src`): the Nest tab (`ui/NestTab.tsx`): names per environment, add and delete, versions and restore. Hold-to-reveal (a one-second pointer hold) with a single-activation path for keyboard, switch and voice users (D-010); the re-hide timer is adjustable up to ten times the default; the value goes into one DOM node and is wiped on hide; copying a `prod` value is off until turned on and the primary copy is the `run` command. The device approval page (`ui/DeviceApprove.tsx`). Trusted Types is enforced in the CSP (`require-trusted-types-for 'script'; trusted-types mosshatch`).

## Measured

| Item | Result |
|---|---|
| Phase 4 unit and database tests (`npx vitest run` on the paths below, 2026-09-30 about 17:47 UTC, code as at commit `ce79de0`) | 163 passed, 0 failed, 0 skipped |
| `packages/api/src/vault` | 58 (bearer 8, drill 6, envelope 10, kms 16, nest 17, wiring 1) |
| `packages/api/src/bindings` | 46 (bindings 20, device 22, scope matrix 4) |
| `packages/api/src/recipes` | 19 |
| `packages/api/src/security/vault-canary.test.ts` | 1 |
| `packages/cli` | 23 (cli 20, pack 3) |
| `apps/web/src/reveal` | 16 |
| Re-runs for the first bearer principal | `security/matrix.test.ts` 14, `foundation.test.ts` 14, `stepup/routes.walk.test.ts` 7: all pass |
| Initial JS / engine chunk (`npm run build`, `scripts/check-budgets.mjs`) | 87.7 kB / 149.1 kB gzip (limits 130 / 150) |
| New lazy chunks | NestTab 5.8 kB, DeviceApprove 2.4 kB, StepUp 0.8 kB, rehide 0.3 kB gzip |
| CLI bundle | one file, 33,151 bytes (11.2 kB gzip); the stored SHA-256 matches the file |
| KMS compromise drill (`vault/drill.test.ts`) | 161 ms end to end against the local KMS fake and local PostgreSQL, 14 rows, 3 customers (logged in `docs/runbooks/kms-compromise.md`). This proves the order of the steps and the code path, not AWS timing |
| Playwright | Not run for this report. The Phase 4 browser specs are `e2e/nest-rescue-account.spec.ts`, `e2e/sensitive-screens.account.spec.ts` and the ST-38 and ST-70 tests in `e2e/prod.spec.ts` |

## Exit criteria

| Criterion | State |
|---|---|
| ST-01 to ST-13, ST-15, ST-17 to ST-20, ST-23 to ST-33, ST-38 to ST-40, ST-62 to ST-66, ST-69 to ST-72, ST-85 to ST-90, ST-129, ST-130, ST-141, ST-153, ST-154 pass | **Not met.** 50 of the 52 ids have a named test that passes; ST-153 and ST-154 have none (they need an AWS account). ST-06 to ST-11 pass only against the KMS fake, the trust-policy evaluator and a fake trail, where the plan names the staging account. ST-18 and ST-40 are partly covered (table below) |
| The canary gate is green for values, names, tokens and the OIDC header | Met against fakes only. Values: `security/vault-canary.test.ts` drives every vault route through success and forced failure with the local KMS fake. Names: ST-20. Tokens and the OIDC header: ST-16 in `security/matrix.test.ts` over every route. The browser half checks page HTML, browser storage and a heap snapshot only (see Not proven) |
| The recipe preview equals what is applied | Met against fakes only (`recipes/recipes.test.ts`: "applies exactly what it showed", ST-86) |
| The CLI works against staging with the device flow and a `dev` grant | **Not met.** No staging deployment exists. In process, `login` runs the device flow and the approved CLI reads `dev` and nothing else (`cli/cli.test.ts`, `bindings/device.test.ts`) |
| The route walk (ST-67) and the scope matrix re-run for the first bearer principal | Met (`foundation.test.ts`, `security/matrix.test.ts`, `bindings/scope-matrix.test.ts`) |
| The cross-tenant matrix re-runs over secrets, connections, audit, recipes, device flow and CLI bearer | Met: the matrix is generated from the route table and covers every Phase 4 route; `bindings/scope-matrix.test.ts` adds the bearer half of ST-91 |
| The timed key-compromise drill is done | Met against fakes only (161 ms, local KMS fake). The staging drill against AWS is owed |
| The independent review (D-032) is closed | **Not met.** No paid reviewer was engaged. Other agents in this build reviewed the vault, the step-up path and the token and CLI modules adversarially (below). That is not a substitute for D-032 |
| Compliance rows C-55, C-58, C-73 built or deferred in writing | **Not met** (table below; you have approved no deferral) |

## Security tests due in this phase

Every vault test wraps data keys with the local KMS fake; the AES-GCM, AAD, database roles and triggers they exercise are real. Paths are relative to `packages/api/src` unless they start with `packages/`, `apps/` or `e2e/`.

| ST | Test | State |
|---|---|---|
| ST-01 | `vault/envelope.test.ts` "changing any one AAD field makes decrypt fail" | Passes |
| ST-02 | `vault/envelope.test.ts` "tampering fails closed" | Passes |
| ST-03 | `vault/nest.test.ts` "swapping the names of two secrets in one domain and env fails to decrypt" | Passes |
| ST-04 | `vault/nest.test.ts` "pointing current_version_id at an older version fails the pointer MAC"; "replaying a saved ... triple after a rotation is refused" | Passes |
| ST-05 | `vault/nest.test.ts` "deleting nulls ciphertext and wrapped_dek of every version at once; re-wrap keeps the plaintext; over 16 KiB is 413" | Passes |
| ST-06 | `vault/kms.test.ts` "the key policy denies a wrong principal, a human SSO role and the web role's own Decrypt outside the vault role (fake)" | Passes against the fake only |
| ST-07 | `vault/kms.test.ts` "only the pinned production token can assume the vault role (trust-policy evaluator)" | Passes against the evaluator only |
| ST-08 | `vault/kms.test.ts` "the runtime roles are denied everything outside GenerateDataKey and Decrypt (fake)" | Passes against the fake only |
| ST-09 | `vault/kms.test.ts` "a prod wrapped key sent to vault-nonprod is AccessDenied (fake)"; `vault/bearer.test.ts` "a dev- or preview-scoped CLI or agent token cannot obtain a prod read" | Token half passes; KMS half against the fake only |
| ST-10 | `vault/drill.test.ts` "Decrypt-volume and secret-diversity alarms fire"; `ops/kms-reconcile.test.ts` (7 tests, including "an unmatched Decrypt delivered 5 minutes late pages within the 15-minute target") | Passes against a fake trail only |
| ST-11 | `vault/kms.test.ts` "the auto-deny blocks Decrypt for an existing session and is removable (fake)"; `vault/drill.test.ts` | Passes against the fake only |
| ST-12 | `vault/nest.test.ts` "the runtime database role cannot insert reveal or read audit rows; the vault role can"; "connection.credential.used rows ... also need the vault role" | Passes (real PostgreSQL roles) |
| ST-13 | `vault/nest.test.ts` "with KMS down, reveal, write and re-wrap fail closed with 503 vault_unavailable and log no context" | Passes (KMS stub, as the plan specifies) |
| ST-15 | `vault/nest.test.ts` "reveal and every vault route answer no-store, private ... and the value never rides in a URL" | Passes; the app has no service worker |
| ST-17 | `security/vault-canary.test.ts` "the value canary appears only in reveal and read response bodies" | Server half passes; browser half partial (see Not proven) |
| ST-18 | `vault/nest.test.ts` "malformed, truncated, oversized and non-UTF-8 bodies, KMS AccessDenied, throttling and timeout, and a name race leak nothing" | Partly tested: the MCP secret tools' malformed-body cases and a CLI crash are not in the test, and the CLI has no `--debug` flag |
| ST-19 | `apps/web/src/reveal/reveal.test.ts` "a truncated reveal response leaves no canary in the error, its stack or the console"; `e2e/nest-rescue-account.spec.ts` | Unit test passes; browser spec not run for this report |
| ST-20 | `vault/nest.test.ts` "a name that is a canary, an sk_live_ string or 200 characters is refused with 422 and appears nowhere" | Passes |
| ST-23 | `vault/nest.test.ts` "no committed step-up is 403; one assertion reveals one secret, once" | Passes |
| ST-24 | `vault/nest.test.ts` "secret.reveal is refused during the passkey hold and the recovery hold, with the hold end in the response" | Passes |
| ST-25 | `vault/nest.test.ts` "3 a minute per secret, 5 a minute and 30 an hour per user"; `vault/bearer.test.ts` (agent traffic never counts) | Passes |
| ST-26 | `vault/nest.test.ts` "the audit row commits before KMS; a failed insert stops the reveal; a KMS failure does not reopen the action" | Passes |
| ST-27 | `vault/nest.test.ts` "a reveal sends the notification; more than 5 reveals in an hour raises the alert" | Passes |
| ST-28 | `vault/bearer.test.ts` "a cookie session is refused, a missing scope is 403 ... and prod needs an explicit :prod" | Passes |
| ST-29 | `vault/bearer.test.ts` "one audit row per secret commits before decrypt; if that write fails the read fails" | Passes |
| ST-30 | `vault/bearer.test.ts` "token read limits return 429 ... and the hourly digest email is sent" | Passes |
| ST-31 | `bindings/device.test.ts` "a CLI login grant is capped to dev and preview" (3 tests); `vault/bearer.test.ts` | Passes |
| ST-32 | `bindings/bindings.test.ts` "secrets.read with dns.write is refused at creation and at widening"; `vault/bearer.test.ts` | Passes |
| ST-33 | `packages/cli/src/cli.test.ts` "a scripted mosshatch run leaves the canary in no log or audit row" | Passes |
| ST-38 | `e2e/prod.spec.ts` "ST-38 Trusted Types is enforced with zero violations" | Browser spec (Chromium); not run for this report |
| ST-39 | `e2e/nest-rescue-account.spec.ts` (heap snapshot after reveal, hide and a forced collection) | Browser spec (Chromium); not run for this report |
| ST-40 | `apps/web/src/reveal/reveal.test.ts` "copy and clipboard" (4 tests) | Partly tested: the manual Safari and Firefox checklist has not been done |
| ST-62 | `bindings/bindings.test.ts` "tokens are hashed, shown once, looked up by hash, and idle tokens fail" | Passes |
| ST-63 | `bindings/bindings.test.ts` "the scope parser" | Passes |
| ST-64 | `bindings/bindings.test.ts` "the widening classifier" (property test, 5,000 cases) | Passes |
| ST-65 | `bindings/scope-matrix.test.ts` "scope matrix (token x route x env), generated from the route table" | Passes |
| ST-66 | `bindings/bindings.test.ts` "revoke-all" (3 tests) | Passes |
| ST-69 | `bindings/device.test.ts` "wrong user-code entries are limited per account and per address" | Passes |
| ST-70 | `bindings/device.test.ts` "approval needs the typed code"; `e2e/prod.spec.ts` "/device ignores a code in the URL" | Unit tests pass; browser spec not run for this report |
| ST-71 | `bindings/device.test.ts` "refresh rotation, reuse and revoke" | Passes |
| ST-72 | `bindings/device.test.ts` "approved scopes equal the scopes shown; the grant is audited and mailed; the kill switches" | Passes |
| ST-85 | `recipes/recipes.test.ts` "recipes.apply alone writes nothing; a dev token cannot target Vercel production or preview" | Passes against fake providers |
| ST-86 | `recipes/recipes.test.ts` "billable or unknown-cost steps need the plan-hash approval for every principal; applied equals previewed" | Passes against fake providers |
| ST-87 | `recipes/recipes.test.ts` "no route, tool or command returns a stored provider credential" (includes a source scan) | Passes |
| ST-88 | `recipes/recipes.test.ts` and `bindings/bindings.test.ts` "reserved and malformed names"; secret PUT in `vault/nest.test.ts` (ST-20 test) | Passes |
| ST-89 | `packages/cli/src/cli.test.ts` "reserved names in run and pull; hostile values round-trip" | Passes |
| ST-90 | `packages/cli/src/cli.test.ts` "pull needs --out or --stdout, and --out refuses symlinks and .git" | Passes |
| ST-129 | `recipes/recipes.test.ts` "one approval per human-started plan with a sensitive record, and nothing hides" | Passes |
| ST-130 | `recipes/recipes.test.ts` "dangling targets are flagged in one scan, and disconnecting removes the recipe's records" | Passes against a fake probe |
| ST-141 | `packages/cli/src/pack.test.ts` "the packed CLI" | Passes on a local pack; the package has never been published |
| ST-153 | none | **NOT TESTED**: needs an off-Neon backup, a scratch project and a multi-Region KMS key |
| ST-154 | none | **NOT TESTED**: needs the AWS organisation and the staging account |
| ST-67 re-run | `foundation.test.ts`, `security/matrix.test.ts`, `agents/walk.test.ts` | Passes |
| ST-91 re-run | `security/matrix.test.ts`, `bindings/scope-matrix.test.ts` | Passes |

## Compliance rows for this phase

| Row | State |
|---|---|
| C-55 accessibility | Partly built. axe WCAG 2.2 AA runs in the Nest, reveal and device-approval browser specs (not run for this report); the single-activation reveal path and the adjustable re-hide are built (D-010). The manual keyboard and screen-reader passes have not been done |
| C-58 `.dev` and `.app` HTTPS | **Not built.** There is no HTTPS note at checkout for `.dev` and `.app` (Hatch sheet row 10, D-024), and no TLS check before a recipe points DNS at a host on those names |
| C-73 legal process for secrets | Counsel. `/legal/legal-process.html` is an outline marked "Draft awaiting counsel". Support has no path to values (ST-144, Phase 2). Logging a disclosure with `actor_kind = 'support'` has no code path yet |

No row is deferred: you have approved no deferral.

## Review findings fixed in this phase's modules

Other agents reviewed these modules adversarially; each finding was reproduced by a failing test before its fix. The first round raised 6 findings in the vault and 9 in tokens and the CLI; 14 are fixed and 1 is open.

| Module | Finding | Fix and test |
|---|---|---|
| Vault | A database writer could save a secret's pointer triple and write it back after a rotation, serving the old value again | Pointer MACs carry a fresh nonce and 0805 refuses any MAC seen before; `vault/nest.test.ts` (ST-04 replay) |
| Vault | The drill stopped on a non-UUID `owner_id` or `secret_id` in the trail after the keys were disabled | Reported as unattributable; `vault/drill.test.ts` |
| Vault | An attacker's extra Decrypt of a record that was also read legitimately was hidden by the legitimate audit row | One audit row covers one Decrypt; `vault/drill.test.ts`, `ops/kms-reconcile.test.ts` |
| Vault | A disconnect landing while a connection PUT was inside KMS could leave a live credential, and concurrent PUTs could return 500 | `vault/drill.test.ts` "connection writes race a disconnect" |
| Vault | Runtime code could insert `connection.credential.used` audit rows and so pre-forge cover for a Decrypt | 0805 extends the vault-role-only trigger; `vault/nest.test.ts` (ST-12) |
| Vault | A preview deployment could turn on the local vault KEK from its environment | Only local mode installs the local vault; `vault/wiring.test.ts` |
| Tokens | An agent's push to `prod` did not email at once or count against the agent write limit | It emails every address at once, and more than 30 values a minute is 429; `bindings/bindings.test.ts` (ST-35) |
| Recipes | A plan did not bind the Neon project | Moving the connection voids an older plan; `recipes/recipes.test.ts` |
| CLI | Two commands refreshing at once presented the same refresh token, and a reuse revokes the family | Refreshes share one lock file; `cli.test.ts` |
| Tokens | A vault failure part-way through a push left a partial write | Push is atomic; `bindings/bindings.test.ts` |
| Tokens | Revoke-all raced a device grant being consumed | `bindings/bindings.test.ts` "a device grant being consumed while revoke-all runs is revoked too" |
| Device flow | An approved device code could be redeemed after its 600-second life | `bindings/device.test.ts` |
| CLI | The `run` masker held back ordinary output | It passes output through at once and holds back only a possible start of a value; `cli.test.ts` |
| CLI | The plan's escaped double-quoted dotenv form is read wrongly by Node's `--env-file` and the dotenv package | Portable quoting (D-044); `cli.test.ts` "pull's dotenv file reads back unchanged through node --env-file" |
| CLI | **Open:** tokens are not in the OS keychain on a plain install | Needs `@napi-rs/keyring` as a dependency, which ST-141's empty allow-list forbids; your decision |

Also fixed in these modules: a refresh refused for a server reason (503, 429) no longer forgets the sign-in, and logout removes a sign-in file left from an earlier fallback (`cli.test.ts`); a recipe's DNS write commits its snapshot and intent before the registrar call (`recipes/recipes.test.ts`); push writes through the vault's own version write, so it gets single-use pointer MACs (`bindings/bindings.test.ts`). In the web app: a value that arrives while the page is hidden is never shown, focus returns to the reveal button after Hide now, a new step-up request replaces a stale summary, and the device approval page locks its scopes while the passkey signs (`e2e/sensitive-screens.account.spec.ts`, not run for this report).

## Deviations from the plan

- **AAD encoding** (D-047): RFC 8785 canonical JSON of `{alg, domain_id, env, format_version, kek_class, kind, name, secret_id, user_id, version}` instead of a length-prefixed concatenation. It adds the KEK class, never the KEK id or ARN, so `ReEncrypt` within a class keeps rows valid and a row moved between classes fails.
- **Pointer MAC**: a fresh nonce in every MAC and a single-use trigger (0805). The plan's MAC over `secret_id || name || env || current_version` was deterministic, and the review showed it could be replayed after a rotation.
- **Dotenv quoting** (D-044): the first portable form per value instead of one escaped double-quoted form.
- **CLI keychain**: a plain install stores tokens in a 0600 file, not the keychain the plan names (D-019), because the package declares no dependencies (ST-141).
- **`mosshatch domains`** (PLAN 4.5 CLI) is not built.
- **Device-flow errors** (`authorization_pending`, `slow_down`) use the house `{error:{code}}` body, not RFC 8628's `{"error": ...}`. Only the Mosshatch CLI reads them today; a third-party RFC 8628 client would not (D-042).
- **AWS SDK**: the KMS adapter signs its own requests instead of using `@aws-sdk/client-kms` (D-013 lists it). The build contract allows no new dependency without a reason, and none was approved.
- **Trusted Types** went straight to enforcement, gated on ST-38's zero violations in the end-to-end run. D-015 asked for Report-Only first and 14 quiet days; no Report-Only header was ever deployed.

## Not proven, and why

- **AWS KMS, IAM and CloudTrail**: never called. The adapter's request and response shapes follow the KMS API reference and are unverified; the SigV4 signer is checked against one AWS test vector. Key policies, the OIDC trust policy, the key-deletion control policy and the multi-Region replica exist only as the fake's model and the evaluator. **The AWS adapter is not wired into boot** (`vault/wiring.ts`): only local mode installs a vault, so in preview, staging and production every vault route answers 503 `vault_unavailable`.
- **Measurements owed by this phase**: KMS latency from an `iad1` function; the build token's `sub` decoded in a throwaway production build; the sandboxed reveal frame decision (D-026). None was done.
- **CloudTrail timing**: the reconcile's 15-minute page is proven with a fake trail delivering 5 minutes late. Real delivery (about 5 minutes, up to 15) and IAM propagation are unmeasured.
- **Recipe providers**: Vercel, Neon and Resend adapters were never called; request shapes are unverified.
- **The CLI**: never published, so npm trusted publishing and provenance are untested; never run against a deployment or on Windows.
- **Browsers**: Chromium only, with a virtual authenticator. ST-40's Safari and Firefox checklist is owed. Firefox before 148 and Safari before 26 ignore Trusted Types (D-015).
- **The canary walk** (PLAN 4.3b store contract): the browser test checks page HTML, `localStorage`, `sessionStorage`, the URL and a heap snapshot. The walk over the store, the scene graph, `Object.keys(window)`, `performance.getEntries()` and a HAR is not built.
- **Account closure and export** (D-030 put them in Phases 3 and 4): not built. Release on closure exists only as a release cause.
- **Neon**: all tests ran on local PostgreSQL 16. The lead reports that the Neon project has migrations only through 0650, so 0800 to 0850 have never run there.

## Runbooks and drills

| Runbook or drill | Written | Rehearsed |
|---|---|---|
| KMS compromise or loss (`docs/runbooks/kms-compromise.md`) | Yes | Against the local KMS fake in CI only (161 ms). The timed staging drill in an AWS account is owed |
| Restore with the vault (ST-153: canary secret decrypts in a scratch project; replica decrypts under a simulated regional failure) | Covered by `docs/runbooks/restore-drill-log.md` for the database only | No. No off-Neon backup, scratch project or KMS replica exists |
| Agent or CLI token leak | Written in Phase 5 (`docs/runbooks/agent-token-leak.md`) | See `docs/PHASE5.md` |

## Decisions needed

1. **AWS account.** Create it (production, staging and log-archive accounts, the KMS keys, CloudTrail and the anchor bucket) so ST-06 to ST-11, ST-153, ST-154, the staging drill and the `iad1` latency measurement can run. Until then the Nest cannot open to anyone.
2. **CLI keychain.** Add `@napi-rs/keyring` as a dependency (it changes ST-141's allow-list and adds a native module), or accept the 0600 file as the default and say so in the help text.
3. **Independent review (D-032).** Engage a paid reviewer for the vault and the step-up commit path, or accept in writing that the internal review stands in until the Phase 6 penetration test.
4. **Sandboxed reveal frame (D-026).** Decide whether the reveal moves to a sandboxed cross-origin frame.
5. **Compliance.** Build or approve deferring C-58 (the `.dev` and `.app` HTTPS note) and the C-55 manual passes; nothing is deferred without your written approval.
6. **Counsel.** The legal-process policy for secrets (C-73, question 19) before the Nest opens to anyone but you.
