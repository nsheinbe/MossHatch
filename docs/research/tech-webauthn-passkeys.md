# WebAuthn / passkeys for a passwordless-only registrar with step-up (Mosshatch Phase 0)

Research dossier. Today = 2026-09-29. All sources accessed 2026-09-29 unless a source's own date is stated. Design values that are not sourced are labelled "design".

## TL;DR

1. Stack: `@simplewebauthn/server` **14.0.3** + `/browser` **14.0.0** (Sep 2026), Node >= 22 (Vercel 22/24 fine, dual ESM/CJS). WebAuthn **Level 3 became a W3C Recommendation on 2026-08-25**; passkeys, autofill UI, hybrid and related origins now ship in Chrome/Edge 128+, Safari 18, Firefox 152+ (F01-F03, F20, F35).
2. Always `userVerification:'required'` (the library's option default is `'preferred'`), check `verified` AND `userVerified`, attestation `none`, discoverable credentials. The library is stateless: a valid assertion verified twice in my harness at counter 0, so replay defence is entirely ours (F06-F09).
3. Step-up = one ceremony per action instance: server normalizes params, challenge = SHA-256(JCS{action, params hash, user, session, nonce, exp}), 300 s TTL, atomic single-use consume before verification, then a single-use grant re-checked against current state at execution (4.2-4.4).
4. Seven action IDs cover the brief: `secret.reveal`, `domain.nameservers.change`, `domain.unlock`, `domain.transfer_out`, `agent.purchase.approve`, `agent.token.create`, `agent.token.widen`. Narrowing is free. Agent tokens can never start or complete a ceremony (4.7, 9).
5. `signCount` is 0 for synced passkeys: store it, enforce only for BE=0, treat the rest as a risk signal. Track BE/BS to detect 'one device-bound credential' and BS 1->0 flips (sections 3, 5).
6. RP ID `mosshatch.com` with an exact origin list, no subdomain origins (spec 13.5.8); decide before launch because a credential is bound to its RP ID. For hatchkind.com prefer a redirect login; related origins work (max 5 labels) (sections 3, 10).
7. Recovery: >= 2 credentials + 10 saved codes (>= 64-bit, NIST) + emailed code (<= 24 h). Email-only path = 72 h cooling-off, auto-cancel on legitimate use, notifications, revoke sessions/credentials, 7-day hold on the seven actions (durations are design values) (section 6).
8. Sync-provider takeover is real (NIST 800-63B-4 App. B Table 5; Unit 42 2026-08-03): offer opt-in hardened mode (BE=0), keep no weaker fallback (Proofpoint downgrade), notify on every credential change (section 7).
9. Session: opaque 256-bit token in a non-persistent `__Host-` Secure HttpOnly SameSite=Lax cookie, idle 30 min / absolute 12 h. `Permissions-Policy publickey-credentials-*` defaults to self but only Chromium enforces it, so add CSP `frame-ancestors 'none'` (sections 3, 8).
10. Could not verify: Apple's own statement that iCloud passkeys report signCount 0, real-device UV behaviour, ICANN limits on delaying unlock/transfer-out, vendor fixes for the Unit 42 attacks (section 14).

## 0. Method and access notes

- Every fact below was fetched on **2026-09-29** from the source named in the findings table (section 12) or the source register (section 15). Quotes in section 12 were machine-checked as verbatim substrings of the cached pages (88 quotes, 0 mismatches; whitespace and case ignored).
- Fetching limits met (none worked around): `github.com` and `api.github.com` answered 403 "GitHub access to this repository is not enabled for this session" (session policy), so release notes came from `raw.githubusercontent.com` (CHANGELOG.md, caniuse JSON), which was reachable. `www.w3.org/TR/...` and `api.w3.org/specifications/webauthn-3` sit behind a Cloudflare challenge; the Level 3 text came from `w3c.github.io/webauthn/` (its header reads "W3C Recommendation, 25 August 2026") and status from `api.w3.org/specifications/webauthn-3/versions/latest`. The FIDO CTAP 2.2 spec needed the headless Chromium. Apple developer forums returned a verify-human wall. The WebSearch budget (200 calls per session) ran out mid-task, so a few side claims are listed as unverified (section 14).
- **Own experiment** (`.../research/webauthn/sim/sim.mjs`, output `sim_output.txt`): a software ES256 authenticator driven against the real `@simplewebauthn/server@14.0.3` on Node 22.22.2. It proves API behaviour (challenge encoding, UV enforcement, counters, replay, origin/RP ID checks, BE/BS handling). It does not prove browser or OS behaviour.
- Cached pages, tarballs and the harness live under `working-directory/research/webauthn/`. Nothing under `/home/user/MossHatch` was touched (the repo has no commits and no product brief; the step-up action list comes from the task text).

## 1. SimpleWebAuthn: what to install and how it really behaves

| Item | Verified value | Findings |
|---|---|---|
| Server package | `@simplewebauthn/server` **14.0.3**, published 2026-09-25 (14.0.0 was 2026-09-02) | F01 |
| Browser package | `@simplewebauthn/browser` **14.0.0**, published 2026-09-02, no dependencies | F01 |
| Types package | `@simplewebauthn/types` frozen at 12.0.0, npm deprecation text "Package no longer supported". Types now ship inside server and browser. | F01 |
| Runtime floor | Changelog v14.0.0: Node LTS 22.x+ (Deno 2.4+). `engines` still says `>=20.0.0`; docs say "Node LTS 22.x and higher". Vercel offers 24.x (default), 22.x, 20.x, so run 22 or 24. | F02, F03 |
| Module format | Dual: `import` -> `esm/`, `require` -> `script/`; both loaded in the harness. Uses `globalThis.crypto`. `npm audit`: 0 vulnerabilities at install. | F11 |
| Security history | 13.3.2 (x5c self-signed root, CVSS v4 2.0) and 14.0.2 (CRL handling, CVSS v3 5.4 and 6.3) were certificate-chain fixes. In the 14.0.3 source, `validateCertificatePath`/`isCertRevoked` are called only by the packed, tpm, android-key, apple, fido-u2f and safetynet attestation verifiers and by the FIDO MDS code, so attestation `none` does not exercise them. Pin >= 14.0.2 anyway. | F11 |

### 1.1 API shape (v14.0.3 type definitions, F04)

- `generateRegistrationOptions({ rpName, rpID, userName, userID?: Uint8Array, challenge?: string|Uint8Array, attestationType?: 'none'|'direct'|'enterprise', excludeCredentials?, authenticatorSelection?, supportedAlgorithmIDs?, preferredAuthenticatorType?: 'securityKey'|'localDevice'|'remoteDevice', timeout?, extensions? })` -> JSON options. `userID` strings throw; a random 32-byte ID is generated if omitted (harness: 32 bytes).
- `verifyRegistrationResponse({ response, expectedChallenge: string | (c)=>bool|Promise<bool>, expectedOrigin: string|string[], expectedRPID?, requireUserPresence=true, requireUserVerification=true, ... })` -> `{ verified, registrationInfo: { credential: {id, publicKey, counter, transports}, credentialDeviceType, credentialBackedUp, userVerified, aaguid, fmt, origin, rpID } }`.
- `generateAuthenticationOptions({ rpID, allowCredentials?, challenge?, timeout?, userVerification?, extensions? })`.
- `verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID, credential: {id, publicKey, counter, transports?}, expectedType?, expectedTopOrigin?, requireUserVerification=true, advancedFIDOConfig? })` -> `{ verified, authenticationInfo: { credentialID, newCounter, userVerified, credentialDeviceType, credentialBackedUp, origin, rpID } }`.
- Browser: `startRegistration({ optionsJSON, useAutoRegister? })`, `startAuthentication({ optionsJSON, useBrowserAutofill?, verifyBrowserAutofillInput? })`, `browserSupportsWebAuthn/Passkeys/WebAuthnAutofill`, `platformAuthenticatorIsAvailable`, `getBrowserCapabilities`, `sendSignal` (new in 14) (F12).

### 1.2 Gotchas proven by the harness or the source (these change the design)

1. **Set UV yourself.** `generateAuthenticationOptions` defaults `userVerification` to `'preferred'` and `timeout` to 60 000 ms; `generateRegistrationOptions` defaults `authenticatorSelection` to `{residentKey:'preferred', userVerification:'preferred'}` (F06). Verification defaults to `requireUserVerification: true`; the docs' passkeys guide shows `false`, so docs and code disagree and the code wins (F07). Harness: an assertion without the UV flag throws by default and only passes (with `userVerified:false`) if you set `requireUserVerification:false`.
2. **The library is stateless, so replay defence is yours.** With counter 0 (every synced passkey), the same assertion verified twice, both `verified:true` (F08). Single-use challenge consumption in Postgres is the only replay control.
3. **A string challenge is UTF-8 encoded, not decoded.** To sign a 32-byte digest, pass a `Uint8Array`; `options.challenge` then equals `base64url(digest)` (harness, F05). `expectedChallenge` may be an async function (F05) but a plain string comparison against a stored value is simpler.
4. **Bad signatures return `verified:false`; most other failures throw.** Check `verified === true` and `authenticationInfo.userVerified === true` explicitly (F09).
5. **Counter check is a hard throw** when either counter is non-zero and the response is not strictly greater (F09). Harness: stored 5 / response 5 -> "Response counter value 5 was lower than expected 5". Policy in section 3.
6. **BE/BS:** the library throws on BE=0 with BS=1, but never compares BE with what you stored; the spec's step ("If credentialRecord.backupEligible is set, verify that currentBe is set") is on you (F10, F40).
7. **Origin/RP ID arrays are supported** (`expectedOrigin: [...]`, `expectedRPID: [...]`); an origin not in the array throws (harness), a matching sub-domain in the array passes, which is why the array must stay exact (F32).
8. **Safari gesture rules** for older Safari: call `startAuthentication()` from a native click handler after a single `fetch` (F13).
9. **PRF:** the project's own docs warn against tying encryption keys to passkeys (F14). Keep the vault on cloud KMS; the passkey is an authorization gate, not a key source.

## 2. Standards and platform status (as of 2026-09-29)

- **WebAuthn Level 3 is a W3C Recommendation, 2026-08-25** (F20). Level 3 adds conditional mediation for get and create, `getClientCapabilities()`, JSON (de)serialization, `hybrid` transport value, signal methods, `topOrigin`, hints, related origins, and assigns the BE/BS flags; it also changes the recommended ceremony timeout to 300 000-600 000 ms and stops clients zeroing the AAGUID under attestation `none` (F21, F43).
- **CTAP 2.2 (Proposed Standard 2025-07-14)** defines the hybrid transport: QR code + tunnel service + BLE proximity (F22).
- **NIST SP 800-63B-4** (page dated 26 Aug 2025) is the identity-assurance yardstick used here. It treats WebAuthn as phishing-resistant through verifier-name binding and allows syncable authenticators up to AAL2 but never AAL3 (F70, F71).

### 2.1 Support matrix (first version supporting; sources in brackets)

| Capability | Chrome / Edge | Safari (macOS / iOS) | Firefox | Notes |
|---|---|---|---|---|
| WebAuthn base | Chrome 67 / Edge 18 (Chrome Android 70) | 13 (iOS Safari 14.5 full) | 60, partial in caniuse ("TouchID not supported") | caniuse: 93.51% full + 2.89% partial of global usage [F50] |
| Passkeys (caniuse "Passkeys") | 108 | 16.1 macOS, 16.0 iOS | 122 | Samsung Internet 21; 93.87% usage [F51] |
| Conditional mediation (autofill UI) | 108 (passkeys.dev lists Edge autofill UI at 122) | 16 | API 119, autofill UI 122 | Android WebView: `isConditionalMediationAvailable()` always false; Windows rows need Windows 11 22H2+ [F52, F53, F56] |
| `getClientCapabilities()` | 133 | 17.4 | 135 | Samsung 29 [F55] |
| JSON helpers (`toJSON`, `parseRequestOptionsFromJSON`) | 129 | 18.4 | 119 | [F55] |
| WebAuthn hints | 128 (Chromium only) | no | no | Samsung 28 [F55] |
| Signal API (`signalUnknownCredential` etc.) | 132 | 26 | no | [F55] |
| Related Origin Requests | 128 | 18 (macOS 15 / iOS 18) | **152 (released 2026-06-16)** | [F35, F54, F56] |
| Conditional create (passkey upgrade) | desktop 136+, Android 142+ (passkeys.dev) | 18 | no version listed | [F54, F56] |
| Permissions-Policy `publickey-credentials-get/-create` | 88 | **no** | **no** | Samsung 15 [F37, F38] |
| Secure Payment Confirmation | 95 | no | no | experimental, Samsung 17 [F62] |
| Device Bound Session Credentials | 145 (Windows) / 147 (Windows + macOS) | no | no | experimental [F94] |

### 2.2 Synced passkeys, hybrid and providers

| Platform | Where passkeys live / sync | Evidence |
|---|---|---|
| iOS 16+/macOS 13+ | iCloud Keychain, E2E encrypted, recoverable if all devices are lost, Apple Account 2FA required | F58 |
| Android 9+ / Chrome everywhere | Google Password Manager (Chrome on Android, macOS, Windows, Linux, ChromeOS); Android 14+ lets the user pick another provider (page last updated 2025-05-19) | F57 |
| Windows | Windows Hello passkeys are device-only (passkeys.dev: synced "Planned"); **Edge 142+ Microsoft Password Manager syncs via a Microsoft account with a PIN (10 unlock attempts)**, rolled out from 2025-11-03; Chrome on Windows uses Google Password Manager | F56, F57, F59 |
| Third-party managers | Android 14+, iOS 17+, macOS 14+, Windows 25H2+ (passkeys.dev); 1Password/Bitwarden store passkeys as vault items via extension/app | F56, F61, F105 |
| Hybrid (cross-device) | Client: Android 9+, ChromeOS 108+, iOS 16+, macOS 13+, Windows 23H2+, Ubuntu via Chrome/Edge. Authenticator: Android 9+, iOS 16+. Needs Bluetooth on both devices and internet | F22, F56, F60 |

Conflicts recorded: web.dev (Jan 2026) said Firefox was still "considering" related origins; Mozilla's Firefox 152 notes (2026-06-16) say it shipped (Mozilla wins). passkeys.dev says Windows synced passkeys are "planned"; Microsoft's Edge blog says Edge-level sync shipped in Nov 2025 (both true: OS-native vs browser-level).

## 3. Protocol decisions for Mosshatch

| Decision | Choice | Why (evidence) |
|---|---|---|
| userVerification | `'required'` for **every** registration, login and step-up; verify `flags.uv` server-side | The RP decides; the UV flag is ignored unless required (F23, F24). OWASP: "the RP must request UV and verify the returned UV flag". A passkey-only product has no second factor, so UV is the second factor. |
| Discoverable credentials | `residentKey: 'required'`; opaque 32-byte user handle; email only as `userName` | Enables conditional UI / usernameless login (F04, F12). |
| Attestation | `'none'` | Default in spec and library; OWASP and NIST say do not gate public apps on it; AAGUID is unauthenticated under `none` (F28-F30). Removes the attestation code paths that produced the 13.3.2/14.0.2 advisories. |
| Algorithms | library default (`-8`, `-7`, `-257`; ML-DSA-44 added first only if the runtime supports PQC). Consider pinning `supportedAlgorithmIDs:[-7,-257]` (and passing the same list to `verifyRegistrationResponse`) so behaviour does not change with Node upgrades | Harness on Node 22.22.2 offered `[-8,-7,-257]` (F06). Ed25519 caused Firefox <=118 key-response bugs per docs. |
| Counter (`signCount`) | Store it. For **BE=1** (synced) credentials pass `counter:0` to the library and log anomalies. For **BE=0** credentials let the library enforce; on throw fail that step-up, flag the credential, do not lock the account | Synced credentials commonly report 0 (F25, F26); OWASP: no automatic lockout on counter anomaly (F27); library hard-throws (F09). Race between two tabs on a hardware key is a legitimate cause (spec 7.2). |
| RP ID | **`mosshatch.com` (apex)**, decided before first registration, with exact origin allowlist `["https://mosshatch.com"]` per environment | A credential only works for the RP ID it was registered under (F31); spec says RPs by default SHOULD NOT allow subdomain origins because user code on a subdomain can exercise RP-ID-scoped credentials (F32); OWASP: narrowest stable domain (F33). If the authenticated app ends up on `app.mosshatch.com` instead, use `app.mosshatch.com` as RP ID. Never host untrusted or third-party content (status page, docs, blog CNAMEs) on a subdomain you allow. |
| Staging / previews | Separate RP ID per environment (`localhost` for dev, a stable staging hostname); do not use `*.vercel.app` previews for passkeys | `vercel.app` is on the Public Suffix List, so each preview hostname would be its own RP ID (F100). |
| Permissions-Policy | `Permissions-Policy: publickey-credentials-get=(self), publickey-credentials-create=(self)` on every response, plus CSP `frame-ancestors 'none'` and no third-party scripts on ceremony pages | Default is already `self` (F37, F38); only Chromium enforces the header, so CSP is the cross-browser control (F39, spec 13.5.8). |
| Conditional UI | Use conditional mediation only for login (`autocomplete="username webauthn"`), never for step-up | Step-up must be a modal, explicit-consent ceremony (OWASP TA 1.4, F87). |
| Hints | Optional `preferredAuthenticatorType:'securityKey'` on the "add a backup key" screen. The library sets both the `security-key` hint (only Chromium honours hints) and `authenticatorAttachment:'cross-platform'` (other browsers honour that) | F55; library source. |

## 4. Step-up design

### 4.1 What step-up defends and what it cannot

Defends: stolen or riding session cookie (XSS/CSRF/session theft), a walked-away laptop, an agent bearer token, and a compromised email account that cannot produce a passkey assertion. Does **not** defend against active script injection on the origin, which can start its own ceremony with attacker parameters and show the user a false summary (spec 13.5.8, OWASP TA 1.1: WebAuthn's OS prompt shows the RP name, not the transaction). Compensating controls: strict CSP and Trusted Types, no third-party JS on ceremony pages, server-rendered summary from the stored request, an after-the-fact email that repeats the summary with a "freeze account" link, and delayed execution with veto for the most destructive action (transfer-out).

### 4.2 Protocol (one ceremony = one action instance)

1. **Begin** (`POST /api/stepup/begin`, cookie session only, CSRF-protected). The client sends only `{action, target_id}`. The server loads the target from its own database, authorizes the action for this user, **normalizes the parameters itself** (client input is never the source of the bound parameters), computes `params_hash`, creates the challenge row and returns WebAuthn options plus a **server-rendered summary**. Options: `rpId`, `challenge` (Uint8Array digest), `userVerification:'required'`, `timeout:300000`, `allowCredentials` = the user's active, step-up-eligible credentials with stored transports.
2. **Ceremony** in the browser from a native click: `startAuthentication({ optionsJSON })`. Modal, not conditional.
3. **Finish** (`POST /api/stepup/finish`): (a) load row, check same user and same session, unexpired; (b) **atomically consume**: `UPDATE ceremony_challenge SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL AND expires_at>now() AND session_id=$2 RETURNING *`; zero rows means replay/expiry and the request dies. Consume happens **before** verification so a failed attempt also burns the challenge (OWASP: invalidate "whether the ceremony succeeds or fails", F85); (c) find the credential by `response.id` where `user_id` = session user and `revoked_at IS NULL`; if a `userHandle` is present it must equal the user's handle; (d) `verifyAuthenticationResponse({ response, expectedChallenge: b64url(digest), expectedOrigin, expectedRPID, credential, requireUserVerification:true })`; require `verified===true` and `userVerified===true`; compare `credentialDeviceType` with the stored BE (mismatch = anomaly, fail and alert); record BS changes; (e) update credential state with `sign_count = GREATEST(sign_count, $new)` inside a per-credential row lock; (f) **re-derive `params_hash` from current server state** and compare with the stored hash (TOCTOU gate, F88); (g) mint a single-use `approval_grant` or execute in the same request.
4. **Execute** behind a fail-closed gate: every mutation handler for the seven actions requires an unconsumed, unexpired grant with the same `action`, `user_id` and `params_hash` as the request being executed, and consumes it atomically. No grant, no execution (OWASP AI-agent sheet: "Fail closed", F89).

### 4.3 Challenge construction (exact bytes)

```
preimage  = "mosshatch/stepup/v1" || 0x00 || JCS({
              v:1, aud:"https://mosshatch.com", rp:"mosshatch.com", typ:"stepup",
              act:"<action id>", ph:"<hex SHA-256(JCS(params))>",
              uid:"<user id>", sid:"<hex SHA-256(session token)>",
              n:"<128-bit random, base64url>", iat:<unix s>, exp:<iat+300> })
challenge = SHA-256(preimage)                      // 32 bytes
options   = generateAuthenticationOptions({ rpID, challenge /* Uint8Array */, userVerification:'required', timeout:300000, allowCredentials })
```

- JCS = RFC 8785 canonical JSON (F99); it constrains numbers to I-JSON, so prices go in as integer minor units or strings.
- Why hash at all: the spec needs an RP-generated random value it stores until used (F43); the hash adds nothing to single-use safety, which comes from the database row. What it adds is **evidence**: the retained `clientDataJSON`, `authenticatorData` and signature prove that credential C signed a digest that commits to action, parameters, user, session and expiry, and the executor can recompute it. The 128-bit nonce inside the preimage keeps the digest unpredictable, satisfying "at least 16 bytes" of entropy (F43).
- Domain separation (`typ`, version prefix) keeps a `login` challenge from being accepted as `stepup` (OWASP TA 1.4: keep authentication and authorization distinct, F87; OWASP passkey sheet: never accept a challenge issued for another ceremony, F85).

### 4.4 Freshness rules

| Rule | Value | Basis |
|---|---|---|
| Challenge lifetime (begin -> finish) | **300 s** server-side, WebAuthn `timeout` 300 000 ms | Spec default and lower bound of its range; spec says challenges should live about as long as the upper limit (600 s) (F43). Accessibility (WCAG "enough time") argues against going much shorter. |
| Assertion -> execution | same request/transaction; for async work a grant valid `min(600 s, quote expiry)` | OWASP TA 2.9: limited window; spec ceiling 600 s (F43, F87). |
| Reuse | **none**: a login assertion never counts; one step-up authorizes exactly one action instance on one target | OWASP TA 1.5/2.10 (F87). No "sudo window" for the seven actions. |
| Session age | irrelevant; a 5-second-old session still needs step-up | Session theft is the threat model. |
| Failed finishes | 3 per challenge, then the challenge is dead; 10 begins per user per 10 min | OWASP TA 2.4; NIST's 100-attempt ceiling is an upper bound (F82). |

### 4.5 Replay and misuse protections (checklist)

Random 128-bit nonce; server-stored row; atomic single-use consume before verification; expiry; user + session binding; credential must belong to the session user; `userHandle` cross-check; exact origin and RP ID; UV required and checked; params hash re-derived at execution; grant single-use; counter as risk signal; per-user rate limits; no challenge/response bodies in logs (OWASP: "never log challenges, full credential responses, session identifiers", F85).

### 4.6 What to store

| Table | Columns |
|---|---|
| `webauthn_credential` | `id` (credential ID, b64url, unique), `user_id`, `public_key` bytea, `alg`, `sign_count` bigint, `backup_eligible` bool (immutable), `backup_state` bool (last seen), `transports` text[], `authenticator_attachment`, `aaguid` (untrusted label), `name` (user-chosen), `rp_id` (the spec suggests storing it, F40), `created_at`, `created_via` (`signup`/`add`/`recovery`), `created_in_session`, `last_used_at`, `step_up_eligible_after` (optional policy: delay step-up eligibility of newly added credentials, e.g. 24 h, for accounts that opt in), `revoked_at`, `revoked_reason`, `uv_initialized` |
| `webauthn_user` | `user_id`, `user_handle` (random 32 bytes, never the email, never reassigned) |
| `ceremony_challenge` | `id`, `typ` (`register`/`login`/`stepup`/`recover_register`), `challenge` bytea unique, `user_id?`, `session_id?`, `action?`, `params` jsonb, `params_hash`, `nonce`, `iat`, `exp`, `consumed_at`, `outcome`, `credential_id?`, `uv`, `be`, `bs`, `sign_count_seen`, `actor_type` (`human_session` only), `pending_approval_id?`, `ip`, `ua_hash`, `failed_attempts` |
| `approval_grant` | `id`, `challenge_id`, `user_id`, `action`, `params_hash`, `expires_at`, `claimed_at`, `state` (`unused`/`claimed`/`done`/`failed`), `idempotency_key` (= challenge id) |
| `pending_approval` | `id`, `user_id`, `requested_by` (`agent_token_id`), `action`, `params` jsonb (server-normalized, incl. price quote and expiry), `status` (`awaiting_human`/`approved`/`rejected`/`expired`/`executed`) |
| `session` | `token_hash`, `user_id`, `created_at`, `last_seen_at`, `absolute_expires_at`, `auth_credential_id`, `uv`, `be`, `bs`, `revoked_at`, `ip_first`, `ua_hash` |
| `recovery_code` | `user_id`, `code_hmac`, `used_at`, `set_id` |
| `recovery_request` | `id`, `user_id`, `path` (`codes+email`/`email_only`), `status`, `created_at`, `cooling_off_until`, `email_token_hash`, `link_expires_at`, `origin_ip`, `origin_ua`, `cancelled_by`, `completed_at` |
| `audit_event` | append-only: `ts`, `user_id`, `actor_type`, `agent_token_id?`, `event`, `action?`, `params_hash?`, `challenge_id?`, `credential_id?`, `uv`, `be`, `bs`, `result`, `notified_addresses` |

Keep the assertion evidence (`clientDataJSON`, `authenticatorData`, `signature`) only for the seven step-up actions, encrypted at rest, to support disputes; it is not needed for security.

### 4.7 The exact step-up list from the brief

The brief's five phrases expand to **seven action IDs** (unlock and transfer are different registry operations; creating and widening a token are different risks). All seven are human-cookie-session only; **agent tokens can never satisfy or start them**.

| # | Brief phrase | Action ID | Parameters bound into `ph` (server-normalized) | Grant / execution | After the action |
|---|---|---|---|---|---|
| 1 | revealing a secret | `secret.reveal` | `secret_id`, `secret_version`, `project_id`, `mode` (`view`/`copy`/`export`) | Executes in the `finish` response only: plaintext (decrypted via KMS after the gate) is returned once, auto-hidden after 30 s in the UI; no grant kept | Audit event; digest email at most once per day per project; per-reveal ceremony, no "vault unlocked for N minutes" |
| 2 | changing nameservers | `domain.nameservers.change` | `domain`, hash of **current** NS set, full **new** NS list (lowercased, punycode, sorted), DS/DNSSEC handling | Grant 300 s; executor re-reads current NS and refuses if it changed since approval | Email with old/new NS and a "freeze account" link; registry call idempotent on `challenge_id` |
| 3a | unlocking a domain | `domain.unlock` | `domain`, current lock status hash, duration if auto-relock is offered | Grant 300 s | Email; optional auto re-lock after N days (product choice) |
| 3b | transferring a domain | `domain.transfer_out` | `domain`, `release_auth_code:true`, gaining registrar if known, current lock/status hash | Grant 300 s; auth code shown once in `finish` response | Email; consider a veto window before release (needs ICANN check, section 14) |
| 4 | approving an agent purchase | `agent.purchase.approve` | `pending_approval_id`, `agent_token_id`, line items `[type, domain, years, unit_price_minor, currency]`, `total_minor`, registrar quote ID/hash, `quote_expires_at`, payment method reference | Grant `min(600 s, quote_expires_at)`; executor worker re-checks price against the quote, then calls the registrar with idempotency key = challenge ID | Receipt email; agent sees only `approved`/`rejected`; price change or quote expiry means a new approval |
| 5a | creating an agent token | `agent.token.create` | `name`, sorted `scopes[]`, `spend_cap_minor`/period, allowed TLDs/domains/projects, `expires_at`, IP allowlist | Grant 300 s; token secret shown once in `finish` response, stored only as a hash | Email; token listed with last-used |
| 5b | widening an agent token | `agent.token.widen` | `token_id` and the **diff**: added scopes, cap old->new, expiry old->new, added domains/projects, removed IP restrictions, lowered approval thresholds | Grant 300 s | Email with the diff |

Asymmetry rule (design): **narrowing is free** (remove scope, lower a cap, shorten expiry, revoke or pause a token, revoke a session): session cookie only, no step-up, so the fastest path is always the safe direction.

**Candidates not in the brief that the same OWASP/NIST controls point at (product decision):** `passkey.add` and `passkey.remove` (NIST requires authentication at the account's AAL to bind an authenticator and an independent notification; OWASP requires recent reauth, F77, F83), `recovery_codes.regenerate` (NIST: replacement code triggers a notification, F73), `account.email.change` and second notification address, `registrant.contact.change`, `dnssec.ds.change`, payment method / auto-renew changes, `vault.export`, team member or role changes, `account.delete`.

### 4.8 Edge cases

- **UV impossible** (old U2F key, key without PIN): registration already requires UV (verify default), so such keys never become credentials. If a step-up hits `NotAllowedError`, show a specific message and offer another credential; do not drop the requirement (F23: the client must error if UV cannot be performed).
- **Hybrid step-up** (phone as authenticator) is allowed; phishing resistance comes from origin binding plus BLE proximity (F22, F60).
- **Two tabs / hardware key counters:** serialize `finish` per credential with a row lock and use `GREATEST` for the stored counter; a lost race fails one ceremony, never the account.
- **Password-manager extensions** act as the WebAuthn client; their UV semantics are provider-defined (unverified). For accounts holding many domains, the opt-in hardened mode (below) is the answer.
- **Hardened mode (opt-in, recommended for high-value accounts):** step-up eligible credentials restricted to `backup_eligible=false` (device-bound) via the BE flag. NIST explicitly lets a verifier use the flag to restrict syncable authenticators and forbids them at AAL3 (F71).
- **Signals:** after credential removal call `sendSignal({signalName:'unknownCredential'})` and after each login `allAcceptedCredentials` so providers hide dead passkeys (Chrome 132+, Safari 26+; no Firefox) (F12, F55).

## 5. Detecting weak credential posture

Compute on every login, every step-up and every registration from `webauthn_credential` (active = `revoked_at IS NULL`):

| State | Condition | Response |
|---|---|---|
| **A: single-device only** | exactly 1 active credential and `backup_eligible=false` (e.g. one security key, Windows Hello TPM key) | Blocking prompt at next login: add a second credential and download recovery codes; until done, no agent-token creation and no purchases. Spec: single-device credentials "not resilient to single device loss" (F41). |
| **B: single synced credential** | 1 active credential, BE=1 | Persistent banner; require recovery codes generated and acknowledged ("recovery-ready"); suggest a hardware key or a different provider. |
| **C: BS flipped 1 -> 0** | `authenticationInfo.credentialBackedUp=false` while stored `backup_state=true` | Spec says guide the user to validate other factors and add another credential (F41). Prompt immediately, email. |
| **D: same fault domain** | all active credentials share `authenticator_attachment='platform'` and the same non-zero AAGUID (or all zero AAGUID) | Nudge to add a credential from another provider or a hardware key. AAGUID is a hint only (F30). |
| **E: BE changed** | asserted BE differs from stored BE | Spec violation; fail the ceremony, alert, flag credential (F10). |
| **Recovery-ready** | >= 2 active credentials **or** (1 synced credential + acknowledged recovery codes) | No banner. |

## 6. Account recovery for a passwordless-only product

Principle: the weakest recovery path is the real security level of the account (OWASP, F84), and losing a registrar account means losing domains, so **there is no support-desk override in Phase 0**.

### 6.1 Tiers

| Tier | Mechanism | Strength / rules | Evidence |
|---|---|---|---|
| R0 prevention | Multiple credentials (spec: "SHOULD allow and encourage"), BE/BS tracking, onboarding nudges | Reduces recoveries | F42, F41 |
| R1 | Sign in with any other registered passkey | Normal login | - |
| R2 | **Saved recovery code + emailed one-time code** | Matches NIST's AAL2 recovery shape without identity proofing: two codes obtained by different methods. Saved codes: >= 64-bit random (Mosshatch: 10 codes x 80 bits), stored hashed (keyed HMAC-SHA-256 with a KMS-held pepper is my design choice; NIST only requires an approved one-way function and I did not read its section 3.1.1.2 in detail), single use, throttled, a **new set issued after any use**, regeneration notifies. Emailed code valid <= 24 h. | F73, F74, F75 |
| R3 | **Email only, delayed** (no saved code, no passkey) | Below NIST's bar, so it gets compensating controls (below). | F75, F84, F98 |
| R4 | Support override | **Not offered** | - |

### 6.2 R3 sequence (delayed, email-based)

1. `POST /api/recovery/start` with an email address. Generic response ("if an account exists ..."); no enumeration. Server creates `recovery_request(status=pending, cooling_off_until = now+72h)` for existing accounts only.
2. **Immediate notifications** to the account email, the second notification address if any (NIST: support at least two, F102), every domain's registrant email if you choose to (idea, not sourced), and an in-app banner on every live session, each with a one-click **Cancel** and **Freeze** link. Cancel needs no login; it also pauses agent tokens.
3. **Auto-cancel on legitimate use:** any successful passkey login or recovery-code use cancels the request (Apple's precedent: recovery is "cancelled automatically" if the account is in use, and takes "several days or longer", F98).
4. At `cooling_off_until` the server emails a **single-use completion link valid 24 h** (NIST email cap, F74). The link contains no sign-in ability by itself.
5. Completion opens a registration ceremony (`typ=recover_register`, UV required) bound to the request; the new credential is stored with `created_via='recovery'`.
6. **On completion:** revoke all sessions; revoke all old credentials (a lost authenticator must be assumed stolen, F78); pause agent tokens until the owner re-approves them by step-up; issue a fresh recovery-code set; notify all channels; start the **post-recovery hold**.
7. **Post-recovery hold: 7 days** during which the seven step-up actions are refused (renewals and payments keep working). OWASP: "Apply a delay or additional verification before high-impact actions when recovery indicates elevated takeover risk" (F84); Apple applies a one-hour security delay for account-security changes (F97).

R2 (codes + email) skips the 72 h wait but still notifies, revokes sessions and old credentials, issues a fresh code set, and applies a shorter 24 h hold.

Numbers (72 h, 7 d, 24 h, 10 x 80 bits) are **design proposals**; NIST sets no cooling-off length and only says recovery "may involve extended waiting times" (F103). Sourced bounds: emailed codes <= 24 h, saved codes >= 64 bits, throttling <= 100 (F73, F74, F82).

### 6.3 Notifications (NIST: every recovery and every binding of an authenticator, on an independent channel, F76, F77)

Send on: recovery start/cancel/complete, passkey added/removed, recovery codes regenerated, email changed, agent token created/widened, and each of the seven actions. Each message states what happened, when, from which IP/UA class, and how to freeze; none contains a sign-in link.

## 7. Account-takeover risks specific to passkey sync providers

| Risk | Evidence | Mosshatch mitigation |
|---|---|---|
| Takeover of the sync account (Apple/Google/Microsoft) restores every synced passkey onto an attacker's device | NIST App. B Table 5: "Synced keys are accessible via cloud-based account recovery processes, which represent a potential weakness to the authenticators." (F80); OWASP lists "Compromise of a device, authenticator, or account used to synchronize passkeys" | Require >= 2 credentials; hardened mode (BE=0) for step-up; new-credential notification; post-recovery holds; recovery codes independent of any provider |
| Low-entropy unlock secret for the sync fabric (device passcode, Google/Microsoft PIN); thief who knows the passcode | Apple built Stolen Device Protection for "someone who has stolen your iPhone and knows your passcode" (F97); Microsoft PIN capped at 10 attempts (F59) | Help text recommending Stolen Device Protection; step-up UV required; freeze link in every email |
| Passkey sharing between people | 1Password: passkeys "like any other items, you can also ... share them" (F61); NIST: "assume that all syncable authenticators may be subject to sharing" (F81) | Credential list shows name, created, last used; alert on first use from a new country/ASN (design); never treat one credential as one person |
| Endpoint malware vs. cloud authenticators | Unit 42 (2026-08-03): attacker "authenticate[s] without user interaction, bypass[es] user verification requirements and extract[s] all synced passkey private keys" (Google Password Manager, Chrome on Windows with TPM) (F95) | Session-riding is still bounded by step-up; hardened mode with a hardware key for high-value accounts; monitor vendor fixes (unverified) |
| Downgrade to a weaker method via AiTM | Proofpoint 2025-08-12: phishlet spoofs an unsupported browser so the IdP offers SMS/OTP (F96) | Passkey-only: there is no weaker method to fall back to; do not gate passkey UI on user-agent; recovery is delayed and its email carries no login |
| Provider cross-import/export changes BE/BS or moves credentials | FIDO Credential Exchange (unverified) | Treat BE/BS changes as events (section 5) |
| Script injection on your own origin | OWASP: passkeys do not prevent "Application code, authorization, or session-management vulnerabilities"; spec 13.5.8 | CSP, Trusted Types, no third-party scripts, after-the-fact email |

## 8. Sessions and cookies

| Setting | Value | Basis |
|---|---|---|
| Session token | 256-bit random, opaque, stored only as SHA-256 server-side; **not** a JWT | NIST: session secret at least 64 bits from an approved RBG (F104); OWASP opaque IDs |
| Cookie | `Set-Cookie: __Host-mh_sid=<token>; Path=/; Secure; HttpOnly; SameSite=Lax` (no `Domain`, no `Max-Age`/`Expires`) | OWASP: `__Host-` recommended for session IDs, explicit SameSite (F90); NIST: session bearer secrets SHOULD NOT be persistent (F101). `__Host-` supported since Chrome 49, Edge 79, Firefox 50, Safari 13 (F93). |
| SameSite=Lax rather than Strict | Because Stripe Checkout returns and emailed links are cross-site top-level navigations; Strict would drop the cookie on the first request. Compensate with CSRF checks. | Design; OWASP prefers Strict "(preferred) or Lax" (F91); Safari has no Lax-by-default so always set it explicitly (BCD) |
| CSRF | POST-only mutations, `Origin`/`Sec-Fetch-Site` same-origin check, signed double-submit token bound to the session on ceremony endpoints | OWASP: SameSite is "defense in depth ... not a replacement for a CSRF token" (F91) |
| Idle / absolute timeout | **30 min / 12 h**, enforced server-side; re-login is one touch | NIST AAL2 SHOULD <= 1 h idle / <= 24 h overall (F72); OWASP 15-30 min idle for low-risk, 4-8 h absolute for a work day (F92). High-risk actions are protected by step-up, not by a tiny idle timeout. |
| Rotation | New token at login, after credential changes and after recovery; revoke all on recovery | OWASP session sheet |
| Session record | Stores which credential, UV, BE/BS were used at login | Audit/risk |
| Hardening later | DBSC binds cookies to device keys (Chrome/Edge only, experimental) | F94 |

## 9. Agent tokens and passkey ceremonies

Rule: **an agent token can never start, continue or complete a WebAuthn ceremony, and can never mint a session.** NIST: an RP "SHALL NOT interpret the presence of an access token as an indicator of the subscriber's presence" (F79).

1. Separate credential classes: agent tokens (`mh_at_...`, hashed, scoped, expiring, `actor_type='agent'`) are accepted only by `/api/agent/*`. `/api/auth/*`, `/api/webauthn/*`, `/api/stepup/*`, `/api/recovery/*`, `/api/approvals/*/approve` and credential/token management reject `Authorization: Bearer` agent tokens even with a wildcard scope. Add a contract test that walks the route table.
2. Agent-triggered protected actions return `202 approval_required` and create a `pending_approval` row; the agent has no way to read or forge a challenge. A human opens the approval page in a cookie session, the server loads the stored request and builds the challenge from it, so the passkey is bound to the exact request (OWASP AI-agent sheet: "Bind approval to the exact action", F89).
3. Creating or widening a token is itself step-up (rows 5a/5b), so an agent cannot enlarge its own authority; narrowing is unrestricted.
4. Purchases enforce server-side spend caps and per-agent rate limits regardless of approval, and the approval UI shows agent identity, total, cumulative spend in the window.
5. No agent token or its hash is ever registered as a WebAuthn credential; `webauthn_credential.user_id` is a human user by construction.
6. Residual risk (unresolved by design): an agent that drives a human's own logged-in browser. OS-level biometric/PIN prompts are not scriptable from the page, but a password-manager extension that auto-approves would be. WebDriver-style virtual authenticators exist in the spec but only hold credentials the automation harness itself created, which do not match the user's registered ones (F44); the UV flag alone is not proof of a human, which is why registration and recovery are the trust anchors. Hardened mode is the mitigation.

## 10. Second domain (hatchkind.com) and Related Origin Requests

- **Preferred:** keep one sign-in origin. `hatchkind.com` redirects to `https://mosshatch.com/login?return=...` and comes back with a one-time code (passkeys.dev: "ROR is designed to be used when federation is not possible!", F36). Cookies would not be shared anyway (different registrable domain).
- **If ROR is unavoidable:** RP ID stays `mosshatch.com`; serve `https://mosshatch.com/.well-known/webauthn` (no `.json`, status 200, `Content-Type: application/json`, HTTPS, no redirects off HTTPS) with `{"origins":["https://hatchkind.com"]}`; list only the *other* origins; at most 5 registrable labels (Chrome's limit; clients must support >= 5) (F34). Server: `expectedRPID:'mosshatch.com'`, `expectedOrigin:['https://mosshatch.com','https://hatchkind.com']`; the credential row stores `rp_id`. Detect support with `getClientCapabilities().relatedOrigins` and fall back to the redirect flow (F35, F55).
- Support today: Chrome/Edge 128+, Safari 18 (macOS 15/iOS 18), Firefox 152+ (2026-06-16); older versions in the wild need the fallback (F35).
- Keep **step-up on `mosshatch.com` only**: the secondary origin has a separate cookie jar and a separate phishing surface.
- The .well-known file can be served from a Vercel route with an explicit content-type header (a static extension-less file has no type).

## 11. Decisions that need a human call

1. RP ID: apex `mosshatch.com` (recommended if the app is served from the apex and no untrusted subdomains will ever exist) vs. `app.mosshatch.com`. Irreversible after launch without ROR/re-registration.
2. Whether purchases need per-purchase approval only, or an approved spending envelope (then *creating/raising the envelope* is the step-up event, row 5a/5b).
3. Whether R3 (email-only recovery) exists in Phase 0 at all. Without it, a user who loses every passkey and every recovery code loses the account; with it, the 72 h/7 d parameters carry the risk.
4. Hardened mode as opt-in vs default for accounts above N domains or a spend threshold.
5. Which of the "candidates not in the brief" (section 4.7) are in scope for Phase 0.
6. Any delay on unlock / transfer-out / auth-code release must be checked against ICANN transfer rules (section 14).


## 12. Findings table (complete; identical to the structured summary)

| ID | Claim | Value | Source URL | Accessed | Conf. | Short quote |
|---|---|---|---|---|---|---|
| F01 | Current SimpleWebAuthn versions (npm latest tag) | @simplewebauthn/server 14.0.3 (published 2026-09-25T17:10:28Z); @simplewebauthn/browser 14.0.0 (2026-09-02T05:49:26Z); MIT; @simplewebauthn/types is frozen at 12.0.0 and npm marks it 'Package no longer supported' | https://registry.npmjs.org/@simplewebauthn/server | 2026-09-29 | high | "Package no longer supported. Contact Support at https://www.npmjs.com/support for more info." |
| F02 | v14 raised the minimum runtime to Node LTS 22.x; package.json engines still says >=20.0.0 (conflict) | Changelog: Node LTS 22.x+/Deno 2.4+. npm view engines: { node: '>=20.0.0' }. Docs install section: 'Node LTS 22.x and higher'. Treat 22 as the floor. Vercel offers 24.x (default), 22.x, 20.x. | https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/CHANGELOG.md | 2026-09-29 | high | "The minimum supported runtime versions have been increased to Node LTS 22.x and higher" |
| F03 | Vercel supported Node.js versions | 24.x (default), 22.x, 20.x; only major versions selectable | https://vercel.com/docs/functions/runtimes/node-js/node-js-versions | 2026-09-29 | high | "24.x (default)" |
| F04 | API shape of the four core server functions (v14.0.3 type definitions) | generateRegistrationOptions({rpName,rpID,userName,userID?:Uint8Array,challenge?:string\|Uint8Array,attestationType?,excludeCredentials?,authenticatorSelection?,supportedAlgorithmIDs?,preferredAuthenticatorType?,timeout?,extensions?}); verifyRegistrationResponse({response,expectedChallenge:string\|fn,expectedOrigin,expectedRPID?,requireUserPresence?=true,requireUserVerification?=true}) -> {verified,registrationInfo:{credential:{id,publicKey,counter,transports},credentialDeviceType,credentialBackedUp,userVerified,aaguid,fmt}}; generateAuthenticationOptions({rpID,allowCredentials?,challenge?,timeout?=60000,userVerification?='preferred',extensions?}); verifyAuthenticationResponse({response,expectedChallenge:string\|(c)=>bool\|Promise<bool>,expectedOrigin,expectedRPID,credential:{id,publicKey,counter,transports?},expectedTopOrigin?,requireUserVerification?=true}) -> {verified,authenticationInfo:{credentialID,newCounter,userVerified,credentialDeviceType,credentialBackedUp,origin,rpID}} | https://registry.npmjs.org/@simplewebauthn/server/-/server-14.0.3.tgz | 2026-09-29 | high | "requireUserVerification **(Optional)** - Enforce user verification by the authenticator (via PIN, fingerprint, etc...) Defaults to `true`" |
| F05 | expectedChallenge may be a (async) function; string challenges are UTF-8 encoded, so a raw digest must be passed as Uint8Array | Harness: options.challenge === base64url(digest) when a Uint8Array digest is passed; a string is base64url(UTF-8 bytes of the string) | https://simplewebauthn.dev/docs/advanced/server/custom-challenges | 2026-09-29 | high | "expectedChallenge can also be an asynchronous function to support e.g. making a network request to retrieve data needed to complete challenge verification." |
| F06 | Library defaults that matter for step-up: options default to userVerification 'preferred' and 60 s timeout; verification defaults to requireUserVerification=true | generateAuthenticationOptions default userVerification='preferred', timeout=60000; generateRegistrationOptions default attestation='none', authenticatorSelection={residentKey:'preferred',userVerification:'preferred'}, default challenge 32 random bytes; verify* default requireUserVerification=true. Set userVerification:'required' and timeout explicitly. | https://registry.npmjs.org/@simplewebauthn/server/-/server-14.0.3.tgz | 2026-09-29 | high | "userVerification **(Optional)** - Set to `'discouraged'` when asserting as part of a 2FA flow, otherwise set to `'preferred'` or `'required'` as desired. Defaults to `"preferred"`" |
| F07 | SimpleWebAuthn docs and code disagree on requireUserVerification (conflict, resolved by test) | Docs passkeys guide shows requireUserVerification:false; code default is true and the harness shows a UV-less assertion is rejected by default (verified:true/userVerified:false only when explicitly set false) | https://simplewebauthn.dev/docs/advanced/passkeys | 2026-09-29 | high | "requireUserVerification is set to false above because many websites can be just fine using passkeys without user verification!" |
| F08 | The library is stateless: it does not stop replay. The same valid assertion verified twice when the stored counter is 0 (synced passkeys) | Harness result 'replay.sameAssertionAcceptedAgainByLibrary(counter=0): true'. Single-use challenge consumption is 100% the application's job. | file://working-directory/research/webauthn/sim/sim_output.txt | 2026-09-29 | high | "replay.sameAssertionAcceptedAgainByLibrary(counter=0): true" |
| F09 | Counter check is a hard throw when either counter is non-zero and response <= stored; a bad signature returns verified:false (does not throw) | Harness: stored0/resp0 ok; stored5/resp5 throws 'Response counter value 5 was lower than expected 5'; wrong public key -> verified:false. Always test verified === true and userVerified === true. | file://working-directory/research/webauthn/sim/sim_output.txt | 2026-09-29 | high | "counter.stored5/resp5: THROWS: Response counter value 5 was lower than expected 5" |
| F10 | Library rejects BE=0/BS=1 but does not compare BE with the stored value; the RP must do that check itself (WebAuthn 7.2) | parseBackupFlags throws InvalidBackupFlags for singleDevice+backedUp; verifyAuthenticationResponse takes no stored backup flags | https://registry.npmjs.org/@simplewebauthn/server/-/server-14.0.3.tgz | 2026-09-29 | high | "Single-device credential indicated that it was backed up, which should be impossible." |
| F11 | Package hygiene: dual ESM/CJS, uses globalThis.crypto (Web Crypto), 0 known vulnerabilities at install; three certificate-chain advisories fixed in 13.3.2 (one) and 14.0.2 (two) | require() and import both work under Node 22.22.2; npm audit: found 0 vulnerabilities; pin >=14.0.2 | https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/CHANGELOG.md | 2026-09-29 | high | "Revamped certificate revocation logic to only cryptographically verify and process CRLs from certificates that chained back to an RP-chosen trust anchor" |
| F12 | Browser package API and conditional UI requirement | startAuthentication({optionsJSON, useBrowserAutofill?, verifyBrowserAutofillInput?}); startRegistration({optionsJSON, useAutoRegister?}); helpers browserSupportsWebAuthn/Passkeys/Autofill, platformAuthenticatorIsAvailable, getBrowserCapabilities, sendSignal (new in 14). Input needs autocomplete="...webauthn" (last token). | https://simplewebauthn.dev/docs/packages/browser | 2026-09-29 | high | "The "webauthn" value in the autocomplete attribute is required for autofill to work." |
| F13 | Safari user-gesture quirks (older Safari) for calling WebAuthn after a fetch | Safari 17.4/macOS 14.4+ no longer needs a native click for well-behaved RPs; earlier versions allow one call per navigation without gesture; call startAuthentication() from a native click handler after a single fetch | https://simplewebauthn.dev/docs/advanced/browser-quirks | 2026-09-29 | medium | "Websites viewed in Safari running in iOS 17.4 and macOS 14.4 and later are free to invoke WebAuthn as needed." |
| F14 | PRF extension warning: do not tie vault keys to a passkey | SimpleWebAuthn documents PRF but warns of unrecoverable data loss if the passkey is deleted; Mosshatch vault stays on cloud KMS, passkey is an authorization gate only | https://simplewebauthn.dev/docs/advanced/prf | 2026-09-29 | high | "Use of WebAuthn's prf extension dangerously ties vital encryption information to a user's passkey." |
| F20 | WebAuthn Level 3 is a W3C Recommendation (published 2026-08-25) | W3C API: status Recommendation, date 2026-08-25, uri https://www.w3.org/TR/2026/REC-webauthn-3-20260825/; previous CR 2026-05-26; L2 was REC 2021-04-08 | https://api.w3.org/specifications/webauthn-3/versions/latest | 2026-09-29 | high | "W3C Recommendation, 25 August 2026" |
| F21 | What Level 3 added that Mosshatch uses or must know | JSON (de)serialization (toJSON, parseCreationOptionsFromJSON, parseRequestOptionsFromJSON), conditional mediation for get and create, getClientCapabilities, hybrid transport value, signal methods, topOrigin, hints, related origins, BE/BS flags; aaguid no longer zeroed under attestation none; new timeout guidance (300000-600000 ms) | https://w3c.github.io/webauthn/#changes-since-l2 | 2026-09-29 | high | "aaguid in attested credential data is no longer zeroed when attestation preference is none" |
| F22 | Hybrid (cross-device) transport is defined by FIDO CTAP 2.2 (Proposed Standard, 2025-07-14): QR + tunnel service + BLE proximity | CTAP 2.2 PS 2025-07-14 section 11.5 | https://fidoalliance.org/specs/fido-v2.2-ps-20250714/fido-client-to-authenticator-protocol-v2.2-ps-20250714.html | 2026-09-29 | high | "It involves both network communication via a service called a tunnel service, and BLE transmissions to show proximity." |
| F23 | userVerification 'required' semantics | RP will fail the ceremony without UV flag; client must error if UV cannot be performed (e.g. key with no PIN and no biometrics); 'preferred' and 'discouraged' never fail the ceremony | https://w3c.github.io/webauthn/#enumdef-userverificationrequirement | 2026-09-29 | high | "The Relying Party requires user verification for the operation and will fail the overall ceremony if the response does not have the UV flag set. The client MUST return an error if user verification cannot be performed." |
| F24 | The RP, not the assertion, decides whether UV was required; the UV flag is ignored unless the RP required it | Server must set userVerification:'required' AND enforce flags.uv on verify (SimpleWebAuthn requireUserVerification:true) | https://w3c.github.io/webauthn/#sctn-verifying-assertion | 2026-09-29 | high | "User verification SHOULD be required if, and only if, pkOptions . userVerification is set to required . If user verification was determined to be required, verify that the UV bit of the flags in authData is set. Otherwise, ignore the value of the UV flag ." |
| F25 | signCount: purpose is clone detection; authenticators may leave it 0; non-increasing is a signal, not proof | Synced passkeys generally report 0; treat counter as a risk signal for multi-device credentials, enforce strictly only for single-device (BE=0) credentials (design choice) | https://w3c.github.io/webauthn/#sctn-sign-counter | 2026-09-29 | high | "If either is non-zero, and the new signCount value is less than or equal to the stored value, a cloned authenticator may exist, or the authenticator may be malfunctioning, or a race condition might exist" |
| F26 | SimpleWebAuthn and OWASP on counters for synced credentials | SimpleWebAuthn: Touch ID on macOS returns 0; OWASP: do not lock out solely on counter anomaly | https://simplewebauthn.dev/docs/packages/server | 2026-09-29 | high | "It's also not unexpected for certain high profile authenticators, like Touch ID on macOS, to always return 0 (zero) for the signature counter." |
| F27 | OWASP: treat counter anomalies as risk signals, not automatic lockouts | Record and evaluate with other signals; document response policy | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | 2026-09-29 | high | "Do not automatically lock out every user solely because of a counter anomaly." |
| F28 | Attestation: 'none' is the WebAuthn default; OWASP says most public-facing apps should use none; NIST says lack of attestation must not block public use | Use attestation none; no authenticator allowlists | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | 2026-09-29 | high | "Most public-facing applications should use no attestation and should not restrict users to a list of authenticator models." |
| F29 | NIST 800-63B-4 on attestation for public-facing use | attestation availability limited in consumer products; requiring it pushes users to weaker methods | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "The unavailability of attestations SHOULD NOT block the use of syncable authenticators for broad public-facing applications." |
| F30 | With attestation none the AAGUID is not authentic and (Level 3) is no longer zeroed by the client | Use AAGUID only as a UX hint (provider label); never as a security decision | https://w3c.github.io/webauthn/#sctn-authenticator-model | 2026-09-29 | high | "but the AAGUID is not provably authentic without attestation" |
| F31 | RP ID scope rule and immutability of a credential's RP ID | RP ID must equal the origin's effective domain or be a registrable domain suffix of it; a credential works only for the RP ID it was registered with (so choose before launch; ROR or re-registration is the only escape) | https://w3c.github.io/webauthn/#rp-id | 2026-09-29 | high | "The RP ID must be equal to the origin 's effective domain , or a registrable domain suffix of the origin 's effective domain ." |
| F32 | Spec: RPs should not allow subdomain origins by default; user content on a subdomain can exercise credentials scoped to the RP ID | Exact-match origin allowlist ["https://mosshatch.com"] | https://w3c.github.io/webauthn/#sctn-code-injection | 2026-09-29 | high | "Therefore, the Relying Party by default SHOULD NOT allow a subdomain origin when verifying the assertion ." |
| F33 | OWASP RP ID guidance: narrowest stable domain | Do not use a registrable parent domain merely to share credentials with unrelated subdomains | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | 2026-09-29 | high | "Use the narrowest stable domain that covers the intended application." |
| F34 | Related Origin Requests mechanism | GET https://{rpId}/.well-known/webauthn, JSON {"origins":[...]}, application/json, HTTPS, no credentials, no referrer; clients must support >=5 registrable labels (Chrome max 5) | https://w3c.github.io/webauthn/#sctn-related-origins | 2026-09-29 | high | "WebAuthn Clients supporting this feature MUST support at least five registrable origin labels ." |
| F35 | Related Origin Requests browser support today | Chrome/Edge 128+, Safari macOS 15+/iOS 18+, Firefox 152+ (released 2026-06-16). web.dev (Jan 2026) still said Firefox was 'considering' - superseded by Mozilla release notes. | https://www.mozilla.org/en-US/firefox/152.0/releasenotes/ | 2026-09-29 | high | "Firefox now supports the WebAuthn Related Origin Request feature, which simplifies login flows by making Passkeys usable from multiple domains." |
| F36 | passkeys.dev advice: ROR is for when federation is not possible; do not list the RP ID's own origin | For hatchkind.com prefer a redirect/federated sign-in on mosshatch.com; use ROR only if that is impossible; detect with getClientCapabilities().relatedOrigins | https://passkeys.dev/docs/advanced/related-origins/ | 2026-09-29 | high | "ROR is designed to be used when federation is not possible!" |
| F37 | Permissions-Policy: default allowlist for publickey-credentials-get/-create is 'self'; cross-origin iframes disabled by default | Header is honoured only by Chromium (Chrome/Edge 88+, Samsung 15+); Firefox and Safari: no (MDN BCD 8.1.3) | https://w3c.github.io/webauthn/#sctn-permissions-policy | 2026-09-29 | high | "Their default allowlists are both ' self '." |
| F38 | MDN: publickey-credentials-get blocked -> credentials.get rejects with NotAllowedError; default allowlist self | Permissions-Policy: publickey-credentials-get=(self) | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/publickey-credentials-get | 2026-09-29 | high | "The default allowlist for publickey-credentials-get is self ." |
| F39 | Spec: clickjacking of WebAuthn-wielding content is a stated risk for embedded use | Approval page: CSP frame-ancestors 'none' (design), no embedding | https://w3c.github.io/webauthn/#sctn-seccons-visibility | 2026-09-29 | high | "an attacker might be able to trick users into purchasing items, transferring money, etc." |
| F40 | Spec credential record: fields the RP should store (incl. backupEligible, backupState, uvInitialized, rpId) | type,id,publicKey,signCount,transports,uvInitialized,backupEligible,backupState (+ optional attestationObject, attestationClientDataJSON, rpId) | https://w3c.github.io/webauthn/#credential-record | 2026-09-29 | high | "Storing this value at registration time can help in the future, such as to audit its use, troubleshoot issues authenticating with it, or to use it across different domains later via Related Origins ." |
| F41 | Spec: single-device credentials need additional authenticators or recovery; BS 1->0 should trigger a re-validation prompt | Basis for the 'only one device-bound credential' detector | https://w3c.github.io/webauthn/#sctn-credential-backup | 2026-09-29 | high | "A single-device credential is not resilient to single device loss. Relying Parties SHOULD ensure that each user account has additional authenticators registered and/or an account recovery process in place." |
| F42 | Spec: RPs should allow and encourage multiple credentials per account | Register several credentials; use excludeCredentials | https://w3c.github.io/webauthn/#sctn-credential-loss-key-mobility | 2026-09-29 | high | "Relying Parties SHOULD allow and encourage users to register multiple credentials to the same user account ." |
| F43 | Spec: challenge entropy, storage and lifetime | Random, server-side, stored until used, >=16 bytes, valid about as long as the upper end of the recommended ceremony timeout (600 s); recommended timeout range 300000-600000 ms, default 300000 | https://w3c.github.io/webauthn/#sctn-cryptographic-challenges | 2026-09-29 | high | "Challenges SHOULD be valid for a duration similar to the upper limit of the recommended range and default for a WebAuthn ceremony timeout ." |
| F44 | WebDriver virtual authenticators exist in the spec: a UV flag is not proof of a human | Automation harnesses can create software authenticators with hasUserVerification/isUserVerified; the defence is 'credential was registered by the human through a trusted path', not the UV bit alone | https://w3c.github.io/webauthn/#sctn-automation-virtual-authenticators | 2026-09-29 | high | "Virtual Authenticators : software implementations of the Authenticator Model" |
| F50 | caniuse WebAuthn: first full support Chrome 67, Edge 18, Safari 13, iOS Safari 14.5; Firefox 60 partial; global usage 93.51% full + 2.89% partial | caniuse features-json webauthn.json (status rec) | https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/webauthn.json | 2026-09-29 | high | ""usage_perc_y": 93.51" |
| F51 | caniuse Passkeys: Chrome/Edge 108, Firefox 122, Safari 16.1 (macOS), iOS Safari 16.0, Samsung Internet 21 | caniuse features-json passkeys.json; global usage 93.87% | https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/passkeys.json | 2026-09-29 | high | ""usage_perc_y": 93.87" |
| F52 | Conditional mediation (autofill UI) availability: PublicKeyCredential.isConditionalMediationAvailable() | Chrome/Edge 108, Firefox 119 (autofill UI effective 122), Safari/iOS 16, Samsung 21; Android WebView: not supported (always false) | https://registry.npmjs.org/@mdn/browser-compat-data/-/browser-compat-data-8.1.3.tgz | 2026-09-29 | high | "chrome >=108 chrome_android >=108 edge >=108 firefox >=119 firefox_android >=119 safari >=16 safari_ios >=16 samsunginternet_android >=21.0" |
| F53 | Firefox 122 (2024-01-23): passkeys stored in iCloud Keychain on macOS and the 'webauthn' autocomplete token | Firefox desktop passkey autofill from 122 | https://www.mozilla.org/en-US/firefox/122.0/releasenotes/ | 2026-09-29 | high | "Firefox now recognizes the “webauthn” autocomplete token and will suggest passkeys in form autofill dialogs ." |
| F54 | Safari 18.0: conditional create, related origins, PRF | WebKit blog for Safari 18.0 | https://webkit.org/blog/15865/webkit-features-in-safari-18-0/ | 2026-09-29 | high | "Second, WebKit for Safari 18.0 adds support for using passkeys across related origins." |
| F55 | getClientCapabilities: Chrome/Edge 133, Firefox 135, Safari/iOS 17.4, Samsung 29; JSON helpers: Chrome 129, Firefox 119, Safari 18.4; hints: Chrome/Edge 128 only; signals: Chrome/Edge 132, Safari/iOS 26, Firefox none | MDN BCD 8.1.3 (2026-09-24) | https://registry.npmjs.org/@mdn/browser-compat-data/-/browser-compat-data-8.1.3.tgz | 2026-09-29 | high | "chrome >=133 chrome_android >=133 edge >=133 firefox >=135 firefox_android >=135 safari >=17.4 safari_ios >=17.4 samsunginternet_android >=29.0" |
| F56 | passkeys.dev device matrix (last updated 2026-09-21): synced passkeys Android 9+, ChromeOS 129+, iOS 16+, macOS 13+; Windows OS-native 'planned'; conditional get Chrome/Edge/Firefox/Safari as listed; hybrid client Android 9+, iOS 16+, macOS 13+, Windows 23H2+; third-party credential managers Android 14+, iOS 17+, macOS 14+, Windows 25H2+ | Parsed from https://passkeys.dev/device-support/ tables | https://passkeys.dev/device-support/ | 2026-09-29 | medium | "Last Updated: Sep 21, 2026" |
| F57 | Google Password Manager syncs passkeys for Chrome on Android/macOS/Windows/Linux/ChromeOS; Android 14+ lets users pick another provider (page last updated 2025-05-19) | Chrome on Windows stores passkeys in Google Password Manager | https://developers.google.com/identity/passkeys/supported-environments | 2026-09-29 | high | "Chrome on Android, macOS, Windows, Linux and ChromeOS stores and authenticate with passkeys on Google Password Manager by default." |
| F58 | Apple: passkeys sync via iCloud Keychain, end-to-end encrypted, recoverable if all devices are lost; Apple Account 2FA required | iOS 16 / macOS 13 minimum (Safari 16.x) | https://support.apple.com/en-us/102195 | 2026-09-29 | high | "Passkeys sync across a user's devices using iCloud Keychain." |
| F59 | Microsoft: synced passkeys via Microsoft Password Manager in Edge 142+ on Windows (MSA), PIN-protected, 10 unlock attempts; Windows Hello passkeys themselves are device-only | Rollout from 2025-11-03; not for Entra or mobile at that time; Entra sync began rolling out June 2026 per secondary sources (unverified) | https://blogs.windows.com/msedgedev/2025/11/03/microsoft-edge-introduces-passkey-saving-and-syncing-with-microsoft-password-manager/ | 2026-09-29 | high | "For unlocking passkeys on a new device, you will have a maximum of 10 attempts to input the correct PIN." |
| F60 | Cross-device auth needs Bluetooth on both devices plus internet (Microsoft Learn) | Hybrid works without copying the passkey | https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/ | 2026-09-29 | high | "This allows the user to authorize another device securely over Bluetooth without transferring or copying the passkey itself." |
| F61 | Password-manager passkeys are ordinary vault items and can be shared | 1Password: view, edit, move, share; NIST: RPs should assume synced authenticators may be shared | https://support.1password.com/save-use-passkeys/ | 2026-09-29 | high | "Because passkeys saved in 1Password are like any other items, you can also view, edit, move, and even share them with other people ." |
| F62 | Secure Payment Confirmation (browser-rendered payment details in the assertion) is Chromium-only and experimental | Chrome/Edge 95+, Samsung 17+; Firefox/Safari no. Not usable as a dependency for 'approve agent purchase' in Phase 0. | https://registry.npmjs.org/@mdn/browser-compat-data/-/browser-compat-data-8.1.3.tgz | 2026-09-29 | high | "secure_payment_confirmation_method \| spec: "https://w3c.github.io/payment-request/#dom-paymentrequest" \| status: {"deprecated":false,"experimental":true,"standard_track":true} chrome >=95 chrome_android >=95 edge >=95 firefox no" |
| F70 | NIST 800-63B-4: AAL2 verifiers must offer a phishing-resistant option; WebAuthn counts via verifier name binding | Passkey-only login satisfies the phishing-resistance expectation; manual-entry codes (OTP, email codes) are not phishing-resistant | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "Verifiers SHALL offer at least one phishing-resistant authentication option at AAL2" |
| F71 | NIST: syncable authenticators are acceptable up to AAL2 and never AAL3; RPs may use the BE flag to restrict them | Offer an opt-in 'hardened' mode requiring single-device (BE=0) credentials for the seven step-up actions | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "Since syncable authenticators (described in Appendix B ) require the private key to be exportable, syncable authenticators SHALL NOT be used at AAL3." |
| F72 | NIST reauthentication limits: AAL2 <= 24 h overall / <= 1 h inactivity; AAL3 <= 12 h / <= 15 min | Mosshatch session defaults sit inside the AAL2 SHOULDs | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "A definite reauthentication overall timeout SHALL be established, which SHOULD be no more than 24 hours at AAL2. The inactivity timeout SHOULD be no more than 1 hour." |
| F73 | NIST saved recovery codes: >=64 bits, stored hashed, throttled, invalidated on use and replaced | Recovery-code design: 10 codes, single use, hashed | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "The recovery code SHALL include at least 64 bits from an approved random bit generator." |
| F74 | NIST issued recovery codes: valid at most 24 hours when emailed; SMS/voice 10 minutes | Email recovery link/code expires within 24 h | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "24 hours when sent to an email address" |
| F75 | NIST recovery at AAL2 without identity proofing requires two recovery codes from different methods (or one code plus a bound single-factor authenticator) | Saved code + emailed code = NIST-shaped recovery; email alone is below that bar and needs compensating controls (cooling-off, notifications, holds) | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "Two recovery codes obtained using different methods from the set (i.e., saved, issued, and recovery contacts)" |
| F76 | NIST: every recovery event and every new authenticator binding must notify the subscriber on an independent channel; support at least two notification addresses | Email + second channel (second email or in-app/push) | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "An account recovery event always causes one or more notifications to be sent to the subscriber to help detect the fraudulent use of account recovery." |
| F77 | NIST: adding an authenticator requires authentication at the account's AAL and an independent notification | Adding a passkey = step-up with an existing passkey | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "When any new authenticator is bound to a subscriber account, the CSP SHALL ensure that the process requires authentication at either the maximum AAL currently available in the subscriber account or the maximum AAL at which the new authenticator will be used, whichever is lower." |
| F78 | NIST: a lost authenticator must be assumed stolen; compromised authenticators are suspended/invalidated promptly | After degraded recovery revoke all old credentials and sessions | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "Generally, one must assume that a lost authenticator has been stolen or compromised by someone other than the legitimate holder of the authenticator." |
| F79 | NIST: an access token is not evidence of the subscriber's presence | Agent tokens can never satisfy or mint a step-up | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "The RP SHALL NOT interpret the presence of an access token as an indicator of the subscriber’s presence in the absence of other signals." |
| F80 | NIST Appendix B Table 5: recovery of the sync fabric is a weakness of synced keys; mitigations include binding multiple authenticators and notifying on recovery | Sync-provider account takeover = passkey takeover | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "Synced keys are accessible via cloud-based account recovery processes, which represent a potential weakness to the authenticators." |
| F81 | NIST: assume synced authenticators may be shared between people | One credential does not equal one person | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "When interacting with the public, agencies have limited visibility into which specific authenticators are being employed by their users and should assume that all syncable authenticators may be subject to sharing." |
| F82 | NIST throttling: at most 100 consecutive failures per authenticator; recovery-code verification is throttled | Upper bound; Mosshatch uses far lower limits for recovery codes and step-up finishes | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "no more than 100 by disabling that authenticator" |
| F83 | OWASP Passkey Security: recent reauthentication before adding/removing passkeys or changing recovery; notify; keep one usable method | Adds passkey management and recovery-code regeneration to the step-up list | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | 2026-09-29 | high | "Require recent reauthentication before adding or removing a passkey, changing recovery methods, or disabling the last strong authenticator." |
| F84 | OWASP Passkey Security: recovery is the weakest link; delay high-impact actions after risky recovery; rotate sessions | Post-recovery hold on the seven step-up actions | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | 2026-09-29 | high | "Apply a delay or additional verification before high-impact actions when recovery indicates elevated takeover risk." |
| F85 | OWASP Passkey Security: challenge binding fields, single use, invalidate on failure; registration challenge must not be usable for authentication | ceremony_challenge row binds ceremony type, session, account, RP/origin, UV policy, expiry | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | 2026-09-29 | high | "Invalidate the challenge whether the ceremony succeeds or fails in a terminal way." |
| F86 | OWASP Passkey Security: never let a failed passkey ceremony silently fall back to a weaker phishable method | Passkey-only: no OTP/SMS/password fallback anywhere | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | 2026-09-29 | high | "A failed passkey ceremony must not silently fall back to a weaker method." |
| F87 | OWASP Transaction Authorization: unique credentials per operation, short validity, server-generated data, WYSIWYS, keep authentication distinct from authorization | One ceremony = one action instance; challenge types 'login' and 'stepup' never interchangeable | https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html | 2026-09-29 | high | "each set of authorization credentials should be unique for every operation." |
| F88 | OWASP Transaction Authorization: final control gate tied to execution (TOCTOU) | Executor re-derives params hash from current state and compares with the approved hash | https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html | 2026-09-29 | high | "There should be a final control gate before transaction execution which verifies whether the transaction was properly authorized by the user." |
| F89 | OWASP AI Agent Security: bind approval to the exact action, short-lived artifacts with replay protection, step-up for critical actions, fail closed | Agent proposes, human approves with passkey, separate executor verifies | https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html | 2026-09-29 | high | "Bind approval to the exact action. Include the actor, tool name, target resource, normalized parameters, timestamp, and expiry in the approval record." |
| F90 | OWASP Session Management: __Host- prefix recommended for session IDs; explicit SameSite; Secure; HttpOnly | Set-Cookie: __Host-mh_sid=...; Path=/; Secure; HttpOnly; SameSite=Lax | https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html | 2026-09-29 | high | "Set-Cookie: __Host-SessionID=<value>; Secure; HttpOnly; SameSite=Strict; Path=/" |
| F91 | OWASP: SameSite is defence in depth, not a replacement for a CSRF token; do not rely on browser defaults | Origin/Sec-Fetch-Site checks plus token on state-changing routes; MDN BCD: Safari has no Lax-by-default | https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html | 2026-09-29 | high | "Treat SameSite as defense in depth against CSRF, not as a replacement for a CSRF token." |
| F92 | OWASP idle/absolute timeout ranges | Idle 2-5 min (high value) / 15-30 min (low risk); absolute 4-8 h for a work-day app | https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html | 2026-09-29 | high | "Common idle timeouts ranges are 2-5 minutes for high-value applications and 15-30 minutes for low risk applications." |
| F93 | __Host- cookie prefix browser support: Chrome 49, Edge 79, Firefox 50, Safari 13, Samsung 5 | MDN BCD 8.1.3 http.headers.Set-Cookie.host_secure_prefixes | https://registry.npmjs.org/@mdn/browser-compat-data/-/browser-compat-data-8.1.3.tgz | 2026-09-29 | high | "chrome >=49 chrome_android >=49 edge >=79 firefox >=50 firefox_android >=50 safari >=13 safari_ios >=13 samsunginternet_android >=5.0" |
| F94 | Device Bound Session Credentials: Chrome/Edge 145 (Windows) and 147 (Windows+macOS), experimental, no Firefox/Safari; optional hardening, cannot be relied on | Chrome DBSC guide + BCD | https://developer.chrome.com/docs/web-platform/device-bound-session-credentials | 2026-09-29 | high | "Chrome generates this key pair during login and stores the private key in secure hardware" |
| F95 | Unit 42 (2026-08-03): malware on a Windows endpoint can take over accounts protected by Google-synced passkeys (three 'Pass-ta-key' attacks), without user interaction and bypassing UV | Scope: Google Password Manager in Chrome on Windows with TPM; responsibly disclosed; vendor fix status not verified here | https://unit42.paloaltonetworks.com/passwordless-authentication-security-risks/ | 2026-09-29 | high | "We show how an attacker can authenticate without user interaction, bypass user verification requirements and extract all synced passkey private keys." |
| F96 | Proofpoint (2025-08-12): FIDO downgrade via AiTM phishlet spoofing an unsupported browser so the IdP falls back to a weaker method; not seen in the wild at publication | Passkey-only removes the weaker method to downgrade to; do not gate the passkey UI on user-agent sniffing | https://www.proofpoint.com/us/blog/threat-insight/dont-phish-let-me-down-fido-authentication-downgrade | 2026-09-29 | high | "Using a dedicated phishlet, attackers could downgrade FIDO-based authentication to less secure methods" |
| F97 | Apple Stolen Device Protection: thief-with-passcode risk acknowledged; biometric-only (no passcode fallback) for passwords/cards and a one-hour security delay | Vendor precedent for a delay on account-security changes | https://support.apple.com/en-us/120340 | 2026-09-29 | high | "Security Delay: Some security actions such as changing your Apple Account password also require you to wait an hour and then perform an additional Face ID or Touch ID authentication." |
| F98 | Apple account recovery precedent: multi-day wait, support cannot shorten it, auto-cancelled if the account is used | Cooling-off with auto-cancel-on-legitimate-use | https://support.apple.com/en-us/118574 | 2026-09-29 | high | "For security reasons, it might take several days or longer before you can use your account again after you start account recovery." |
| F99 | RFC 8785 JSON Canonicalization Scheme for a deterministic params hash | Use JCS (I-JSON: money as integer minor units or strings) | https://www.rfc-editor.org/rfc/rfc8785.txt | 2026-09-29 | high | "This document describes the JSON Canonicalization Scheme (JCS)." |
| F100 | vercel.app is on the Public Suffix List, so preview deployments need their own full-hostname RP ID | publicsuffix.org list line: vercel.app (also vercel.dev, vercel.run) | https://publicsuffix.org/list/public_suffix_list.dat | 2026-09-29 | high | "vercel.app" |
| F101 | NIST: session bearer secrets should not be persistent; 'remember me' cookies must not replace authentication; secrets >= 64 bits from an approved RBG | Non-persistent __Host- session cookie (no Max-Age/Expires); 256-bit random value; hashed at rest | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "Session secrets that are used as bearer tokens for session management SHOULD NOT be persistent" |
| F102 | NIST: notification addresses - at least two per account; notifications go to all non-postal addresses | Support a second notification address (second email or in-app/push) and notify all on recovery and credential changes | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "CSPs SHALL support at least two notification addresses per subscriber account." |
| F103 | NIST: recovery is expected to be slower than authentication and may involve extended waiting | Basis for cooling-off (NIST sets no number) | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "Since account recovery is expected to be invoked infrequently, it is generally less convenient than authentication and" |
| F104 | NIST: session-binding secrets come from an approved RBG and are at least 64 bits | 256-bit random session token; store only its hash | https://pages.nist.gov/800-63-4/sp800-63b.html | 2026-09-29 | high | "and are at least 64 bits in length." |
| F105 | Bitwarden stores and autofills passkeys through its browser extension and mobile apps (E2E encrypted); passkeys can be synced or device-bound | Third-party managers act as the WebAuthn client via extension, so UV semantics are provider-defined (unverified) | https://bitwarden.com/help/storing-passkeys/ | 2026-09-29 | high | "Save passkeys in your Bitwarden vault and use the browser extension or mobile apps to autofill them across the apps and websites you use every day." |

## 13. Compliance / requirements checklist

| Item | Requirement | Applies to | Source | How Mosshatch meets it |
|---|---|---|---|---|
| C01 Passkey-only login, no phishable fallback | Offer at least one phishing-resistant option and never fall back to OTP/SMS/password on failure | Login, step-up, recovery UI | https://pages.nist.gov/800-63-4/sp800-63b.html | No password, OTP or SMS anywhere; failed ceremony shows retry/recovery entry only; recovery emails never contain a sign-in link (F70, F86, F96) |
| C02 userVerification required everywhere | Set userVerification:'required' in options AND enforce UV on verification (RP decides; UV flag ignored otherwise) | generateRegistrationOptions, generateAuthenticationOptions, verify* | https://w3c.github.io/webauthn/#sctn-verifying-assertion | Central wrapper sets userVerification:'required' and requireUserVerification:true, asserts result.authenticationInfo.userVerified === true (F06, F23, F24) |
| C03 Attestation none | Use attestationType 'none'; do not restrict authenticator models | Registration | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | attestationType:'none' (also library default); AAGUID stored as untrusted label only (F28-F30) |
| C04 Discoverable credentials | residentKey 'required' so conditional UI/usernameless login works | Registration | https://simplewebauthn.dev/docs/packages/server | authenticatorSelection {residentKey:'required', userVerification:'required'}; opaque 32-byte user handle (F04, F06) |
| C05 Exact RP ID and origin allowlist | Pick RP ID before launch; validate origin by exact match; do not allow subdomain origins | Server config | https://w3c.github.io/webauthn/#sctn-code-injection | RP ID mosshatch.com, origins ['https://mosshatch.com'] per environment; separate RP ID for staging; localhost for dev; Vercel previews not used for passkeys (F31-F33, F100) |
| C06 Challenge = server-generated, >=16 bytes, single-use, expiring, bound | Store challenge with ceremony type, user, session, RP/origin, UV policy and expiry; consume once even on failure | All ceremonies | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | ceremony_challenge table (typ = register/login/stepup/recover_register); atomic UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() RETURNING before verification (F43, F85, F08) |
| C07 Step-up per action instance | Unique authorization credential per operation; time-limited; server-generated transaction data; final execution gate | The seven step-up actions (from the brief's five phrases) + additions | https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html | Challenge commits to SHA-256(JCS{action,params_hash,user,session,nonce,iat,exp}); executor re-derives params hash and consumes a single-use grant (F87, F88, F99) |
| C08 Reauthentication before credential changes | Recent reauth before adding/removing passkeys or changing recovery; notify on every change | Credential management | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | passkey.add/remove, recovery-code regenerate, email change are step-up actions; email + in-app notice each time (F77, F83) |
| C09 Multiple credentials + recovery | Allow/encourage multiple credentials; track BE/BS; prompt when only one single-device credential or BS flips 1->0 | Onboarding, dashboard | https://w3c.github.io/webauthn/#sctn-credential-backup | Posture detector (section 5): banner until recovery-ready; hard prompts on single BE=0 credential and on BS 1->0 (F41, F42, F40) |
| C10 Saved recovery codes | >=64-bit random, hashed, throttled, single-use, replaced after use, regeneration notifies | Recovery | https://pages.nist.gov/800-63-4/sp800-63b.html | 10 codes x 80 bits (16 Crockford base32 chars), stored as keyed hash (KMS-held pepper), 5 attempts/hour/account, new set issued after any use (F73, F82) |
| C11 Email-issued recovery code/link <= 24 h | Issued recovery code valid at most 24 h by email; independent notification on recovery | Recovery | https://pages.nist.gov/800-63-4/sp800-63b.html | Link valid 24 h after cooling-off ends, single use; notify all addresses (F74, F76) |
| C12 Cooling-off + hold for the degraded path | Delay/additional verification before high-impact actions after risky recovery; recovery is the weakest link | Recovery | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | Email-only recovery: 72 h cooling-off, auto-cancel on any legitimate login, then 7-day hold on the seven step-up actions (design; precedents F97, F98) |
| C13 Assume lost authenticator = compromised | Revoke old credentials and sessions after degraded recovery | Recovery completion | https://pages.nist.gov/800-63-4/sp800-63b.html | All sessions, agent tokens (paused) and, on the email-only path, all credentials revoked at completion (F78) |
| C14 Session secrets | Opaque random session secret >=64 bits, server-side timeouts, rotate on privilege change | Sessions | https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html | 256-bit random token in __Host- cookie, SHA-256 stored server-side; rotate at login and after step-up-gated credential changes; idle 30 min / absolute 12 h (F72, F90, F92) |
| C15 Cookie attributes | __Host- prefix, Secure, HttpOnly, explicit SameSite, Path=/, no Domain | Vercel functions | https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html | Set-Cookie: __Host-mh_sid=<opaque>; Path=/; Secure; HttpOnly; SameSite=Lax (no Max-Age/Expires: non-persistent per NIST 5.1; timeouts enforced server-side) (F90, F91, F93) |
| C16 CSRF on ceremony endpoints | CSRF protection on registration/step-up begin and finish | /api/webauthn/*, /api/stepup/* | https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | POST only, Origin/Sec-Fetch-Site same-origin check, signed double-submit token bound to session (F91) |
| C17 Permissions-Policy and framing | Restrict publickey-credentials-get/create to self; forbid embedding of approval UI | HTTP response headers | https://w3c.github.io/webauthn/#sctn-permissions-policy | Permissions-Policy: publickey-credentials-get=(self), publickey-credentials-create=(self); CSP frame-ancestors 'none'; only Chromium enforces the first (F37-F39) |
| C18 Agent tokens cannot do ceremonies | Access token presence is not user presence; approvals bound to exact action | Auth middleware | https://pages.nist.gov/800-63-4/sp800-63b.html | /api/webauthn/*, /api/stepup/*, /api/auth/*, recovery routes reject any Authorization: Bearer agent token; agent actions create pending_approval rows only (F79, F89) |
| C19 Counters as signals | Store signCount; do not lock out solely on anomaly; enforce strictly only where meaningful | Authentication verification | https://w3c.github.io/webauthn/#sctn-sign-counter | BE=1: pass counter 0 to the library and log anomalies; BE=0: enforce (library throws), step-up fails, credential flagged not deleted (F09, F25-F27) |
| C20 Related origins only if needed | Serve /.well-known/webauthn as application/json; <=5 labels; exact origins in verify | hatchkind.com sign-in | https://passkeys.dev/docs/advanced/related-origins/ | Prefer redirect to mosshatch.com login; if ROR: well-known lists https://hatchkind.com, expectedOrigin array, no step-up on secondary origin (F34-F36) |
| C21 Library patch level | Use a maintained WebAuthn server library and keep current | Dependencies | https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/CHANGELOG.md | Pin @simplewebauthn/server >=14.0.3 and browser >=14.0.0, Dependabot/renovate, Node 22/24 on Vercel (F01-F03, F11) |

## 14. Unverified, and needs a lawyer or specialist

### 14.1 Unverified (with reason)

- Apple iCloud Keychain / Touch ID always returning signCount 0 - only SimpleWebAuthn docs ('Touch ID on macOS') and the W3C spec (counter optional) support it; Apple's own doc did not state it (Apple developer forums returned a verify-human wall).
- How third-party password-manager browser extensions (1Password, Bitwarden, Dashlane) populate the UV flag when userVerification is 'required' - provider-defined; not verified from primary docs.
- Whether Google/Microsoft/Apple have fixed the Unit 42 'Pass-ta-key' attacks (published 2026-08-03); vendor responses were not fetched.
- FIDO Credential Exchange Protocol/Format (CXP/CXF) final status: only search snippets were seen (WebSearch budget ran out), no primary spec fetched.
- SquareX 'Passkeys Pwned' (malicious browser extension hijacking the WebAuthn API, DEF CON 2025): could not be verified - search budget exhausted and no primary source fetched. Treat extension/XSS hijack of the WebAuthn API as a general risk (OWASP: passkeys do not prevent application-code vulnerabilities).
- Microsoft Entra passkey sync rollout (June 2026) - secondary-source snippet only; Edge blog (2025-11-03) says Entra/mobile not supported at that date.
- Windows Hello native synced passkeys: passkeys.dev (2026-09-21) says 'Planned'; Microsoft Learn page fetched (Windows passkeys) does not mention sync. Only Edge/Microsoft Password Manager sync verified.
- Chrome 128 as the first Chrome with Related Origin Requests: taken from passkeys.dev's matrix; Chrome 128 release notes fetched mention hints but not ROR.
- Numeric cooling-off and hold durations (72 h, 7 d, 12 h/30 min sessions, 300 s challenge TTL, 600 s grant cap) are design proposals sourced to precedents (Apple, NIST, OWASP, WebAuthn spec), not to a rule that mandates those numbers.
- Legal/regulatory interaction of any delay on unlock/transfer-out/auth-code release with the ICANN Transfer Policy and registry rules: not researched in this dossier.
- Behaviour of cross-device (hybrid) step-up on iOS/Android for userVerification 'required' when the phone has only a passcode: not tested (no real devices).
- Real-device behaviour of Safari/Chrome/Firefox for conditional mediation + modal step-up on the same page (no browsers with authenticators available in the sandbox).
- CTAP 2.2 hybrid transport spec details beyond the QR + tunnel + BLE-proximity summary.
- Whether SimpleWebAuthn engines '>=20.0.0' is an oversight or intentional - changelog wins (Node 22+), not confirmed with the maintainer.

### 14.2 Needs a lawyer, accountant or registry/ICANN specialist

- ICANN Transfer Policy and registry rules on delaying or vetoing unlock, transfer-out and auth-code release (section 4.7 rows 3a/3b, section 6 holds). Not researched here; check with the ICANN/registry dossier before shipping any delay.
- Whether a post-recovery hold that blocks nameserver changes could conflict with registrant rights or registry SLAs (for example a customer under DNS attack who needs to change nameservers). Legal/policy call.
- Privacy notice and retention for stored assertion evidence, IP/UA hashes and audit events (GDPR/UK GDPR). Not researched.

## 15. Source register (all accessed 2026-09-29)

| URL | Used for (finding IDs) |
|---|---|
| https://registry.npmjs.org/@simplewebauthn/server | F01 |
| https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/CHANGELOG.md | F02, F11 |
| https://vercel.com/docs/functions/runtimes/node-js/node-js-versions | F03 |
| https://registry.npmjs.org/@simplewebauthn/server/-/server-14.0.3.tgz | F04, F06, F10 |
| https://simplewebauthn.dev/docs/advanced/server/custom-challenges | F05 |
| https://simplewebauthn.dev/docs/advanced/passkeys | F07 |
| file://working-directory/research/webauthn/sim/sim_output.txt | F08, F09 |
| https://simplewebauthn.dev/docs/packages/browser | F12 |
| https://simplewebauthn.dev/docs/advanced/browser-quirks | F13 |
| https://simplewebauthn.dev/docs/advanced/prf | F14 |
| https://api.w3.org/specifications/webauthn-3/versions/latest | F20 |
| https://w3c.github.io/webauthn/#changes-since-l2 | F21 |
| https://fidoalliance.org/specs/fido-v2.2-ps-20250714/fido-client-to-authenticator-protocol-v2.2-ps-20250714.html | F22 |
| https://w3c.github.io/webauthn/#enumdef-userverificationrequirement | F23 |
| https://w3c.github.io/webauthn/#sctn-verifying-assertion | F24 |
| https://w3c.github.io/webauthn/#sctn-sign-counter | F25 |
| https://simplewebauthn.dev/docs/packages/server | F26 |
| https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html | F27, F28, F33, F83, F84, F85, F86 |
| https://pages.nist.gov/800-63-4/sp800-63b.html | F29, F70, F71, F72, F73, F74, F75, F76, F77, F78, F79, F80, F81, F82, F101, F102, F103, F104 |
| https://w3c.github.io/webauthn/#sctn-authenticator-model | F30 |
| https://w3c.github.io/webauthn/#rp-id | F31 |
| https://w3c.github.io/webauthn/#sctn-code-injection | F32 |
| https://w3c.github.io/webauthn/#sctn-related-origins | F34 |
| https://www.mozilla.org/en-US/firefox/152.0/releasenotes/ | F35 |
| https://passkeys.dev/docs/advanced/related-origins/ | F36 |
| https://w3c.github.io/webauthn/#sctn-permissions-policy | F37 |
| https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/publickey-credentials-get | F38 |
| https://w3c.github.io/webauthn/#sctn-seccons-visibility | F39 |
| https://w3c.github.io/webauthn/#credential-record | F40 |
| https://w3c.github.io/webauthn/#sctn-credential-backup | F41 |
| https://w3c.github.io/webauthn/#sctn-credential-loss-key-mobility | F42 |
| https://w3c.github.io/webauthn/#sctn-cryptographic-challenges | F43 |
| https://w3c.github.io/webauthn/#sctn-automation-virtual-authenticators | F44 |
| https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/webauthn.json | F50 |
| https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/passkeys.json | F51 |
| https://registry.npmjs.org/@mdn/browser-compat-data/-/browser-compat-data-8.1.3.tgz | F52, F55, F62, F93 |
| https://www.mozilla.org/en-US/firefox/122.0/releasenotes/ | F53 |
| https://webkit.org/blog/15865/webkit-features-in-safari-18-0/ | F54 |
| https://passkeys.dev/device-support/ | F56 |
| https://developers.google.com/identity/passkeys/supported-environments | F57 |
| https://support.apple.com/en-us/102195 | F58 |
| https://blogs.windows.com/msedgedev/2025/11/03/microsoft-edge-introduces-passkey-saving-and-syncing-with-microsoft-password-manager/ | F59 |
| https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/ | F60 |
| https://support.1password.com/save-use-passkeys/ | F61 |
| https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html | F87, F88 |
| https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html | F89 |
| https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html | F90, F91, F92 |
| https://developer.chrome.com/docs/web-platform/device-bound-session-credentials | F94 |
| https://unit42.paloaltonetworks.com/passwordless-authentication-security-risks/ | F95 |
| https://www.proofpoint.com/us/blog/threat-insight/dont-phish-let-me-down-fido-authentication-downgrade | F96 |
| https://support.apple.com/en-us/120340 | F97 |
| https://support.apple.com/en-us/118574 | F98 |
| https://www.rfc-editor.org/rfc/rfc8785.txt | F99 |
| https://publicsuffix.org/list/public_suffix_list.dat | F100 |
| https://bitwarden.com/help/storing-passkeys/ | F105 |
| https://simplewebauthn.dev/docs/advanced/server/cross-origin-support | expectedTopOrigin support |
| https://web.dev/articles/webauthn-related-origin-requests | web.dev ROR article (Jan 2026 text: Firefox still considering; max 5 labels in Chrome) |
| https://blogs.windows.com/msedgedev/2026/04/22/engineering-secure-passkey-sync-in-microsoft-password-manager/ | Edge blog 2026-04-22: Microsoft Password Manager sync architecture |
| https://developers.google.com/identity/passkeys/developer-guides/server-registration | Google server-side registration guide (attestationType none in sample; last updated 2025-05-19) |
| https://developer.chrome.com/docs/identity/webauthn-conditional-ui | Chrome conditional UI overview (last updated 2022-11-30) |
| https://developer.chrome.com/release-notes/128 | Chrome 128 release notes (WebAuthn hints) |
| https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html | OWASP MFA sheet: changing factors, downgrade attacks |
| https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html | OWASP Authentication sheet: re-authentication for sensitive features |
| https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html | OWASP CSRF sheet: signed double-submit, Fetch Metadata |
| file://working-directory/research/webauthn/sim/sim.mjs | Own harness (source) - output in sim/sim_output.txt |
