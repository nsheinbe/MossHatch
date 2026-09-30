import { withUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { revokeAllBindings } from "../bindings/tokens.ts";
import { sentHomeNotice } from "./notices.ts";

/**
 * "Send all visitors home" (ST-66): every binding (agents, connected apps and command-line sign-ins), every refresh token
 * of either kind, every approved-but-unclaimed device grant, every pending request and every open OAuth consent, in the
 * caller's transaction. Never rate limited: a revoke path must always work. Kept apart from the Visitors page so the undo of a
 * recovery (ST-48) runs the same path inside the sign-in transaction without importing the rest of the agent surface.
 */
export async function sendAllHomeIn(ctx: AppContext, c: PoolClient, userId: string, cause: string, o: { notify?: boolean } = {}) {
  const base = await revokeAllBindings(ctx, c, userId, cause);
  const now = ctx.clock.now();
  const oauthRefresh = await c.query("update oauth_refresh_tokens set revoked_at = $2 where user_id = $1 and revoked_at is null", [userId, now]);
  const consents = await c.query("update oauth_authorizations set status = 'denied', decided_at = $2 where user_id = $1 and status in ('pending','approved')", [userId, now]);
  const voided = await c.query("update agent_requests set state = 'void', decision_reason = 'send_home' where user_id = $1 and state = 'pending'", [userId]);
  await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "visitors.sent_home", resourceKind: "user", resourceId: userId, detail: { ...base, oauth_refresh: oauthRefresh.rowCount ?? 0, consents: consents.rowCount ?? 0, voided: voided.rowCount ?? 0 } });
  if (o.notify !== false) await sentHomeNotice(ctx, c, userId, { bindings: base.bindings });
  return { revoked: base.bindings, refresh_tokens: base.refresh + (oauthRefresh.rowCount ?? 0), device_grants: base.devices, requests_declined: base.requests + (voided.rowCount ?? 0), consents_closed: consents.rowCount ?? 0 };
}

/** The Visitors page's one action, in its own transaction. */
export async function sendAllHome(ctx: AppContext, userId: string, cause = "send_home") {
  return withUser(ctx.runtime, userId, (c) => sendAllHomeIn(ctx, c, userId, cause));
}
