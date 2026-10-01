import { withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { mintToken, parseToken } from "../util/token.ts";
import { lockUser } from "../agents/common.ts";
import type { Scope } from "./scopes.ts";

/**
 * Token lifecycle (PLAN 4.5 Tokens). Every token is `mh_<kind>_<32 base62>+<crc32>`, shown once, stored as SHA-256 only
 * and looked up by that hash (a caller cannot choose a preimage, so the lookup leaks nothing about stored tokens). Expiry,
 * revocation and scopes are checked in the database on every request; there is no self-contained token.
 */

export const MIN = 60_000;
export const DAY = 86_400_000;
export const ACCESS_TTL_MS = 60 * MIN;
export const REFRESH_IDLE_MS = 30 * DAY;
export const REFRESH_ABSOLUTE_MS = 90 * DAY;
export const AGENT_DEFAULT_MS = 30 * DAY;
export const AGENT_MAX_MS = 90 * DAY;

export interface IssuedCli { bindingId: string; accessToken: string; refreshToken: string; expiresIn: number }

/** Create the CLI binding for an approved device request and issue its first access and refresh tokens. */
export async function issueCliGrant(ctx: AppContext, c: PoolClient, o: { userId: string; deviceRequestId: string; actionId: string | null; scopes: Scope[] }): Promise<IssuedCli> {
  const now = ctx.clock.now();
  const access = mintToken("cli");
  const refresh = mintToken("clr");
  const family = new Date(now.getTime() + REFRESH_ABSOLUTE_MS);
  const b = (await c.query(
    `insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, expires_at, created_by_action_id, device_request_id, family_expires_at, created_at, updated_at)
     values ($1,'cli','CLI login',$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id`,
    [o.userId, access.prefix, access.hash, JSON.stringify(o.scopes), new Date(now.getTime() + ACCESS_TTL_MS), o.actionId, o.deviceRequestId, family, now])).rows[0];
  await c.query(
    "insert into binding_refresh_tokens (binding_id, user_id, token_prefix, token_hash, created_at, idle_expires_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7)",
    [b.id, o.userId, refresh.prefix, refresh.hash, now, new Date(Math.min(now.getTime() + REFRESH_IDLE_MS, family.getTime())), family]);
  return { bindingId: b.id, accessToken: access.token, refreshToken: refresh.token, expiresIn: ACCESS_TTL_MS / 1000 };
}

/** Revoke one binding and its refresh family, in the caller's transaction. Returns whether anything changed. */
export async function revokeBinding(ctx: AppContext, c: PoolClient, userId: string, bindingId: string, cause: string, actor: { kind: "user" | "cli" | "agent" | "system"; id?: string }): Promise<boolean> {
  const now = ctx.clock.now();
  const r = await c.query("update bindings set revoked_at = $3 where id = $1 and user_id = $2 and revoked_at is null returning id", [bindingId, userId, now]);
  await c.query("update binding_refresh_tokens set revoked_at = $3 where binding_id = $1 and user_id = $2 and revoked_at is null", [bindingId, userId, now]);
  if (r.rowCount === 1) await appendAudit(ctx, c, { chainId: userId, actorKind: actor.kind, actorId: actor.id ?? userId, action: "binding.revoked", resourceKind: "binding", resourceId: bindingId, detail: { cause } });
  return r.rowCount === 1;
}

/**
 * Revoke-all (ST-66): every binding, every refresh token, every approved-but-unclaimed device grant, and every pending agent
 * request of the user, in one transaction. Never rate limited (a revoke path must always work).
 *
 * Lock order, the same on every path that touches agent requests and bindings (ST-66, ST-74): the user's agent lock (`lockUser`),
 * then agent requests in id order, then bindings in id order, then refresh tokens. Decline, approval, proposals, the sweeper and the
 * reservation-release trigger (a request leaving `pending` updates its binding) all take a request before its binding; this path
 * used to revoke the bindings first and could deadlock with them.
 */
export async function revokeAllBindings(ctx: AppContext, c: PoolClient, userId: string, cause: string): Promise<{ bindings: number; refresh: number; devices: number; requests: number }> {
  const now = ctx.clock.now();
  // Device grants first: this waits for any poll that is consuming one right now (it holds that row), so the binding the
  // poll inserts is committed, and seen, before the bindings are revoked below. Each statement reads a fresh snapshot.
  const d = await c.query("update device_requests set state = 'denied', decided_at = $2 where user_id = $1 and state = 'approved'", [userId, now]);
  // The agent lock also keeps a proposal from adding a pending request while this runs, so none is left behind on a revoked binding.
  await lockUser(c, userId);
  const pending = (await c.query("select id from agent_requests where user_id = $1 and state = 'pending' order by id for update", [userId])).rows.map((x) => x.id as string);
  await c.query("select id from bindings where user_id = $1 and revoked_at is null order by id for no key update", [userId]);
  // Declining releases each held reservation in the trigger, on a binding this transaction already holds.
  const q = pending.length ? await c.query("update agent_requests set state = 'declined', decision_reason = 'revoke_all' where id = any($1::uuid[]) and state = 'pending'", [pending]) : null;
  const b = await c.query("update bindings set revoked_at = $2 where user_id = $1 and revoked_at is null", [userId, now]);
  const r = await c.query("update binding_refresh_tokens set revoked_at = $2 where user_id = $1 and revoked_at is null", [userId, now]);
  const out = { bindings: b.rowCount ?? 0, refresh: r.rowCount ?? 0, devices: d.rowCount ?? 0, requests: q?.rowCount ?? 0 };
  await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "binding.revoke_all", resourceKind: "user", resourceId: userId, detail: { cause, ...out } });
  return out;
}

/**
 * Refresh-token rotation. A live refresh token yields a new access token (the binding's token hash is replaced) and a new
 * refresh token; the old one is marked rotated. Presenting a rotated one again revokes the whole family (ST-71).
 */
export async function rotateRefresh(ctx: AppContext, presented: string): Promise<IssuedCli> {
  const parsed = parseToken(presented);
  if (!parsed || parsed.kind !== "clr") throw new HttpError(400, "invalid_grant");
  const row = (await withNoUser(ctx.runtime, (c) => c.query("select * from auth_refresh_get($1)", [parsed.hash]))).rows[0];
  if (!row) throw new HttpError(400, "invalid_grant");
  const now = ctx.clock.now();
  return withUser(ctx.runtime, row.user_id, async (c) => {
    if (row.rotated_at && !row.revoked_at) {
      await revokeBinding(ctx, c, row.user_id, row.binding_id, "refresh_reuse", { kind: "system" });
      await appendAudit(ctx, c, { chainId: row.user_id, actorKind: "system", action: "binding.refresh_reuse", resourceKind: "binding", resourceId: row.binding_id, detail: {} });
      return null;
    }
    if (row.revoked_at || new Date(row.expires_at) <= now || new Date(row.idle_expires_at) <= now) return null;
    const b = (await c.query("select id, revoked_at, paused_at, family_expires_at from bindings where id = $1 and user_id = $2 for update", [row.binding_id, row.user_id])).rows[0];
    if (!b || b.revoked_at || b.paused_at) return null;
    const used = await c.query("update binding_refresh_tokens set rotated_at = $2 where id = $1 and rotated_at is null and revoked_at is null", [row.id, now]);
    if (used.rowCount !== 1) {
      // Lost a race with another use of the same token: that is reuse too.
      await revokeBinding(ctx, c, row.user_id, row.binding_id, "refresh_reuse", { kind: "system" });
      return null;
    }
    const access = mintToken("cli");
    const refresh = mintToken("clr");
    const family = new Date(b.family_expires_at ?? row.expires_at);
    await c.query("update bindings set token_prefix = $2, token_hash = $3, expires_at = $4 where id = $1 and revoked_at is null",
      [row.binding_id, access.prefix, access.hash, new Date(Math.min(now.getTime() + ACCESS_TTL_MS, family.getTime()))]);
    await c.query(
      "insert into binding_refresh_tokens (binding_id, user_id, token_prefix, token_hash, created_at, idle_expires_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7)",
      [row.binding_id, row.user_id, refresh.prefix, refresh.hash, now, new Date(Math.min(now.getTime() + REFRESH_IDLE_MS, family.getTime())), family]);
    await appendAudit(ctx, c, { chainId: row.user_id, actorKind: "cli", actorId: row.binding_id, action: "binding.refreshed", resourceKind: "binding", resourceId: row.binding_id, detail: {} });
    return { bindingId: row.binding_id as string, accessToken: access.token, refreshToken: refresh.token, expiresIn: ACCESS_TTL_MS / 1000 } satisfies IssuedCli;
  }).then((x) => { if (!x) throw new HttpError(400, "invalid_grant"); return x; });
}

/** RFC 7009: revoke by presenting an access or refresh token. Unknown tokens are not an error (the answer is always 200). */
export async function revokeByToken(ctx: AppContext, presented: string): Promise<void> {
  const parsed = parseToken(presented);
  if (!parsed) return;
  if (parsed.kind === "clr") {
    const row = (await withNoUser(ctx.runtime, (c) => c.query("select * from auth_refresh_get($1)", [parsed.hash]))).rows[0];
    if (row) await withUser(ctx.runtime, row.user_id, (c) => revokeBinding(ctx, c, row.user_id, row.binding_id, "oauth_revoke", { kind: "cli", id: row.binding_id }));
    return;
  }
  const row = (await withNoUser(ctx.runtime, (c) => c.query("select * from auth_binding_get($1, $2)", [parsed.prefix, parsed.hash]))).rows[0];
  if (row) await withUser(ctx.runtime, row.user_id, (c) => revokeBinding(ctx, c, row.user_id, row.id, "oauth_revoke", { kind: row.kind === "cli" ? "cli" : "agent", id: row.id }));
}

/** Create an agent binding (after `agent.token.create`). Returns the token, shown once. */
export async function createAgentBinding(ctx: AppContext, c: PoolClient, o: { userId: string; name: string; scopes: Scope[]; capMinor: bigint; expiresAt: Date; actionId: string }): Promise<{ id: string; token: string; prefix: string }> {
  const m = mintToken("live");
  const now = ctx.clock.now();
  const r = (await c.query(
    `insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, spend_cap_minor, expires_at, created_by_action_id, created_at, updated_at)
     values ($1,'agent',$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id`,
    [o.userId, o.name, m.prefix, m.hash, JSON.stringify(o.scopes), o.capMinor.toString(), o.expiresAt, o.actionId, now])).rows[0];
  return { id: r.id, token: m.token, prefix: m.prefix };
}
