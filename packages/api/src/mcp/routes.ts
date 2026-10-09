import { withUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError, json, type Router } from "../http/router.ts";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import { callerOf } from "../agents/common.ts";
import { ownedDomainMap, parseScope, scopeString } from "../bindings/scopes.ts";
import { dispatch, LATEST, RPC } from "./server.ts";
import { deny, originAllowed, readRpc } from "./transport.ts";
import { PUBLIC_MCP_PATH, publicMcpRoutes } from "./public.ts";
import { TOOLS } from "./tools.ts";

export { originAllowed } from "./transport.ts";

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


export async function mcpHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  // Origin first among our own checks: a rebinding page never reaches the tools, whatever token it carries.
  if (!originAllowed(ctx, req.request.headers.get("origin"))) return deny(403, "forbidden_origin");
  if (req.principal.kind !== "binding") return deny(401, "unauthorized", { "WWW-Authenticate": mcpChallenge(ctx) });
  const caller = callerOf(req);
  // Audience: a token minted by our OAuth server for another resource is not a token for /mcp (RFC 8707, MCP authorization).
  const b = (await withUser(ctx.runtime, caller.userId, (c) => c.query("select audience from bindings where id = $1 and user_id = $2", [caller.bindingId, caller.userId]))).rows[0];
  if (!b || (b.audience !== null && b.audience !== mcpResource(ctx))) return deny(401, "invalid_token", { "WWW-Authenticate": mcpChallenge(ctx, "invalid_token") });
  const rpc = readRpc(req);
  if (!rpc.ok) return rpc.res;
  const { msg, meta } = rpc;
  let out;
  try { out = await dispatch(ctx, caller, msg, meta); }
  catch (e) {
    if (e instanceof HttpError) throw e;
    return json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: RPC.internal, message: "Internal error" } }, 500);
  }
  if (out === null) return { status: 202, json: {} };
  const result = out.result as { structuredContent?: { error?: { code?: string } } } | undefined;
  if (b.audience && result?.structuredContent?.error?.code === "scope_missing") {
    // OAuth clients discover optional access through RFC 6750's challenge. Suggest only the exact owned resource asked
    // for; the client must return through owner consent. Static bearer clients retain the tool-error contract.
    const tool = TOOLS.find((t) => t.name === msg.params?.name);
    const args = msg.params?.arguments as Record<string, unknown> | undefined;
    let scope: string | undefined;
    if (tool && typeof tool.capability === "string") {
      const resource = tool.capability === "register.propose" ? "*" : typeof args?.domain === "string" ? args.domain : undefined;
      if (resource) {
        const owned = await withUser(ctx.runtime, caller.userId, (c) => ownedDomainMap(c, caller.userId));
        try { scope = scopeString(parseScope(`${tool.capability}:${resource}${typeof args?.env === "string" ? `:${args.env}` : ""}`, owned)); }
        catch { /* No valid owned scope to suggest. Never widen to a wildcard as a fallback. */ }
      }
    }
    return json(out, 403, { headers: { "Cache-Control": "no-store, private", "WWW-Authenticate": `${mcpChallenge(ctx, "insufficient_scope")}${scope ? `, scope="${scope}"` : ""}` } });
  }
  return json(out, 200, { headers: { "Cache-Control": "no-store, private", ...(meta.era === "2026" ? { "MCP-Protocol-Version": LATEST } : {}) } });
}

/**
 * GET on either MCP address: a person who pastes the address into a browser (Accept: text/html) lands on the instructions page;
 * an MCP client opening a GET stream gets the 405 the transport allows for a server without one (Allow: POST).
 */
async function mcpGet(req: HandlerReq): Promise<HandlerResult> {
  if ((req.request.headers.get("accept") ?? "").includes("text/html")) return { status: 302, json: {}, headers: { Location: `${req.ctx.config.origin}/assistants`, "Cache-Control": "no-store" } };
  throw new HttpError(405, "method_not_allowed", "method_not_allowed", { Allow: "POST" });
}

export const mcpRoutes: Route[] = [
  // `anonymous` is admitted only so the handler can answer 401 with the metadata challenge; every tool needs a binding.
  { method: "POST", path: MCP_PATH, principals: ["binding", "anonymous"], handler: mcpHandler, challenge: (ctx) => mcpChallenge(ctx, "invalid_token"), resource: mcpResource, tag: "mcp" },
  { method: "GET", path: MCP_PATH, principals: ["binding", "anonymous"], handler: mcpGet, challenge: (ctx) => mcpChallenge(ctx, "invalid_token"), resource: mcpResource, tag: "mcp" },
  { method: "GET", path: PUBLIC_MCP_PATH, principals: ["anonymous"], handler: mcpGet, tag: "mcp" },
];

export function registerMcpRoutes(router: Router): Router {
  router.add(...mcpRoutes, ...publicMcpRoutes);
  return router;
}
