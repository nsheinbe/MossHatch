# Homepage pageview measurement

Source: the first-party PostgreSQL `pageview_counts` table, populated by `POST /api/v1/pageviews`. This is separate from `conversion_counts` (funnel stages), waitlist cohorts and Vercel Web Analytics. Enabling the Vercel dashboard alone does not instrument the app. Zero Vercel events does not establish zero visitors. Nothing here backfills historical traffic.

The minimal scope is the homepage (`/`) document load, once per document including reloads. React renders, Find/Grove/Connect navigation, history updates and bfcache restores do not add events. Static information pages, unknown paths, invite/device/payment routes and any query key other than the three existing UTM keys are excluded. UTM values and fragments are never included. This deliberately does not claim sitewide coverage or unique people. JavaScript-disabled visits, DNT/GPC, blockers and failed requests undercount; bots and QA can inflate counts. There are no automatic retries.

The browser sends only `{ "page": "home" }`, with credentials omitted and no referrer. The server accepts only that strict shape, respects DNT/GPC headers and increments one daily aggregate row. No new cookies, storage, visitor IDs, raw URLs, IP addresses, user IDs, device dimensions or campaign values are stored in the counter. The existing short-lived network-prefix rate limiter protects ingestion; ordinary hosting/security logs remain outside this aggregate measurement. No third-party analytics, replay, ad tracker or paid service is added. The existing browser opt-out behavior remains; no new consent mechanism is introduced.

## Fleet / owner readout

From the existing authorized database environment, run `node scripts/pageview-report.mjs 30` with `DATABASE_URL_CRON` (or the existing owner connection) already supplied securely. Do not copy credentials into Fleet, this document or command history. The script performs only a SELECT and outputs aggregate JSON; Fleet can ingest that output through its existing authorized execution path. No new public reporting endpoint or Fleet credential/integration is provisioned by this change.

The window is N UTC calendar days including today: `start_inclusive` is midnight UTC N−1 days ago, `end_exclusive` is tomorrow at midnight UTC. `as_of` identifies the report time; today is partial, not a rolling 24-hour window. Daily rows are server-receipt dates. Missing rows within the window mean zero accepted events, not proof of no visitors or a functioning collector. `total` is a decimal string to avoid integer precision loss. Report the source, window, coverage start/deployment time and QA annotations alongside counts. Controlled QA visits must be recorded separately with timestamp and expected increment; the collector cannot identify or retroactively remove a person.

## Release prerequisites

This draft needs review and separate production authorization. Apply migration `1230_homepage_pageviews.sql` through the normal reviewed migration process before releasing the collector. Publish the updated privacy document through the existing document-version process. The deployed web build needs the existing `VITE_API_ENABLED=1` flag and a configured API/database; a normal preview without a database cannot prove persistence. Do not add production credentials to a preview. No production migration, document sync, merge or deployment is part of this work.

After an authorized release, a separately labelled controlled visit should establish one accepted response and the expected aggregate increase in the production report. Until then, production collection and Fleet ingestion remain unverified. Existing launch restrictions, domain purchases, prices, authentication and checkout behavior are unchanged.
