# Verification notes: reg-porkbun, lens = TECH / PRICING

Verifier run: 2026-09-29 (UTC 20:20 to 20:35). Raw fetches and sandbox transcripts are in
`working-directory/research/vtech-porkbun/`.
I did not reuse any of the analyst's fetched files (the analyst's `pb/` dir); everything below was fetched again by me.
WebSearch budget was already exhausted (200/200), so no external incident/complaint search was possible; all evidence is first-party Porkbun pages plus live API calls.

## What I re-fetched (all HTTP 200, 2026-09-29)

- https://porkbun.com/api/json/v3/spec (OpenAPI, `info.version` 3.44, 105 paths / 119 operations, 345,868 bytes)
- https://porkbun.com/llms-full.txt, /llms.txt, /llms/domain, /llms/dns, /llms/account, /llms/webhooks, /llms/sandbox, /llms/guides, /llms/guides/register-a-domain, /getting-started, /onboard-a-mobile-app-user
- https://porkbun.com/api/json/v3/documentation
- https://api.porkbun.com/api/json/v3/pricing/get (GET and POST forms, six TLDs)
- https://porkbun.com/products/domains, /products/domains_ach, /tld/{com,ai,io,dev,studio}
- Website retail search rendered in headless Chromium: https://porkbun.com/checkout/search?q=zzqmosshatch98765.io
- https://porkbun.com/blog/upcoming-price-increases/ (HTML table parsed by column)
- KB: 27, 37, 53, 70, 181, 201, 242, 266, 293 (kb.porkbun.com/article/...)
- https://api.porkbun.com/api/json/v3/mock (route index)
- Live sandbox API (see below). Two throwaway sandbox accounts minted; no real account, no real money, no real registry action.

## Sandbox credentials: how obtained (CORRECTION to analyst)

Analyst said sandbox keys need a Porkbun account created at porkbun.com/account/api. That is one route, but the spec (`/apikey/request` description and `sandbox` body param) and llms.txt ("Get one instantly, no signup") document a second: `POST /apikey/request {"sandbox":true}` returns a `pk1_sb_...`/`sk1_sb_...` pair immediately, for a throwaway test account with $1000 fake credit, no approval. Rate limit 20 requests per IP per hour. I called it twice and both returned HTTP 200 with keys. Responses carry `"sandbox": true` and header `X-Porkbun-Sandbox: true`. Balance started at 100000 cents.

## Sandbox behaviour observed (resolves several analyst "unverified" items)

| Analyst unverified item | What I observed |
|---|---|
| Sandbox enforces $100 cap / .ai 2-year term? | Yes. `POST /domain/create/x.ai` with cost 8270 returned `COST_MISMATCH`, "minimum allowed duration (2 years). Expected: 16540 cents ($165.40)". With cost 16540 (and with dryRun cost 0) it returned `ORDER_TOO_LARGE`: "Registrations over $100 are not currently supported via API." Same on a second fresh account. |
| Do .com/.ai/.io/.dev/.app/.studio return apiRegisterable:true, and durations? | `GET /domain/getRegistrationRequirements/{tld}` with a sandbox key: all six `apiRegisterable:true`; `registrationDurationYears` 1 except .ai = 2; `maxRegistrationYears` null; whoisPrivacySupported true; requiresValidatedAddress false. |
| Do .ai/.io transfers face the $100 cap? | Transfer is not capped: dryRun transfer example.ai returned wouldSucceed:true at $165.09 (16509); a real sandbox transfer of example.ai for 16509 succeeded. Renewal cap for .ai not testable (see next row). |
| Are API-created domains auto opted in to API access? | Sandbox: API-created .com has `apiAccess:1`. BUT an inbound-transferred domain (example.ai) landed with `apiAccess:0`, `autoRenew:1`, `whoisPrivacy:0`; renew returned `API_ACCESS_DISABLED`, `/dns/create` and `/dns/retrieve` returned a 400 with code `DOMAIN_IS_NOT_OPTED_IN_TO_API_ACCESS_...`, and `updateAutoRenew` returned HTTP 200 with a per-domain ERROR. The spec has no endpoint that toggles apiAccess (checked every request body). So opt-in is web UI ("Opt In All Domains" or per domain) only. |
| Do simulated transfers complete on a timer? | No timer: sandbox transfers complete immediately ("simulated as completing immediately"); `getTransfer` returns `DONE`; `holdForDnsSetup:true` is ignored (no PENDINGDNS, `getTransferSetup` returns TRANSFER_NOT_FOUND). The PENDING* statuses cannot be exercised in sandbox. `listTransfers` returned an empty array even after DONE. |
| 30-day renewal rule enforced in sandbox? | Not in dryRun: dryRun renew on a domain registered seconds earlier returned wouldSucceed:true. |
| Expiry time-shift? | Nothing documented or found; only `/sandbox/triggerWebhook`. Not tested. |
| Which register-attempt limit behaviour? | Two parallel creates: one succeeded, the other returned HTTP 400 with `"code":"1_OUT_OF_1_CREATE_ATTEMPTS_WITHIN_1_SECONDS_USED"`, no `Retry-After`, no `next_action`. This is NOT the documented `429 RATE_LIMIT_EXCEEDED` shape. |
| Is general 20 req / 2 s per-key budget enforced? | Still `X-RateLimit-Mode: observe` on every authenticated response today (limit 20, window 2). Not enforced as of 2026-09-29 (sandbox key). |
| Register without Idempotency-Key on an already-owned name | Sandbox charged again each time (orderIds 9913724 and 9913725; balance fell $11.08 each; expireDate unchanged). This is a SANDBOX ARTIFACT: sandbox availability ignores sandbox-owned names (dryRun on my own name says "available"), while names registered in the real world are refused (`DOMAIN_NOT_AVAILABLE` for google.com). So production duplicate behaviour stays unverified, and the sandbox cannot be used to test duplicate-registration handling. |

Idempotency (documented and observed): same key + same body returned the original response with header `idempotent-replayed: true` (no second charge); same key + different body returned 409 `IDEMPOTENCY_KEY_MISMATCH`; concurrent same-key returned 409 `IDEMPOTENCY_KEY_IN_USE` with `retryable:true`.

Other sandbox observations worth an adapter's attention:
- New API-created .com showed `securityLock:0` and `autoRenew:0`, whereas changelog v3.23 says new registrations are now transfer-locked at the registry and KB 70 says auto-renew is on by default. The sandbox may simply not simulate those; production is unverified.
- `.io` create (dryRun and real, two fresh accounts) returns `{"code":"FRAUD_BLOCK","message":"Unable to process order at this time. (001)"}`; .co/.me/.xyz/.org/.net/.sh/.com/.dev/.app/.studio pass. `FRAUD_BLOCK` appears nowhere in the spec or llms docs. Cause unknown (sandbox artifact or a real .io-specific screen). The adapter must treat it as a non-retryable, undocumented code, and it needs a question to Porkbun before .io is promised.
- COST_MISMATCH is checked before FRAUD_BLOCK (cost 2812 for .io got COST_MISMATCH "Expected: 5180 cents ($51.80)").
- `GET /domain/get` in sandbox returns only: domain, status ("ACTIVE"), tld, createDate, expireDate, securityLock, whoisPrivacy, autoRenew, apiAccess, notLocal. No registry status codes.
- DNS: TTL 60 and 300 were accepted and stored as given in sandbox (docs say "Minimum is determined by account settings (typically 600)"); sandbox may not enforce it.
- `checkDomain` with a sandbox key needs credentials (`API_KEY_REQUIRED` without); llms.txt says "(no auth required)", which is wrong for that endpoint. `pricing/get` and `/ping`, `/ip` need none.
- The docs tell callers to use `checkDomain?priceType=renewal`; the parameter is not in the schema and the live response ignores it (still `type:"registration"`).
- Register-related error `next_action` and codes are inconsistent: `ORDER_TOO_LARGE`, `COST_MISMATCH`, `DOMAIN_NOT_AVAILABLE` have `next_action`; the parallel-attempt and DNS opt-in errors have generated all-caps codes and no `next_action`.

## Prices re-fetched (2026-09-29), USD

Sources: (a) `GET api.porkbun.com/api/json/v3/pricing/get?tlds=com,ai,dev,io,app,studio` (public, no auth); (b) `checkDomain` with a sandbox key (bulk call), whose `additional.renewal/transfer` blocks I compared; (c) `dryRun create/renew/transfer cost:0` quotes; (d) https://porkbun.com/products/domains rendered list; (e) https://porkbun.com/tld/{tld}; (f) the website domain search in Chromium.

| TLD | pricing/get reg / renew / transfer | checkDomain + dryRun (what the API bills) | Website list |
|---|---|---|---|
| .com | 11.08 / 11.08 / 11.08 | reg 11.08 (dryRun 1108), renew 11.08, transfer 11.08 (dryRun 1108) | 11.08 |
| .ai | 82.70 / 82.70 / 165.09 | price 82.70 is PER YEAR; `minDuration:2`; create needs cost 16540 ($165.40) and is refused ORDER_TOO_LARGE; renewal shown 82.70 (renew cost for the 2-year term untestable); transfer 165.09 (dryRun 16509, allowed) | 82.70 / 82.70 / 165.09; note "minimum term of 2 years for registration and renewals; transfers include a 2 year renewal" |
| .io | 28.12 / 51.80 / 51.80 | reg 51.80 (`firstYearPromo:"no"`; COST_MISMATCH "Expected: 5180"), renew 51.80, transfer 51.80 (dryRun 5180) | "1st Yr Sale! $28.12", regular 51.80 (also in Chromium search results) |
| .dev | 8.75 / 12.87 / 12.87 | reg 8.75 (`firstYearPromo:"yes"`, regular 12.87; dryRun 875), renew 12.87, transfer 12.87 | 8.75 sale / 12.87 |
| .app | 8.75 / 14.93 / 14.93 | reg 8.75 (promo yes, dryRun 875), renew 14.93, transfer 14.93 | 8.75 sale / 14.93 |
| .studio | 11.84 / 32.44 / 32.44 | reg 32.44 (`firstYearPromo:"no"`; dryRun 3244; a cost of 1184 gets COST_MISMATCH "Expected: 3244"), renew 32.44, transfer 32.44 | 11.84 sale / 32.44 |

Key price finding: for .io and .studio the public `pricing/get` and the website show a first-year sale price (28.12 and 11.84) that the authenticated API quote did NOT apply on a fresh sandbox account (51.80 and 32.44). .dev and .app promos do flow through. Same gap for .org (web search page showed 1st-year $7.98; dryRun cost 1184). Reason unknown; production may differ (promos could depend on account eligibility), but an adapter must take price only from `checkDomain`/`dryRun cost:0`, never from `pricing/get`.

Basis: Retail list price. KB 266 (last updated May 11, 2026): ".com Wholesale $10.26 + ICANN Fee $0.20 + Credit Card Fees $0.62 = $11.08" and "Our strategy is marking up $1 or less on all standard domain names". KB 53 ("Does Porkbun offer a bulk discount?"): "Not precisely" (only ACH). The spec's "Intended use" says the API "does not establish a reseller relationship". So an API customer pays the same public list price; there is no reseller/wholesale tier. ACH-only list re-checked at /products/domains_ach: .com 10.54, .ai 80.65/80.65/161.29, .io 28.12 sale/50.40, .dev 8.27/12.30, .app 8.27/14.31, .studio 11.84/31.45; whether ACH prices flow into API quotes remains unverified (needs an ACH account).
Restore fee: /products/domains footer: "Names recovered via the Redemption Grace Period will be assessed a domain restoration fee of $200 in addition to the normal renewal price."
Scheduled changes (blog table, columns Start Date/TLD/Reg/Renewal/Transfer, disclaimer "Prices shown are estimated projections"): .studio $43.00 from 2026-10-06; .com $11.81 from 2026-11-01 (KB 201, updated May 27, 2026: "raising November 1, 2026, 0400 UTC to approximately $11.81"); .io $60.00 from 2027-01-19. The same table also listed .io $53.00 from 2026-01-19 and .ai $84/$84/$167 from 2026-03-05; neither materialised (live .io regular 51.80, .ai 82.70), so projections have been off.

## Rate limits (spec text and live `limits` objects)

Attempt limit 1/s per account (live: "1 out of 1 create attempts within 1 seconds used"); success limit 1000 per 86400 s (live: "N out of 1000 successful creates within 86400 seconds used"); spec `x-ratelimit` note still says 50 (stale, and the `TransferDomainResponse` example even says `limit: 50` next to "1 out of 1000"). Single availability 10 per 10 s (live "1 out of 10 checks within 10 seconds used"); bulk 25 domains/call and 200 domains per 60 s (live "6 out of 200 bulk-checked domains within 60 seconds used"). General per-key 20/2 s in observe mode (live header). Register/renew/transfer limits are "configurable per API key", but no request path for changes is documented.

## Changelog review (v3.1 to v3.44, read in full)

No deprecation or sunset notice found. The "minor bumps are strictly additive, never remove or repurpose a field" guarantee is not strictly true of the log itself: v3.31 changed `securityLock/whoisPrivacy/autoRenew/apiAccess/notLocal` from a string "1" or number 0 to always integers; v3.13 replaced hosting `product`+`plan` by `sku`; v3.20 changed `/dns/create` refusals from HTTP 200 SUCCESS to HTTP 400 with codes; v3.26 fixed an inverted sort direction (a behaviour change); v3.30 changed availability and register limits. Also relevant: v3.22 fixed "a domain could only ever be transferred in once through the API"; v3.23 fixed a dead lock step; v3.44 (latest) changed glue/DNSSEC delete semantics. The Idempotency section says it covers "All v3 POST endpoints (excluding partner-only routes)"; the mock index lists `/abuse/*` and `/auth/*` routes (partner/abuse tooling), none of which is a lock/auth-code/transfer-out route.

## Verdicts per claim

1. startTransferIn = yes, `POST /domain/transfer/{domain}` {authCode, cost, dryRun, holdForDnsSetup}, .uk/manage-only/premium unsupported, typically 5-7 days: CONFIRMED (spec + live dryRun). Caveats: sandbox completes instantly; transferred-in domains arrive with apiAccess=0 in sandbox.
2. getTransfer status enum and webhook: CONFIRMED enum exactly (NEW, PENDINGAUTH, PENDINGSUBMIT, PENDINGTRANSFER, DONE, CANCELED, INIT); `PENDINGDNS` is documented only in prose for the hold flow; live `/webhook/eventTypes` lists 9 events, no transfer failure/out.
3. getAuthCode none: CONFIRMED (119 operations enumerated; no route; grep of llms-full; mock index; KB 27 shows web UI "Get Authorization Code"; KB 242 shows subaccounts/authorized users cannot generate codes). The API landing page's "Everything in the Porkbun dashboard, over the API" is marketing and contradicted by this.
4. startTransferOut none: CONFIRMED (same evidence; only `dns/preflight?intent=transfer-out` exists as a pre-check helper).
5. setLock none, securityLock read-only integer: CONFIRMED. "New API registrations start locked (v3.23)": UNVERIFIABLE (changelog says so; sandbox shows securityLock 0).
6. DNS CRUD: CONFIRMED live (create, retrieve, edit by name/type, delete by name/type, dryRun; DUPLICATE_RECORD with existingId; RECORD_CONFLICT with conflictingRecords; edit of missing name/type errors; no-op edit succeeds). `/dns/import` is idempotent skip-existing (max 500), not an update-upsert. TTL "typically 600" is the docs wording; sandbox accepted 60.
7. getDomain lacks registry status codes: CONFIRMED (schema and live response; only "ACTIVE").
8. register idempotency (replay, mismatch, in-use): CONFIRMED live. No-key duplicate behaviour in production: UNVERIFIABLE.
9. register constraints (prepaid credit only, $100 cap, premium excluded, registry-minimum term): CONFIRMED (spec text, live ORDER_TOO_LARGE, COST_MISMATCH text). .ai "likely trips cap (unverified)": CORRECTED to confirmed in sandbox: 2-year cost 16540 is refused ORDER_TOO_LARGE; price 82.70 is per year.
10. Sandbox exists and credentials: CORRECTED (no-account bootstrap via `/apikey/request {"sandbox":true}`).
11. Documented rate limits: CONFIRMED numerically; error shape CORRECTED (register-attempt breach is HTTP 400 with a generated code, not 429 RATE_LIMIT_EXCEEDED).
12. Prices .com, .dev, .app: CONFIRMED (API-billed and list agree). .ai: CONFIRMED as per-year 82.70, with the 2-year cost 165.40 now verified. .io and .studio first-year: CORRECTED (API quote 51.80 and 32.44, not the 28.12/11.84 promos). Renewals for all six and transfers for all six: CONFIRMED.
13. Basis (retail list, no reseller tier): CONFIRMED (KB 53, KB 266, spec Intended use).
14. Scheduled price changes: CONFIRMED (blog table and KB 201).
15. Changelog "no removals, additive": CORRECTED (no removals listed, but several behaviour and type changes; no deprecation notices).
16. Funding limits (5/day, 20/month, 500-50000 cents, $100/month ceiling when no limit): CONFIRMED (spec `/account/topup` and v3.37/v3.38).
17. Webhook event list and delivery contract: CONFIRMED against spec and live `eventTypes` (delivery itself not exercised).
18. Renewal preconditions (opted in, >30 days, registry-minimum term): CONFIRMED in spec; the opt-in rule confirmed live (`API_ACCESS_DISABLED`); the 30-day rule is not enforced by sandbox dryRun.
19. Sandbox helper amounts (topup default $1000, max $10,000): CONFIRMED (spec: default 100000, max 1000000 cents).
20. Per-key IP/domain allowlists, header/body auth, 119 operations, api-ipv4 host: CONFIRMED from spec (allowlists not exercised live).

## Missed by analyst (also in structured output)

See `missed` array: no-account sandbox bootstrap; sandbox simulation limits; register-limit error shape; inbound transfers arrive without API access; `FRAUD_BLOCK` on .io; pricing/get vs API quote gap; per-year price vs total cost for .ai; documentation mismatches; changelog non-additive changes.
