import { json, type Router } from "../http/router.ts";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import { HttpError } from "../http/router.ts";
import { NO_STORE } from "../vault/context.ts";
import { agentView, cardView, decline, listForUser, propose, requestScope, resolveScope } from "./requests.ts";
import { approveDnsHandler, checkoutHandler, decideHandler, registerApprovalSpecs } from "./approve.ts";
import { agentDnsChange, agentDnsRead } from "./dns.ts";
import { agentNameserverPropose } from "./nameservers.ts";
import { getDomainFor, listDomainsFor, nestNamesFor, secretGetFor, secretSetFor, transferStatusFor } from "./capabilities.ts";
import { callerOf, sessionUserOf } from "./common.ts";
import { guarded } from "./guard.ts";
import { listVisitors, restoreHandler, sendHomeHandler, thresholdHandler, versionsHandler } from "./visitors.ts";
import { secretScanningHandler, verifyGitHubSignature } from "./scanning.ts";
import { registerAgentJobs } from "./jobs.ts";
import { registerMcpRoutes } from "../mcp/routes.ts";
import { registerOAuthRoutes } from "../oauth/routes.ts";

/**
 * The agent surface's routes (PLAN 4.5 REST table): approvals (session; approving is a step-up), the visitor list and
 * "Send all visitors home" (session), the REST equivalents of the MCP tools under /api/v1/agent (bearer only, each on the
 * caller's own resources and scopes), the secret-scanning hook (webhook), and the Nest restore for an agent's prod write.
 */

const rest = (op: string, kind: "read" | "write", fn: (req: HandlerReq) => Promise<unknown>, status = 200, headers?: Record<string, string>) =>
  async (req: HandlerReq): Promise<HandlerResult> => {
    const caller = callerOf(req);
    const out = await guarded(req.ctx, caller, op, kind, "rest", () => fn(req));
    return json(out, status, headers ? { headers } : undefined);
  };
const p = (req: HandlerReq, k: string) => req.params[k] ?? "";
const body = (req: HandlerReq) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {});

async function approvalGet(req: HandlerReq): Promise<HandlerResult> {
  if (req.principal.kind === "binding") {
    const caller = callerOf(req);
    return json(await guarded(req.ctx, caller, "get_proposal", "read", "rest", () => agentView(req.ctx, caller, p(req, "id"))), 200, { headers: NO_STORE });
  }
  return json(await cardView(req.ctx, sessionUserOf(req), p(req, "id")), 200, { headers: NO_STORE });
}
async function approvalList(req: HandlerReq): Promise<HandlerResult> {
  const state = req.url.searchParams.get("state");
  if (state !== null && !["pending", "approved", "declined", "expired", "void", "failed", "completed"].includes(state)) throw new HttpError(400, "invalid_request");
  return json({ approvals: await listForUser(req.ctx, sessionUserOf(req), state ?? undefined) });
}

const A = "/api/v1/agent";
const session = { principals: ["session" as const], tag: "agents" };
const bearer = { principals: ["binding" as const], tag: "agents" };

export const agentRoutes: Route[] = [
  // Approvals (session). Decline, resolve and checkout are free; approving is a passkey step-up.
  { ...session, method: "GET", path: "/api/v1/approvals", handler: approvalList },
  { method: "GET", path: "/api/v1/approvals/:id", principals: ["session", "binding"], tag: "agents", handler: approvalGet },
  { ...session, method: "POST", path: "/api/v1/approvals/:id/decide", stepUp: "agent.purchase.approve", handler: decideHandler },
  { ...session, method: "POST", path: "/api/v1/approvals/:id/approve-dns", stepUp: "dns.sensitive.approve", handler: approveDnsHandler },
  { ...session, method: "POST", path: "/api/v1/approvals/:id/decline", handler: async (req) => json(await decline(req.ctx, sessionUserOf(req), p(req, "id"))) },
  { ...session, method: "POST", path: "/api/v1/approvals/:id/resolve", handler: async (req) => json(await resolveScope(req.ctx, sessionUserOf(req), p(req, "id"))) },
  { ...session, method: "POST", path: "/api/v1/approvals/:id/checkout", liveGate: true, handler: checkoutHandler },
  // Visitors (session). Sending everyone home is never rate limited.
  { ...session, method: "GET", path: "/api/v1/visitors", handler: listVisitors },
  { ...session, method: "POST", path: "/api/v1/visitors/send-home", handler: sendHomeHandler },
  { ...session, method: "PUT", path: "/api/v1/visitors/threshold", handler: thresholdHandler },
  // The Nest's history and restore (session): an agent's production write can be undone here (ST-35).
  { ...session, method: "GET", path: "/api/v1/domains/:fqdn/secrets/:env/:name/versions", handler: versionsHandler },
  { ...session, method: "POST", path: "/api/v1/domains/:fqdn/secrets/:env/:name/restore", handler: restoreHandler },
  // REST equivalents of the MCP tools (bearer only; a cookie session is refused by the router).
  { ...bearer, method: "GET", path: `${A}/domains`, capability: "domains.read", handler: rest("list_domains", "read", (req) => listDomainsFor(req.ctx, callerOf(req)).then((d) => ({ domains: d }))) },
  { ...bearer, method: "GET", path: `${A}/domains/:fqdn`, capability: "domains.read", handler: rest("get_domain", "read", (req) => getDomainFor(req.ctx, callerOf(req), p(req, "fqdn"))) },
  { ...bearer, method: "GET", path: `${A}/domains/:fqdn/dns`, capability: "dns.read", handler: rest("dns_list", "read", (req) => agentDnsRead(req.ctx, callerOf(req), p(req, "fqdn"))) },
  { ...bearer, method: "POST", path: `${A}/domains/:fqdn/nameservers/proposals`, capability: "nameservers.propose", handler: rest("nameservers_propose", "write", (req) => agentNameserverPropose(req.ctx, callerOf(req), p(req, "fqdn"), req.body), 202) },
  { ...bearer, method: "POST", path: `${A}/domains/:fqdn/dns`, capability: "dns.write", handler: async (req) => {
    const caller = callerOf(req);
    const out = await guarded(req.ctx, caller, "dns_upsert", "write", "rest", () => agentDnsChange(req.ctx, caller, p(req, "fqdn"), req.body));
    return json(out, "status" in out && out.status === "pending_human_approval" ? 202 : 200);
  } },
  { ...bearer, method: "GET", path: `${A}/domains/:fqdn/nest/:env`, capability: "nest.names", handler: rest("nest_names", "read", (req) => nestNamesFor(req.ctx, callerOf(req), p(req, "fqdn"), p(req, "env")), 200, NO_STORE) },
  { ...bearer, method: "POST", path: `${A}/domains/:fqdn/secrets/:env/:name/read`, capability: "secrets.read", handler: rest("secrets_get", "read", (req) => secretGetFor(req.ctx, callerOf(req), p(req, "fqdn"), p(req, "env"), p(req, "name")), 200, NO_STORE) },
  { ...bearer, method: "PUT", path: `${A}/domains/:fqdn/secrets/:env/:name`, capability: "secrets.write", handler: rest("secrets_set", "write", (req) => secretSetFor(req.ctx, callerOf(req), p(req, "fqdn"), p(req, "env"), p(req, "name"), body(req).value), 200, NO_STORE) },
  { ...bearer, method: "GET", path: `${A}/domains/:fqdn/transfer`, capability: "transfer.status", handler: rest("transfer_status", "read", (req) => transferStatusFor(req.ctx, callerOf(req), p(req, "fqdn"))) },
  { ...bearer, method: "POST", path: `${A}/proposals`, capability: "register.propose", handler: rest("propose", "write", (req) => propose(req.ctx, callerOf(req), req.body), 202) },
  { ...bearer, method: "POST", path: `${A}/scope-requests`, handler: rest("request_scope", "write", (req) => requestScope(req.ctx, callerOf(req), req.body), 202) },
  // GitHub secret-scanning partner alerts: signature-verified before the handler runs (ST-68).
  { method: "POST", path: "/api/v1/hooks/github-secret-scanning", principals: ["webhook"], verify: verifyGitHubSignature, handler: secretScanningHandler, tag: "agents" },
];

/** One registration line in `routes.ts`: the agent routes, the MCP endpoint and the OAuth server, their specs and their jobs. Safe to call twice. */
export function registerAgentRoutes(router: Router): Router {
  registerApprovalSpecs();
  registerAgentJobs();
  router.add(...agentRoutes);
  registerMcpRoutes(router);
  registerOAuthRoutes(router);
  return router;
}
