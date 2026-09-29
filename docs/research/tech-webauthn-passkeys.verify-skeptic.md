# Skeptic verification: tech-webauthn-passkeys (Mosshatch Phase 0)

Verifier lens: skeptic. Date of check: 2026-09-29. Method: I re-fetched primary sources myself with curl (browser UA, pre-configured proxy, TLS verification on) and re-ran the library behaviour claims with my own harness. I did not reuse the analyst's cached pages, quotes or harness. Working files: `working-directory/research/verify-skeptic/webauthn/` (raw pages, `sim/sim.mjs`, `sim/sim_output.txt`).

Access notes (nothing worked around):
- `api.w3.org` now answers 403 (Cloudflare "Just a moment") to curl, so the analyst's W3C API status check could not be repeated. The spec text at `w3c.github.io/webauthn/` carries the status header, which I used instead.
- `github.com` / advisories not attempted (analyst reported session policy block); I used the npm registry bulk-advisory API and the raw CHANGELOG instead.
- WebSearch budget was already exhausted (200/200), so no search-based checks. Everything below is direct fetches.
- Two Bash calls in my own session were denied by the permission classifier (a proxy-status/README read and a read of the dossier tail). I did not retry or route around them. The dossier head plus the analyst's structured summary were enough to pick the load-bearing claims; I did not read dossier sections 5-15 directly, so section-level details not restated in the summary were not audited.

## Verdict table (load-bearing claims)

| # | Claim | Verdict | Primary source I opened |
|---|---|---|---|
| 1 | server 14.0.3 (2026-09-25T17:10:28Z), browser 14.0.0 (2026-09-02T05:49:26Z), types frozen at 12.0.0 "no longer supported" | confirmed | registry.npmjs.org/@simplewebauthn/{server,browser,types} |
| 2 | v14 floor is Node LTS 22.x; `engines` still `>=20.0.0`; Vercel offers 24.x (default), 22.x, 20.x | confirmed (plus missed lifecycle facts, below) | raw CHANGELOG.md; tarball package.json; vercel.com/docs/.../node-js-versions |
| 3 | Library defaults: auth `userVerification` 'preferred', timeout 60000; reg `authenticatorSelection` {residentKey:'preferred', userVerification:'preferred'}; attestation 'none'; `requireUserVerification` defaults true | confirmed | 14.0.3 tarball .d.ts and .js; my own run |
| 4 | Library is stateless: same valid assertion verifies twice at counter 0; counter throws when either non-zero and response <= stored; bad signature returns verified:false; UV-less assertion throws by default; BE is not compared to a stored value; string challenge is UTF-8 encoded | confirmed (independently reproduced) | `sim/sim_output.txt` (fresh install, Node 22.22.2) |
| 5 | WebAuthn Level 3 is a W3C Recommendation dated 2026-08-25 | confirmed (spec header); API check blocked | w3c.github.io/webauthn ("W3C Recommendation, 25 August 2026", "This version: .../REC-webauthn-3-20260825/") |
| 6a | Related Origin Requests: Firefox 152 (2026-06-16) | confirmed | mozilla.org/firefox/152.0/releasenotes ("June 16, 2026", ROR line) |
| 6b | ROR: Safari 18.0 | confirmed | webkit.org/blog/15865 |
| 6c | ROR: Chrome/Edge 128 | unverifiable from a vendor source | passkeys.dev matrix says 128+; web.dev only says "supported on Chrome and Safari"; Chrome 128 release page is JS-rendered (no ROR text); chromestatus entry is stale ("No active development") |
| 7 | Spec: RP decides UV; UV flag ignored unless RP required it; challenge should live about as long as the upper end of the timeout range; recommended timeout 300000-600000 ms, default 300000; RPs SHOULD NOT allow subdomain origins by default; permissions-policy default 'self'; RPs should compare stored BE and BS; BS 1->0 should trigger validation of other factors | confirmed | w3c.github.io/webauthn (7.2 assertion steps, 13.5.3, 13.5.8, 15.1, 5.9, 6.1.3) |
| 8 | Permissions-Policy `publickey-credentials-get/-create` honoured only by Chromium (Chrome/Edge 88, Samsung 15; Firefox and Safari no) | confirmed | @mdn/browser-compat-data 8.1.3 (npm, modified 2026-09-24) |
| 9 | NIST 800-63B-4: recovery code >= 64 bits; emailed code valid <= 24 h; AAL2 recovery = two codes by different methods (or code + bound single-factor authenticator); AAL2 reauth SHOULD be <= 24 h overall / <= 1 h inactivity; syncable never AAL3; attestation unavailability SHOULD NOT block public use; >= 2 notification addresses; bearer session secrets SHOULD NOT be persistent; <= 100 consecutive failures; access token is not evidence of presence | confirmed (all quotes found verbatim) | pages.nist.gov/800-63-4/sp800-63b.html (dated 26 Aug 2025) |
| 10 | Session design 30 min idle / 12 h absolute is presented as consistent with the cited guidance | corrected: within NIST AAL2 SHOULDs, but outside OWASP's own ranges | OWASP Session Management sheet: idle "2-5 minutes for high-value applications and 15-30 minutes for low risk"; absolute "4 and 8 hours" for a full-day office worker |
| 11 | OWASP Passkey / Transaction Authorization / AI Agent quotes (counter anomaly no lockout; attestation none; narrowest RP ID; recent reauth; delay after risky recovery; invalidate challenge; no silent fallback; unique credentials per operation; final control gate; bind approval to exact action) | confirmed | cheatsheetseries.owasp.org (four sheets) |
| 12 | Unit 42 (2026-08-03): malware on Windows can take over Google-synced passkeys, bypass UV, extract all keys | confirmed but understated (see below) | unit42.paloaltonetworks.com/passwordless-authentication-security-risks/ |
| 13 | Proofpoint 2025-08-12 FIDO downgrade via phishlet, not seen in the wild | confirmed | proofpoint.com blog ("August 12, 2025") |
| 14 | Edge 142+ Microsoft Password Manager sync (MSA, Windows), 10 PIN attempts, not for mobile or Entra at 2025-11-03 | confirmed | blogs.windows.com/msedgedev/2025/11/03/... |
| 15 | passkeys.dev device matrix "Last Updated Sep 21, 2026"; ROR Chrome/Edge 128+, Firefox 152+; conditional get, Windows synced "Planned"; third-party managers Android 14+, iOS 17+, macOS 14+, Windows 25H2+ | confirmed as a page reading (secondary aggregator) | passkeys.dev/device-support/ |
| 16 | getClientCapabilities Chrome 133/Firefox 135/Safari 17.4; JSON helpers Chrome 129/Firefox 119/Safari 18.4; signals Chrome 132/Safari 26/no Firefox; conditional mediation 108/119/16; __Host- prefix 49/79/50/13; Safari has no Lax-by-default; DBSC 145 Win/147 Win+macOS experimental; SPC Chrome/Edge 95 experimental | confirmed | MDN BCD 8.1.3 |
| 17 | Apple: passkeys sync via E2E iCloud Keychain, recoverable, 2FA required; Stolen Device Protection "Security Delay ... wait an hour"; account recovery "several days", auto-cancelled if account used | confirmed (the "iOS 16 / macOS 13" floor is not on the Apple page; it is on passkeys.dev) | support.apple.com/en-us/102195, /120340, /118574 |
| 18 | Synced passkeys report signCount 0 (Apple's own statement unverified) | confirmed as a general statement, Apple-specific claim stays unverifiable | SimpleWebAuthn server docs ("Touch ID on macOS ... always return 0"); Unit 42 ("synchronized passkey systems ... constant signCount"); spec 6.1.1 |
| 19 | CTAP 2.2 PS 2025-07-14 defines hybrid via tunnel service + BLE proximity; vercel.app on PSL; caniuse 93.51%/93.87% | confirmed | fidoalliance.org CTAP 2.2 PS; publicsuffix.org list line 16269; Fyrd/caniuse JSON |

## Details that matter

### Own harness (claim 3/4)
Fresh `npm install @simplewebauthn/server@14.0.3` on Node 22.22.2, my own ES256 software authenticator built with `node:crypto` (not the analyst's code). Output:
- default auth options: `userVerification=preferred timeout=60000`; explicit `required`/300000 honoured.
- default reg options: `authenticatorSelection={residentKey:preferred,userVerification:preferred}`, `attestation=none`, `timeout=60000`, algs `[-8,-7,-257]`, user id 32 bytes.
- `Uint8Array` challenge round-trips as base64url(digest); a base64url string passed as `challenge` does not (it is UTF-8 encoded).
- same assertion verified twice at stored counter 0: both `verified:true, userVerified:true`.
- no UV flag: throws "User verification required, but user could not be verified" by default; passes with `userVerified:false` only when `requireUserVerification:false`.
- counters: 0/0 ok; 5/5 throws "lower than expected 5"; 5/4 throws; 5/6 ok.
- wrong signing key: `verified:false` (no throw).
- exact-origin: subdomain origin throws unless it is in the `expectedOrigin` array, in which case it verifies (so the array must stay exact).
- BE=0 with BS=1 throws InvalidBackupFlags; BE=1/BS=1 verifies against a record that had been BE=0 (library has no stored-BE input), so the RP-side check the analyst prescribes is necessary.
- `expectedChallenge` as an async function works.

### Claim 10 (correction): session timeouts
The analyst's section-8 values (idle 30 min, absolute 12 h) are inside NIST's AAL2 SHOULDs (<= 24 h, <= 1 h), which the dossier says. But the same OWASP sheet the dossier cites for the cookie design says idle 2-5 min for high-value applications and 15-30 min for low risk, and absolute 4-8 h for a full-day office app. A registrar holding a customer's domains and secrets is a high-value application by any reading, and 12 h absolute is outside OWASP's stated range. The design is defensible only because the seven risky actions do not depend on session age (per-action step-up), but it should be labelled "NIST-conformant, deliberately looser than OWASP" rather than implied to follow both. Suggested: 15 min idle / 8 h absolute as a starting point, or document the trade-off.

### Claim 12: Unit 42 is more serious than the summary says
Read in full (section headings Pass-ta-key, UV Flag, Silver, Golden, Mitigations):
- Base "Pass-ta-key" (identity-key signature, UV=0): "attacks typically fail when user verification is required because the UV flag remains unset" (GitHub rejects). It succeeded only against RPs that did not validate UV (eBay, since fixed). Mosshatch's `requireUserVerification:true` plus explicit `userVerified===true` check does stop this variant.
- "Silver": attacker deletes `passkey_enclave_state`/issues `device/forget`, exploits the `uv_key_pending` re-onboarding state and registers an attacker-controlled UV public key with the cloud authenticator (no attestation check), then obtains assertions with UV=1 "even when user verification is enforced and validated", reusable from the attacker's own machine.
- "Golden": Chrome's process memory exposes the security-domain secret (SDS) during re-onboarding; with it the attacker decrypts every synced passkey private key. Article: Google removed the SDS from Chrome's log output after the report, but it "remains accessible in Chrome's process memory" and "there is no way to rotate or revoke the SDS" in Google's current implementation. Silver is mitigated by unregistering/re-enrolling the device; Golden has "strong persistence".
- Scope: Google Password Manager in Chrome on Windows with TPM, malware already on the endpoint. Article says the cloud-authenticator model is used by other providers but does not test them.
Consequences for the dossier: (1) the analyst's open question "vendor fixes" is partly answered: as of 2026-08-03 not fixed; (2) UV=1 is not proof of a local human gesture for GPM-on-Windows credentials, so "UV is the second factor" (dossier section 3) is true only against non-malware threats; (3) step-up with a synced (BE=1) credential does not defend against endpoint malware on that stack; the opt-in BE=0 mode is the right mitigation and should be promoted for high-value accounts, and the step-up "what it cannot defend" list (dossier 4.1) should add endpoint malware for synced credentials.

### Missed: ICANN Transfer Policy parity rule (bears on step-up rows 3a/3b and the post-recovery hold)
Current policy text (page headed "Updated 21 February 2024 ... must implement no later than 21 August 2025"), section I.A.5 "Requirements for the ClientTransferProhibited Status and AuthInfo Codes" (page: icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers/policy):
- 5.3: "Registrars may not employ any mechanism for complying with a Registered Name Holder's request to remove the 'ClientTransferProhibited' status or obtain the applicable 'AuthInfo Code' that is more restrictive than the mechanisms used for changing any aspect of the Registered Name Holder's contact or name server information."
- 5.1/5.2: if the registrar does not provide self-service facilities, it must remove the lock / provide the AuthInfo code within five calendar days of the request.
- 5.4: cannot refuse solely over a payment dispute.
- Change of Registrant (II.C) treats a material change to registrant name, organisation or email as a trigger for confirmations and, per II.C.2 and 3.8.5, a mandatory 60-day inter-registrar transfer lock that the registrar may let the holder opt out of beforehand. 3.7.4 also requires that an opt-in registrar lock be removable within five calendar days of the holder's request; 3.9.3 says a Registrar Lock status is not a valid denial reason unless the holder had a reasonable opportunity to unlock. The dossier lists `account.email.change` as a candidate step-up action; if the account email is also the registrant email this interacts with that rule.
Implication: the dossier's optional "veto window before release" on `domain.transfer_out`, and a 7-day hold that blocks transfer-out and nameserver changes but not contact changes, could make the unlock/auth-code path more restrictive than the contact/NS path. Any hold must apply symmetrically or be cleared by counsel and the upstream registrar. Section 3.7 lists "Evidence of fraud" among the few permitted transfer-denial reasons, which is the likely lawful hook for a fraud hold. This is a lead for the lawyer, not a conclusion (the reseller's upstream registrar carries the ICANN obligation).

### Other missed or under-stated items
1. Node lifecycle: nodejs/Release schedule.json shows v22 end-of-life 2027-04-30 and v24 end-of-life 2028-04-30; Vercel changelog (14 Jul 2026) "Node.js 20 is being deprecated on October 1, 2026". SimpleWebAuthn 14 says it will support Node LTS through Active and Maintenance windows. Prefer 24.x for a new launch; 22 gives about seven months of margin.
2. PQC default algorithm list: in 14.x `getDefaultSupportedAlgorithmIDs()` prepends ML-DSA-44 (-48) whenever `runtimeSupportsWebCryptoKeyAlg('ML-DSA-44')` is true, and `verifyAuthenticationResponse` throws `PQCNotSupportedError` for a PQC credential on a runtime without it. The analyst's harness ran on Node 22.22.2 (list `[-8,-7,-257]`); Vercel's default is Node 24, which I could not test here. Pinning `supportedAlgorithmIDs:[-7,-257]` in both generate and verify, as the analyst suggests, is the right control and should be non-optional.
3. npm advisory coverage lags: the bulk advisory API returned only GHSA-6hxq-p678-4hr2 (<=13.3.1) and nothing for 14.0.1, although the CHANGELOG says 14.0.2 fixed GHSA-2g3p-m8c9-hhwh and GHSA-j3h4-m3m2-7p7j. `npm audit` therefore cannot be the gate for the ">= 14.0.2" pin. 14.0.3 shows no advisories (as of 2026-09-29).
4. BE is an unauthenticated bit under attestation 'none': NIST 800-63B-4 says the unavailability of attestation should not block public use, but also "RPs SHOULD use attestation to determine the level of confidence they have in a syncable authenticator when attestations are available" and that attestation "can provide stronger assurance". The dossier's "hardened mode = BE=0" therefore only asserts what the authenticator claims. For the opt-in hardened mode consider requesting `direct` attestation for security keys (SimpleWebAuthn has MDS support), while keeping `none` for the default path. OWASP also says BE/BS are risk inputs, "not user-verification results or proof of a specific sync provider".
5. WebAuthn L3 REC status text: "There have been no substantive changes since the Candidate Recommendation Snapshot of 26 May 2026", so nothing in the final text changes the dossier. L3 deprecates `rp.name`; SimpleWebAuthn still requires `rpName` (no action).
6. web.dev (Jan 2026) still said Firefox was "considering" ROR; Mozilla's Firefox 152 notes (2026-06-16) supersede it (the analyst had this right).
7. CXP/CXF status and SquareX extension-hijack research remain unverified; no primary source reached (search budget gone; the only CXP page retrievable was a 2024 Working Draft).

## Items I could not re-check
- api.w3.org status JSON (Cloudflare 403). Covered by the spec header instead.
- Chrome 128 as the first ROR version (vendor source not reachable).
- Apple's own statement about signCount 0.
- Real-device UV behaviour, hybrid step-up on passcode-only phones, password-manager extension UV semantics.
- Microsoft Entra passkey sync rollout (June 2026): Edge blog dated 2025-11-03 says not supported; later status not fetched.
- Node 24 behaviour of the library (only Node 22.22.2 available locally).
- Dossier sections 5-15 were not read directly (see access notes), so claims present only there (for example section 6 recovery numbers, section 9 agent-token routing) were audited only through the structured summary.
