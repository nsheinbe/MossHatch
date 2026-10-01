# Restore drill log

One line per drill, appended by `scripts/ops-restore-drill.mjs`. Targets (own targets, D-027): reads back within 4 hours, writes within 8.
A drill on a small scratch database measures the mechanism, not the production restore time; the first drill on a production-sized Neon branch replaces these numbers.

The first line is a synthetic local run (600 audit rows, local PostgreSQL 16, local KMS, file anchor sink). No drill against a Neon branch, the Object Lock bucket or AWS KMS has been run yet.

| Date | Label | Total | Steps | Chains and anchors | Erasure ledger | Result |
|---|---|---|---|---|---|---|
| 2026-09-30 | phase2-local-seed-600-rows | 0.6 s | dump 0.1 s, restore 0.3 s, purge 0.0 s, verify 0.0 s | 4 chains, 2 unanchored rows, 0 gap findings, 0 tampered | 0 re-erased, 0 resurrected | pass |
