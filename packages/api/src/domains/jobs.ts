import { registerDeadLetterHook, registerRecurringJob } from "../jobs/engine.ts";
import { getJobDef, registerJob, type JobDef } from "../jobs/registry.ts";
import type { AppContext } from "../ports.ts";
import { runBalanceCheck } from "./balance.ts";
import { expiryLastchanceJob, expiryNoticeJob, priceChangeNoticeJob, renewalNoticeJob } from "./notices.ts";
import { runPosture } from "./posture.ts";
import { runReconcile } from "./reconcile.ts";
import { runReleaseSweep } from "./release.ts";
import { renewalChargeDeadLetter, renewalChargeJob, runRenewalScheduler } from "./renewals.ts";
import { domainSyncJob } from "./sync.ts";

const DAY = 86_400;
type Def = JobDef & { everySec?: number };

/** PLAN 4.3b jobs table. Priority 0 is money; recurring cadences are UTC-aligned buckets, one row per bucket (safe with duplicated ticks). */
export const DOMAIN_JOBS: Def[] = [
  { kind: "renewal.scheduler", priority: 0, maxRuntimeSec: 120, everySec: 300, handler: async (ctx) => { await runRenewalScheduler(ctx); } },
  { kind: "renewal.charge", priority: 0, maxRuntimeSec: 120, maxAttempts: 12, handler: (ctx: AppContext, job) => renewalChargeJob(ctx, job) },
  { kind: "domain.sync", priority: 1, maxRuntimeSec: 60, everySec: 3600, handler: domainSyncJob },
  { kind: "renewal.notice", priority: 1, maxRuntimeSec: 120, everySec: 3600, handler: async (ctx) => { await renewalNoticeJob(ctx); } },
  { kind: "expiry.notice", priority: 1, maxRuntimeSec: 120, everySec: 3600, handler: async (ctx) => { await expiryNoticeJob(ctx); } },
  { kind: "expiry.lastchance", priority: 1, maxRuntimeSec: 120, everySec: 3600, handler: async (ctx) => { await expiryLastchanceJob(ctx); } },
  { kind: "price_change.notice", priority: 1, maxRuntimeSec: 120, everySec: 3600, handler: async (ctx) => { await priceChangeNoticeJob(ctx); } },
  { kind: "registrar.reconcile", priority: 1, maxRuntimeSec: 300, everySec: DAY, handler: async (ctx) => { await runReconcile(ctx); } },
  { kind: "registrar.posture", priority: 1, maxRuntimeSec: 300, everySec: DAY, handler: async (ctx) => { await runPosture(ctx); } },
  { kind: "registrar.balance", priority: 1, maxRuntimeSec: 60, everySec: 3600, handler: async (ctx) => { await runBalanceCheck(ctx); } },
  { kind: "domain.release", priority: 1, maxRuntimeSec: 120, everySec: 3600, handler: async (ctx) => { await runReleaseSweep(ctx); } },
];

/** Idempotent. Called by `registerDomainRoutes`. */
export function registerDomainJobs(): void {
  for (const { everySec, ...def } of DOMAIN_JOBS) {
    if (!getJobDef(def.kind)) registerJob(def);
    if (everySec) registerRecurringJob({ kind: def.kind, everySec });
  }
  // A money job that dead-letters keeps retrying to E-1 (PLAN jobs table).
  if (!deadHookInstalled) { registerDeadLetterHook("renewal.charge", renewalChargeDeadLetter); deadHookInstalled = true; }
}
let deadHookInstalled = false;
