import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { ACTION_TYPES, type ActionType } from "../http/types.ts";
import { HttpError } from "../http/router.ts";

/** Every action id in the 4.5 table except `mandate.sign`, which stays open so renewals keep working. */
export const HELD_ACTIONS: readonly ActionType[] = ACTION_TYPES.filter((a) => a !== "mandate.sign");

/**
 * Is `actionType` refused for this user right now? An `all_held` hold covers every held id; the `secret.reveal`
 * hold (a passkey added while signed in) covers that id only. Runs on any client that can read `action_holds`
 * (a user-scoped transaction or the cron role).
 */
export async function isHeld(ctx: Pick<AppContext, "clock">, client: PoolClient, userId: string, actionType: ActionType): Promise<boolean> {
  if (!HELD_ACTIONS.includes(actionType)) return false;
  const r = await client.query(
    "select 1 from action_holds where user_id = $1 and until > $2 and (scope = 'all_held' or scope = $3) limit 1",
    [userId, ctx.clock.now(), actionType],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Throws 423 `recovery_hold` while a hold covers the action. */
export async function assertNotHeld(ctx: Pick<AppContext, "clock">, client: PoolClient, userId: string, actionType: ActionType): Promise<void> {
  if (await isHeld(ctx, client, userId, actionType)) {
    // ST-24: the refusal says when the hold ends (the latest covering hold).
    const r = await client.query("select max(until) as until from action_holds where user_id = $1 and until > $2 and (scope = 'all_held' or scope = $3)", [userId, ctx.clock.now(), actionType]);
    const until = r.rows[0]?.until ? new Date(r.rows[0].until).toISOString() : undefined;
    throw new HttpError(423, "recovery_hold", undefined, undefined, until ? { hold_until: until } : undefined);
  }
}

/** Any recovery activity that freezes account changes: an all-held hold, or a request still open (pending, cooling off, holding). */
export async function recoveryActive(ctx: Pick<AppContext, "clock">, client: PoolClient, userId: string): Promise<boolean> {
  const h = await client.query("select 1 from action_holds where user_id = $1 and until > $2 and scope = 'all_held' limit 1", [userId, ctx.clock.now()]);
  if ((h.rowCount ?? 0) > 0) return true;
  const q = await client.query("select 1 from recovery_requests where user_id = $1 and (status in ('pending','cooling_off') or (status = 'holding' and hold_until > $2)) limit 1", [userId, ctx.clock.now()]);
  return (q.rowCount ?? 0) > 0;
}

/** Address, recovery-code and credential changes are refused during any recovery hold. */
export async function assertNoRecoveryActivity(ctx: Pick<AppContext, "clock">, client: PoolClient, userId: string): Promise<void> {
  if (await recoveryActive(ctx, client, userId)) throw new HttpError(423, "recovery_hold");
}
