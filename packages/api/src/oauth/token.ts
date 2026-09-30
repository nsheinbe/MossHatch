import crypto from "node:crypto";
import { withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { appendAudit } from "../audit.ts";
import { hit } from "../ratelimit.ts";
import { safeEqual, sha256 } from "../util/bytes.ts";
import { mintToken, parseToken } from "../util/token.ts";
import { revokeBinding, ACCESS_TTL_MS, REFRESH_IDLE_MS } from "../bindings/tokens.ts";
import { scopeString, storedScopes } from "../bindings/scopes.ts";
import { mcpResource } from "../mcp/routes.ts";
import { resolveClient } from "./clients.ts";

/**
 * The token and revocation endpoints of the MCP authorization server (RFC 6749 3.2 and 5, RFC 7636, RFC 7009; OAuth 2.1).
 * Form-encoded bodies, public clients (`token_endpoint_auth_method: none`), errors in RFC 6749 5.2 form (`{"error": ...}`),
 * which is a deliberate departure from this codebase's `{error:{code}}` because OAuth clients parse the standard shape.
 * Access tokens are `mh_cli_` (the 60-minute class) and stored only as the binding's SHA-256; refresh tokens are `mh_clr_`,
 * bound to their client, rotate on every use, and a replayed rotated one revokes the grant and its whole family.
 */

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };
const oauthError = (error: string, status = 400): HandlerResult => json({ error }, status, { headers: NO_STORE });
const str = (v: unknown): string | null => (typeof v === "string" && v.length <= 2048 ? v : null);
export const TOKEN_LIMIT = { bucket: "oauth.token.ip", max: 120, windowSeconds: 60 };

const s256 = (verifier: string) => crypto.createHash("sha256").update(verifier).digest("base64url");

async function issue(ctx: AppContext, c: PoolClient, o: { userId: string; bindingId: string; clientRef: string; familyEnd: Date }) {
  const now = ctx.clock.now();
  const access = mintToken("cli");
  const refresh = mintToken("clr");
  const accessEnd = new Date(Math.min(now.getTime() + ACCESS_TTL_MS, o.familyEnd.getTime()));
  const u = await c.query("update bindings set token_prefix = $3, token_hash = $4, expires_at = $5 where id = $1 and user_id = $2 and revoked_at is null and paused_at is null", [o.bindingId, o.userId, access.prefix, access.hash, accessEnd]);
  if (u.rowCount !== 1) return null;
  await c.query("insert into oauth_refresh_tokens (binding_id, user_id, client_ref, token_prefix, token_hash, created_at, idle_expires_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [o.bindingId, o.userId, o.clientRef, refresh.prefix, refresh.hash, now, new Date(Math.min(now.getTime() + REFRESH_IDLE_MS, o.familyEnd.getTime())), o.familyEnd]);
  const scopes = (await c.query("select scopes from bindings where id = $1", [o.bindingId])).rows[0]?.scopes;
  return { access_token: access.token, token_type: "Bearer", expires_in: Math.max(1, Math.floor((accessEnd.getTime() - now.getTime()) / 1000)), refresh_token: refresh.token, scope: storedScopes(scopes).map(scopeString).join(" ") };
}

async function codeGrant(ctx: AppContext, b: Record<string, unknown>): Promise<HandlerResult> {
  const code = str(b.code), verifier = str(b.code_verifier), redirectUri = str(b.redirect_uri), clientId = str(b.client_id), resource = b.resource === undefined ? undefined : str(b.resource);
  if (!code || !verifier || !redirectUri || !clientId || resource === null) return oauthError("invalid_request");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError("invalid_grant");
  const row = (await withNoUser(ctx.runtime, (c) => c.query("select * from oauth_code_get($1)", [sha256(code)]))).rows[0];
  if (!row) return oauthError("invalid_grant");
  const now = ctx.clock.now();
  if (row.status === "exchanged") {
    // A code presented twice was intercepted or replayed: the grant it produced is revoked (RFC 6749 4.1.2).
    if (row.binding_id) await withUser(ctx.runtime, row.user_id, (c) => revokeBinding(ctx, c, row.user_id, row.binding_id, "oauth_code_reuse", { kind: "system" }));
    return oauthError("invalid_grant");
  }
  if (row.status !== "approved" || !row.code_expires_at || new Date(row.code_expires_at) <= now) return oauthError("invalid_grant");
  const client = await resolveClient(ctx, clientId);
  // The code belongs to the client it was issued to, for the exact redirect URI, and only with the matching verifier.
  if (!client || client.id !== row.client_ref || row.redirect_uri !== redirectUri) return oauthError("invalid_grant");
  if (!safeEqual(Buffer.from(s256(verifier)), Buffer.from(row.code_challenge))) return oauthError("invalid_grant");
  if (resource !== undefined && resource !== (row.resource ?? mcpResource(ctx))) return oauthError("invalid_target");
  const out = await withUser(ctx.runtime, row.user_id, async (c) => {
    const won = await c.query("update oauth_authorizations set status = 'exchanged' where id = $1 and status = 'approved' and code_hash = $2", [row.id, sha256(code)]);
    if (won.rowCount !== 1) return null;
    const bind = (await c.query("select id, family_expires_at, revoked_at from bindings where id = $1 and user_id = $2 for update", [row.binding_id, row.user_id])).rows[0];
    if (!bind || bind.revoked_at || !bind.family_expires_at || new Date(bind.family_expires_at) <= now) return null;
    const t = await issue(ctx, c, { userId: row.user_id, bindingId: row.binding_id, clientRef: row.client_ref, familyEnd: new Date(bind.family_expires_at) });
    if (t) await appendAudit(ctx, c, { chainId: row.user_id, actorKind: "agent", actorId: row.binding_id, action: "binding.granted", resourceKind: "binding", resourceId: row.binding_id, detail: { kind: "oauth", client: row.client_ref } });
    return t;
  });
  return out ? json(out, 200, { headers: NO_STORE }) : oauthError("invalid_grant");
}

async function refreshGrant(ctx: AppContext, b: Record<string, unknown>): Promise<HandlerResult> {
  const presented = str(b.refresh_token), clientId = str(b.client_id);
  if (!presented || !clientId) return oauthError("invalid_request");
  const parsed = parseToken(presented);
  if (!parsed || parsed.kind !== "clr") return oauthError("invalid_grant");
  const row = (await withNoUser(ctx.runtime, (c) => c.query("select * from oauth_refresh_get($1)", [parsed.hash]))).rows[0];
  if (!row) return oauthError("invalid_grant");
  const client = await resolveClient(ctx, clientId);
  if (!client || client.id !== row.client_ref) return oauthError("invalid_grant");
  const now = ctx.clock.now();
  const out = await withUser(ctx.runtime, row.user_id, async (c) => {
    if (row.rotated_at && !row.revoked_at) {
      // Reuse of a rotated refresh token: the family is compromised. Revoke the grant (the trigger revokes the family).
      await revokeBinding(ctx, c, row.user_id, row.binding_id, "refresh_reuse", { kind: "system" });
      await appendAudit(ctx, c, { chainId: row.user_id, actorKind: "system", action: "binding.refresh_reuse", resourceKind: "binding", resourceId: row.binding_id, detail: { kind: "oauth" } });
      return null;
    }
    if (row.revoked_at || new Date(row.expires_at) <= now || new Date(row.idle_expires_at) <= now) return null;
    const bind = (await c.query("select id, family_expires_at, revoked_at, paused_at from bindings where id = $1 and user_id = $2 for update", [row.binding_id, row.user_id])).rows[0];
    if (!bind || bind.revoked_at || bind.paused_at) return null;
    const used = await c.query("update oauth_refresh_tokens set rotated_at = $2 where id = $1 and rotated_at is null and revoked_at is null", [row.id, now]);
    if (used.rowCount !== 1) {
      await revokeBinding(ctx, c, row.user_id, row.binding_id, "refresh_reuse", { kind: "system" });
      return null;
    }
    const t = await issue(ctx, c, { userId: row.user_id, bindingId: row.binding_id, clientRef: row.client_ref, familyEnd: new Date(bind.family_expires_at ?? row.expires_at) });
    if (t) await appendAudit(ctx, c, { chainId: row.user_id, actorKind: "agent", actorId: row.binding_id, action: "binding.refreshed", resourceKind: "binding", resourceId: row.binding_id, detail: { kind: "oauth" } });
    return t;
  });
  return out ? json(out, 200, { headers: NO_STORE }) : oauthError("invalid_grant");
}

/** POST /oauth/mcp/token (anonymous, form-encoded). */
export async function tokenHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const rl = await withNoUser(ctx.runtime, (c) => hit(ctx, c, `oauth.token:${req.ipPrefix}`, TOKEN_LIMIT));
  if (!rl.allowed) return json({ error: "slow_down" }, 429, { headers: { ...NO_STORE, "Retry-After": String(rl.retryAfterSeconds) } });
  const b = (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
  if (Object.values(b).some((v) => Array.isArray(v))) return oauthError("invalid_request");
  if (b.grant_type === "authorization_code") return codeGrant(ctx, b);
  if (b.grant_type === "refresh_token") return refreshGrant(ctx, b);
  return oauthError(typeof b.grant_type === "string" ? "unsupported_grant_type" : "invalid_request");
}

/**
 * POST /oauth/mcp/revoke (RFC 7009): an access or refresh token of this client's grant. The answer is 200 whatever happened,
 * so a caller learns nothing about tokens it does not hold; a revoke is never rate limited.
 */
export async function revokeHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const b = (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
  const token = str(b.token), clientId = str(b.client_id);
  if (!token) return oauthError("invalid_request");
  const parsed = parseToken(token);
  if (!parsed) return json({}, 200, { headers: NO_STORE });
  const client = clientId ? await resolveClient(ctx, clientId) : null;
  let owner: { binding_id: string; user_id: string; client_ref: string | null } | undefined;
  if (parsed.kind === "clr") owner = (await withNoUser(ctx.runtime, (c) => c.query("select binding_id, user_id, client_ref from oauth_refresh_get($1)", [parsed.hash]))).rows[0];
  else {
    const g = (await withNoUser(ctx.runtime, (c) => c.query("select id, user_id from auth_binding_get($1,$2)", [parsed.prefix, parsed.hash]))).rows[0];
    if (g) owner = { binding_id: g.id, user_id: g.user_id, client_ref: (await withUser(ctx.runtime, g.user_id, (c) => c.query("select oauth_client_id from bindings where id = $1", [g.id]))).rows[0]?.oauth_client_id ?? null };
  }
  if (owner && (!owner.client_ref || !client || client.id === owner.client_ref)) {
    await withUser(ctx.runtime, owner.user_id, (c) => revokeBinding(ctx, c, owner.user_id, owner.binding_id, "oauth_revoke", { kind: "agent", id: owner.binding_id }));
  }
  return json({}, 200, { headers: NO_STORE });
}
