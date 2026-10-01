import { registerDeadLetterHook, registerRecurringJob } from "../jobs/engine.ts";
import { getJobDef, registerJob, type JobDef, type JobRow } from "../jobs/registry.ts";
import type { AppContext } from "../ports.ts";
import { advance, machine, reconcileOpen, sweepUnknown, toCanceling } from "./machine.ts";
import { loadOrder } from "./support.ts";
import { MIN_AUTH_WINDOW_MS } from "./types.ts";
import { recordSales } from "./sales-ledger.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The only thing read from a job payload is an order id. */
export function orderIdOf(job: Pick<JobRow, "payload">): string | null {
  const v = job.payload?.order_id;
  return typeof v === "string" && UUID.test(v) ? v : null;
}

const CAPTURE_STATES = ["registered", "capturing", "capture_failed"];

export const orderFulfil = async (ctx: AppContext, job: JobRow) => {
  const id = orderIdOf(job);
  if (id) await advance(machine(ctx, { attemptId: job.attempt_id, jobId: job.id }), id);
};
export const orderCapture = async (ctx: AppContext, job: JobRow) => {
  const id = orderIdOf(job);
  const o = id ? await loadOrder(ctx.cron, id) : null;
  if (id && o && CAPTURE_STATES.includes(o.state)) await advance(machine(ctx, { attemptId: job.attempt_id, jobId: job.id }), id);
};
export const orderCancel = async (ctx: AppContext, job: JobRow) => {
  const id = orderIdOf(job);
  const o = id ? await loadOrder(ctx.cron, id) : null;
  if (id && o && o.state === "canceling") await advance(machine(ctx, { attemptId: job.attempt_id, jobId: job.id }), id);
};
export const orderReconcile = async (ctx: AppContext, job: JobRow) => {
  const id = orderIdOf(job);
  if (id) await advance(machine(ctx, { attemptId: job.attempt_id, jobId: job.id }), id);
  else await reconcileOpen(machine(ctx, { attemptId: job.attempt_id, jobId: job.id }));
};
export const orderSweepUnknown = async (ctx: AppContext, job: JobRow) => { await sweepUnknown(machine(ctx, { attemptId: job.attempt_id, jobId: job.id })); };

const defs: JobDef[] = [
  { kind: "order.fulfil", priority: 0, maxRuntimeSec: 45, handler: orderFulfil },
  { kind: "order.reconcile", priority: 0, maxRuntimeSec: 45, handler: orderReconcile },
  { kind: "order.sweep_unknown", priority: 0, maxRuntimeSec: 30, handler: orderSweepUnknown },
  { kind: "order.capture", priority: 0, maxRuntimeSec: 45, handler: orderCapture },
  { kind: "order.cancel", priority: 0, maxRuntimeSec: 45, handler: orderCancel },
  // C-43: captured and refunded amounts per billing region and month, and the nexus alerts.
  { kind: "sales.ledger", priority: 1, maxRuntimeSec: 120, handler: async (ctx) => { await recordSales(ctx); } },
];

let registered = false;
/** Register the money jobs (priority 0), the recurring schedule, and the dead-letter default. Safe to call twice. */
export function registerOrderJobs(): void {
  if (registered && getJobDef("order.fulfil")) return;
  for (const d of defs) if (!getJobDef(d.kind)) registerJob(d);
  registerRecurringJob({ kind: "order.reconcile", everySec: 300 });
  registerRecurringJob({ kind: "order.sweep_unknown", everySec: 60 });
  registerRecurringJob({ kind: "sales.ledger", everySec: 3600 });
  registerDeadLetterHook("order.fulfil", async (ctx, dead) => {
    // A money job that dead-letters applies a default: if the authorization deadline is near and the name is not ours yet, cancel the hold.
    const row = (await ctx.cron.query("select payload from jobs where id = $1", [dead.id])).rows[0];
    const id = orderIdOf({ payload: row?.payload ?? {} });
    const o = id ? await loadOrder(ctx.cron, id) : null;
    if (!o || !o.captureBefore) return;
    if (!["authorized", "registrar_unavailable", "review_hold"].includes(o.state)) return;
    if (o.captureBefore.getTime() - ctx.clock.now().getTime() < 2 * MIN_AUTH_WINDOW_MS) await toCanceling(machine(ctx), o, [o.state], "auth_window");
  });
  registered = true;
}
