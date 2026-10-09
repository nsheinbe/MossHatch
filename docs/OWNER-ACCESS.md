# Owner sign-in and agent access

These instructions describe the production-based review branch and the existing owner account screens. The local checks use PostgreSQL fixtures, fake mail/provider services and browser virtual authenticators. No real owner's passkey, recovery settings, credentials or agent grants were created or changed. Production rollout and provider validation are separate gates.

## Sign in and keep a way back

1. Open **Sign in** on your trusted MossHatch site. Use an existing passkey, or verify your email and create your first passkey.
2. Save the ten recovery codes in a password manager or another secure location. Each code works once, together with a code sent to your account email. The server stores only hashes of the saved recovery codes. Codes are shown once and are not persisted by the browser app.
3. Open **Account → Add a passkey**. Give it a recognizable name, approve the addition with your current passkey, then choose **Create the new passkey**. A second device or security key gives you another way in if your first device is lost. Adding a passkey signs out other browser sessions and puts secret reveals on hold for 24 hours.
4. Removal of the last live passkey requires explicit confirmation and remaining recovery codes. A passkey paused by recovery cannot be removed while that recovery is active.
5. Review the list: a passkey may sync through its provider or stay on one device. Protect the passkey provider account too. No biometrics or device PIN are sent to MossHatch.

MossHatch uses passwordless passkeys, not a password followed by a separate one-time code. A user-verified passkey can combine possession of the credential with a device PIN or biometric verification. That does not make a synced passkey independent of the account that synchronizes it. Sensitive actions still require a new passkey verification bound to the specific change. This work adds no TOTP enrollment or seed storage.

If all passkeys are lost, choose **Lost your passkey?**:

- **With a recovery code:** verify both, then create a replacement passkey. Sensitive actions stay on hold for 24 hours.
- **With email only:** available only when the account already has another verified address on a different mail domain. Wait 72 hours, start the same recovery flow again to receive the emailed code, then create a replacement passkey. Sensitive actions stay on hold for another 72 hours. This screen does not enroll the second email address.

After the codes are accepted, a registration ticket lasts 30 minutes. If the browser passkey prompt is cancelled, use **Try the passkey again**; do not redeem the spent codes again. Closing the recovery screen does not cancel an open server recovery request. Use the emailed cancellation flow or, while signed in, **Cancel the recovery**. The account screen shows open recovery requests and active holds.

Completed recovery revokes existing browser sessions and agent bindings and suspends old passkeys. Signing in with an old suspended passkey within 30 days undoes that recovery and revokes the recovery's sessions and agent access. Recovery-code guesses are limited independently of passkey sign-in. **Sign out everywhere** ends browser sessions; revoke agent access separately under **Connected apps**.

## Connect your own agent

Prefer your client's OAuth MCP connection to your trusted site origin followed by `/mcp`. Its discovery document is `/.well-known/oauth-protected-resource/mcp`. Start the connection yourself, inspect the return host and reported app identity, and review every scope before approving with your passkey. A client’s requested scopes may already be selected; uncheck any access you do not want to grant. OAuth uses S256 PKCE and resource audience checks; an access token for another resource cannot be reused here.

For a program that needs a token, open **Account → Connected apps → New token**. Choose a recognizable name, the shortest useful expiry and only the exact domain capabilities it needs. Keep the spend cap at zero for DNS-only work. The token is shown once; put it in the agent's secret storage, not a repository, prompt, log or shared document.

Example scope choices for a domain you own:

| Need | Scope |
| --- | --- |
| Read that domain's DNS | `dns.read:example.com` |
| Request DNS edits | `dns.write:example.com` |
| Propose a registry nameserver change | `nameservers.propose:example.com` |

Start with read access. DNS write access and nameserver proposals are optional and need explicit consent. An agent can ask for additional access with the MCP `request_scope` tool or `POST /api/v1/agent/scope-requests`; that request does not widen its grant. You review and approve a specific widening with your passkey. Narrowing and revocation do not require granting anything new. For DNS execution and queued provider recipes, grant expiry, pause, revocation and ownership are checked again before effects. Queued recipes retain both the planning and applying identities, even when you apply an agent's plan yourself. Changing either grant invalidates its saved authorization; create a fresh plan. Ordinary OAuth token refresh does not change the grant. Agent DNS recipes remain gated.

Pausing or revoking access stops queued recipe effects at their next authorization check. It cannot recall a provider request already dispatched or undo a completed effect. Failed jobs do not become executable again merely because access is restored, and provider timeouts are not automatically retried. Recipe plans and queued work created before these authorization checks must be recreated after an authorized rollout; old work is not silently assigned new authority.

OAuth access tokens last at most 60 minutes. Refresh tokens rotate; the refresh idle limit is 30 days, bounded by the owner's grant. OAuth connections default to a 90-day owner grant; manually created tokens default to 30 days. Both offer shorter durations and a 90-day maximum. OAuth refresh cannot extend the original approved grant window. Choose a shorter duration for a one-off task. A manually created token keeps the expiry you choose; it is not an OAuth access token.

Never give an agent your owner password, email code, recovery code, passkey, device PIN or registrar account credentials. It gets its own revocable grant. Use **Connected apps** to remove access, or **Disconnect everything**, then **Yes, disconnect everything**, to revoke every binding and decline waiting requests.

## Review changes before execution

DNS edits use the same server policy for browser, MCP and REST. Deletions and sensitive changes require approval of the exact before/after state, including TTL and preserved upstream record types. A stale or changed proposal needs a fresh review. Closing an approval before its execution request starts prevents that execution; a request already sent may have reached the provider and must be reconciled rather than blindly repeated.

`nameservers.propose` permits proposals only. Registry delegation is different from an NS record in the zone. This branch blocks nameserver execution until authorized destination access, a complete source inventory and a supported DNSSEC transition can be verified. Public DNS lookups cannot prove a complete inventory. Custom nameservers and glue remain gated. Preserve source records and authorize any external DNS provider separately.

DNSSEC DS/DNSKEY changes also remain unavailable until their verification and durable execution workflow supports uncertain provider outcomes. Existing DNSSEC data is shown as registrar-reported state; it does not prove that the parent zone publishes matching DS records or that destination signatures validate.

A provider accepting a request, matching provider read-back, authoritative visibility and sampled propagation are distinct observations. No screen or receipt proves immediate global propagation. Rollback cannot restore mail already lost or erase answers already cached elsewhere.
