# Runbook: agent or command-line token leak

Template: PLAN section 5. Written in Phase 5 (the phase that builds agent bindings, the MCP server, the OAuth server for MCP and the GitHub secret-scanning receiver). Nothing here has run against GitHub: enrolment in the secret-scanning partner programme has not happened, so the receiver is proven only against a key pair made in the test (`packages/api/src/agents/scanning.test.ts`, ST-68).

## Trigger

Any of:

- A GitHub secret-scanning partner alert reaches `POST /api/v1/hooks/github-secret-scanning` (the receiver revokes the token and emails the owner by itself; this runbook covers what a person does next).
- A customer reports a token (`mh_live_`, `mh_cli_` or `mh_clr_`) in a repository, a log, a chat, a prompt or a screenshot.
- Alert `agent.scope_denied_burst` (a token hammering capabilities it does not hold), `bearer.failure_burst` (many bad tokens under one prefix from one network), `agent.velocity` (proposal limits hit), or the vault's bulk-read alarm on a binding.
- A refresh-token reuse (`binding.refresh_reuse` in the audit log): a CLI or OAuth refresh token was replayed, so the family was revoked automatically.
- Mosshatch's own token seen outside its store (for example in a support ticket).

## Severity

S2 for one customer's token that is already revoked. S1 when the token held `secrets.read` on `prod`, `dns.write`, or `register.propose` with a spend cap, and was used after the leak (audit rows with the binding as actor after the first-seen time), or when more than one customer is affected.

## First 15 minutes

1. Revoke. If the receiver did not already: the customer presses "Send all visitors home" (Account, Visitors) or revokes the one token; an operator with the customer's consent runs the same function for the user (`sendAllHome` in `packages/api/src/agents/visitors.ts`). Revocation is a database check on every request, so it takes effect on the next call. It also revokes refresh tokens (CLI and OAuth), declines waiting requests and closes open OAuth consents.
2. Scope what the token did. From `audit_log` for the user's chain, rows with `actor_id` = the binding id since its creation: `secret.read` (one row per secret, committed before decrypt), `secret.write` (prod writes also queued `agents.prod_write_notice`), `dns.write`, `agent.request.created`, `mcp.tool_call`, `agent.call`. List the secret ids read and the DNS snapshots written.
3. Secrets read: tell the customer which variables (by name) were read and from which environment, so they rotate them where they were issued. Mosshatch cannot rotate a third-party credential.
4. DNS written: every agent write has a 30-day snapshot (`dns_snapshots`, `actor_kind = 'agent'`); roll back from the DNS tab, History, if the change was not wanted.
5. Production values written: the prior version is kept; restore it from the Nest (`POST /api/v1/domains/{fqdn}/secrets/prod/{name}/restore`), then rotate the value at its source.
6. Purchases: an agent cannot buy. Check `agent_requests` for the binding: pending ones are declined by step 1; approved ones were approved by the person with a passkey and paid on Stripe by them.
7. If the leak is Mosshatch-wide (many tokens, or a platform log that captured headers), rotate nothing on our side first: tokens are stored only as SHA-256, so the fix is revoking the affected bindings (a one-off query over `bindings` by user or prefix list, each through `revokeBinding` so the audit rows exist) and finding the log that captured them.

## Decision owner

Founder. The second trusted person may run steps 1 and 2 on the customer's request.

## Customer-notice template

The receiver's automatic email says the token was found in public and is revoked. For a manual case: "On <date> a token for your Mosshatch account (<token name>) was found <where, in plain words>. We revoked it at <time>. It read <n> stored values (<names>) and changed <n> DNS records on <domains> after it was exposed. Rotate those values where they were issued. You can roll back the DNS change from the DNS tab and restore a production value from the Nest. If a program still needs access, create a new token and keep it out of repositories." Never include the token, a value or a code.

## Upstream and regulator clocks

- GitHub partner programme: answer the alert with the feedback labels the receiver already returns; no other clock.
- Tucows / OpenSRS: only if a registrar credential was involved (then follow `registrar-credential-exposure.md`, 4 hours, MSA 2.8).
- GDPR: 72 hours to the supervisory authority where personal data of people in scope was affected (counsel confirms applicability; secret values may be personal data).

## Evidence to preserve

The alert or report (hash of the token, never the token; the location), `audit_log` rows for the binding, `agent_requests`, `dns_snapshots`, `secret_versions` metadata (versions, authors, times), `webhook_events` row for the delivery, `alerts` of the window. Export before any clean-up.

## Exit test

- The token answers 401 on `/api/v1/whoami` and on `/mcp`; its refresh token (if any) answers `invalid_grant`.
- Every secret read after first exposure is listed to the customer; every DNS write after it is rolled back or confirmed wanted.
- The GitHub delivery (if any) has a `webhook_events` row with `processed_at` set, and exactly one `binding.revoked` audit row for the binding.
- The drill time is recorded below: report received, token revoked, scope listed, customer told (target: revoke within 5 minutes of a report, own target).

## Drill log

| Date | Where | Report to revoke | Notes |
|---|---|---|---|
| 2026-09-30 | vitest, Fake GitHub keys | immediate (in process) | ST-68: signed alert, revoke once, email once, feedback labels with hashes only. Not run against GitHub: not enrolled. |
