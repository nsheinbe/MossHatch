import { registerRecurringJob } from "../jobs/engine.ts";
import { getJobDef, registerJob, type JobRow } from "../jobs/registry.ts";
import { tx } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { pollOutsideMachine } from "./driver.ts";
import { gateSweep } from "./gate.ts";
import { OPEN_STATES } from "./policy.ts";
import { expireUnconfirmed } from "./start.ts";
import { rowToTransfer } from "./store.ts";

/**
 * `transfer_in.poll` (every 5 minutes): unconfirmed transfers expire, every live or late-watched transfer is read from the adapter
 * (through the order machine where it owns the order, directly where the payment was already taken), and the Gate sweep runs. The
 * payload is empty: a job never carries a code, an address or a name.
 */
export async function pollTransfersIn(ctx: AppContext, job?: Pick<JobRow, "id" | "attempt_id">): Promise<{ expired: number; polled: number; notified: number; released: number }> {
  const now = ctx.clock.now();
  let expired = 0, polled = 0;
  const stale = (await ctx.cron.query("select * from transfers_in where state = 'awaiting_confirmation' and (confirm_expires_at < $1 or created_at < $2)", [now, new Date(now.getTime() - 86_400_000)])).rows;
  for (const r of stale) if (await tx(ctx.cron, (c) => expireUnconfirmed(ctx, c, rowToTransfer(r), "timeout"))) expired++;
  const due = (await ctx.cron.query(
    `select * from transfers_in where (state = any($1) and state <> 'awaiting_confirmation' and (next_check_at is null or next_check_at <= $2))
        or (state in ('failed','nacked','cancelled') and ((late_watch_until > $2 and (next_check_at is null or next_check_at <= $2))
            or exists (select 1 from orders o where o.id = transfers_in.order_id and o.state = 'captured')))
      order by created_at limit 200`, [[...OPEN_STATES], now])).rows;
  for (const r of due) {
    try { await pollOutsideMachine(ctx, rowToTransfer(r), job ? { jobId: job.id, attemptId: job.attempt_id } : undefined); polled++; }
    catch (e) { if ((e as Error)?.name === "LeaseLostError") throw e; /* one bad transfer never stops the rest; the next pass retries it */ }
    if (r.late_watch_until) await ctx.cron.query("update transfers_in set next_check_at = $2 where id = $1 and state in ('failed','nacked','cancelled')", [r.id, new Date(now.getTime() + 5 * 60_000)]);
  }
  const g = await gateSweep(ctx);
  return { expired, polled, ...g };
}

export function registerTransferJobs(): void {
  if (!getJobDef("transfer_in.poll")) registerJob({ kind: "transfer_in.poll", priority: 1, maxRuntimeSec: 60, handler: async (ctx, job) => { await pollTransfersIn(ctx, job); } });
  registerRecurringJob({ kind: "transfer_in.poll", everySec: 300 });
}
