# Surge readiness — 2026-10-03

## Confirmed production gap and fix

Production main `dbcea91afea2d494b055af89cf66459696924a96` had durable jobs but no Vercel cron declaration, and the webhook wake-up registered a no-op instead of a request lifetime hook. On 2026-10-03 the public `/api/health/ticks` returned `{"ageSeconds":null}`: no completed tick was recorded. This is a fulfillment reliability gap regardless of traffic size.

The API now registers its wake-up promise with Vercel's request context, and a protected cron runs every minute. Claims, leases, retries, priority ordering, and payment idempotency stay in Postgres. Duplicated/overlapping ticks can claim independent jobs without double-claiming. The health endpoint returns 503 when no tick has completed or its heartbeat is over 180 seconds old.

The API has an explicit 800-second duration. A cron claims work for up to 450 seconds, leaving 350 seconds for the final wave: registered handlers currently run at most 300 seconds. `MH_TICK_BUDGET_MS` may reduce this budget; larger values clamp to 450,000. `MH_TICK_CONCURRENCY` defaults to 32 jobs per wave and supports 1–256. Database pool capacity and provider limits must be checked when raising it; this is tunability, not a throughput certification. Existing per-kind shared caps for `domain.sync` and `dns.verify` remain.

## Other release gates

The live registration spend fuse still defaults to **3 registrations per trailing day and 10 lifetime registrations**. `MH_LIVE_DAILY_REGISTRATIONS` and `MH_LIVE_TOTAL_REGISTRATIONS` lower the corresponding database flags; they do not override them upward. The database daily flag defaults to 200. Account exposure/review controls and invite-only acquisition are separate commercial policy gates, not compute capacity. Operators need to deliberately select the launch policy and inspect the current flags before a public acquisition push.

Authoritative registrar lookup budgets are shared through Postgres (default 20,000/day, 70% search and 30% checkout). Reaching them denies lookups even if web capacity is available. Verify Openprovider quotas and balance, Stripe configuration, mail delivery, database pooled connection capacity and backup restoration, and operator alerts. Current alert notifier logs to the server; an external monitor/notification destination is still needed.

After deployment, verify an authenticated cron request, heartbeat freshness, a configured test-mode purchase from checkout through fulfillment, replayed webhooks, and a sustained multi-account backlog test on an isolated database/provider sandbox. Record completions/hour, p95 fulfillment time, pending priority-zero age, errors, leases/retries, upstream 429s, database connections, and cost. Do not certify a specific paying-customer count from these code changes alone.

References: https://vercel.com/docs/functions/configuring-functions/duration ; https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package ; https://github.com/vercel/vercel/blob/main/packages/functions/src/get-context.ts
