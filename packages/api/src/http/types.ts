import type { AppContext } from "../ports.ts";

export type PrincipalKind = "anonymous" | "session" | "binding" | "cron" | "webhook";

export interface Principal {
  kind: PrincipalKind;
  userId?: string;
  /** SHA-256 of the session cookie value (session principals). */
  sessionIdHash?: Buffer;
  authCredentialId?: string | null;
  bindingId?: string;
  bindingKind?: "agent" | "cli";
  scopes?: unknown;
  provider?: string;
}

export type ActionType =
  | "secret.reveal" | "domain.nameservers.change" | "domain.unlock" | "domain.transfer_out" | "domain.contact.change"
  | "agent.purchase.approve" | "agent.token.create" | "agent.token.widen" | "dns.sensitive.approve" | "device.approve"
  | "passkey.add" | "card.publish" | "mandate.sign";

export const ACTION_TYPES: readonly ActionType[] = [
  "secret.reveal", "domain.nameservers.change", "domain.unlock", "domain.transfer_out", "domain.contact.change",
  "agent.purchase.approve", "agent.token.create", "agent.token.widen", "dns.sensitive.approve", "device.approve",
  "passkey.add", "card.publish", "mandate.sign",
];

export interface HandlerReq {
  ctx: AppContext;
  request: Request;
  url: URL;
  params: Record<string, string>;
  principal: Principal;
  /** Parsed JSON body (null for GET or empty). */
  body: unknown;
  /** Truncated client address (/24 or /48) for rate limits and session metadata. */
  ipPrefix: string;
  uaFamily: string;
  /** Present on step-up gated routes after the gate has passed. */
  action?: { id: string; type: ActionType; params: unknown };
}

export interface HandlerResult {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
  /** Extra Set-Cookie header values. */
  cookies?: string[];
  /** Raw body for non-JSON responses (email-action confirm pages). */
  html?: string;
}

export type Handler = (req: HandlerReq) => Promise<HandlerResult>;

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  /** Pattern like /api/v1/domains/:fqdn/dns/:id . */
  path: string;
  /** Deny by default: a route with no principals cannot be registered. */
  principals: PrincipalKind[];
  handler: Handler;
  /** The route mutates through a step-up: only a committed action of this type unlocks it. */
  stepUp?: ActionType;
  /** Webhook signature check; required when principals includes "webhook". */
  verify?: (request: Request, rawBody: string, ctx: AppContext) => Promise<{ ok: boolean; provider: string }>;
  /** Bearer carve-out: capability the binding must hold (checked by the handler with scopes). */
  capability?: string;
  /** Skip the cookie CSRF guard (ceremony endpoints carry their own tokens; never used for mutations by default). */
  csrf?: "guard" | "none";
  /** Free-form tag for the route walk (module name). */
  tag?: string;
  /** Request body format. `form` accepts `application/x-www-form-urlencoded` (OAuth token and revocation endpoints, RFC 6749/7009). */
  body?: "json" | "form";
  /** `WWW-Authenticate` value sent with a 401 from this route (RFC 9728 `resource_metadata` for /mcp). */
  challenge?: (ctx: AppContext) => string;
}
