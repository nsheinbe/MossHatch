import { getJobDef, registerJob, type JobDef } from "../jobs/registry.ts";
import { registerRecurringJob } from "../jobs/engine.ts";
import { anchorAudit, auditVerifyJob } from "./anchor.ts";
import { purgeFromLedger } from "./erasure.ts";
import { KMS_RECONCILE_EVERY_SEC, kmsReconcile } from "./kms-reconcile.ts";
import { purgeExpired, purgeWebhookPayloads } from "./retention.ts";
import { checkDisputeRates } from "../stripe/disputes.ts";
import { checkDomainExpiry, emailDnsJob, externalChecksJob } from "./external.ts";
import { svc } from "./services.ts";

const DAY = 86_400;
const HOUR = 3_600;

const OPS_JOBS: (JobDef & { everySec?: number })[] = [
  { kind: "audit.anchor", priority: 1, maxRuntimeSec: 120, everySec: DAY, handler: async (ctx) => { await anchorAudit(ctx, svc(ctx, "anchorSink")); } },
  { kind: "audit.verify", priority: 1, maxRuntimeSec: 300, everySec: DAY, handler: async (ctx) => { await auditVerifyJob(ctx, svc(ctx, "anchorSink")); } },
  // Every 5 minutes, so an unmatched Decrypt pages inside the 15-minute own target of ST-10 (CloudTrail delivers in about 5).
  { kind: "audit.kms_reconcile", priority: 1, maxRuntimeSec: 120, everySec: KMS_RECONCILE_EVERY_SEC, handler: async (ctx) => { await kmsReconcile(ctx, svc(ctx, "cloudTrail")); } },
  // Ledger half of retention.purge (re-applies erasures, also run after every restore). The expiry half is retention.expire.
  { kind: "retention.purge", priority: 1, maxRuntimeSec: 300, everySec: DAY, handler: async (ctx) => { await purgeFromLedger(ctx, svc(ctx, "erasureLedger")); } },
  // C-19: rows past retain_until without a legal hold; the webhook log's payloads (30 or 90 days) and rows (180 days).
  { kind: "retention.expire", priority: 1, maxRuntimeSec: 300, everySec: DAY, handler: async (ctx) => { await purgeExpired(ctx); } },
  { kind: "retention.webhook_payloads", priority: 1, maxRuntimeSec: 120, everySec: DAY, handler: async (ctx) => { await purgeWebhookPayloads(ctx); } },
  // C-40: dispute and early-fraud-warning ratios against the own target, Stripe's line, VAMP and ECM.
  { kind: "stripe.dispute_rate", priority: 1, maxRuntimeSec: 60, everySec: HOUR, handler: async (ctx) => { await checkDisputeRates(ctx); } },
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
