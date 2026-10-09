# Public retail launch verdict — 2026-10-09

**Hold public retail launch.** Production source has substantial passing local money-state tests and one documented successful live registration. It still has a destructive DNS inventory defect, and the repository does not establish that the commercial deployment and operational release gates have passed. This verdict is independent of the optional agent DNS and authentication draft.

## Exact scope and fresh verification

- Production source reviewed: `origin/main`, `e311dae` (2026-10-08 end-of-day handoff). It was checked out detached at `/tmp/mosshatch-retail-audit`, a worktree of this same repository. The feature branch and main were not switched or changed.
- Dependencies: `npm ci --ignore-scripts --cache /tmp/mosshatch-npm-cache` completed successfully.
- Test run on 2026-10-09 at 13:51 UTC: **30 files, 270 tests passed; zero failed or skipped**, 41.29 seconds. Native PostgreSQL used isolated test databases on loopback; Stripe, registrar and shared-store effects were fakes. No live purchases, registrations, DNS writes, production database operations or credential changes occurred.
- Per-file results: [retail verification summary](retail-verification-2026-10-09.json). Full execution evidence remains in `/tmp/mosshatch-retail-verification.log` and `/tmp/mosshatch-retail-verification.json` in the selected environment.

Exact command, from the detached production worktree:

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres \
MH_PG_BIN=/tmp/mosshatch-pg-client/bin \
npx vitest run packages/api/src/orders packages/api/src/pricing \
  packages/api/src/domains/gate.test.ts packages/api/src/domains/refunds.test.ts \
  packages/api/src/domains/dashboard-refund.test.ts packages/api/src/domains/funding-decline.test.ts \
  packages/api/src/domains/renewals.test.ts packages/api/src/stripe \
  packages/api/src/registrar-rpc/funding-control.test.ts packages/api/src/registrar-rpc/paid-operation.test.ts \
  packages/api/src/golive packages/api/src/golive.test.ts packages/api/src/transfers \
  --maxWorkers=2 --reporter=default --reporter=json \
  --outputFile=/tmp/mosshatch-retail-verification.json
```

These tests cover duplicate and concurrent Checkout submissions; signed, replayed and out-of-order webhooks; amount/currency/customer guards; one registrar send under concurrent workers; timeout and worker-death reconciliation without blind resend; rival-domain ownership; insufficient funds; capture failures and refunds; renewal reservations; and transfer polling/late completion. Funded admission tests include an eight-account authorization burst with two funded slots and independent concurrent PostgreSQL reservation transactions. They establish behavior with the modeled provider, not real provider accounting, capacity or settlement.

## Decision gates

| Gate | Evidence at reviewed production source | Required before an unrestricted public launch |
| --- | --- | --- |
| Preserve customers' DNS | `packages/registrar/src/openprovider/adapter.ts` filters unsupported RR types in `fromWire`, omits TTL from the port representation, and explicitly removes unseen CAA/other types in `replaceZone` (lines 544–625 at `e311dae`). Browser edits use this adapter too. | Integrate and review the preservation/partial-outcome fix against current production main, or keep affected DNS mutation paths unavailable. The old-base feature draft does not change deployed behavior. |
| Nameserver migration | Production `domain-mgmt/specs.ts` accepts `target_signed` and uses cached DS state; neither proves destination DNSKEY/signature compatibility with parent DS. | Gate unsafe migration until actual state verification and a supported transition exist. The new proposal-only feature deliberately blocks execution; it is not a completed live migration integration. |
| Commercial funding admission | Implemented in `orders/funding.ts`, enabled by commercial registration policy in `boot.ts`; passing tests prove shared-lease admission and durable reservations. | Confirm migration/protocol and both deployed hashes, actual policy/flags, authenticated available/held funds, renewal cushion, provider quotas and pending/debit settlement behavior in an authorized isolated sandbox. The bounded Redis lease cannot bound all asynchronous vendor effects. |
| Full lifecycle | [October 8 audit](https://github.com/nsheinbe/MossHatch/blob/e311dae/docs/AUDIT-2026-10-08.md) documents one successful live registration/capture after earlier fixes. [Build plan](https://github.com/nsheinbe/MossHatch/blob/e311dae/docs/BUILD-PLAN-2026-10-08.md) leaves renewal, refund and transfer drills open. | Owner-authorized lifecycle validation with recorded provider/payment outcomes; no such live mutation was authorized or attempted here. |
| Mail and support | October 8 evidence records iCloud Junk placement and open root SPF/DMARC/CAA warnings. Support round-trip and monitoring configuration appear in the release backlog. | Fresh read-only status verification, then separately authorized remediation and inbox/support/alert-delivery proof. These dated observations were not rechecked against live accounts in this test run. |
| Retail economics and catalog | Current source prices and the fee policy are tested; margins vary materially by extension/payment assumptions. `.ai` remains supported in production source despite the handoff's deferral intent. | Resolve the catalog decision, membership/fixed-cost allocation, tax/descriptor decisions and expected payment mix using [the separate economics report](retail-unit-economics-2026-10-09.md). Do not treat revenue, customer authorization or capture as prepaid registrar working capital. |

## Limits and document conflicts

The selected suite is not a fresh full production-commit lint/typecheck/build/browser/CI run. No production environment variables, current balances, customer records, provider grants, deployment settings or current email/DNS posture were read for this test run. Public endpoint availability alone would not close these gates.

The [funded-admission runbook](https://github.com/nsheinbe/MossHatch/blob/e311dae/docs/runbooks/funded-admission.md) supersedes the older commercial runbook paragraph saying admission is not atomic: the implementation and tests now exist. Its provider/deployment verification gates remain explicit. Likewise, the October 8 audit supersedes GO-LIVE's stale statement that the live registrar and Stripe have never been called. The prior successful purchase is historical evidence, not evidence that every open release gate is complete today.

Existing controls separate invite-only signup, purchase access, the web build mode and commercial registration policy. The source defaults to dogfood limits until explicit commercial configuration; actual production settings were not inferred or changed here. The feature draft based on `689ea51` is 64 commits behind production main and needs a separate production integration review before any deployment decision.
