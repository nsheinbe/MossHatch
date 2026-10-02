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
  | "passkey.add" | "card.publish" | "mandate.sign"
  // Account closure and export (closure module, migration 1050).
  | "account.close" | "account.export";

export const ACTION_TYPES: readonly ActionType[] = [
  "secret.reveal", "domain.nameservers.change", "domain.unlock", "domain.transfer_out", "domain.contact.change",
  "agent.purchase.approve", "agent.token.create", "agent.token.widen", "dns.sensitive.approve", "device.approve",
  "passkey.add", "card.publish", "mandate.sign",
  "account.close", "account.export",
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
  /** A Server-Sent Events stream (the launcher's creature turn): sent as `text/event-stream`, never cached or buffered. */
  sse?: ReadableStream<Uint8Array>;
  /** A file download (the launcher's site export): sent as an attachment with its own type, never rendered inline. */
  download?: { body: Uint8Array<ArrayBuffer>; contentType: string; filename: string };
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
  /**
   * A purchase or registrar-backed route of the shop. While the invite-only live gate is on (`ctx.services.liveGate`, waitlist/gate.ts)
   * only an account activated with an invite reaches it; everyone else gets 403 invite_required and the site stays the demo for them.
   */
  liveGate?: boolean;
  /** Free-form tag for the route walk (module name). */
  tag?: string;
  /** Request body format. `form` accepts `application/x-www-form-urlencoded` (OAuth token and revocation endpoints, RFC 6749/7009). */
  body?: "json" | "form";
  /** A stricter body cap in bytes than the router default: refused with 413 by declared length or while reading (the CSP report). */
  maxBodyBytes?: number;
  /** `WWW-Authenticate` value sent with a 401 from this route (RFC 9728 `resource_metadata` for /mcp). */
  challenge?: (ctx: AppContext) => string;
  /**
   * The protected resource this route belongs to (RFC 8707, e.g. `/mcp`). A bearer token minted for a resource (an OAuth grant's
   * `audience`) is accepted only on routes that declare that same resource; tokens with no audience are unaffected.
   */
  resource?: (ctx: AppContext) => string;
}
