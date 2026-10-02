# Go live: invite-only dogfood on mosshatch.com

What this gets you: you (and only accounts you invite) can buy a real domain on mosshatch.com, registered through **Openprovider live**
and paid with **Stripe live**. Everyone else keeps seeing today's demo (banner, practice hatch from the public registry lookup, no prices,
waitlist). Do the steps in order; each ends with a check. Nothing here needs a code change.

Read first: what has and has not been verified (end of this page). **No call to the live Openprovider API has ever been made**; your first
purchase is the first one.

## How it fits together

```
browser ── mosshatch.com (Vercel project "mosshatch": web + API, Stripe live key, NO registrar credentials)
                │  signed RPC (HMAC, REGISTRAR_RPC_SECRET, 60 s window, nonce, allow-listed commands)
                ▼
          mosshatch-registrar.vercel.app (Vercel project "mosshatch-registrar": apps/registrar, ONLY the Openprovider
                │                          username and password, no database, no Stripe, no vault)
                ▼
          https://api.openprovider.eu/v1 (Openprovider live)
```

The Openprovider password lives only in the second Vercel project, so nothing reachable from the web code paths (pages, API routes, the
vault) can read it (PLAN 4.3b, threat rows 29 and 30). That is the "extra Vercel project" below; it is one function and costs nothing extra
on Pro. Trade-off kept on purpose: the registrar project has no fixed egress IP (no Static IPs, D-005), so Openprovider's optional IP
allow-list cannot be used yet; a leaked Openprovider password would work from anywhere. Mitigations: 2FA on the Openprovider control panel
(the API login does not use it), a USD 20 balance as the hard spend ceiling, the spend fuses below, and the rotation runbook
(`docs/runbooks/registrar-credential-exposure.md`). Turn on Static IPs for the registrar project and the Openprovider allow-list before
strangers buy.

## 1. AWS (production keys)

Follow `docs/AWS-SETUP.md` to the end of its step 9. Production refuses to start until AWS is right, so do this first.

Check: `curl -s https://mosshatch.com/api/health/ticks` answers 503 and the `reason` lists **no** `aws_*`, `kms_*`, `anchor_*` or `vault_*`
code (only the money codes from steps 3 to 6 remain).

## 2. Openprovider account

1. Control panel, account settings: two-factor authentication on (LAUNCH-CHECKLIST stage 2).
2. Account currency **USD**. The adapter refuses any price that is not USD (`currency_mismatch`), so a EUR account cannot sell.
3. API access enabled for the user whose login you will give the registrar project. If the panel offers an API IP allow-list, leave it
   **off** for now (no fixed egress yet, see above).
4. Balance: USD 20 is enough for one .com (11.98 non-member) with room for a renewal test later. Do not add more until the rehearsal is done.
5. Membership: not bought. Prices below are non-member prices. Buying a membership lowers our cost; it never raises what a customer pays.

Check: in the panel, Reseller details shows the USD balance.

## 3. The `mosshatch-registrar` Vercel project

1. Vercel, Add New, Project, import the same GitHub repository (`nsheinbe/MossHatch`).
2. Project name `mosshatch-registrar`. **Root Directory `apps/registrar`** (Edit next to it). Framework Preset: Other. Leave the build and
   install commands empty: `apps/registrar/vercel.json` sets them (`cd ../.. && npm install`, `cd ../.. && node scripts/build-registrar.mjs`).
   Keep "Include files outside the root directory in the Build Step" on (the default).
3. Before the first deploy, Settings, Environment Variables, **Production only, Sensitive** for every one:

   | Name | Value |
   |---|---|
   | `MH_SCOPE` | `registrar` |
   | `MH_MODE` | `production` |
   | `MH_REGISTRAR_MODE` | `live` |
   | `MH_REGISTRAR_PROVIDER` | `openprovider` |
   | `OPENPROVIDER_ENV` | `production` |
   | `OPENPROVIDER_USERNAME` | your Openprovider API login |
   | `OPENPROVIDER_PASSWORD` | its password |
   | `REGISTRAR_RPC_SECRET` | a new random secret, at least 32 characters: `openssl rand -base64 48` (keep it for step 6) |
   | `MH_REGISTRAR_DAILY_SPEND_OPS` | optional; paid operations a UTC day per function instance, default `5` |
   | `MH_REGISTRAR_KILL_SWITCH` | optional; `open` (default), `writes_paused` or `all_paused` |

   Never put these in the `mosshatch` project: its boot refuses any `OPENPROVIDER_*` variable (`registrar_key_outside_registrar_scope`).
4. Settings, Git: set the Ignored Build Step to build production only (the registrar has no Preview variables, so a preview build would
   only answer "not configured"; skipping them keeps its traffic small). Settings, Deployment Protection: leave Standard Protection
   (it protects previews; the production URL must stay reachable by `mosshatch`).
5. Deploy (Deployments, Redeploy, or push to `main`).

Check:
```sh
curl -s -X POST https://mosshatch-registrar.vercel.app/rpc/v1/capabilities -d '{}'
# {"error":{"code":"unauthorized"}}   <- up, and refuses unsigned calls (the right answer)
```
A misconfigured registrar project logs one line per cold start in its function logs: `{"event":"registrar_not_configured","reasons":[...]}`.
The same codes reach `mosshatch`'s boot (step 7).

## 4. Database

From your machine, with the Neon **owner** connection string (the runtime role cannot create tables):

```sh
DATABASE_URL_OWNER='postgres://<owner>@<host>/<db>?sslmode=require' node scripts/go-live-db.mjs --sell-gate-floor 500
```

It applies pending migrations (1120 adds Openprovider's price table, the extension policy and refund rows for `openprovider`, and the
live-access check), publishes the legal documents checkout records acceptance of, and lowers the sell gate floor from USD 250 to USD 5 (with
a USD 20 balance the default floor refuses every order with `sell_gate`). Run it again with `--status` any time.

Check: the output shows `latest migration: 1120_openprovider_live.sql`, eighteen `openprovider price rows` (com/register 11.98,
com/renew 16.98, ...), the documents in force, `tax regions open: 51`, and `orders_paused = false`.

## 5. Stripe live

1. Activate the live account (business details, bank account). Settings, Public details: the statement descriptor prefix (C-40).
2. **Stripe Tax** in live mode: activate it and set the origin address. Checkout is created with `automatic_tax` and Stripe refuses it
   when Tax is not active. Registrations per your accountant (Stripe Tax charges zero where you have none).
3. Developers, API keys, **Create restricted key** `mosshatch-production` with Write on: Customers, Checkout Sessions, PaymentIntents,
   PaymentMethods, Refunds, Products; Read on Charges and Radar reviews (the PaymentIntent read expands the charge and review). If Stripe
   names another permission in an error, add exactly that one.
4. Create the four Products once (idempotent, prints ids only):
   ```sh
   STRIPE_SECRET_KEY='rk_live_...' node scripts/stripe-catalog.mjs
   # live mh_domain_register created ... (four lines)
   ```
5. Developers, Webhooks, **Add endpoint**:
   - URL `https://mosshatch.com/api/v1/webhooks/stripe`
   - API version **`2026-08-26.dahlia`** (must equal `STRIPE_API_VERSION` in `packages/api/src/stripe/real.ts`)
   - Events: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `payment_intent.succeeded`, `payment_intent.canceled`, `payment_intent.payment_failed`,
     `payment_intent.amount_capturable_updated`, `payment_intent.requires_action`, `review.opened`, `review.closed`, `refund.updated`,
     `refund.failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, `radar.early_fraud_warning.created`,
     `payment_method.automatically_updated`
   - Copy the signing secret (`whsec_...`) for step 6.

Check: the endpoint shows in the dashboard as enabled; the catalog script printed four lines.

## 6. The `mosshatch` Vercel project

Settings, Environment Variables, **Production only** (Sensitive for the secrets; the `VITE_*` ones are public build flags):

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | the `rk_live_...` restricted key from step 5 |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_...` signing secret from step 5 |
| `MH_REGISTRAR_MODE` | `live` |
| `MH_REGISTRAR_PROVIDER` | `openprovider` (and no `MH_REGISTRAR_PROVIDER_BY_TLD`) |
| `REGISTRAR_RPC_URL` | `https://mosshatch-registrar.vercel.app` |
| `REGISTRAR_RPC_SECRET` | the same value as in the registrar project |
| `VITE_API_ENABLED` | `1` |
| `VITE_SITE_MODE` | `invite` (one build: demo for visitors, the shop for invited accounts) |
| `MH_LIVE_DAILY_REGISTRATIONS` | `3` (the default when live; `0` stops registrations) |
| `MH_LIVE_TOTAL_REGISTRATIONS` | `10` (the default when live; lifetime cap while dogfooding) |

Already present from before and still needed: `DATABASE_URL`, `DATABASE_URL_CRON`, `MH_ORIGIN=https://mosshatch.com`, `CRON_SECRET`
(32+ characters), `RESEND_API_KEY`, the AWS variables. Invite-only sign-up (`MH_INVITE_ONLY`) and the live gate (`MH_LIVE_GATE`) are on by
default in production; do not set them to `0` (the gate stays on even if sign-up is opened; only `MH_LIVE_GATE=0` opens the shop to every account). Then Deployments, Redeploy the production deployment (a new build: the `VITE_*` flags are
read at build time).

## 7. Verify the boot

```sh
curl -s https://mosshatch.com/api/v1/session
# {"signedIn":false,"live_gate":true}   <- the full API booted, and the shop is gated
```
Any 503 names what is still missing, as codes only:

| Code | Fix |
|---|---|
| `origin_not_configured`, `cron_secret_not_configured`, `database_not_configured` | `MH_ORIGIN`, `CRON_SECRET` (32+), `DATABASE_URL` |
| `vercel_env_not_production` | the live money paths only run in the Production environment |
| `stripe_secret_key_missing`, `stripe_key_not_live` | `STRIPE_SECRET_KEY` missing, or a test key in production |
| `stripe_webhook_secret_missing` | `STRIPE_WEBHOOK_SECRET` missing or not a `whsec_...` value |
| `registrar_mode_not_live`, `registrar_provider_not_openprovider` | `MH_REGISTRAR_MODE=live`, `MH_REGISTRAR_PROVIDER=openprovider`, no per-extension routing |
| `registrar_rpc_url_missing`, `registrar_rpc_secret_missing` | `REGISTRAR_RPC_URL`, `REGISTRAR_RPC_SECRET` (32+) in `mosshatch` |
| `registrar_rpc_target_environment_mismatch` | the RPC URL's host has a non-production word in it (`staging`, `preview`, `dev`, ...) |
| `registrar_rpc_unreachable` | the registrar project is down, or the URL is wrong (step 3 check) |
| `registrar_rpc_secret_mismatch` | the two projects have different `REGISTRAR_RPC_SECRET` values |
| `registrar_project_secret_missing` | the registrar project has no (or a short) `REGISTRAR_RPC_SECRET` |
| `openprovider_credentials_missing` | `OPENPROVIDER_USERNAME` / `OPENPROVIDER_PASSWORD` missing in the registrar project |
| `registrar_scope_missing`, `live_outside_production`, `registrar_provider_unsupported`, `registrar_mode_invalid` | registrar project variables (step 3 table) |
| `openprovider_sandbox_credentials_in_production`, `openprovider_env_registrar_mode_mismatch` | `OPENPROVIDER_ENV=production` with `MH_REGISTRAR_MODE=live` in the registrar project |
| `registrar_mode_mismatch` | the registrar project answers in a mode other than live |
| `stripe_live_not_configured`, `registrar_live_not_configured` | the code-level kill (`PRODUCTION_LIVE_WIRED` in `packages/api/src/boot.ts`) is off |
| `mode guard: ...` | the mode guard refused the mix (for example a `DATABASE_URL` host containing `dev` or `staging`) |
| AWS codes | `docs/AWS-SETUP.md` step 9 |

## 8. Invite yourself

1. On mosshatch.com, join the waitlist with your address and click the confirmation link in the email.
2. From your machine:
   ```sh
   DATABASE_URL='<cron or owner url>' RESEND_API_KEY='re_...' node scripts/waitlist-invite.mjs --email you@example.com
   # invited 1, failed 0, skipped 0
   ```
3. Open the invite link from the email (valid 14 days, works once), create your passkey, save the recovery codes.

Check: signed in, the "Mosshatch isn't open yet" banner is gone and searches show prices. In a private window (not signed in) the banner,
the "Invited? Sign in" button, the practice hatch and the waitlist are all still there and searches show no prices: the demo still asks the
public registries (RDAP) and never the shop routes, which answer `403 invite_required` to anyone without an invite.

## 9. First purchase (a cheap .com)

1. Pick a long, obviously unregistered .com (for example `mosshatch-dogfood-<date>.com`). The chip shows **$20.98**.
2. Open it. "How the price is made" shows Registry cost $16.98, Flat fee $4.00, and the note that the first year is charged at the
   renewal price. Total before tax $20.98; tax is added by Stripe at Checkout.
3. Fill the registrant contact (your real details: it goes to the registry), tick the terms, Pay. Use your own card on Stripe Checkout.
4. Watch the egg. Behind it: Stripe authorizes (manual capture), the app re-quotes Openprovider (the price guard refuses anything other
   than 11.98 create / 16.98 renew), registers through the registrar project, then captures.

Check, in this order:
- The app: the creature hatches; the Ledger shows the order captured. The receipt email arrives.
- Openprovider panel: the domain is listed (status ACT), and the balance dropped by exactly 11.98.
- Stripe dashboard (live): one payment of 20.98 plus tax, captured; the webhook endpoint shows 2xx deliveries.
- `whois`/`lookup.icann.org` for the name: registrar Hosting Concepts B.V. d/b/a Registrar.eu.

If the hatch sheet says the price is not standard (`price_not_standard`): Openprovider's live price differs from the table, so nothing was
charged. Add a dated row with what the panel shows (never edit an old one), then retry:
```sql
insert into wholesale_prices (registrar, tld, kind, amount_minor, effective_from, source)
values ('openprovider', 'com', 'register', <cents>, current_date, 'Openprovider live panel <date>');
```
If it says new orders are paused: `sell_gate` (balance minus the floor too low; step 4's floor), `global_daily_cap` / `global_total_cap`
(the spend fuse), or `orders_paused` (the flag).

## 10. Roll back to the demo, instantly

- **Stop all selling now, no deploy** (seconds): `update flags set value = 'true', updated_by = 'owner', updated_at = now() where name in ('orders_paused', 'registrar_writes_paused');`
  The site stays up; purchase routes answer "paused" and nothing is charged. Undo with `'false'`.
- **Back to the public demo** (seconds): Vercel, project `mosshatch`, Deployments, the last demo deployment, Instant Rollback. Then check
  that the crons in `vercel.json` are as expected (Instant Rollback does not update them).
- **Cut the registrar off**: in `mosshatch-registrar` set `MH_REGISTRAR_KILL_SWITCH=all_paused` and redeploy it, or pause that project.
- **Fully off**: remove `STRIPE_SECRET_KEY` from `mosshatch` and redeploy. Production then refuses to boot (503 with a reason), while the
  waitlist and the registry lookup keep working (they are served before the boot).
- **Spend fuses**, always on while live: 3 registrations a day and 10 in total (`MH_LIVE_DAILY_REGISTRATIONS`, `MH_LIVE_TOTAL_REGISTRATIONS`,
  flag `limits.total_live_registrations`), 5 paid operations a day per registrar instance, and the Openprovider balance itself.

## What the customer pays (and why)

Price per year = max(Openprovider register, Openprovider renew) + the D-003 fee, the same every year. Non-member prices read 2026-10-01
from Openprovider's public price feed (migration 1120 lists the URL):

| Extension | Openprovider create / renew | Fee | Customer, first year | Customer, renewal |
|---|---|---|---|---|
| .com | 11.98 / 16.98 | 4.00 | 20.98 | 20.98 |
| .dev | 23.98 / 23.98 | 4.00 | 27.98 | 27.98 |
| .app | 26.98 / 26.98 | 4.00 | 30.98 | 30.98 |
| .studio | 46.00 / 46.00 | 4.00 | 50.00 | 50.00 |
| .io | 74.98 / 89.98 | 9.00 | 98.98 | 98.98 |
| .ai | 109.00 / 134.00 a year, 2 years minimum | 10.00 a year | 288.00 for 2 years | 288.00 for 2 years |

A renewal is never sold below cost: the renewal margin is the fee. The first-year difference (.com 5.00) is disclosed on the hatch sheet
and the fees page. With a membership (`.com` 10.46 both ways) the table gets a new dated row and the price falls; it never rises because of
membership. Restore is not sold online yet (no Openprovider restore price in the table, so it cannot be charged).

## Verified, and not

- Verified offline (tests, fakes, no network): the web to registrar signed RPC with the Openprovider adapter behind it, the live adapter
  calling `https://api.openprovider.eu/v1` (the host and `/v1` paths in Openprovider's OpenAPI document, fetched 2026-10-01; the older
  `/v1beta` path is not used), every boot reason code, the mode guard (live only with `VERCEL_ENV=production`, a live Stripe key and a live
  registrar), the renewal floor and price guard, the spend fuses, and the invite gate on every purchase route (`packages/api/src/golive.test.ts`,
  `packages/api/src/registrar-rpc/serve.test.ts`, `e2e/invite.spec.ts`).
- Verified against the Openprovider **sandbox** (2026-09-30): the adapter's calls and responses (`docs/registrar-parity.md`).
- **Never called**: the live Openprovider API (login, prices, a real create, the debit), the live Stripe API (`StripeReal` has only run
  against fakes), Stripe Tax in live mode, the restricted key's exact permission set, and the Vercel registrar project. Your first purchase
  is the first real test of all of them; that is why the balance is USD 20 and the fuses are low.
- Unverified prices: whether Openprovider's live API quotes the same numbers as its public feed (the price guard refuses any difference),
  whether the .studio non-member promotion (21.99 to 2026-12-31) applies to API orders, and whether a delete inside the add grace period
  credits the balance (the refund drill in the rehearsal checks it).
- Known gaps for later: the registrar project's nonce store and daily cap are per function instance (no database there); a replayed signed
  request within 60 seconds on another instance is possible only for someone who captured one, and register is not idempotent upstream
  but a second create of the same name is refused (346). Static pages (fees, legal) keep the demo banner even for invited accounts.
  Transfer-away and Gate texts follow `domains.registrar`: an Openprovider domain reads "our registrar" and "our registrar's support"
  (who sends Openprovider's transfer-away email is UNVERIFIED); only an `opensrs` domain (the mock and sample path) names OpenSRS and
  Tucows. No email names a registrar: the transfer-in email (`transfer_submitted`) says "our registrar emailed the owner" only when the
  adapter reports that step, which the Openprovider adapter never does (whether Openprovider sends one is UNVERIFIED); the account-closed
  email says the registrar keeps its records "for as long as registrar rules and the law require", with no period, because Openprovider's
  privacy policy gives none (source in `docs/design/account-closure-export-erasure.md`, section 5).
