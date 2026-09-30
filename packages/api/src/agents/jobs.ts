import { withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { registerRecurringJob } from "../jobs/engine.ts";
import { getJobDef, registerJob, type JobDef, type JobRow } from "../jobs/registry.ts";
import { expireDue, reconcileReservations } from "./requests.ts";
import { prodWriteNotice } from "./notices.ts";

/** Sweepers of the agent surface. Each is safe to run twice. */

async function prodWriteJob(ctx: AppContext, job: JobRow): Promise<void> {
  const secretId = String(job.payload.resource ?? ""), version = Number(job.payload.version ?? 0), by = String(job.payload.by ?? "");
  if (!job.user_id || !/^[0-9a-f-]{36}$/i.test(secretId) || !version) return;
  const s = (await ctx.cron.query(
    "select s.name, s.env, d.fqdn_ascii, b.name as binding_name from secrets s join domains d on d.id = s.domain_id left join bindings b on b.id::text = $3 where s.id = $1 and s.user_id = $2",
    [secretId, job.user_id, by])).rows[0];
  if (!s || s.env !== "prod") return;
  await withUser(ctx.runtime, job.user_id, (c) => prodWriteNotice(ctx, c, job.user_id!, { secretId, version, name: s.name, fqdn: s.fqdn_ascii, bindingName: s.binding_name ?? "token" }));
}

const defs: JobDef[] = [
  { kind: "agents.expire", priority: 1, maxRuntimeSec: 30, handler: async (ctx) => { await expireDue(ctx); } },
  { kind: "agents.reconcile", priority: 1, maxRuntimeSec: 60, handler: async (ctx) => { await reconcileReservations(ctx); } },
  { kind: "agents.prod_write_notice", priority: 1, maxRuntimeSec: 30, handler: prodWriteJob },
];

/** Register the agent jobs and their schedule. Safe to call twice. */
export function registerAgentJobs(): void {
  for (const d of defs) if (!getJobDef(d.kind)) registerJob(d);
  registerRecurringJob({ kind: "agents.expire", everySec: 300 });
  registerRecurringJob({ kind: "agents.reconcile", everySec: 86_400 });
}
