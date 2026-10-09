# Secure agent DNS: production-based review

This branch, `codex/production-secure-agent-dns`, starts from production `main` at `e311dae06f75d41131f92d4421355a3934b9bcda`. Read-only Vercel metadata on 2026-10-09 identified that same commit for both `mosshatch.com` and `mosshatch-registrar.vercel.app`. It is a review branch, not a deployment or provider certification.

[Draft PR 45](https://github.com/nsheinbe/MossHatch/pull/45) remains intact on the originally selected `claude/vigilant-ritchie-8vinxb` base. Its final commit is `afe9ced52244585cd539c38b58a19cf7766f3b3f`. Only intended implementation changes were ported into a separate worktree and branch. No other worker's branch was overwritten. No merge, deployment, customer DNS change, purchase, production migration, real owner enrollment, credential or grant creation was performed. All three Vercel project files disable automatic Git deployment for this exact review branch.

## Result and limits

- DNS inventory, plans, exact approvals and hashes include TTL and every representable user-managed record type. CAA and unchanged opaque records survive ordinary edits. Unsupported fields, incomplete provider inventories and records that cannot round-trip fail closed. Provider-generated apex SOA/NS are outside this inventory; child zone NS records are preserved.
- Browser, direct MCP/REST DNS and owner DNS recipes share the existing policy/execution path. Approval binds the owner, domain, agent grant where applicable, exact changes, state and expiry. Execution rechecks ownership, account/session/grant status and upstream state. Deletions, verification TXT, mail/service dependencies and production hosts receive conservative classification.
- Durable receipts precede provider writes. Openprovider's remove/add calls are not atomic and have no compare-and-swap guarantee. Partial results and timeouts block further writes. Reconciliation observes provider state without repeating the write. A before/partial observation cannot prove a timed-out request is finished. An operator needs provider-terminal evidence before releasing unresolved work.
- Provider acceptance/read-back, authoritative visibility and propagation sampling remain separate. This implementation reports authoritative visibility as not checked and propagation as not sampled. Rollback requires a fresh approved change and cannot recover lost mail or remove cached answers.
- `nameservers.propose:<domain>` is explicit, limited to one owned domain and available through MCP and REST. Registry delegation differs from a zone NS record. Execution, custom nameservers/glue and DNSSEC mutations remain gated until a durable supported transition verifies destination authorization, full source inventory, actual parent DS and destination DNSKEY/signatures. Client `target_signed` assertions are not trusted. Public DNS scans cannot establish full inventory.
- Provider-aware DNSSEC display preserves main's Openprovider DNSKEY metadata, managed signing and registrant verification notices. Generic DS entry is not represented as an Openprovider capability.
- Passkey/login/recovery changes retain the existing system and sensitive-action step-up. They close credential races and repeated/cancelled UI actions. Recovery secrets remain hashed and single-use. No TOTP system was introduced. [Owner instructions](OWNER-ACCESS.md) distinguish passwordless passkeys from password-plus-OTP and explain incremental agent consent.

## Production conflicts resolved deliberately

The port preserves main's shipped behavior rather than restoring older implementations:

| Area | Preserved production behavior and scoped addition |
| --- | --- |
| Search/shop | Main search, ideas, shortlist and conversion behavior retained. Only a results-group accessibility role added. |
| Account | Current invite/session state, recovery holds, suspended credentials, 30-day recovery undo, retry ticket, last-passkey confirmation and two-step passkey creation retained. Added cancellation/repetition protection. |
| Connected apps | Pause/resume, activity, one-domain choices, manual-token 30-day and OAuth 90-day defaults retained. Added explicit domain-only nameserver proposal choice; refresh still cannot extend the approved grant. |
| MCP | Public read-only `/mcp/search`, transport/read RPC and private recipe tools retained. Direct `dns_upsert` now accepts TTL, matching REST. |
| Recipes | Main shared planning/apply/history/waiting functions and Connect UI retained. Both agent entry points and queued dispatch block DNS recipes until grant-bound queued approval is implemented. Owner status/recovery holds are rechecked at dispatch. |
| Registrar/RPC | Openprovider login caching, no-effect response handling, member prices, settlement fallback, verification extras and managed DNSSEC metadata retained. RPC funding admission, shared nonces, paid lease and daily cap preserved. Added complete DNS state/expected hash/capability transport and redaction. |
| Money/release | Funding, order, Stripe, boot and public-sales policy modules are unchanged. Waitlist/launch gates remain. Main's 40-minute CI timeout and already-patched lockfile are retained. |

Independent agent review inspected those preservation boundaries and found no new blocking defect in its reviewed scope. It is not an independent provider/security certification. A pre-existing queued non-DNS recipe limitation is explicitly retained as a separate gate below.

## Migration and old-state handling

New migrations are `0998_nameserver_proposals.sql` and `1130_dns_reconciliation.sql`. They have run only against synthetic local databases. Review them through the normal separately authorized release process.

Migration 1130 adds a nullable `state_format` marker without a default or backfill. Only newly complete snapshots receive `complete-v1`; main's old snapshots lacked TTL/opaque records and remain untrusted. Legacy snapshots cannot authorize rollback or clear unknown operations, even if an old desired hash matches. Old approvals lack the new exact/grant binding and must be voided/reissued after a fresh complete provider read. The upgrade regression actually applies the migration to an isolated temporary main-format schema.

This migration deliberately differs from the never-deployed PR 45 version. Do not mix migration artifacts from the two drafts or mark one version as having applied the other. Before any authorized rollout, inventory pending approvals and unresolved snapshots, rehearse the upgrade on synthetic copies, and explicitly resolve legacy unknown work using provider-terminal evidence. No automatic write retry or mass hash conversion is a rollout step.

## Verification and evidence

Final commands and results are maintained in the scoped draft PR and its GitHub Actions checks, tied to its exact head. Do not substitute PR 45's old-base CI for this production-based branch. Local commands are reproducible using [cloud workspace instructions](CLOUD-WORKSPACE.md). There is no repository lint script.

| Requirement | Local regression evidence |
| --- | --- |
| CAA/unknown records/TTL, framed hashes, malicious content | Registrar DNS/fidelity/SystemDNS suites; API DNS security and approval display suites |
| Partial/timeout writes, duplicate apply, read-only reconciliation, upstream changes | Registrar fidelity; domain DNS; agent DNS security/write/upgrade suites |
| Tenant/domain/audience/PKCE/refresh reuse and grant lifetime | Security/scope matrices; bindings, OAuth and MCP suites |
| Paused/revoked/expired/narrowed grant during execution | DNS provider-read races and nameserver paused-during-read regression |
| Stale/wrong-agent approvals and legacy upgrade | DNS security, recipe and new `agents/dns-upgrade.test.ts` |
| DNSSEC/NS parity, denied legacy bypass | Nameserver, management, security and registrar tests |
| Owner replay, credential race, secret redaction | Auth/recovery/step-up/RPC suites |
| Cancellation/repeated clicks, consent, phone accessibility | Virtual-authenticator and mocked/local-router browser suites; axe checks |

Local provider evidence uses documented or historical fixtures. Live sandbox tests remain skipped. The historical Openprovider signed-delegation replay stops at the new safety gate; unexecuted exchanges are not certification. Browser screenshots use synthetic records and were captured from this port, with [desktop/phone evidence](evidence/production-port-dns/README.md). Local Chromium 151 differs from CI's pinned Chromium; both results must be reported accurately.

## Remaining release gates

Keep the waitlist and public-sales gates in place. [Production release gates](PRODUCTION-RELEASE-GATES.md) carries the retail findings, contribution-floor design and bounded owner/provider validation steps. Real-provider validation requires separate authorization for a disposable, designated sandbox domain and an explicit action list; no authorization is inferred from this coding task.

There is also a **pre-existing queued `postgres-neon` grant limitation**: a job accepted before pause/revocation/expiry/scope narrowing can still create a Neon project or copy its database connection URL to previously planned Nest/Vercel targets using the owner's saved provider connection. Initial scope checks precede enqueue, but non-DNS dispatch does not recheck the originating binding. DNS recipes are blocked and direct DNS/nameserver proposals recheck grants. Treat non-DNS queued recipe revalidation as a separate hardening/release gate; do not promise that revocation cancels every already queued operation.

Real-device passkeys/recovery, external MCP OAuth round trips, registrar inventory/TTL behavior, provider-terminal reconciliation and supported DNSSEC/delegation transitions remain unproven against live services. No global propagation, atomic upstream update or completed live integration claim is made.

Technical contract sources used in the original implementation: [Openprovider OpenAPI](https://developer.openprovider.com/data/swagger.json), [Openprovider DNSSEC transitions](https://support.openprovider.eu/hc/en-us/articles/216648828-DNSSEC-Updates-and-transfers), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [OAuth Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html). These inform fixture contracts; they do not replace sandbox validation.
