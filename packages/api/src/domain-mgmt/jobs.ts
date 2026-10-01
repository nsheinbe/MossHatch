import { registerRecurringJob } from "../jobs/engine.ts";
import { getJobDef, registerJob, type JobDef } from "../jobs/registry.ts";
import { snapshotSweepJob } from "./dns.ts";
import { codeRerandomizeJob } from "./security.ts";
import { freezeApplyJob, transferPollJob } from "./transfer.ts";
import { contactChangePollJob } from "./contact.ts";
import { verifySweepJob } from "./verification.ts";

const defs: JobDef[] = [
  { kind: "transfer.poll", priority: 1, maxRuntimeSec: 45, handler: transferPollJob },
  { kind: "domain.freeze_apply", priority: 1, maxRuntimeSec: 45, handler: freezeApplyJob },
  { kind: "domain.code_rerandomize", priority: 1, maxRuntimeSec: 30, handler: codeRerandomizeJob },
  { kind: "contact.change.poll", priority: 1, maxRuntimeSec: 45, handler: contactChangePollJob },
  { kind: "registrant.verify_sweep", priority: 1, maxRuntimeSec: 45, handler: verifySweepJob },
  { kind: "dns.snapshot_sweep", priority: 1, maxRuntimeSec: 30, handler: snapshotSweepJob },
];

/** Register the domain-management jobs and their schedule. Safe to call twice. */
export function registerDomainMgmtJobs(): void {
  for (const d of defs) if (!getJobDef(d.kind)) registerJob(d);
  registerRecurringJob({ kind: "transfer.poll", everySec: 300 });
  registerRecurringJob({ kind: "contact.change.poll", everySec: 300 });
  registerRecurringJob({ kind: "registrant.verify_sweep", everySec: 3600 });
  registerRecurringJob({ kind: "dns.snapshot_sweep", everySec: 86_400 });
}
