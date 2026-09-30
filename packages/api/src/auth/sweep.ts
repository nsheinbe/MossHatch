import { tx } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { SUSPENSION_MS } from "./common.ts";

/**
 * Housekeeping for the ops sweeper (cron role): drops expired pending accounts, spent challenges and codes, revokes
 * credentials that a recovery suspended more than 30 days ago, and settles finished recovery holds.
 */
export async function sweepAuth(ctx: AppContext): Promise<{ removed: number; expiredSuspensions: number; settled: number }> {
  const now = ctx.clock.now();
  return tx(ctx.cron, async (c) => {
    const removed = Number((await c.query("select auth2_sweep($1) as n", [now])).rows[0].n);
    const exp = await c.query("update passkeys set revoked_at = $2 where suspended_at is not null and revoked_at is null and suspended_at <= $1", [new Date(now.getTime() - SUSPENSION_MS), now]);
    const settled = await c.query("update recovery_requests set status = 'completed', updated_at = $1 where status = 'holding' and hold_until <= $1", [now]);
    return { removed, expiredSuspensions: exp.rowCount ?? 0, settled: settled.rowCount ?? 0 };
  });
}
