# The brand launcher

Tap an egg, the creature hatches, you talk to it. It turns the conversation into a short brief, gold sparks rise, and a scroll unrolls
with the brief and its price in credits. Approve it and Slate (the website builder, a separate app) builds a first version; runes mark
the build steps and the preview appears on the scroll. Keep talking to revise it ("make it warmer"); every revision is a new version
you can switch back to. Publishing to your own domain arrives next; today you can download a version's files. Decision: D-061.

The launcher is **off by default**. It needs all three of: a complete configuration (below), the `launcher_enabled` flag set to true
(the migration inserts it as false), and, in production and staging, an account that came in through an invite (`user_live_access`).
Everyone else, including every demo visitor, gets the teaser: a static panel that never calls the model or any launcher route.

## Where things live

| Part | Path |
|---|---|
| Routes (`/api/v1/launcher/*`, session-only, CSRF-guarded) | `packages/api/src/launcher/routes.ts` |
| Gating, conversations, quotes, builds, refunds, export | `packages/api/src/launcher/service.ts` |
| Configuration from the environment (reason codes, never values) | `packages/api/src/launcher/config.ts` |
| The creature: Claude adapter and scripted fake | `packages/api/src/launcher/claude.ts`, `claude-fake.ts` |
| The persona, rules and the two tools (`propose_brief`, `revise_site`) | `packages/api/src/launcher/persona.ts`, `packages/core/src/brief.ts` |
| Slate partner client and fake | `packages/api/src/launcher/slate.ts`, `slate-fake.ts` |
| Credits ledger | `packages/api/src/launcher/credits.ts` |
| Brief screen (phishing floor) | `packages/api/src/launcher/screen.ts` |
| Schema (conversations, builds, credits, flag) | `packages/db/migrations/1200_launcher.sql` |
| UI: panel, conversation, scroll, runes, teaser | `apps/web/src/ui/launcher/` |
| Scene: framing, gold sparks, glow | `apps/web/src/world/engine.ts` (`focusCreature`, `goldSparks`, `setVoice`), `rig.ts` |
| Voice seams | `apps/web/src/voice/` |
| Owner scripts | `scripts/launcher-credits.mjs`, `scripts/launcher-frame-src.mjs` |
| Tests | `packages/api/src/launcher/*.test.ts`, `packages/core/src/brief.test.ts`, `e2e/launcher.spec.ts`, `e2e/launcher-teaser.prod.spec.ts` |

Entry points: "Talk to <species>" on the card after a practice hatch (`CardPanel.tsx`, source `practice`) and "Talk to its creature"
on an owned domain's panel (`DomainPanel.tsx`, source `owned`). A practice conversation can build but never publish.

## Environment

Set in the `mosshatch` Vercel project (sensitive values as sensitive variables; never commit any of them). An incomplete set leaves
the launcher off and the app boots anyway; boot logs `launcher_not_configured` with reason codes when any launcher variable is present.

| Variable | Required | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | The creature's model. |
| `SLATE_PARTNER_URL` | yes | Slate's partner API base, https, e.g. `https://<slate host>/api/partner/v1`. |
| `SLATE_PARTNER_ID` | yes | Must be `mosshatch`. |
| `SLATE_PARTNER_SECRET` | yes | The shared HMAC secret (at least 32 characters). Same value as Slate's `SLATE_PARTNER_SECRETS.mosshatch`. |
| `SLATE_PARTNER_USER_KEY` | yes | Our own key (at least 32 characters, different from the secret) for the pseudonymous per-account id sent to Slate. Slate never sees a Mosshatch user id or email. |
| `SLATE_PREVIEW_ORIGIN` | no | The origin preview pages are served from, when it is not the partner URL's origin. |
| `MH_LAUNCHER_MODEL` | no | Default `claude-opus-5-5`. |
| `MH_LAUNCHER_MARKUP_BPS` | no | Markup on Slate's quote in basis points. Default 15000 (1.5x), range 10000 to 100000. |
| `MH_LAUNCHER_DAILY_BUILDS` | no | Builds and revisions one account may confirm per UTC day. Default 5. |
| `MH_LAUNCHER_DAILY_SPEND_MINOR` | no | Credits all accounts together may be charged per UTC day. Default 5000 (USD 50). |
| `MH_LAUNCHER_DAILY_TURNS` | no | Creature turns per account per UTC day. Default 60. |
| `MH_LAUNCHER_DAILY_TURNS_GLOBAL` | no | Creature turns for everyone per UTC day. Default 600. |
| `MH_LAUNCHER_CONVERSATION_TURNS` | no | Owner messages per conversation. Default 40. |
| `MH_LAUNCHER_FALLBACKS` | no | `off` disables server-side refusal fallbacks. |
| `MH_LAUNCHER_INVITE_ONLY` | no | `1` or `0`. Defaults to on in production and staging, off locally. |
| `MH_FAKE_LAUNCHER` | dev/test | `1` runs the scripted creature and the fake Slate (no model or Slate call). Refused in production. `scripts/e2e-server.mjs` sets it. |

## Slate contract

Slate's side is documented in Slate's `apps/studio/docs/PARTNER_API.md` (branch `claude/brand-launcher`). Every request is signed
with `x-slate-partner`, `x-slate-timestamp`, `x-slate-nonce`, `x-slate-partner-user` and `x-slate-signature`
(HMAC-SHA256 over timestamp, nonce, method, path with query and the body hash; details in `slate.ts`). Endpoints used: `POST /quote`,
`POST /builds`, `GET /builds/:id`, `POST /builds/:id/cancel`, `GET /builds/:id/export`, and the signed preview URLs. Every response is
parsed with a schema; Slate's error messages are never passed on, only codes.

Provisioning, done once by the owner:

1. On Slate: apply its partner migration, generate the secret (`partner:provision -- --new-secret`), put it in Slate's
   `SLATE_PARTNER_SECRETS`, then create and fund the partner wallet (`partner:provision -- --partner mosshatch --credit-cents ...`).
2. Here: set `SLATE_PARTNER_SECRET` to the same value, and generate a separate `SLATE_PARTNER_USER_KEY`
   (`openssl rand -hex 32`). Set `SLATE_PARTNER_URL`, `SLATE_PARTNER_ID=mosshatch` and `ANTHROPIC_API_KEY`.
3. Rotation is a coordinated switch: set the new secret on both sides together.

Unverified with Slate: that the signed path is the full request path with query (for example `/api/partner/v1/quote`).

## Preview framing

The page's CSP is static (`vercel.json`) and ships `frame-src 'none'`. With it, the scroll links out to the preview instead of framing
it. To frame previews, commit the one preview origin:

```
node scripts/launcher-frame-src.mjs https://<slate preview origin>   # or: none
```

This rewrites `frame-src` in `vercel.json` and `e2e/plan-headers.ts` together (the header test compares them). Set
`SLATE_PREVIEW_ORIGIN` to the same origin and rebuild; the API frames a preview only when the two agree, and never hands the page a
preview URL on any other origin or path. The iframe is sandboxed.

## Money

1 credit = 1 US cent. The ledger (`launcher_credits`) is append-only: grants, charges, refunds and adjustments, each a row; the balance
is their sum. The price shown on the scroll is Slate's quote times the markup, rounded up, and nothing is charged until the owner
presses Approve. A build is charged once, settled down if Slate charged less than it quoted, and refunded in full if it fails (unique
index per build and kind, so retries cannot move money twice). Daily caps per account and for everyone bound the bill on both the model
and Slate side; Slate has its own partner caps on top.

Until Stripe credit packs exist, the owner grants credits and toggles the flag with:

```
DATABASE_URL=... node scripts/launcher-credits.mjs --enable                      # launcher_enabled = true (or --disable)
DATABASE_URL=... node scripts/launcher-credits.mjs --email a@b.c --grant 1000    # grant 1000 credits (USD 10)
DATABASE_URL=... node scripts/launcher-credits.mjs --email a@b.c                 # show the balance
```

Turning it on for the dogfood: configure the environment, deploy, run `--enable`, then grant credits to invited accounts.

## Prompt caching

The request is ordered tools, system rules, persona, messages. The tools and rules are byte-identical for every conversation; the
persona is built once from the creature's spec and stored on the conversation row; `api_messages` is append-only. A code change never
shifts the cached prefix of a running conversation. `persona.test.ts` holds this.

## Threat model

- The owner's words only ever appear in user turns; the rules tell the creature they are not instructions. Tool inputs are strict
  schemas, validated again on our side before anything is quoted.
- `screen.ts` refuses the most obvious phishing briefs (a known brand plus a sign-in or payment lure, or collecting credentials) before
  Slate is asked. It is a floor, not the content screening a published site needs before strangers can launch.
- Ownership: every route is session-only and scoped to the account (and RLS); the security matrix covers the launcher routes.
- Downloads are served as attachments with a `sandbox` CSP. Previews come only from the configured origin.
- No secret, prompt text or message text is logged; usage is recorded as token counts only.

## Voice next

Not shipped. `apps/web/src/voice/types.ts` defines the seams a provider plugs into: `SpeechToText` (the owner's speech becomes the same
text the input sends), `TextToSpeech` (speaks streamed replies in the species voice from `voiceFor` in `packages/core/src/launcher.ts`)
and `AmplitudeSource` (drives the creature's glow; today `TokenAmplitude` from streamed words, next `AnalyserAmplitude` on playback).
`Permissions-Policy` keeps `microphone=()` until voice ships behind its own decision.

## Testing

- Unit and integration: `npx vitest run packages/api/src/launcher packages/core/src/brief.test.ts` (needs the test database,
  `scripts/pg-local.sh start`).
- End to end with fakes: `npx playwright test --project=launcher`. Set `LAUNCHER_SHOTS=<dir>` to save screenshots of the key moments.
- The demo teaser under the production CSP: `npx playwright test --project=prod e2e/launcher-teaser.prod.spec.ts` (after `npm run build`).
