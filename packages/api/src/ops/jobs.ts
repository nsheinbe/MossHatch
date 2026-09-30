import { getJobDef, registerJob, type JobDef } from "../jobs/registry.ts";
import { registerRecurringJob } from "../jobs/engine.ts";
import { anchorAudit, auditVerifyJob } from "./anchor.ts";
import { purgeFromLedger } from "./erasure.ts";
import { kmsReconcile } from "./kms-reconcile.ts";
import { checkDomainExpiry, emailDnsJob, externalChecksJob } from "./external.ts";
import { svc } from "./services.ts";

const DAY = 86_400;

const OPS_JOBS: (JobDef & { everySec?: number })[] = [
  { kind: "audit.anchor", priority: 1, maxRuntimeSec: 120, everySec: DAY, handler: async (ctx) => { await anchorAudit(ctx, svc(ctx, "anchorSink")); } },
  { kind: "audit.verify", priority: 1, maxRuntimeSec: 300, everySec: DAY, handler: async (ctx) => { await auditVerifyJob(ctx, svc(ctx, "anchorSink")); } },
  { kind: "audit.kms_reconcile", priority: 1, maxRuntimeSec: 120, everySec: DAY, handler: async (ctx) => { await kmsReconcile(ctx, svc(ctx, "cloudTrail")); } },
  // Ledger half of retention.purge. Retention-expiry deletion (sealed chains, tombstones) arrives with Phase 4.
  { kind: "retention.purge", priority: 1, maxRuntimeSec: 300, everySec: DAY, handler: async (ctx) => { await purgeFromLedger(ctx, svc(ctx, "erasureLedger")); } },
  { kind: "ops.external_checks", priority: 1, maxRuntimeSec: 120, everySec: DAY, handler: async (ctx) => {
    const r = svc(ctx, "dnsResolver");
    await externalChecksJob(ctx, r); await emailDnsJob(ctx, r); await checkDomainExpiry(ctx);
  } },
];

/** Idempotent: registers the ops job kinds and their daily schedule. Called by registerOps(router). */
export function registerOpsJobs(): void {
  for (const { everySec, ...def } of OPS_JOBS) {
    if (!getJobDef(def.kind)) registerJob(def);
    if (everySec) registerRecurringJob({ kind: def.kind, everySec });
  }
}
