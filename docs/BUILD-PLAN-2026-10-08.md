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
| Registrant verification (app side) | Mirrors the registrar's check since the panel audit change (F1): the owner's link click clears the notice on the next open of the DNS tab | `verificationSource` = provider |
| DNS | Run live: `A @ 76.76.21.21` and `CNAME www` on untilwow.com, https://untilwow.com serves the test page | owner's screenshot 2026-10-08 17:04 UTC |
| DNSSEC section | Said "we do not offer DNSSEC signing" under a registry DS record: Openprovider's nameservers sign every zone they host, and the add form could never succeed there (DS in, DNSKEY wanted). Fixed in the panel audit change | public DNS: DS 56056/8/2, DNSKEY in zone |
| Auto-renew, Gate, Nest, refund, renewal, transfer | Never run live | Getting-started list reads 1 of 3 |
| Hatch card portrait, grove chip, creature tap | PR 40 | owner's screenshots |
| Root-domain SPF and DMARC, CAA | Missing; seven `external.email_dns` warnings open since 2026-10-03 | Namecheap zone read 2026-10-08 |

## 1. Live verification pass (this week, owner clicks, operator watches)

Run on untilwow.com, in this order. Each step has a pass condition the database or a log can confirm; the operator reads it after each
click and records the result in AUDIT-2026-10-08 §6.

1. **Registrant verification.** The owner used the registrar's link on 2026-10-08 16:23. Open the DNS tab once the panel audit change
   is live. Pass: the notice is gone, `registrant_verifications.state = 'verified'` with audit detail `via: registrar`, the
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
| F1 | Provider mode for registrant verification: the registrar's check (`GET /customers/verifications/emails/domains`) is read when the DNS tab opens and by the hourly sweep; verified there verifies here, an open check there sets our deadline, only a suspension there is mirrored; "Send the email again" restarts the registrar's email; our code flow stays for registrars that leave verification to us | Two verifications confused the first owner, and at day 15 we would have "put on hold" a name the registrar had verified | done, panel audit change |
| F2 | "Check your Junk folder" line under Email me a code and on the hatch card's receipt note | The owner's first two app emails went to Junk | XS |
| F3 | Ledger refund button shows "until <date>" and hides after the window; the server already refuses | The owner asked why the button exists | S |
| F4 | Root SPF `v=spf1 -all` and DMARC `v=DMARC1; p=reject; adkim=s; aspf=s; rua=mailto:dmarc@mosshatch.com` at Namecheap; CAA `0 issue "letsencrypt.org"` once Vercel's issuer is confirmed | Closes the `external.email_dns` warnings; helps reputation | owner, XS |
| F5 | Dated `.com` price rows effective 2026-11-01 (Verisign 10.26 → 10.97; member price expected 11.17) | The price guard refuses every .com order from that morning otherwise | XS, needs the number |
| F6 | Operator action to retry or cancel one order (an ops route, audited), replacing today's SQL surgery | Needed within the first hour of live traffic | M |
| F7 | Page when an hourly balance snapshot drops more than the hour's orders explain | The 170/180 auto-reload means a leaked key would be refilled | S |
| F8 | Portrait card, grove chip anchor, creature tap (in the portrait change) | Owner's review of the first card | done, PR 40 |
| F9 | Panel audit from the owner's screenshots (section 2a): DNSSEC truth and a public-key form, the records list in the side panel, History lines in local time, the sensitive warning after a keystroke, the nameserver guard, passkeys on the account panel, the token form's cap, copy button and labels | The three screenshots of 2026-10-08 | done, panel audit change |

### 2a. Panel audit (owner's screenshots, 2026-10-08)

What the Account panel, the DNS tab and Connected apps showed, what was wrong, and what changed.

| Where | Finding | Change |
|---|---|---|
| DNS tab, DNSSEC | The note said we do not sign; the registry held DS 56056 (algorithm 8) because Openprovider's nameservers sign every hosted zone. The add form took DS fields, but Openprovider takes DNSKEY material, so the form failed after the passkey every time | `GET /ds` reports `auto_signed`, `key_input` and a note per situation; a managed key reads "Signed by our nameservers" with "Turn DNSSEC off"; the form is a DS form or a public-key form by registrar, with checks before the passkey; hidden while our key stands |
| DNS tab, Nameservers | A signed name moved to unsigned nameservers would stop resolving; the only hint was a 409 after the passkey | With our key at the registry the box is replaced by the order of operations; with a key of the owner's the box carries a one-line explanation |
| DNS tab, Records | Five columns in a 380-pixel panel: `76.76.21.21` broke into three lines | Each record is a block (type, name, button; value; note). The table roles are explicit so it stays a table for assistive technology |
| DNS tab, History | "4:59 PM UTC: before a change, 1 added, 0 removed, 1 sensitive" to someone whose morning it was | Local time with the zone named; "1 record added (1 sensitive)" |
| DNS tab, Add a record | The red sensitive warning showed before a keystroke (an empty name is the domain itself) | Shown once something is typed, or for MX and SRV |
| DNS tab, Contact and registrant | "Verify within 15 days or the registry puts the name on hold" after the owner had used the registrar's link; our code would not have satisfied the registrar, and our sweep would have suspended on its own at day 15 | F1: provider mode. The banner names the registrar's email and offers "Send the email again"; a hold reads as a hold |
| Account panel | Six buttons in a row; "Add a second passkey" with no way to add one (the API had `POST /passkeys` since 4.5) | Sections: Passkeys (list, Add a passkey through the step-up then the browser's ceremony from its own click, Remove with the last-passkey confirmation), Apps and tools, Your data, Signed in |
| Connected apps, New token | Spend cap defaulted to 0, so a spending token could suggest nothing; no copy button for a token shown once; the threshold and command-line settings had no explanation | Cap required and explained; Copy; labels and hints; days bounded 1 to 90 |

Not changed, noted: the record table in Connected apps (a wide panel) is fine as a table; the contact form still asks for the phone and
address again on every change (the server returns only name, email and country by design).

### 2b. Connected apps and assistants (owner's review, 2026-10-08)

The owner asked what "Claude" meant in the token form and who pays for it. Nobody: a token or a connection is a key for the person's own
assistant or program, and Mosshatch is an MCP server it calls. The review found the agent features built and invisible. What changed:

| Item | Change |
|---|---|
| Front door | Connected apps opens with "Connect Claude or another assistant": the address to paste, steps for Claude, Claude Code, ChatGPT and Cursor, and what it can do. Public page /assistants with the same steps, linked from Find, How it works and Connected apps |
| Search with no account | `POST /mcp/search` (mcp/public.ts): `search_names` and `get_quote` only, no token accepted. While the shop is invite-only it answers from the public registries with the page's lookup limits and the published prices, plus the waitlist link; once open, from the registrar under the anonymous search limits. Buy links carry the name in the URL fragment (V1) and open Find on it |
| Recipes for people | A Connect tab on each name: paste a scoped provider token, preview exactly what the recipe changes, approve with the passkey when it is sensitive, apply, watch it finish, disconnect (which removes the records it wrote) |
| Recipes for assistants | MCP tools `list_recipes`, `plan_recipe`, `apply_recipe` (answers `pending_human_approval` when the passkey is needed) and `get_recipe_application`; the plan waits on the name's Connect tab and on the Account button |
| What waits for you | One list (`lib/waiting.ts`): token requests and recipe plans. A count on the Account button, a notice at the bottom of the page, the grove bar, and the name's creature shows "needs you"; a tap opens the request |
| Approval email | Still no link (threat row 43, and session.test.ts checks these mails carry no URL): it now says to sign in at mosshatch.com and that the request waits under Account. A link straight to the card was the first recommendation; it would loosen row 43, so it is the owner's call |
| Pause | One click stops a token or connected app (`POST /bindings/:id/pause`); Resume is the existing widen behind the passkey, whose summary now reads "Resume the token" |
| Activity | Per app: what it did, in words (the tool it ran and how it ended, the domain) |
| Consent screen | The same choices as the token form, one-name option, a required cap when buying is ticked, 7, 30 or 90 days with 90 the default; the server's default for connected apps is now 90 days |
| Tokens for people | "Which names: all, or only one"; a recipes choice; after creation, Copy and ready lines for Claude Code, Cursor and curl that fill in the token only when copied |
| Safety copy | "How we keep this safe" on Connected apps and the public page: only claims the code enforces |

Found and fixed while verifying (each has a test): a buy link on a first visit was overwritten by the arrival demo 1.5 s later (the
link is now read before the first render); the consent screen dropped "Connect names" when an app asked for every choice, because two
choices share `dns.write` (choices are now matched against the whole request, and `choices.test.ts` parses every choice with the server's
grammar); the recipes choice lacked `recipes.plan`, so a script could not plan over REST; a paused or revoked token's plan still showed as
waiting after Disconnect everything (only a live token's plan waits now); the page's notice could cover an open panel's buttons. Initial JS
after this work: 109.0 kB gzip (target 110).

Owner actions from this review:

- Try the front door once: Claude, Settings, Connectors, Add custom connector, `https://mosshatch.com/mcp`. The discovery documents and the 401
  challenge answer correctly in production (checked 2026-10-08); a full sign-in from claude.ai has not been run.
- GitHub secret scanning: the webhook (`/api/v1/hooks/github-secret-scanning`) is built but Mosshatch is not enrolled in GitHub's partner program,
  so leaked tokens are not reported yet and the pages do not claim it. Apply at GitHub, then add the claim.
- The site menu and the security policy do not link /assistants: both are versioned legal documents (account/documents.ts hashes the files),
  so a link there needs the go-live-db workflow to publish the new versions. Do it with the next document change.

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
