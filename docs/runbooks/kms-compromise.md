# Runbook: vault KMS compromise

Template: PLAN section 5. Written in Phase 4 with the vault (`packages/api/src/vault/drill.ts`). The drill runs against the local KMS fake in CI (`packages/api/src/vault/drill.test.ts`). **It has never run against AWS**: no AWS account exists yet. The AWS steps below are the documented calls, not tested ones. Rehearse them in the staging account before the Nest opens to anyone but the founder, and log the timings at the end of this file.

## Trigger

Any of these:

- An `kms.decrypt_unaudited` page from `audit.kms_reconcile`: a CloudTrail Decrypt with no matching reveal or read row.
- A `kms.decrypt_volume`, `kms.secret_diversity` or `vault.secret_diversity` page.
- A CloudTrail alarm on `AssumeRoleWithWebIdentity` with an unknown `sub` or `aud`, or on `CreateGrant`, `PutKeyPolicy`, `DisableKey` or `ScheduleKeyDeletion`.
- A leaked `x-vercel-oidc-token` header or OIDC audience value.
- An unexpected production deployment or dependency install script.
- A `vault.integrity` page (a stored row failed authentication).

## Severity

S1. Page immediately. The founder is the sole on-call; the second trusted person has read-only alert access and the emergency sheet.

## What an attacker could do

If code runs in the production `web` project, it can call `Decrypt` for any wrapped key it can read (PLAN 4.3b, Blast radius). KMS does not prevent this. KMS does three things here: it lets us revoke access, it keeps an independent trail in CloudTrail, and it makes a database-only leak useless. Values that were decrypted before the Deny are exposed. Rotating the key does not un-expose them; only the customer can rotate the secret where it was issued.

## First 15 minutes: stop decrypts

The code calls each step `revoke_and_deny`, `disable_keys` and so on (`runCompromiseDrill`).

1. **Revoke and deny** (`revoke_and_deny`). Use the incident identity, never the `web` role. Attach an explicit IAM Deny on `kms:Decrypt`, `kms:GenerateDataKey` and `kms:ReEncryptFrom` to both runtime roles, `vault-prod` and `vault-nonprod`. This is reversible and takes effect for sessions that were already assumed. `autoDenyOnUnauditedDecrypt` does the same thing automatically when a `kms.decrypt_unaudited` alert is open. Then take away the source of new sessions: remove the IAM OIDC provider's audience, or the role trust policy. AWS "revoke active sessions" does not deny sessions assumed afterwards, so it is not the main stop.
2. **Per-customer block, if you do not need an outage.** Add a key-policy Deny on `kms:EncryptionContext:owner_id = <user id>` (`denyOwner`).
3. **Disable the key.** Do this in staging for the drill, and in production only if steps 1 and 2 cannot be applied (`disable_keys`). `DisableKey` takes down every customer's reveals and reads at once. The break-glass role, on a hardware key, is the only principal allowed to do it. From the moment of the Deny, the vault answers `503 vault_unavailable` and the CLI exits 75. This is expected.
4. Set `registrar_writes_paused` only if the same identity can reach the registrar project (it should not).

## Scope the exposure (`scope_from_trail`, `affected_list`)

1. Pull CloudTrail `Decrypt` and `ReEncrypt` events for the window. The window runs from the earliest suspicious event, minus the 1-hour maximum role session, to the Deny. Filter to the compromised principal or session name if known; otherwise take everything in the window.
2. Run `affectedFromTrail(ctx, events, { from, to, principals })`. It returns one entry per customer (`user_id`), and each entry lists the records whose encryption context shows a successful decrypt. For each record it gives the count, whether a reveal, read or credential-use audit row matches it, and `unaudited`, the number of records with no matching audit row. Contexts that name an owner who does not own the record are dropped as forged.
3. If the key itself (not one session) is suspected, the affected set is everyone with material under that key: `customersUnderKek(ctx, kekRef)`.
4. Record the incident id, the window, the counts and the list's hash in the incident log. Do not copy secret names or values into the log, a ticket or chat.

## Notify (`notices`)

`sendCompromiseNotices(ctx, incidentId, affected)` sends one notice to each affected customer, at every notification address, at once (class B, immediate). Each send also writes a `vault.incident.notice` audit row. The template (`VAULT_MAIL.incident`) contains counts and a short incident reference only. It never includes names or values. It tells the customer to rotate the affected secrets where they were issued.

Counsel decides regulator and partner notices (GDPR Article 33: 72 hours from awareness where personal data is involved; stored provider credentials: tell Vercel, Neon and Resend under their terms). See C-73 for legal process.

## Migrate to a new KEK (`new_keys`, `reencrypt`, `retire_old_keys`, `lift_role_deny`)

Values, nonces, tags and the AAD are untouched. The AAD names the KEK class, never the ARN, so a re-wrap within the class keeps every row valid.

1. Create one new symmetric key per class (`vault-prod`, `vault-nonprod`) as multi-Region keys with the us-east-2 replica. Apply the standard key policy (`defaultKeyPolicy`): runtime use pinned to `app`, `env` and the exact context key set; operator `ReEncryptFrom` and `ReEncryptTo`; humans denied Decrypt; destroy and grant operations limited to break-glass.
2. On each old key, remove the runtime statement so only the operator can use it (`restrictToOperator`), and enable it again if it was disabled.
3. Point the application at the new keys: update the KEK ARNs in the `web` configuration (`currentKek`) and redeploy. New writes go to the new key.
4. Run the `vault.rewrap` job, or `rewrapAll(ctx, oldKek, newKek)` per class, under the operator role, which Vercel cannot assume. It re-wraps each `secret_versions` and `connection_credentials` row with `ReEncrypt`, using the same encryption context. Each row is written with a compare-and-set on the old wrapped key, so the job resumes safely after a failure. Stop when `remaining = 0`.
5. Verify. No live row names the old key (`select count(*) from secret_versions where kek_ref = $old and destroyed_at is null` is 0, and the same for `connection_credentials`). A sample of reveals across both classes succeeds. The canary secret from the monthly restore drill decrypts.
6. Disable the old keys (`retire_old_keys`). Schedule deletion only after the backup retention window has passed, with the 30-day waiting period: old off-Neon backups still hold keys wrapped by them.
7. Lift the role Deny (`lift_role_deny`), but only after the entry point is closed (the compromised deployment removed, and the OIDC audience rotated if it leaked). The new keys are the only usable ones.

## Decision owner

Founder. The second person may carry out steps 1 and 3 of the first 15 minutes on instruction.

## Timings

| Date | Where | revoke and deny | disable | scope and list | notices | re-encrypt | total | Rows |
|---|---|---|---|---|---|---|---|---|
| 2026-09-30 | CI, local KMS fake, local PostgreSQL 16 | 0.1 ms | 0.1 ms | 9 ms | 59 ms | 91 ms | 161 ms | 14 rows, 3 customers |
| (owed) | staging AWS account, `iad1` function | | | | | | | |

The CI figure proves the order of the steps and the code path. It says nothing about AWS latency, IAM propagation (Deny statements can take seconds to minutes to apply) or CloudTrail delivery (about 5 minutes, up to 15). The staging rehearsal must record those.

## After

- Rotate the OIDC custom audience. Review the Deployment Policies and the lockfile for the release that introduced the code.
- Close the alerts and write the incident record: the window, the affected count, the time from page to Deny, and the time from Deny to the end of the migration.
- Re-run the timed drill in staging within 30 days.
