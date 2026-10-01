# Registrar parity: what `mock:opensrs` cannot model

Scope: `MockRegistrarPort` (`packages/registrar/src/mock-port.ts`) against the OpenSRS adapter that arrives with Phase 3. Sources: `docs/PLAN.md` 4.1, 4.1a, 4.3b ("MockRegistrar rules"); `docs/research/reg-opensrs.md`. No OpenSRS call has ever been made: every OpenSRS statement below is a documentation statement, not an observation. Review this file at each phase report (rule 6).

## How the contract suite is tagged

`runRegistrarContract(makeAdapter, { tags })` in `packages/registrar/src/contract.ts`. Each test is tagged:

- `both`: must pass on the mock and on the Horizon sandbox adapter (register, second register rejected, taken after register, capabilities honesty, unsupported extension).
- `mock-only`: needs fault injection or seeded state. Everything under "Fault API" below, `.ai` term arithmetic, sample labelling, the seeded kinds, funding arithmetic, premium refusal, renew draft, maintenance.
- `sandbox-only`: needs the real provider. Today one test (Horizon rejects the same name twice). Phase 3 adds recorded-response replays and the nightly random-name run (1-year terms; Horizon cannot register one name twice even across resellers).

The mock is run with `["both","mock-only"]`; the Horizon adapter will be run with `["both","sandbox-only"]`.

## Modelled, and only as far as the documentation says

| Behaviour | Mock | Basis |
|---|---|---|
| No idempotency key; second `register` for a taken name fails `rejected` | yes | 4.1a `register` |
| `period` defaults to 2 when omitted (`defaultPeriod2` fault) | yes: the ignored period bills and extends two years | 4.1a |
| `.ai` minimum term 2 years | yes (`invalid_period`) | 4.1a, reg-opensrs K12 |
| Forced pending (unfunded order) and async 250 | yes; `accepted_pending`, never `registered` | 4.1a, 4.3b rule 3 |
| Claim rule (profile username, `type=new`, orderDate >= sentAt - 5 s, registrant) | yes, `claim.ts` | 4.3b order state machine |
| `LOOKUP` cache unless `no_cache=1` | yes: 5-minute stale cache | 4.1a `checkAvailability` |
| One name per lookup call | yes (no batch method exists) | 4.1a |
| Renewal retry after success fails (555/541); failed renewal leaves a draft that blocks until cancelled | yes, with codes `555`, `541`, `draft_exists` | 4.1a `renew`, reg-opensrs K7 |
| Restore per extension (`.com .dev .studio` yes; `.app .ai .io` no) | capabilities only; no `restore()` method yet | 4.1a gap note |
| Registry-premium names refused | yes (`premium_refused`); the premium multiple in quotes is a mock fixture, not a price | D-031 |

## Not modelled (the mock cannot tell you)

1. **Real `GET_PRICE` output.** Whether the amount includes the USD 0.20 ICANN fee, whether `.ai` is 2 x 111.00, and whether promotional first-year prices (`.dev` 10, `.io` 34, `.app` 14) apply to API orders. Mock wholesale is the plan's table (`SAMPLE_WHOLESALE_CENTS`); the post-order debit comparison (4.3b rule 4) can only be proven against Horizon or live.
2. **Real response codes and messages.** Only the codes named above are reproduced; the mapping of OpenSRS 2xx/4xx/5xx codes to `RegistrarError.kind` is unproven.
3. **Timing.** Async completion uses a fixed 60 s on the injected clock. Real queue latency, `PROCESS_PENDING` behaviour, registry approval times and clock skew between our clock and OpenSRS `orderDate` (the 5 s window exists because of skew) are not modelled.
4. **Network faults.** No real timeouts, TLS resets, partial responses or HTTP 401 for a non-allow-listed address. `timeoutAfterAccept` is a synthetic stand-in.
5. **Lookup fees and rate limits.** The MSA 3.2 "excessive use may result in a fee" threshold is unquantified; OpenSRS rate limits are unknown. The mock's `rateLimited` fault is on demand.
6. **Funding.** No card or PayPal top-up gross-up (about +3.09%), no held amounts, no auto-renew failures on a low balance. The balance is a single number and `topUp` completes forced-pending orders immediately.
7. **Lifecycle after registration.** Add grace refunds (`REVOKE`), expiry grace (40 days), redemption (30 days), live auction from day 41, and drop are not simulated; `getDomain` reports `expired` after expiry and nothing more.
8. **Transfers.** No `CHECK_TRANSFER`, no `GET_TRANSFERS_AWAY`, no emailed approval steps; the capability flag `outboundTransfer: emailed_approval` is descriptive only. `.io` auth codes by support are a capability field.
9. **DNS.** No zone commands. `dnsMode: replace_all`, no TTL, no CAA are capabilities, not behaviour. Whether `SET_DNS_ZONE` replaces the whole zone or only the supplied types, and the TXT length limit, are undocumented and need Horizon.
10. **Registrant verification and suspension**, WHOIS privacy states beyond the fixed per-extension display, DS records, registry statuses beyond `clientTransferProhibited`/`ok`.
11. **Events and webhooks.** `events: false`, `webhooks: false`: OpenSRS event delivery is not verified in Horizon.
12. **Two customers, one name** across resellers: `sameNameTwoUsers` models one rival profile only.
13. **Reserved and premium name data.** Seeded from a hash and prefixes (`taken-`, `reserved-`, `premium-`, `unknown-`, `free-`); real registry reserved lists and premium groups differ. Observed live in the research: `example.dev`, `example.app`, `example.studio` are reserved.
14. **Profile validation.** Length rules for `reg_username` (3-20) and `reg_password` (10-20) are checked; character-set rules and password strength are not.

## Fault API summary

`mock.faults.set(name, { times?, fqdn?, durationMs? })`, `clear(name?)`, `has(name)`; `topUp(minor)`, `setBalance(minor)`, `advance(ms)`, `registerAsOther(fqdn)`, `overrideQuote`, `setKind`, `addMaintenanceWindow`; counters `calls.*`, `upstream.*`, `debits`; state `orders`, `domainRecord`. Faults: `timeoutAfterAccept`, `workerDeath` (throws `DeathSignal` after applying), `duplicateSubmit`, `sameNameTwoUsers`, `insufficientFunds`, `async250`, `registryMaintenance`, `renewDraft`, `defaultPeriod2`, `rateLimited`, `unknownAvailability`.

## Phase 3 review (2026-09-30)

Items 8 to 10 above are now partly modelled, still from documentation only: `getTransfersAway`, `stopTransferAway` (re-lock and replace the code; the pending transfer remains, as OpenSRS has no cancel call), the out-of-band simulator (`oob.startTransferAway`, `oob.setLock`, `oob.setNameservers`, `oob.addDs`, `oob.changeOwnerEmail`, `oob.setAutoRenew`, `oob.letExpire`, `oob.setPrivacy`, `oob.editZone`) for the detector, replace-all DNS in both overwrite modes (`dnsOverwrite: "whole_zone" | "per_type"`), DS records, contact changes that start an ICANN trade, redemption and `restore()`, and `getBalance`. The OpenSRS adapter (`packages/registrar/src/opensrs`) runs the shared contract suite against hand-written fixtures labelled `source: "documented"`; no Horizon response has been seen. The whole-zone versus per-type overwrite question, the `GET_PRICE` total, and every attribute name marked UNVERIFIED in the adapter stay open until Horizon credentials exist (docs/PHASE3.md lists them).

## Openprovider (added 2026-09-30)

Adapter: `packages/registrar/src/openprovider/` (`OpenproviderAdapter`, REST API v1, bearer token from `POST /auth/login`). Why Openprovider: `docs/research/cheaper-upstreams-2026-09-30.md`. Unlike the OpenSRS adapter, this one has been run against the provider: every "verified" row below was observed on the **live Openprovider sandbox** (`https://api.sandbox.openprovider.nl/v1`, play money, 2026-09-30). Production (`https://api.openprovider.eu/v1`) has not been called. The host and the `/v1` paths are those of Openprovider's OpenAPI document (`developer.openprovider.com/data/swagger.json`, re-fetched 2026-10-01: `host: api.openprovider.eu`, paths `/v1/...`); the older `/v1beta` base is not used.

How it is tested:
- `openprovider.test.ts` (offline): allow-list, guards (kill switch, fuses, live/sandbox versus deployment), token reuse and re-login, error mapping, ST-22 code hygiene, money and dates, DS arithmetic against RFC 4509 and RFC 6605, the DNS write plan, provider routing.
- `replay.test.ts` (offline, runs in CI): the shared contract (`both` + `sandbox-only`) and a full lifecycle replayed from fixtures **recorded from the sandbox** (`fixtures/*.recorded-sandbox.json`, `source: "recorded-sandbox"`, recorded 2026-09-30; tokens, passwords, authorization codes, customer handles and the account holder's details scrubbed). Replay is strict: each request must equal the recorded one, in order.
- `sandbox.test.ts` (live, skipped unless `OPENPROVIDER_PASSWORD` is set and never in CI): the same contract and lifecycle against the sandbox; `OPENPROVIDER_RECORD=1` rewrites the fixtures.
- Contract tests excluded for Openprovider, each for a provider reason printed in the skipped test name (`OPENPROVIDER_EXCLUSIONS` in `openprovider/testing.ts`): the OpenSRS restore map, the nameserver test with made-up hosts, DS-by-DS, the 20-character code format, the not-hosted zone test (needs foreign nameservers), and the pending-approval contact change. The lifecycle covers each of these the Openprovider way.

| Area | Openprovider behaviour | Status |
|---|---|---|
| Login | `POST /auth/login {username,password,ip:"0.0.0.0"}` returns an opaque 32-character token; bad credentials or token answer HTTP 401 code 196. Token reused 12 h (lifetime unknown), re-login once on 401 | verified (lifetime UNVERIFIED) |
| Availability | `POST /domains/check`: `free` / `active`; `nothing.xyz` refused before sending | verified; other statuses (reserved, premium flag) UNVERIFIED; whether results are cached upstream UNVERIFIED |
| Prices | `GET /domains/prices`: `price.reseller.price` is the total for the period, USD, a JSON number (kept as text, no floats). Sandbox (non-member): .com create 11.98 (2 y 23.96), renew 16.98, transfer 11.98; .ai 109/year (2 y 218); .io 70; .studio 46 | verified |
| Register | `POST /domains` with an explicit `period`; contacts are customer handles (one created per order); `autorenew: "off"`; Openprovider DNS nameservers. .com and .io answer `ACT` at once; debit equals the quote exactly | verified for .com, .io |
| .ai | 1-year create refused (316); a 2-year create answered **HTTP 504 and was created anyway** (status `REQ`, price held in `reserved_balance`), so a timeout after a write is `outcomeUnknown` | verified |
| .dev, .app, .studio | Sandbox registry refused creates ("Incorrect contact's details" for .dev/.app, "Contact type not permitted: registrant" for .studio) | UNVERIFIED in production; the live contract maps these names to .com |
| Duplicate register | code 346, `rejected`; no idempotency key | verified |
| Claim rule | No per-order profile: the adapter writes `mh:<regUsername>` in the domain `comments` and synthesises one order per domain (`type` NEW, `order_date`); fingerprint from the owner handle | verified |
| Dates | `creation_date`, `expiration_date`, `renewal_date` in UTC; `order_date`, `active_date`, `last_changed` in Europe/Amsterdam time (two hours apart); a pending .ai showed local time in `creation_date` | verified (the REQ case is UNVERIFIED) |
| Lock | New .com is locked (`is_locked`, clientTransferProhibited); `PUT is_locked` round-trips | verified |
| Renew | `POST /domains/{id}/renew {period}`; no expiry-year guard upstream (a repeat renews again; omitted period renewed 1 year), so the adapter compares the year first; debit equals the renew quote. One renew took over 30 s and had been applied when the client gave up | verified |
| Auth code | Provider-generated: `POST /domains/{id}/authcode/reset` returns a new 12-character code with symbols. `PUT auth_code` and `PUT reset_auth_code` answer success and change nothing. The code also comes back unasked in `GET /domains`, `GET /domains/{id}` and `POST /domains`; the adapter strips it on parse | verified |
| DNS | Zone created with the domain (signed master, SOA + NS). Per-record `PUT /dns/zones/{name}`: names relative, TXT stored with quotes, SRV value "weight port target" with `prio`. **`add` and `remove` in one request: the remove is silently dropped.** A remove must match the stored form (quotes, `prio`) or it does nothing while answering success; 18002 when nothing matched; `replace` swaps the whole zone. The adapter removes then adds in separate requests and reads back | verified |
| TXT length | A 300-character TXT was accepted; the adapter keeps the 254 limit | verified |
| Nameservers | `PUT name_servers`; the sandbox registry refuses unknown hosts (399). After a move away the zone stays but `getDns` reports not hosted | verified |
| DNSSEC | DNSKEY-based (`dnssec_keys`, a full set per write). Openprovider DNS signs new domains (read-only alg-8 key); **while that key is present an added key is silently dropped** (the adapter reads back: `dnssec_key_not_applied`). The key stays after moving nameservers away; removing it and adding our own works; moving back to Openprovider DNS left the domain unsigned (not re-signed). The port's DS view is computed (SHA-256); `addDs` by DS is refused (`dnssec_dnskey_required`), `addDnskey` is the adapter extra | verified |
| Contacts | Email and phone edits on the handle apply at once; a name edit on a handle answers success and is ignored, so a name change creates a new handle and sets `owner_handle`, which applied at once. No pending ICANN Change of Registrant step was visible | verified; the 60-day lock and registrant email verification effects UNVERIFIED |
| Auto-renew | `autorenew` on/off round-trips; `default` read as on | verified (meaning of `default` UNVERIFIED) |
| Balance | `GET /resellers`: `balance`, `reserved_balance` | verified |
| Inventory | `GET /domains` with limit/offset, newest first | verified |
| Delete and restore | A deleted .io is `DEL` / softQuarantine with `restorable_until`; `POST /restore` brought it back to `ACT` at no charge; `DELETE` on a pending order answers 366 | verified for .io; other extensions and redemption fees UNVERIFIED |
| Transfer in | Codes are checked at once: a wrong code answers 358 (`invalid_auth_code`), even for an unregistered name. `import_nameservers_from_registry` alone is refused (223); with `ns_group` it passes validation | refusals verified; a real transfer, its statuses, owner email and cancel UNVERIFIED (no second sandbox registrar) |
| Transfers away | No list endpoint in the spec and no status observed: `getTransfersAway` refuses (`transfers_away_unsupported`); `stopTransferAway` reports the pending transfer as remaining | UNVERIFIED |
| Insufficient funds, rate limits, maintenance | Never provoked (100,000 of play money); mapped by description, HTTP 429 and the `maintenance` flag | UNVERIFIED |
| Webhooks, events, idempotency | None in the spec | n/a |

Configuration: `MH_REGISTRAR_PROVIDER=openprovider|opensrs|mock` (whole) and `MH_REGISTRAR_PROVIDER_BY_TLD=com=openprovider,...` (per extension), parsed by `parseRegistrarRouting`; `OPENPROVIDER_USERNAME`, `OPENPROVIDER_PASSWORD`, `OPENPROVIDER_ENV=sandbox|production`. `loadConfig` refuses `OPENPROVIDER_*` outside `MH_SCOPE=registrar` and in preview, sandbox credentials in production, production credentials outside production, and credentials that disagree with `MH_REGISTRAR_MODE` (`packages/api/src/config/openprovider-guard.ts`).

## Live wiring (added 2026-10-01)

Live sales go through Openprovider only (`MH_REGISTRAR_PROVIDER=openprovider`; production refuses OpenSRS with `registrar_provider_not_openprovider`). The adapter runs in the `mosshatch-registrar` Vercel project (`apps/registrar`, `packages/api/src/registrar-rpc/serve.ts`), the only place the credentials exist, behind the signed RPC; `docs/GO-LIVE.md` has the setup. Offline tests drive web's RPC client through that handler to a fake Openprovider and check that the live adapter calls the production base URL (`registrar-rpc/serve.test.ts`). Prices: migration 1120 (non-member, USD, public feed 2026-10-01); the D-031 guard compares each live quote, including the renewal price, with that table and refuses any difference. Still UNVERIFIED in production: every row above marked verified was seen in the sandbox only.
