# Build plan after the first live purchase (2026-10-08)

untilwow.com was registered, paid and hatched at 16:14 UTC on 2026-10-08, on the fourth attempt of the day. The three failed attempts
each exposed a defect that is now fixed (AUDIT-2026-10-08 §1–§2d). This plan turns the rest of what the day showed into ordered work:
what to verify live next, what to fix, what to improve, and what only the owner can do. It is written to be executed one pull request
at a time, each proven locally and in CI before merge, as the four PRs of 2026-10-08 were.

Evidence rule: nothing below is "working" until it has run for real once, against the live registrar, the live Stripe account and a
real inbox. The order flow has; almost nothing after the hatch has.

## 0. Where things stand

| Area | State | Evidence |
|---|---|---|
| Search, quote, checkout, authorization, registration, capture, hatch | Works live | order 01a11c38, Openprovider order 30378066, Stripe capture 13.46 |
| Session keepalive, phone normalization, funding pre-check, Stripe refusal alerts, Openprovider no-effect codes | Fixed, live or in PR 39 | PRs 36, 37, 38, 39 |
| Receipt and registrant-verification emails | Sent and delivered, but land in Junk at iCloud | Resend log, owner's inbox |
| Registrant verification (registrar side) | Verified by the owner through Openprovider's link | Openprovider confirmation 16:23 |
| Registrant verification (app side), DNS, auto-renew, Gate, Nest, refund, renewal, transfer | Never run live | Getting-started list reads 0 of 3 |
| Hatch card portrait, grove chip, creature tap | Fixed in the portrait change (unmerged) | owner's screenshots |
| Root-domain SPF and DMARC, CAA | Missing; seven `external.email_dns` warnings open since 2026-10-03 | Namecheap zone read 2026-10-08 |

## 1. Live verification pass (this week, owner clicks, operator watches)

Run on untilwow.com, in this order. Each step has a pass condition the database or a log can confirm; the operator reads it after each
click and records the result in AUDIT-2026-10-08 §6.

1. **App-side registrant verification.** Email me a code, Verify. Pass: `registrant_verifications.state = 'verified'`, the
   Getting-started item ticks, no `domain.registrant_*` alert.
2. **DNS: connect the Vercel test site.** Add `A @ 76.76.21.21` and `CNAME www cname.vercel-dns.com` (both are sensitive names, so
   each asks for the passkey). Pass: the records appear at Openprovider's nameservers, https://untilwow.com serves the test page with a
   certificate, the DNS snapshot row exists, the refund button is refused with `domain_in_use`.
3. **Auto-renew on** (passkey). Pass: `domains.auto_renew = true`, the renewal scheduler sees it, the Overview wording changes.
4. **Gate.** Transfer lock off and on again; show the transfer code once. Pass: Openprovider reflects the lock state; the code is shown
   once and never logged (ST-22).
5. **Nest.** Add a dev secret in the panel, reveal it, watch it hide; then from a laptop: `npm i -g` the CLI from `packages/cli` (not
   published yet), `mosshatch login` (device approval with the passkey), `mosshatch run untilwow.com --env dev -- printenv NAME`.
   Pass: the value prints only through `run`, the audit log shows the reveal and the run, prod is refused unless named at approval.
6. **Renew now** on Checkout for one year. Pass: Openprovider's expiry moves a year, the ledger shows the renewal, Stripe shows the
   capture. (This spends 10.46 of balance; it is the one way to prove renewal before 2027.)
7. **Refund inside the window** on a second, throwaway .com bought for the purpose, before any DNS records. Pass: the name is deleted at
   Openprovider, the balance is credited (add-grace), the card is refunded in full, the ledger shows it. Cost: Stripe's fee on 13.46 and
   the 3% funding fee on 10.46, about one dollar.
8. **Transfer in** one of the owner's Namecheap names (everyinput.com or samebench.com). Pass: the transfer completes, the name
   appears in the grove with its expiry extended a year, the ledger shows the charge. This is the only way to run the transfer driver
   for real before a customer does.

Anything that fails here becomes a fix PR with the same shape as PRs 36–39: root cause from production evidence, code, test, docs.

## 2. Fixes already identified (small, this week)

| # | Fix | Why | Size |
|---|---|---|---|
| F1 | Read Openprovider's `email_verification_status` for the registrant and mark the app's verification done when the registrar's is | Two verifications confuse customers; the registrar's is the one that suspends | S |
| F2 | "Check your Junk folder" line under Email me a code and on the hatch card's receipt note | The owner's first two app emails went to Junk | XS |
| F3 | Ledger refund button shows "until <date>" and hides after the window; the server already refuses | The owner asked why the button exists | S |
| F4 | Root SPF `v=spf1 -all` and DMARC `v=DMARC1; p=reject; adkim=s; aspf=s; rua=mailto:dmarc@mosshatch.com` at Namecheap; CAA `0 issue "letsencrypt.org"` once Vercel's issuer is confirmed | Closes the `external.email_dns` warnings; helps reputation | owner, XS |
| F5 | Dated `.com` price rows effective 2026-11-01 (Verisign 10.26 → 10.97; member price expected 11.17) | The price guard refuses every .com order from that morning otherwise | XS, needs the number |
| F6 | Operator action to retry or cancel one order (an ops route, audited), replacing today's SQL surgery | Needed within the first hour of live traffic | M |
| F7 | Page when an hourly balance snapshot drops more than the hour's orders explain | The 170/180 auto-reload means a leaked key would be refilled | S |
| F8 | Portrait card, grove chip anchor, creature tap (in the portrait change) | Owner's review of the first card | done, unmerged |

## 3. Improvements (next two weeks)

| # | Improvement | Why | Size |
|---|---|---|---|
| I1 | Extension shortlist for American consumers (section 5), with the fee tier adjusted so wholesale over 25 carries a 6.00 fee | At 3.00 the margin on a 40-dollar wholesale is under a dollar and .design loses money | M (rows, policy, tests, fees page) |
| I2 | Registrar project behind a fixed egress IP, then Openprovider's IP allow-list on | The balance is the loss ceiling until then | M |
| I3 | Alert acknowledgement and the open-alert list in the ops console | Seven warnings have sat open five days with no place to ack them | M |
| I4 | Hatchglow attach: count clicks from the Getting-started step | The product the margin lives in needs its funnel measured before it is built out | S |
| I5 | Statement descriptor prefix MOSSHATCH (Stripe Dashboard) and Managed Payments default off | Card statements read NICHOLAS today | owner, XS |
| I6 | Tax code decision with the accountant (C-44); `txcd_10000000` is the interim preset | Set 2026-10-08 as a stopgap | owner |
| I7 | Monthly fixed costs and the break-even order count, written down | "Not losing money" is per order today | S |

## 4. Hardening before invites go out (weeks three and four)

- Static egress and the allow-list (I2); rotate the Openprovider password after it is on.
- `sslmode=verify-full` on every Neon URL; the pg warning on each cold start goes away.
- Posture probe and KMS reconcile configured (the two `*_not_configured` warnings).
- Rate limits reviewed against a real browser session; Radar rules confirmed in the live Dashboard.
- A support run-through: a customer email to support@mosshatch.com arrives in the Resend inbox and gets a reply from a verified sender.
- The go-live checklist re-run top to bottom by someone who did not write it.

## 5. Extension shortlist (American consumers)

Member prices read from Openprovider's public price API on 2026-10-08 (create / renew per year, USD). Customer price is the app's
rule: max(create, renew) plus the fee tier. Margin is after Stripe (2.9% + 30¢) and the 3% card-funding fee, before any dispute.

| TLD | Create / renew | Customer | Margin, year 1 | Note |
|---|---|---|---|---|
| .net | 11.86 / 11.86 | 14.86 | 1.91 | add first |
| .org | 11.20 / 11.20 | 14.20 | 1.95 | add first |
| .us | 6.50 / 6.50 | 9.50 | 2.22 | nexus rules: US presence required, verify the registrant country |
| .page | 10.20 / 10.20 | 13.20 | 2.01 | HTTPS-only extension, good for Hatchglow |
| .xyz | 13.50 / 13.50 | 16.50 | 1.81 | |
| .me | 16.43 / 16.43 | 19.43 | 1.65 | |
| .co | 15.00 / 30.00 | 33.00 | 16.29 then 0.84 | the renewal floor (D-059) prices year one at the renewal rate |
| .blog | 20.20 / 20.20 | 23.20 | 1.42 | |
| .shop | 30.20 / 30.20 | 33.20 | 0.83 | needs the fee tier change |
| .online | 27.70 / 27.70 | 30.70 | 0.98 | needs the fee tier change |
| .store | 40.18 / 40.18 | 43.18 | 0.24 | needs the fee tier change |
| .design | 45.20 / 45.20 | 48.20 | −0.06 | loses money at the 3.00 tier |

Recommendation: .net, .org, .us, .page, .xyz, .me, .co and .blog in one change after the fee tier is settled; .shop, .online and
.store with it if the tier moves. Each extension needs: `tld_policy`, `refund_policy` and `wholesale_prices` rows, the adapter's launch
list, the fees page, the contract test, and its Openprovider contract signed (all are, as of 2026-10-08). Promotions stay unused.

## 6. Owner actions, in order

1. Add the two root DNS records at Namecheap (F4); tell the operator, who re-runs the posture check.
2. Finish the verification pass (section 1), one step per message.
3. The new .com member price from Openprovider's banner (F5).
4. Stripe Dashboard: descriptor prefix, Managed Payments default (I5).
5. The accountant's tax code (I6).
