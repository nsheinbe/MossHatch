import type { Router } from "../http/router.ts";
import type { Route } from "../http/types.ts";
import { getJobDef, registerJob, type JobDef } from "../jobs/registry.ts";
import { registerRecurringJob } from "../jobs/engine.ts";
import { registerActionSpec } from "../stepup/specs.ts";
import { accountCloseSpec, closureStatus, closureSweep, requestClosure } from "./closure.ts";
import { accountExportSpec, downloadExport, exportJob, exportLink, exportSweep, listExports, requestExport } from "./export.ts";

/**
 * Account routes (PLAN 4.5 "Account": POST /account/export, POST /account/close). Session only: a bearer token can neither close an
 * account nor take a copy of it, and both requests need a passkey (step-up). Mutations go through the router's CSRF guard.
 */
export const closureRoutes: Route[] = [
  { method: "GET", path: "/api/v1/account/closure", principals: ["session"], handler: closureStatus, tag: "closure" },
  { method: "POST", path: "/api/v1/account/close", principals: ["session"], stepUp: "account.close", handler: requestClosure, tag: "closure" },
  { method: "POST", path: "/api/v1/account/export", principals: ["session"], stepUp: "account.export", handler: requestExport, tag: "closure" },
  { method: "GET", path: "/api/v1/account/exports", principals: ["session"], handler: listExports, tag: "closure" },
  { method: "POST", path: "/api/v1/account/exports/:id/link", principals: ["session"], handler: exportLink, tag: "closure" },
  { method: "POST", path: "/api/v1/account/exports/:id/download", principals: ["session"], handler: downloadExport, tag: "closure" },
];

const HOUR = 3_600;
const CLOSURE_JOBS: (JobDef & { everySec?: number })[] = [
  { kind: "account.export", priority: 1, maxRuntimeSec: 120, maxAttempts: 6, handler: exportJob },
  { kind: "account.export_sweep", priority: 1, maxRuntimeSec: 120, everySec: HOUR, handler: async (ctx) => { await exportSweep(ctx); } },
  // Cooling-off ends, names are deleted, accounts close, erasure runs (ledger first) and chains are sealed; also the restore replay.
  { kind: "account.closure", priority: 1, maxRuntimeSec: 300, everySec: HOUR, handler: async (ctx) => { await closureSweep(ctx); } },
];

export function registerClosureJobs(): void {
  for (const { everySec, ...def } of CLOSURE_JOBS) {
    if (!getJobDef(def.kind)) registerJob(def);
    if (everySec) registerRecurringJob({ kind: def.kind, everySec });
  }
}

export function registerClosureRoutes(router: Router): Router {
  registerActionSpec(accountCloseSpec);
  registerActionSpec(accountExportSpec);
  registerClosureJobs();
  router.add(...closureRoutes);
  return router;
}
