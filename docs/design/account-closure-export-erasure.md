# Account closure, export and erasure: Phase 2 design

Status: design only. The chain format, PII columns and export shape are fixed in Phase 2; the flows are built in Phases 3 (closure, released names) and 4 (export, vault destruction). Sources: PLAN 4.3b "Account closure, export and erasure" and "Backup, restore and regional failure", decisions D-027 and D-030 (Proposed default). What Phase 2 already ships is marked **built**.

## 1. States and transitions

`active -> closing -> closed -> purged` (column `users.status`; `pending` exists only before sign-up completes).

| Transition | Trigger | Effects (one transaction unless noted) |
|---|---|---|
| `active -> closing` | Signed-in owner asks, passkey step-up | New orders blocked. Sessions, bindings and mandates revoked. Every domain is offered transfer-out first (deletion within 45 days, C-28). A `closing` row of the audit chain is written. |
| `closing -> closed` | All domains transferred out, released or deleted, and no open order, refund or dispute | `chain.closed` row seals the user's audit chain; its hash goes to the external anchor at the next `audit.anchor`. Stripe customer deleted, Resend contact removed, cards unpublished and CDN cache invalidated (Phase 3 to 4). |
| `closed -> purged` | `retention.purge` after the longest applicable retention, or immediately for an erasure request that has no legal hold | **Built:** `eraseUser()` (packages/api/src/ops/erasure.ts) deletes notification addresses, contacts, passkeys, sessions, email action tokens, recovery codes, challenges and codes; revokes bindings and mandates; replaces the address with `erased-<id>@erased.invalid`; sets `status = 'purged'`; appends `account.erased` to the user's chain. The `users` row stays as a tombstone because orders and payments reference it. |

Closure never deletes money records that the law requires us to keep (sales ledger, receipts, consents: `retain_until`, `legal_hold`). Those rows carry ids only; the identifying tables are the ones erased.

## 2. What the audit chain holds after erasure

Pseudonymous by construction: `actor_id` and `resource_id` are opaque ids; `detail` holds ids and counts (enforced by convention and by the `appendAudit` contract); domain ids, not names. Erasure therefore leaves the chain intact and verifiable, and the erased user's `pii` column is null. A closed account's chain is sealed by `chain.closed`. Deleting a sealed chain after the retention period needs a separate `retention` database role (not the app role, not cron) and writes a tombstone `{chain_id, sealed_hash, deleted_at}` to the anchor store first. Phase 4 builds that role; until then no code path deletes an audit row (the triggers in migration 0006 forbid it below the application).

Open point for counsel: whether a per-user audit key (destroyed on erasure) is needed on top of pseudonymous ids. The plan text mentions it; the current chain uses one KMS key for all chains, which keeps verification simple. Recommendation: not needed while `detail` and `pii` carry no direct identifiers; revisit if `pii` is used for anything but transient support context.

## 3. Restore safety: the erasure ledger

**Built.** `ErasureLedger` (packages/api/src/ops/erasure.ts) is an append-only list of `{sha256("mh-erasure-v1:" + userId), erasedAt}` held outside the database (log-archive bucket in production, a file locally). Order of operations for an erasure: append to the ledger, then run `eraseUser`. A crash between the two is repaired by the next `retention.purge`, which replays the whole ledger against the database (`purgeFromLedger`). Every point-in-time restore and every snapshot restore ends with the same replay; `restoreDrill()` performs it and fails the drill if any ledger user is still not purged afterwards (ST-143, ST-152).

The Privacy Notice says erased data may persist in database history for the restore window (7 days at Launch, 30 at Scale) and in Resend logs for 30 days.

## 4. Export (`account.export`, Phase 4)

- Requested from a signed-in session; a passkey step-up is not needed to request, but the download link also needs a signed-in session. The request creates an `account_exports` row and a job.
- Contents: profile (no credentials), domains and DNS records, orders and receipts, the account's own audit trail, and secret names with version metadata. Secret values are never in the export; they come only through CLI `pull` or a step-up reveal.
- Format: one JSON file plus CSV per table, zipped, encrypted at rest with the PII key, stored under `storage_ref`, delivered as an expiring signed link within 30 days of the request (target: 24 hours). `expires_at` is 7 days after `ready_at`.
- The export job runs as the tenant (`withUser` on the runtime role), so RLS bounds what it can read.
- Not built in Phase 2: the job, the link and the storage. Schema is in migration 0005 (`account_exports`).

## 5. Third parties on closure or erasure

| Party | Action | Note |
|---|---|---|
| Stripe | Delete the customer | Charges and refunds stay in Stripe's ledger under their own retention. |
| Resend | Remove the contact | Message logs persist 30 days. |
| Cards (hatchkind.com) | Unpublish, invalidate the CDN cache | Phase 6 surface, designed here. |
| OpenSRS | None possible | Keeps registration and payment records for 3 years (MSA 3.9); the Privacy Notice says so. |

## 6. Released names

A domain that leaves us (registry deletion, completed transfer-out, auction, refund deletion, closure, UDRP outcome) gets `released_at` in one transaction on adapter confirmation, never while the name can still be restored: bindings scoped to it are revoked, pending requests cancelled, mandates revoked, cards unpublished, connections ended, queued jobs cancelled. Secret ciphertext is destroyed after a 30-day hold during which only the owner can export by domain id with a step-up. Re-registration inserts a new `domains` row, so the previous tenant's scopes and Nest never attach to the next owner. The partial unique index `domains_live_fqdn` (where `released_at is null`) already allows the new row.

## 7. Test plan (when built)

1. Closure walks every state and refuses `closing -> closed` while a domain, order, refund or dispute is open.
2. After erasure no table outside the money and audit tables contains the address, name or any contact field of the erased user (scan every text column of the database for the seeded values).
3. Chain verification passes after erasure; anchor verification passes.
4. Restore to a point before an erasure, then replay: the user is purged again (built for ST-143; extend to the export table and to Stripe deletion jobs).
5. Export contains no secret value, no ciphertext, no other user's row; its link fails without a session, after expiry and for another user.
6. Released-name re-registration by another user sees none of the previous tenant's scopes.

## 8. Not decided here

Retention periods per `retention_class` (counsel, C-rows for sales records and consents); whether closed accounts are purged on request before the longest retention (recommendation: erase identifying tables at once, keep money records until their `retain_until`); the `retention` role's credential custody (break-glass style, hardware key).
