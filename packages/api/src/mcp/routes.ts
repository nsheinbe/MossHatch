import { withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError, json, type Router } from "../http/router.ts";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import { callerOf } from "../agents/common.ts";
import { dispatch, isRpcRequest, LATEST, RPC, SUPPORTED, type CallMeta } from "./server.ts";

/**
 * `POST /mcp` (Streamable HTTP, one endpoint, JSON responses; the router answers GET and DELETE with 405 as the 2026-07-28
 * transport asks). In front of the JSON-RPC handler, in this order (ST-84): the bearer token is authenticated by the router
 * (only a Mosshatch `mh_` token found live in the database passes; anything minted elsewhere is 401, ST-83), then the Origin
 * allow-list (DNS rebinding, transport spec F4: a present, unlisted Origin is 403), then the token's audience (an OAuth token
 * minted for another resource is refused), then the protocol-version and method headers. A 401 names the RFC 9728
 * metadata document in `WWW-Authenticate`, which is how OAuth clients (claude.ai, Desktop) find the authorization server.
 */

export const MCP_PATH = "/mcp";
export const mcpResource = (ctx: Pick<AppContext, "config">) => `${ctx.config.origin}${MCP_PATH}`;
export const prmUrl = (ctx: Pick<AppContext, "config">) => `${ctx.config.origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
export const mcpChallenge = (ctx: Pick<AppContext, "config">, error?: string) => `Bearer realm="mosshatch"${error ? `, error="${error}"` : ""}, resource_metadata="${prmUrl(ctx)}"`;

/** Browsers send Origin; server-side MCP clients usually do not. A present Origin must be the app's own. */
export function originAllowed(ctx: AppContext, origin: string | null): boolean {
  if (origin === null) return true;
  return ctx.config.allowedOrigins.includes(origin) || origin === ctx.config.origin;
}

const deny = (status: number, code: string, headers?: Record<string, string>): HandlerResult => ({ status, json: { error: { code } }, headers });

export async function mcpHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  // Origin first among our own checks: a rebinding page never reaches the tools, whatever token it carries.
  if (!originAllowed(ctx, req.request.headers.get("origin"))) return deny(403, "forbidden_origin");
  if (req.principal.kind !== "binding") return deny(401, "unauthorized", { "WWW-Authenticate": mcpChallenge(ctx) });
  const caller = callerOf(req);
  // Audience: a token minted by our OAuth server for another resource is not a token for /mcp (RFC 8707, MCP authorization).
  const b = (await withUser(ctx.runtime, caller.userId, (c) => c.query("select audience from bindings where id = $1 and user_id = $2", [caller.bindingId, caller.userId]))).rows[0];
  if (!b || (b.audience !== null && b.audience !== mcpResource(ctx))) return deny(401, "invalid_token", { "WWW-Authenticate": mcpChallenge(ctx, "invalid_token") });
  // The token is never read from the query string (MCP authorization: header only).
  if (req.url.searchParams.has("access_token")) return deny(400, "token_in_query");
  const pv = req.request.headers.get("mcp-protocol-version");
  if (pv !== null && !(SUPPORTED as readonly string[]).includes(pv)) return deny(400, "unsupported_protocol_version");
  const meta: CallMeta = pv === LATEST ? { era: "2026", version: LATEST } : { era: "legacy", version: pv ?? SUPPORTED[1] };
  const msg = req.body;
  if (Array.isArray(msg)) return json({ jsonrpc: "2.0", id: null, error: { code: RPC.invalidRequest, message: "Batches are not supported" } }, 400);
  if (!isRpcRequest(msg)) return json({ jsonrpc: "2.0", id: null, error: { code: RPC.invalidRequest, message: "Invalid request" } }, 400);
  // 2026-07-28 method headers, when sent, must agree with the body (a proxy may route on them).
  const hm = req.request.headers.get("mcp-method"), hn = req.request.headers.get("mcp-name");
  if (hm !== null && hm !== msg.method) return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: RPC.invalidRequest, message: "Mcp-Method does not match" } }, 400);
  if (hn !== null && msg.method === "tools/call" && hn !== msg.params?.name) return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: RPC.invalidRequest, message: "Mcp-Name does not match" } }, 400);
  let out;
  try { out = await dispatch(ctx, caller, msg, meta); }
  catch (e) {
    if (e instanceof HttpError) throw e;
    return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: RPC.internal, message: "Internal error" } }, 500);
  }
  if (out === null) return { status: 202, json: {} };
  return json(out, 200, { headers: { "Cache-Control": "no-store, private", ...(meta.era === "2026" ? { "MCP-Protocol-Version": LATEST } : {}) } });
}

export const mcpRoutes: Route[] = [
  // `anonymous` is admitted only so the handler can answer 401 with the metadata challenge; every tool needs a binding.
  { method: "POST", path: MCP_PATH, principals: ["binding", "anonymous"], handler: mcpHandler, challenge: (ctx) => mcpChallenge(ctx, "invalid_token"), tag: "mcp" },
];

export function registerMcpRoutes(router: Router): Router {
  router.add(...mcpRoutes);
  return router;
}
