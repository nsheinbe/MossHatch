# Runbook: stop a hostile transfer

Template: PLAN section 5 (4.3b Gate). Skeleton written in Phase 3. The product path (poll, needs attention, Stop) is proven with `MockRegistrarPort`'s transfer-away simulator (ST-125) and in the browser (`e2e/account.spec.ts`). Horizon cannot simulate transfers; the real path is unproven until the Phase 6 live rehearsal.

## Trigger

`transfer.poll` (every 5 minutes, `GET_TRANSFERS_AWAY`) finds a pending outbound transfer that no committed `domain.transfer_out` action explains: the domain shows "needs attention", the owner is emailed at every notification address, and the operator is paged (`unrequested_transfer`). Or an owner writes in to say they did not ask for a transfer.

## Severity

S1. An inter-registrar transfer can complete in 5 days, and the owner's decline link in the OpenSRS email is the only thing that ends it without Tucows.

## First 15 minutes

1. Confirm with the owner, in the product: the Stop button re-locks the name and replaces the transfer code with one nobody knows (`stopTransferAway`), and opens a ticket. OpenSRS has no API to cancel an outbound transfer (`capabilities().cancelTransferAway = false`), so the transfer is still pending after Stop.
2. Ask the owner to decline it using the link in the transfer email from OpenSRS (sent to the registrant address). Tell them where to look; never send them a link to click in our own email.
3. Open a ticket with OpenSRS support: domain, gaining registrar, request time, "registrant did not authorise; please deny". Record the ticket number in `domain_tickets`.
4. If the owner's account may be compromised: Freeze it (sessions revoked, bindings paused; renewals continue, nothing is unlocked).
5. If several names show the same pattern, follow `registrar-credential-exposure.md`: pause registrar writes and rotate the key.

## Decision owner

Founder; the owner decides on declining the transfer.

## Customer-notice template

"A transfer of <domain> to <gaining registrar> started on <date>. You did not ask for it, so we locked the name again and replaced its transfer code. To end the transfer, decline it in the email from OpenSRS sent to the registrant address, or reply to this email and we ask our registrar to deny it. Nothing else changed."

## Upstream and regulator clocks

- Transfer Policy: the losing registrar may deny within 5 calendar days for evidence of fraud; OpenSRS support must receive the request well inside that window.
- If a credential compromise is suspected: Tucows within 4 hours (MSA 2.8).

## Evidence to preserve

`domain_transfers_away` and `domain_tickets` rows; the `alerts` and `audit_log` rows; the times the poll saw it, Stop was pressed and the upstream answered; the OpenSRS ticket.

## Exit test

- `GET_TRANSFERS_AWAY` shows the transfer `cancelled` (not `completed`); the poll closes the row and the domain leaves "needs attention".
- The name is locked, the code was replaced after the transfer started, and the owner confirmed the outcome.
- If the transfer completed anyway: a dispute is opened with the gaining registrar (TDRP) and the release rules apply (ST-94).
