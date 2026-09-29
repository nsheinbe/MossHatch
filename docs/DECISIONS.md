# Mosshatch decisions

One entry per decision: context, choice, why, and what would change it. Status values: **Needs your decision** (listed in `PLAN.md` under Open decisions, with a recommendation), **Proposed default** (I decided because a defensible default exists; veto it in `PLAN.md` under Assumptions), **Fixed by the brief** (recorded for completeness). Evidence for every entry lives in `docs/research/`; dates are 2026-09-29 unless stated.

## D-001 Registrar: OpenSRS primary, CentralNic Reseller fallback
**Status:** Needs your decision.
**Context.** The brief launches as a reseller and asks for a live-verified comparison. Nine providers were researched in depth and nine more screened; every dossier was attacked by independent verifiers (`docs/research/reg-*.md`).
**Choice.** Primary: OpenSRS (Tucows Domains Inc., IANA 69) at the Essential tier. Fallback: CentralNic Reseller (Key-Systems GmbH, IANA 269), conditional on a written price quote. Dynadot is the cost benchmark and a candidate for per-extension routing later. Ship `MockRegistrar` first; the first real adapter is OpenSRS.
**Why.** OpenSRS is the only candidate whose published contract is written for resale, needs no ICANN accreditation, publishes wholesale prices for all six extensions and has a sandbox. Its costs are operational (XML API, IP allow-list, no idempotency key, replace-all DNS) rather than contractual blockers.
**Would change if.** OpenSRS answers the written questions (lookup limits and fee, add-grace refund rules, duplicate-registration behaviour, `.ai` and `.io` handling, opt-out from parked pages) badly; counsel finds the MSA unacceptable (broad suspension and price-change rights, sole-remedy clause, assignment bar); or CentralNic or Dynadot quotes materially lower wholesale with acceptable paper.

## D-002 Payment path: authorize, register, then capture
**Status:** Needs your decision (departs from the brief).
**Context.** The brief registers only after a verified `payment_intent.succeeded`, with a refund path on failure. Stripe keeps its processing fee on refunds but cancelling an uncaptured authorization is free and is not reported to card networks as fraud.
**Choice.** Hosted Checkout with `payment_intent_data.capture_method=manual`, cards, Apple Pay and Google Pay only (ACH disabled, Link off until its capture window is documented). Register while the money is held; capture on success; cancel the authorization on failure. Renewals are charged first (off-session, immediate capture) and renewed upstream second.
**Why.** Registration is the step that can fail; failing it should cost nothing. It also removes a class of refund-fee losses and dispute-eligible captures.
**Would change if.** Sandbox tests show manual capture misbehaves with a supported wallet or with Stripe Tax in Checkout; authorization windows prove too short for slow registrations (Visa merchant-initiated 4 days 18 hours); or a required payment method cannot do manual capture.

## D-003 Fee structure and price presentation
**Status:** Needs your decision.
**Context.** The brief's USD 1.50 placeholder is below break-even on every extension (USD 0.09 to 0.30 expected contribution on `.com`, `.dev`, `.app`; a loss on `.studio`, `.io`, `.ai`). Stripe's 2.9% scales with ticket size, so one flat number cannot serve both a USD 15 and a USD 222 order.
**Choice.** USD 4.00 per domain-year where wholesale is under USD 50 a year; USD 9.00 where it is USD 50 or more. The same fee on registration, renewal and transfer-in. No promotional first-year prices; "renews at" is read from the registrar's renewal price and both prices display at the same size; the Hatch sheet shows registry and registrar cost plus the Mosshatch fee. `.ai` shows "First 2 years (minimum)".
**Why.** See `PLAN.md` 4.2: fee needed for +USD 1.50 expected contribution per domain-year is 3.00 (`.com`, `.dev`), 3.25 (`.app`), 4.25 (`.studio`), 6.50 (`.io`), 9.75 (`.ai`). Mosshatch will not be the cheapest on `.com` (USD 19.25 against about USD 11 elsewhere).
**Would change if.** OpenSRS volume tiers or a cheaper provider lower wholesale; real dispute and refund rates differ from the assumptions (the model's softest inputs); or you prefer a single fee and fewer extensions (a USD 4 single fee works for `.com`, `.dev`, `.app` only).

## D-004 Trust model of the Nest and choice of KMS
**Status:** Needs your decision.
**Context.** The brief requires a per-secret AES-256-GCM data key wrapped by a cloud KMS key. Agents, the CLI and wire-it recipes need server-side decryption.
**Choice.** AWS KMS, us-east-1, one KEK per environment, Vercel OIDC federation, encryption context `{app, env, owner_id, secret_id}`. The vault is not zero-knowledge: a compromise of the production project exposes what it can decrypt until the key is disabled. A client-held-key tier (passkey PRF) is recorded as a later hardening option for production secrets, not built.
**Why.** Only AWS documents IAM and key-policy conditions on the encryption context and has a server-side re-wrap. About USD 3 to 9 a month at 1,000 secrets.
**Would change if.** You want a zero-knowledge vault (which breaks agents, CLI and recipes for those secrets), or measured KMS latency from Vercel is unacceptable.

## D-005 Egress to the registrar
**Status:** Needs your decision.
**Context.** The OpenSRS live API accepts at most five allow-listed address ranges. Vercel has no fixed egress by default; Static IPs are USD 100 a month per project.
**Choice.** Put every registrar-calling function in one Vercel project with Static IPs and treat the allow-list as a second factor for the credentials. Cheaper alternative: a small self-run gateway on a fixed address.
**Why.** No new infrastructure to run, and it lowers the impact of a leaked key.
**Would change if.** USD 100 a month is too high at launch volume (a gateway costs less but adds a component that holds the crown-jewel credentials and needs operating), or the chosen provider needs no allow-list.

## D-006 Launch scope
**Status:** Needs your decision.
**Context.** Sales tax and VAT registration, the EU accessibility act, and several consumer-law regimes are cheaper to satisfy in one jurisdiction. `.ai` and `.io` have unresolved product and legal issues.
**Choice.** United States billing addresses only (all others blocked at checkout until registered), USD only, cards and wallets only. Sell `.com`, `.dev`, `.app` first; `.studio` after fee approval; `.io` and `.ai` only after per-extension tests and disclosures. The mock and the creatures support all six from Phase 1.
**Why.** `.ai` needs a two-year minimum charge, offers no privacy service and shows contacts publicly, is absent from the OpenSRS sandbox, and its transfer rules are registry-specific. `.io`'s future is uncertain (the UK-Mauritius treaty signed 2025-05-22 is not in force and was shelved after the US withdrew support; ICANN says any retirement is a five-year process), it has no privacy service, its auth codes are issued by support, and Porkbun's sandbox flagged every `.io` create as fraud for reasons unknown.
**Would change if.** Tests and counsel clear `.ai` and `.io`; a tax adviser recommends other jurisdictions; you want EU customers at launch (VAT One-Stop-Shop registration, EU consumer-law and accessibility-act review).

## D-007 Counsel and accountant engagement
**Status:** Needs your decision.
**Choice.** Engage a lawyer and an accountant before Phase 2 money flows. Priority questions are collected in `PLAN.md` 4.7 (OpenSRS MSA review; entity, terms of service, registration agreement and privacy notice; trademark clearance; state nexus and which states to register in; whether a domain registration is "fully performed" for the EU withdrawal right; whether a security delay on transfer-out or unlock is compatible with ICANN Transfer Policy I.A.5.3 and the five-day rule; NIS2 reseller scope; OFAC screening scope).
**Why.** Several items are interpretations the research could not settle from primary sources.
**Would change if.** You already have counsel; the order of engagement can then follow their availability.

## D-008 Renewal and auto-renew policy
**Status:** Proposed default (veto in Assumptions).
**Choice.** Auto-renew is opt-in, unchecked, a passkey-signed mandate with a price ceiling. Charge date about ten days before expiry; notices at expiry minus 44, minus 32 and minus 18 days (the last is charge minus 8); decline ladder at charge, +3 and +6 days with at least seven days to pay by other means; a post-expiry notice within five days; the ICANN expiry notices are sent regardless. Registrar-side auto-renew stays off. Registrations are refundable for the shorter of five days and the upstream window; `.io` and `.ai` are shown as non-refundable before payment. Unpaid domains are never locked or suspended as leverage (Gandi's contract forbids it and the ICANN Transfer Policy bars blocking a transfer for non-payment).
**Why.** It satisfies the brief (no pre-checked boxes), California, New York and Vermont renewal-notice laws, Visa's stored-credential rules and ICANN's ERRP. The first draft's cadence had zero margin against Visa's seven-day floor and California's 15 to 45 day window, so the verified cadence adds margin.
**Would change if.** Counsel reads the auto-renewed-name ERRP notice rule differently (a charged renewal moves expiry before the T-7 notice).

## D-009 Step-up scope and the Gate
**Status:** Proposed default.
**Choice.** Seven actions from the brief plus contact changes (ICANN I.A.5.3 parity). After a passkey step-up, unlock and the transfer authorization code are available immediately; a security delay is an opt-in setting the owner turns on in advance ("lock harder", default 48 hours, always inside five calendar days), plus a notification with a freeze link on every unlock, code issue and nameserver change. The brief's "cooling-off" is therefore an owner-chosen delay, not a default.
**Why.** ICANN requires the code and unlock within five calendar days of the holder's request and bars mechanisms more restrictive than contact or nameserver changes. A default delay risks non-compliance; an owner-requested one is the holder's own request.
**Would change if.** Counsel approves a default delay.

## D-010 Hold-to-reveal accessibility
**Status:** Needs your decision (departs from the brief).
**Choice.** Ship hold-to-reveal as an enhancement, and always provide a single-activation path (activate, confirm, reveal) for keyboard, switch and voice users. The 10-second re-hide is adjustable, and the value is never in a live region.
**Why.** WCAG's Understanding text for 2.1.1 names "a key must be held down for an extended period" as a failing timing; the brief's "hold Space/Enter" would not pass an audit.
**Would change if.** You accept the audit risk (not recommended).

## D-011 Sensitive DNS changes by agents and recipes
**Status:** Proposed default.
**Choice.** Changes to `MX`, `NS`, `DS`, apex `A/AAAA/CNAME` and SPF/DMARC `TXT` records made by an agent or a recipe create a pending approval that needs a human passkey, like a purchase.
**Why.** An MX change intercepts email, including password resets at other services; it is as dangerous as a nameserver change, which the brief already gates.
**Would change if.** It makes recipes feel heavy; the recipe preview could then count as the approval for a human-initiated recipe (agents stay gated).

## D-012 Names, trademarks and hatchkind.com
**Status:** Needs your decision (counsel).
**Choice.** Keep both names; no blocker found in the knockout search; instruct a trademark attorney to run a full clearance (CROSSHATCH in Class 42 is the closest collision; HATCH is crowded). Use `hatchkind.com` as the public card host under the conditions in `PLAN.md` 4.8 (credential-free, cookie-free, read-only, publish-gated, no email), with the host as a configuration value. Do not build public brand equity in HATCHKIND until cleared.
**Would change if.** Clearance finds a conflict; a rename then becomes a redirect.

## D-013 Toolchain and versions
**Status:** Proposed default.
**Choice.** Node 24.x; npm workspaces with `npm ci` and an explicit `allowScripts` policy; Vite 8.3, React 19.3, three 0.186, TypeScript 7 via the documented alias so `typescript-eslint` keeps working; Vitest 5; no `@vercel/node`; an `overrides` entry for `drizzle-kit`'s esbuild; `drizzle-orm` at least 0.45.2; `@simplewebauthn` 14.0.3; `stripe` pinned `~22.6.2` with an explicit API version; `@modelcontextprotocol/server` 2.x. Pins are re-verified at the start of Phase 1.
**Why.** Verified in a scratch install: 494 packages, no peer conflicts, 0 audit findings on the recommended manifest.
**Would change if.** TypeScript 7.1 or Drizzle 1.0 land before Phase 1 (both have pre-release tags); pins are then re-tested.

## D-014 Database driver and jobs
**Status:** Proposed default.
**Choice.** Neon Postgres in `aws-us-east-1` (paired with Vercel `iad1`; a Neon region cannot be changed). Drizzle over `node-postgres` on TCP with a pooled connection, because `neon-http` has no interactive transactions. Runtime role created with SQL (Console-created roles bypass row-level security and can write any table). A `jobs` table claimed with `FOR UPDATE SKIP LOCKED` plus a one-minute Vercel cron on Pro; no Vercel Queues or Workflow on the money path (beta). Neon Launch through Phase 3, Scale before real customer money (30-day point-in-time restore, IP allow-list, SOC 2 report access).
**Would change if.** Vercel Queues or Workflow reach general availability with adequate guarantees.

## D-015 Content Security Policy, cookies and headers
**Status:** Proposed default.
**Choice.** The enforced CSP and header set in `PLAN.md` 4.3a; `__Host-` session cookie with `SameSite=Lax` (not Strict, which is not sent on the return from Stripe); CSRF defence by `Sec-Fetch-Site`, `Origin`, JSON and a custom header; Trusted Types in Report-Only first; no service worker in Phase 1 (`Cache.put()` stores `no-store` responses); Stripe redirect through `fetch` then `location.assign`.
**Would change if.** A needed library requires a looser policy (for example `@react-three/drei` CDN defaults are blocked and should be self-hosted).

## D-016 Sessions and recovery parameters
**Status:** Proposed default.
**Choice.** 15-minute idle and 8-hour absolute sessions; recovery with two credentials, ten recovery codes, an emailed code, and a slow email-only path (72 hours) with a 72-hour hold on step-up actions afterwards; an opt-in hardened mode for device-bound credentials.
**Why.** NIST AAL2 is met and OWASP's high-value ranges are approached; the first draft's 30 minutes and 12 hours were looser than the sources it cited.
**Would change if.** Usability testing shows the idle timeout is too aggressive for the Nest; only that surface could be relaxed.

## D-017 Availability search and front-running commitments
**Status:** Proposed default.
**Choice.** Server-side fan-out, debounced, cached; the registrar's check is authoritative and runs on select and at checkout; RDAP stays off the per-keystroke path. Public commitments: never register or hold a name because it was searched, never sell search data, no durable storage of search text.
**Why.** No registry publishes a numeric RDAP limit and all restrict high-volume automated use; RDAP 404 does not mean available.

## D-018 Scene technology
**Status:** Fixed by the brief, confirmed.
**Choice.** WebGL2 with `WebGLRenderer` and GLSL `ShaderMaterial` (WebGPU is not a safe sole target and `WebGPURenderer` does not support custom `ShaderMaterial`); one merged mesh per creature; at most 24 individually animated creatures; a tiered hero (baked still, 2D ambience, live scene behind a capability gate and frame-time watchdog); 30 fps tier; scene chunk loaded lazily after first paint.
**Would change if.** WebGPU reaches universal support and three's WebGPU path supports custom shaders.

## D-019 Agent surface
**Status:** Proposed default.
**Choice.** MCP specification 2026-07-28 on `@modelcontextprotocol/server` 2.x, static scoped bearer tokens first (`mh_<kind>_<32 base62>+CRC32`, SHA-256 at rest) and an OAuth authorization server in Phase 5; server-enforced approval; no secret-returning tool marked read-only; CLI login by RFC 8628 device flow with a passkey-gated approval page; keychain storage via `@napi-rs/keyring`.
**Would change if.** Major clients adopt the 2026-07-28 revision and OAuth becomes the only connection path.

## D-020 Registrant model and WHOIS privacy
**Status:** Proposed default.
**Choice.** The customer is always the registrant of record; Mosshatch never registers in its own name for others (that would make it the registered name holder with the attendant liability). "WHOIS privacy: Free" means default redaction under the ICANN Registration Data Policy for the gTLDs, with no paid add-on; the sheet states what `.ai` and `.io` expose.
**Would change if.** The upstream registrar stops redacting by default.

## D-021 Test and evidence approach
**Status:** Proposed default.
**Choice.** Playwright pinned to 1.56.1 (matches the preinstalled Chromium 141) or `executablePath`; never `--disable-gpu`; deterministic screenshots via frozen time and seeded random; structural performance budgets in CI and real-device frame times as a manual protocol; the secret-scan prototype and its tests adopted in Phase 4.

## D-022 Repository workflow
**Status:** Proposed default.
**Choice.** Commit in small steps on `claude/vigilant-ritchie-8vinxb`; no push and no pull request until you ask. Your brief is not committed to the repository unless you want it there. This container is ephemeral: unpushed work is lost if the session is reclaimed, so ask for a push whenever you want the docs kept off this machine.

## D-023 Research method and its limits
**Status:** Recorded.
**Context.** The search tool had a 200-call budget that ran out early; later research used direct fetches of primary pages. Several sites were unreachable (bot protection or egress policy): Namecheap and ResellerClub legal pages, the UK IPO search, the W3C site through Cloudflare, Mastercard's rulebook, some tax authority pages. Nothing was worked around.
**Choice.** Every claim in `PLAN.md` is either sourced to a dated primary page, labelled as measured here, labelled as our own target or assumption, or listed as unverified.
