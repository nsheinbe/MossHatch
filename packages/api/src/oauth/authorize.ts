import { z } from "zod";
import { withNoUser, withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { appendAudit } from "../audit.ts";
import { hit } from "../ratelimit.ts";
import { b64u, randomBytes, sha256 } from "../util/bytes.ts";
import { mintToken } from "../util/token.ts";
import { markExecuted, requireAction } from "../stepup/gate.ts";
import type { ActionSpec } from "../stepup/specs.ts";
import { ownedDomainMap, parseScope, scopeString, type Scope } from "../bindings/scopes.ts";
import { canonical, NAME_RE, parseForUser } from "../bindings/specs.ts";
import { AGENT_MAX_MS, DAY } from "../bindings/tokens.ts";
import { grantNotice } from "../bindings/notice.ts";
import { registerRoutedSpec } from "../agents/specs.ts";
import { notFound, sessionUserOf, UUID } from "../agents/common.ts";
import { mcpResource } from "../mcp/routes.ts";
import { clientByRef, hostOf, isLoopback, redirectMatches, resolveClient } from "./clients.ts";

/**
 * The authorization endpoint and the consent screen (RFC 6749 4.1 with PKCE S256 only, OAuth 2.1; D-019). The browser arrives
 * at GET /api/v1/oauth/authorize; the client and the redirect URI are checked before anything else, and until both are
 * known good nothing is ever redirected (an unregistered redirect gets a plain error page, ST-84). The request is stored for
 * ten minutes and the browser goes to the app's consent screen, where the first signed-in person to open it claims it. The
 * grant is an agent binding created by `agent.token.create` under a passkey, binding this request, this client and this
 * redirect URI, so one client's consent can never be used by another. The code is 256 bits, single use, 60 seconds.
 */

export const AUTH_REQUEST_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 60_000;
/** Authorization requests per source range (own target). */
export const AUTHORIZE_LIMIT = { bucket: "oauth.authorize.ip", max: 60, windowSeconds: 600 };
export const issuer = (ctx: Pick<AppContext, "config">) => ctx.config.origin;

const errorPage = (title: string, text: string): HandlerResult => ({
  status: 400, headers: { "Cache-Control": "no-store" },
  html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`,
});

function redirectWith(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

const one = (url: URL, k: string): string | undefined | null => {
  const all = url.searchParams.getAll(k);
  if (all.length > 1) return null;   // a repeated parameter is an error (RFC 6749 3.1)
  return all[0];
};

/** GET /oauth/authorize (anonymous or a signed-in browser). */
export async function authorizeHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx, url } = req;
  // Each call stores a request and may fetch a metadata document: limited per source range (a person's browser comes here).
  const rl = await withNoUser(ctx.runtime, (c) => hit(ctx, c, `oauth.authorize:${req.ipPrefix}`, AUTHORIZE_LIMIT));
  if (!rl.allowed) return { ...errorPage("Too many sign-in requests", "Wait a few minutes and try again. Nothing was shared."), status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(rl.retryAfterSeconds) } };
  const clientId = one(url, "client_id"), redirectUri = one(url, "redirect_uri");
  if (!clientId || !redirectUri) return errorPage("This sign-in link is not valid", "The app that sent you here did not say who it is or where to return. Nothing was shared.");
  const client = await resolveClient(ctx, clientId);
  if (!client) return errorPage("This app is not known", "The app that sent you here is not registered with Mosshatch. Nothing was shared.");
  if (!redirectMatches(client.redirect_uris, redirectUri)) return errorPage("This sign-in link is not valid", "The address this app wants to return to is not one it registered. Nothing was shared.");
  // From here on, errors go back to the verified redirect URI with the client's state and our issuer (RFC 9207).
  const state = one(url, "state");
  const back = (error: string) => ({ status: 302, json: {}, headers: { Location: redirectWith(redirectUri, { error, ...(state ? { state } : {}), iss: issuer(ctx) }) } });
  if (state === null || (state !== undefined && !/^[\x21-\x7e]{1,500}$/.test(state))) return back("invalid_request");
  if (one(url, "response_type") !== "code") return back("unsupported_response_type");
  const challenge = one(url, "code_challenge"), method = one(url, "code_challenge_method");
  if (method !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back("invalid_request");
  const resource = one(url, "resource");
  if (resource === null || (resource !== undefined && resource !== mcpResource(ctx))) return back("invalid_target");
  const scope = one(url, "scope");
  if (scope === null || (scope !== undefined && (scope.length > 2000 || !/^[\x20-\x7e]*$/.test(scope)))) return back("invalid_scope");
  const id = (await withNoUser(ctx.runtime, (c) => c.query("select oauth_authorization_create($1,$2,$3,$4,$5,$6,$7,$8,$9::interval) as id",
    [client.id, redirectUri, state ?? null, challenge, scope ?? null, resource ?? null, req.ipPrefix, ctx.clock.now(), `${AUTH_REQUEST_TTL_MS} milliseconds`]))).rows[0].id as string;
  return { status: 302, json: {}, headers: { Location: `${ctx.config.origin}/?oauth_request=${id}` } };
}

/** GET /oauth/requests/:id (session): what the consent screen shows. The first person to open it claims it. */
export async function consentViewHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = sessionUserOf(req);
  const id = req.params.id ?? "";
  if (!UUID.test(id)) throw notFound();
  const row = (await withNoUser(ctx.runtime, (c) => c.query("select * from oauth_authorization_claim($1,$2,$3)", [id, userId, ctx.clock.now()]))).rows[0];
  if (!row) throw notFound();
  const client = await clientByRef(ctx, row.client_ref);
  if (!client) throw notFound();
  const owned = await withUser(ctx.runtime, userId, (c) => ownedDomainMap(c, userId));
  const suggested: string[] = [];
  let ignored = 0;
  for (const s of String(row.requested_scope ?? "").split(" ").filter(Boolean).slice(0, 50)) {
    try { suggested.push(scopeString(parseScope(s, owned))); } catch { ignored++; }
  }
  return json({
    id, expires_at: new Date(row.expires_at).toISOString(),
    // Facts the server checked: where the grant goes back to, and how the client identified itself.
    redirect_host: hostOf(row.redirect_uri), redirect_is_this_computer: isLoopback(row.redirect_uri),
    client_id_host: client.registration === "cimd" ? hostOf(client.client_id) : null, registration: client.registration,
    // What the client says about itself: never shown as fact.
    reported: { client_name: client.client_name },
    suggested_scopes: suggested, ignored_scopes: ignored, domains: [...owned.keys()].sort(),
    // Connected apps default to the longest grant (90 days): a monthly reconnect was the cost of the old 30-day default.
    defaults: { name: "Connected app", expires_in_days: AGENT_MAX_MS / DAY, spend_cap_minor: 0 },
  }, 200, { headers: { "Cache-Control": "no-store, private" } });
}

// ---- agent.token.create for an OAuth grant -----------------------------------------------------------------------------------

const consentInput = z.strictObject({
  name: z.string().regex(NAME_RE),
  scopes: z.array(z.string().max(300)).min(1).max(50),
  spend_cap_minor: z.number().int().min(0).max(100_000_00).optional(),
  expires_in_days: z.number().int().min(1).max(AGENT_MAX_MS / DAY).optional(),
});

export const oauthConsentSpec: ActionSpec<z.infer<typeof consentInput>> = {
  type: "agent.token.create", held: true, userInput: consentInput,
  async derive(ctx, c, userId, targetId, input) {
    const id = targetId.slice("oauth_".length);
    if (!UUID.test(id)) throw notFound();
    const row = (await c.query("select * from oauth_authorizations where id = $1 and user_id = $2 and status = 'pending' and expires_at > $3", [id, userId, ctx.clock.now()])).rows[0];
    if (!row) throw notFound();
    const scopes = await parseForUser(c, userId, input.scopes);
    return {
      params: {
        route: "oauth", oauth_request_id: row.id, client_ref: row.client_ref, redirect_uri: row.redirect_uri, redirect_host: hostOf(row.redirect_uri), resource: row.resource ?? mcpResource(ctx),
        name: input.name, scopes: canonical(scopes), spend_cap_minor: input.spend_cap_minor ?? 0, expires_in_days: input.expires_in_days ?? AGENT_MAX_MS / DAY,
      },
      resourceId: row.id,
    };
  },
  summary: (p) => {
    const cap = Number(p.spend_cap_minor ?? 0);
    return `Let the app that returns to ${String(p.redirect_host)} act as your token "${String(p.name)}" for ${String(p.expires_in_days)} days. It can: ${(p.scopes as Scope[]).map(scopeString).join(", ")}.${cap > 0 ? ` It can ask you to approve purchases up to USD ${(cap / 100).toFixed(2)} in total.` : ""}`;
  },
};

export function registerConsentSpec(): void {
  registerRoutedSpec("agent.token.create", (t) => t.startsWith("oauth_"), "oauth", oauthConsentSpec as ActionSpec);
}

/**
 * POST /oauth/requests/:id/approve (session, `agent.token.create`). Creates the grant's binding (no usable token yet: the first
 * access token is issued at the code exchange) and a 60-second single-use code, and answers with the redirect for the browser.
 */
export async function consentApproveHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = sessionUserOf(req);
  const action = requireAction(req, "agent.token.create");
  const p = action.params as { route?: string; oauth_request_id: string; client_ref: string; redirect_uri: string; resource: string; name: string; scopes: Scope[]; spend_cap_minor: number; expires_in_days: number };
  if (p.route !== "oauth" || p.oauth_request_id !== req.params.id) throw notFound();
  const code = b64u(randomBytes(32));
  const out = await withUser(ctx.runtime, userId, async (c) => {
    await markExecuted(c, action);
    const now = ctx.clock.now();
    const row = (await c.query("select state_param from oauth_authorizations where id = $1 and user_id = $2 and status = 'pending' and expires_at > $3 for update", [p.oauth_request_id, userId, now])).rows[0];
    if (!row) throw new HttpError(409, "request_unavailable");
    // No usable token yet: a placeholder hash nobody holds. The code exchange replaces it with the first access token.
    const placeholder = mintToken("cli");
    const grantEnd = new Date(now.getTime() + Math.min(p.expires_in_days * DAY, AGENT_MAX_MS));
    const b = (await c.query(
      `insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, spend_cap_minor, expires_at, family_expires_at, created_by_action_id, oauth_client_id, audience, created_at, updated_at)
       values ($1,'agent',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) returning id`,
      [userId, p.name, placeholder.prefix, placeholder.hash, JSON.stringify(p.scopes), String(p.spend_cap_minor), now, grantEnd, action.id, p.client_ref, p.resource, now])).rows[0];
    const upd = await c.query(
      "update oauth_authorizations set status = 'approved', binding_id = $2, approved_by_action_id = $3, code_hash = $4, code_expires_at = $5, decided_at = $6 where id = $1 and status = 'pending'",
      [p.oauth_request_id, b.id, action.id, sha256(code), new Date(now.getTime() + CODE_TTL_MS), now]);
    if (upd.rowCount !== 1) throw new HttpError(409, "request_unavailable");
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "binding.created", resourceKind: "binding", resourceId: b.id, detail: { kind: "oauth", action_id: action.id, client: p.client_ref, scopes: p.scopes.length } });
    await grantNotice(ctx, c, userId, b.id, p.scopes, "agent");
    return { state: row.state_param as string | null };
  });
  return json({ redirect_to: redirectWith(p.redirect_uri, { code, ...(out.state ? { state: out.state } : {}), iss: issuer(ctx) }) }, 200, { headers: { "Cache-Control": "no-store, private" } });
}

/** POST /oauth/requests/:id/deny (session). The client learns only `access_denied`. */
export async function consentDenyHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = sessionUserOf(req);
  const id = req.params.id ?? "";
  if (!UUID.test(id)) throw notFound();
  const row = await withUser(ctx.runtime, userId, async (c) => {
    const r = (await c.query("update oauth_authorizations set status = 'denied', decided_at = $3 where id = $1 and user_id = $2 and status = 'pending' returning redirect_uri, state_param", [id, userId, ctx.clock.now()])).rows[0];
    if (r) await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "oauth.denied", resourceKind: "oauth_authorization", resourceId: id });
    return r;
  });
  if (!row) throw notFound();
  return json({ redirect_to: redirectWith(row.redirect_uri, { error: "access_denied", ...(row.state_param ? { state: row.state_param } : {}), iss: issuer(ctx) }) });
}
