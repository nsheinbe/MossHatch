#!/usr/bin/env node
// External dead-man's switch (ST-138). Runs OUTSIDE the app (GitHub Actions schedule or another host), reads
// GET /api/health/ticks and pages when no tick has completed in 3 minutes, when the endpoint is unreachable or
// when it answers something unexpected. It also calls the tick endpoint when MH_CRON_SECRET is set (the second trigger
// from an external scheduler, PLAN 4.3b Jobs). It holds no database credentials.
//
//   MH_BASE_URL=https://mosshatch.com MH_PAGE_WEBHOOK=https://... node scripts/ops-external-check.mjs
//
// Exit code 0 healthy, 1 paged, 2 misconfigured.

import { pathToFileURL } from "node:url";

export const MAX_AGE_SECONDS = 180;

/** Pure decision: `{ok:true}` or `{ok:false, reason}`. The reason is an enumerated code, never response text. */
export function evaluateTicks(status, body, maxAge = MAX_AGE_SECONDS) {
  if (status !== 200) return { ok: false, reason: "bad_status" };
  const age = body && typeof body === "object" ? body.ageSeconds : undefined;
  if (age === null) return { ok: false, reason: "no_tick_yet" };
  if (typeof age !== "number" || !Number.isFinite(age) || age < 0) return { ok: false, reason: "bad_body" };
  if (age > maxAge) return { ok: false, reason: "stale", ageSeconds: age };
  return { ok: true, ageSeconds: age };
}

export async function checkTicks({ baseUrl, fetchImpl = fetch, pageWebhook, cronSecret, maxAge = MAX_AGE_SECONDS, timeoutMs = 10_000 }) {
  const t = (ms) => AbortSignal.timeout(ms);
  let verdict;
  try {
    const res = await fetchImpl(new URL("/api/health/ticks", baseUrl), { signal: t(timeoutMs), redirect: "error" });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    verdict = evaluateTicks(res.status, body, maxAge);
  } catch {
    verdict = { ok: false, reason: "unreachable" };
  }
  let paged = false;
  if (!verdict.ok && pageWebhook) {
    try {
      await fetchImpl(pageWebhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ severity: "S1", check: "cron-heartbeat", reason: verdict.reason, ageSeconds: verdict.ageSeconds ?? null }), signal: t(timeoutMs) });
      paged = true;
    } catch { /* the exit code still fails the scheduled job, which notifies by its own means */ }
  }
  // Second trigger: an external scheduler also ticks, so one dead Vercel cron does not stop the queue.
  let ticked = null;
  if (cronSecret) {
    try { ticked = (await fetchImpl(new URL("/api/cron/tick", baseUrl), { headers: { authorization: `Bearer ${cronSecret}` }, signal: t(60_000) })).status; } catch { ticked = 0; }
  }
  return { ...verdict, paged, ticked };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseUrl = process.env.MH_BASE_URL;
  if (!baseUrl) { console.error("MH_BASE_URL is required"); process.exit(2); }
  const r = await checkTicks({ baseUrl, pageWebhook: process.env.MH_PAGE_WEBHOOK, cronSecret: process.env.MH_CRON_SECRET });
  console.log(JSON.stringify({ ok: r.ok, reason: r.reason ?? null, ageSeconds: r.ageSeconds ?? null, paged: r.paged, ticked: r.ticked }));
  process.exit(r.ok ? 0 : 1);
}
