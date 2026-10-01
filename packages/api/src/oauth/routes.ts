import { json, type Router } from "../http/router.ts";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import type { AppContext } from "../ports.ts";
import { mcpResource } from "../mcp/routes.ts";
import { registerHandler } from "./clients.ts";
import { authorizeHandler, consentApproveHandler, consentDenyHandler, consentViewHandler, issuer, registerConsentSpec } from "./authorize.ts";
import { revokeHandler, tokenHandler } from "./token.ts";

/**
 * Discovery documents and endpoints of the OAuth 2.1 authorization server for MCP (D-019; dossier sections 3 and 9.1).
 * RFC 8414 metadata at the issuer's well-known path and RFC 9728 protected resource metadata for `/mcp` (the MCP 2026-07-28
 * authorization spec requires the latter, F8). Claude's connectors choose Client ID Metadata Documents only when the metadata
 * says both `client_id_metadata_document_supported: true` and `none` for token endpoint auth (F34); both are advertised.
 * `iss` is returned in authorization responses (RFC 9207). The well-known paths and `/mcp` sit outside /api and need a
 * rewrite to the API function on Vercel (added to vercel.json; UNVERIFIED on a deployment: the request URL a rewritten
 * function sees was not tested, dossier section 12).
 */

const V = "/api/v1/oauth";
/** Scope names offered to OAuth clients: our grammar, valid OAuth scope tokens. The person chooses the real grant on the consent screen. */
export const SCOPES_SUPPORTED = ["domains.read:*", "dns.read:*", "register.propose:*", "renew.propose:*", "transfer.status:*"];

export function authServerMetadata(ctx: Pick<AppContext, "config">) {
  const o = ctx.config.origin;
  return {
    issuer: issuer(ctx),
    authorization_endpoint: `${o}${V}/authorize`,
    token_endpoint: `${o}${V}/mcp/token`,
    registration_endpoint: `${o}${V}/register`,
    revocation_endpoint: `${o}${V}/mcp/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SCOPES_SUPPORTED,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata(ctx: Pick<AppContext, "config">) {
  return { resource: mcpResource(ctx), authorization_servers: [issuer(ctx)], scopes_supported: SCOPES_SUPPORTED, bearer_methods_supported: ["header"], resource_name: "Mosshatch" };
}

/** Public discovery documents: any origin may read them (browser-based MCP clients fetch them cross-origin). */
const PUBLIC = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" };
const meta = (f: (ctx: AppContext) => unknown) => async (req: HandlerReq): Promise<HandlerResult> => json(f(req.ctx), 200, { headers: PUBLIC });

export const oauthRoutes: Route[] = [
  { method: "GET", path: "/.well-known/oauth-authorization-server", principals: ["anonymous"], handler: meta(authServerMetadata), tag: "oauth" },
  { method: "GET", path: "/.well-known/oauth-protected-resource", principals: ["anonymous"], handler: meta(protectedResourceMetadata), tag: "oauth" },
  { method: "GET", path: "/.well-known/oauth-protected-resource/mcp", principals: ["anonymous"], handler: meta(protectedResourceMetadata), tag: "oauth" },
  // DCR (RFC 7591) is the fallback; it registers a public client with the redirect URIs it lists and nothing else.
  { method: "POST", path: `${V}/register`, principals: ["anonymous"], handler: registerHandler, tag: "oauth" },
  // The browser's entry: anonymous or signed in (a GET never changes state beyond storing a ten-minute request).
  { method: "GET", path: `${V}/authorize`, principals: ["anonymous", "session"], handler: authorizeHandler, tag: "oauth" },
  // The consent screen (session only). Approving is `agent.token.create` with a passkey.
  { method: "GET", path: `${V}/requests/:id`, principals: ["session"], handler: consentViewHandler, tag: "oauth" },
  { method: "POST", path: `${V}/requests/:id/approve`, principals: ["session"], stepUp: "agent.token.create", handler: consentApproveHandler, tag: "oauth" },
  { method: "POST", path: `${V}/requests/:id/deny`, principals: ["session"], handler: consentDenyHandler, tag: "oauth" },
  // Token and revocation endpoints: public clients, form-encoded bodies, each call carries its own proof (code + verifier, refresh token).
  { method: "POST", path: `${V}/mcp/token`, principals: ["anonymous"], body: "form", handler: tokenHandler, tag: "oauth" },
  { method: "POST", path: `${V}/mcp/revoke`, principals: ["anonymous"], body: "form", handler: revokeHandler, tag: "oauth" },
];

export function registerOAuthRoutes(router: Router): Router {
  registerConsentSpec();
  router.add(...oauthRoutes);
  return router;
}
