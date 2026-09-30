import { withUser, type PoolClient } from "@mosshatch/db";
import type { ActionType, HandlerReq } from "../http/types.ts";
import { ACTION_TYPES } from "../http/types.ts";
import { HttpError } from "../http/router.ts";
import { safeEqual } from "../util/bytes.ts";
import { getActionSpec } from "./specs.ts";
import { assertNotHeld } from "./holds-port.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACTION_HEADER = "x-mh-action-id";

const required = (type: ActionType) => new HttpError(403, "step_up_required", undefined, undefined, { type });

/**
 * The gate for routes that declare `stepUp`. Requires a committed action of exactly that type, for the same user and
 * session, not expired and not yet used. The action id comes in the `X-MH-Action-Id` header. Every failure looks the same.
 */
export function createStepUpGate(): (req: HandlerReq, type: ActionType) => Promise<{ id: string; type: ActionType; params: unknown }> {
  return async (req, type) => {
    if (!ACTION_TYPES.includes(type)) throw new Error("step-up gate called with an id outside the thirteen");
    const p = req.principal;
    if (p.kind !== "session" || !p.userId || !p.sessionIdHash) throw new HttpError(403, "forbidden_principal");
    const id = req.request.headers.get(ACTION_HEADER) ?? "";
    if (!UUID.test(id)) throw required(type);
    const userId = p.userId;
    const row = await withUser(req.ctx.runtime, userId, async (c) => {
      const r = (await c.query("select id, type, params, state, expires_at, session_id_hash from actions where id = $1 and user_id = $2", [id, userId])).rows[0];
      if (!r || r.type !== type || r.state !== "committed" || new Date(r.expires_at) <= req.ctx.clock.now() || !safeEqual(Buffer.from(r.session_id_hash), p.sessionIdHash!)) return null;
      // A hold that began after the commit still blocks the effect.
      if (getActionSpec(type)?.held) await assertNotHeld(req.ctx, c, userId, type);
      return r as { id: string; params: unknown };
    });
    if (!row) throw required(type);
    return { id: row.id, type, params: row.params };
  };
}

/** For handlers that want to assert the gate ran (defence in depth). Throws 403 `step_up_required` naming the type. */
export function requireAction(req: HandlerReq, type: ActionType): { id: string; type: ActionType; params: unknown } {
  if (!req.action || req.action.type !== type) throw required(type);
  return req.action;
}

/**
 * Mark the action used. Call it inside the handler's own transaction, so the effect and the single use commit together.
 * Zero rows means another request used it first: the handler must abort (409), which rolls back its effect.
 */
export async function markExecuted(c: PoolClient, action: { id: string; type: ActionType }): Promise<void> {
  const r = await c.query("update actions set state = 'executed' where id = $1 and type = $2 and state = 'committed'", [action.id, action.type]);
  if (r.rowCount !== 1) throw new HttpError(409, "action_consumed");
}

/** For executors that run after commit (jobs): record the outcome of a committed or dispatching action. */
export async function markActionState(c: PoolClient, actionId: string, from: "committed" | "dispatching", to: "dispatching" | "executed" | "failed" | "outcome_unknown"): Promise<boolean> {
  const r = await c.query("update actions set state = $3 where id = $1 and state = $2", [actionId, from, to]);
  return r.rowCount === 1;
}
