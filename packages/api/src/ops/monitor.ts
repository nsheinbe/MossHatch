import type { AppContext } from "../ports.ts";
import { oldestRunnableP0Seconds, P0_LATENCY_ALARM_SECONDS, tickAgeSeconds, TICK_STALE_SECONDS } from "../jobs/engine.ts";
import { closeAlerts, raiseAlert } from "./alerts.ts";

/**
 * Dead-man's switch, database side (ST-138). Reads the heartbeat; when no tick has completed in 3 minutes (or none ever
 * has) it raises a `page` alert row. The independent check that survives a dead app is scripts/ops-external-check.mjs,
 * which reads GET /api/health/ticks from outside; this function is what an external scheduler's tick, a second
 * runner or an operator console calls to write the row.
 */
export async function checkTickAge(ctx: Pick<AppContext, "cron" | "clock" | "services">, staleSeconds = TICK_STALE_SECONDS): Promise<{ ageSeconds: number | null; stale: boolean }> {
  const ageSeconds = await tickAgeSeconds(ctx, ctx.cron);
  const stale = ageSeconds === null || ageSeconds > staleSeconds;
  if (stale) await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "tick.stale", subject: "heartbeat.tick", detail: { age_seconds: ageSeconds } });
  else await closeAlerts(ctx.cron, "tick.stale", "heartbeat.tick");
  return { ageSeconds, stale };
}

/** Alarm when the oldest runnable priority 0 job is older than 60 seconds. */
export async function checkP0Latency(ctx: Pick<AppContext, "cron" | "clock" | "services">): Promise<{ oldestSeconds: number | null; alarm: boolean }> {
  const oldestSeconds = await oldestRunnableP0Seconds(ctx);
  const alarm = oldestSeconds !== null && oldestSeconds > P0_LATENCY_ALARM_SECONDS;
  if (alarm) await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "jobs.p0_latency", subject: "priority0", detail: { oldest_seconds: oldestSeconds } });
  else await closeAlerts(ctx.cron, "jobs.p0_latency", "priority0");
  return { oldestSeconds, alarm };
}
