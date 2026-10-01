# Runbook: account takeover through recovery abuse

Template: PLAN section 5. Written in Phase 5, when agents and connected apps give a taken-over account the most reach. It relies on the recovery design of PLAN 4.5 (Sessions and recovery) built in Phase 2 and the visitor controls built in Phase 5. Nothing here has run against a real attacker; the controls it uses are covered by the recovery tests (`packages/api/src/auth/recovery.test.ts`) and the agent tests (ST-61, ST-66, ST-73 to ST-80).

## Trigger

Any of:

- A customer says a recovery they did not start began or finished (the recovery-started mail goes to every address and the registrant contact at once, with a cancel link).
- A sign-in banner or email the customer did not expect: a passkey added, an address changed, "every visitor was sent home", a new token or connected app, an approval they did not make.
- Many recovery starts against one account or from one network (the recovery rate limits alarm), or an emailed-code recovery completing on an account that has a second verified channel.
- Unexplained domain events after a recovery: unlock, transfer-out code, nameserver or contact change attempts (these are held during the recovery hold, so an attempt shows as a refusal).
- Support receives a social-engineering attempt to "just reset" an account (support cannot do that: there is no support-side recovery).

## Severity

S1 while an unexplained recovery is in its cooling-off period or hold (the attacker is waiting for the hold to lift). S2 once the customer has cancelled it or restored their credentials.

## First 15 minutes

1. Cancel or freeze. If recovery is still cooling off, the customer uses the cancel link in any recovery email (it needs no sign-in and is never rate limited). If it completed, the customer (or the operator on their instruction) uses a freeze link: it locks every domain, re-randomises codes, revokes sessions and pauses (does not revoke) bindings. Freeze never unlocks or changes nameservers and renewals continue.
2. Send every visitor home. A recovery completion already revokes all sessions and bindings; if the attacker created tokens or connected an app after that, the customer presses "Send all visitors home" (Account, Visitors) from a restored session. It revokes every binding and refresh token, declines waiting requests and closes open OAuth consents in one transaction.
3. Restore the owner. A user-verified assertion from one of the owner's suspended credentials (suspended for 30 days, never deleted) restores them, revokes what the recovery created and re-applies the hold. If the owner has no credential left, stop: the account stays frozen and support follows the identity process; nobody at Mosshatch can bypass the hold.
4. Check the holds did their job. In `audit_log` for the account: refusals of held actions (`stepup` refusals for `domain.unlock`, `domain.transfer_out`, `domain.nameservers.change`, `domain.contact.change`, `agent.purchase.approve`, `agent.token.create`, `agent.token.widen`, `dns.sensitive.approve`, `device.approve`, `secret.reveal`), any `binding.created` or `oauth` consent after the recovery, and `transfer.poll` findings. `mandate.sign` is not held, so renewals keep working.
5. If a transfer away started, follow `stop-hostile-transfer.md` at once.
6. If a token or connected app was used after the takeover, follow `agent-token-leak.md` step 2 onward for each one.

## Decision owner

Founder. The second trusted person may confirm the freeze and read the audit trail on the customer's request; neither can recover an account for anyone.

## Customer-notice template

"On <date> someone started account recovery on your Mosshatch account<, and it finished on <date>>. <We froze your account at <time> / You cancelled it at <time>.> While it was held, these were refused: <list in plain words>. <These tokens or apps were created and are now revoked: <names>.> Your domains are locked and renew as usual. To finish, sign in with one of your own passkeys; that restores your account and removes what the recovery added. Then add a second passkey on another device and check your notification addresses." Never include a code, a token or a contact detail.

## Upstream and regulator clocks

- Tucows / OpenSRS: only if a registrar-side change happened or a transfer away is pending (then within 4 hours, and ask for a NACK inside the pending window, `stop-hostile-transfer.md`).
- ICANN: through Tucows, within 7 days, where Tucows asks for it.
- GDPR: 72 hours to the supervisory authority where personal data of people in scope was affected (counsel confirms applicability).

## Evidence to preserve

`recovery_requests`, `action_holds`, `sessions` (hashes and prefixes only), `passkeys` (suspended rows), `audit_log` for the account's chain, `email_log`, `agent_requests`, `oauth_authorizations`, `bindings` created in the window, `alerts` of the window, the step-up evidence of any committed action (credential, flags, client data, authenticator data, signature). Do not delete anything until it is captured.

## Exit test

- The attacker's sessions, bindings, refresh tokens and passkeys are revoked or suspended; `/api/v1/whoami` answers 401 for every token created in the window.
- The owner signs in with an original passkey and the recovery-created credential is gone.
- No held action committed during the hold (the audit trail shows only refusals).
- Every domain is locked, no transfer is pending, and the unattributed-change detector's next run opens no finding.
- The drill time is recorded below (target: freeze within 10 minutes of the customer's first message, own target).

## Drill log

| Date | Where | First message to freeze | Notes |
|---|---|---|---|
| (owed) | staging | | Run on a founder-owned test account in staging before launch (Phase 6 live rehearsal). |
