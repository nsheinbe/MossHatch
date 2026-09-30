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
