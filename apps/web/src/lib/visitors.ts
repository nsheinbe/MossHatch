import { api, ApiError } from "./api";
import { explainDomain, gated } from "./domains";

/**
 * The visitor calls: tokens, command-line sign-ins and connected apps; the requests they make; the OAuth consent screen.
 * Nothing here is persisted: a token is shown once from the create response and held only in component state.
 */

export interface Spend { cap_minor: string; spent_minor: string; reserved_minor: string }
export interface Visitor {
  id: string; kind: "agent" | "cli"; name: string; prefix: string; scopes: string[];
  connected_app: { reported_name: string | null; redirect_host: string | null; registration: string } | null;
  created_at: string; last_used_at: string | null; expires_at: string; revoked_at: string | null; paused: boolean; spend: Spend; pending_requests: number;
}
export interface VisitorList { visitors: Visitor[]; pending_requests: number; confirm_threshold_minor: string; device_login_enabled: boolean }
export interface DomainName { unicode: string; ascii: string; mixed_script: boolean; has_unicode: boolean }
export interface RequestSummary { id: string; kind: string; state: string; domain: DomainName | null; years: number | null; max_total_minor: string; requested_at: string; expires_at: string; requester: { binding_id: string; name: string } }
export interface Card {
  id: string; kind: "register" | "renew" | "dns_change" | "scope"; state: string; agent_state: string;
  requester: { binding_id: string; name: string; kind: string; connected_app: boolean; token_expires_at: string; live: boolean };
  requested_at: string; age_seconds: number; expires_at: string; new_network: boolean; decided_at: string | null; decision_reason: string | null; order_id: string | null;
  domain?: DomainName; years?: number;
  first_charge?: { subtotal_minor: string; max_total_minor: string; tax_ceiling_minor: string };
  renewal?: { subtotal_minor: string; years: number } | null;
  spend?: Spend; confirm?: { required: boolean; reasons: string[] };
  dns?: { added: DnsLine[]; removed: DnsLine[]; sensitive: { type: string; name: string; reasons: string[] }[] };
  scopes?: string[];
}
export interface DnsLine { type: string; name: string; value: string; priority?: number }
export interface Consent {
  id: string; expires_at: string; redirect_host: string; redirect_is_this_computer: boolean; client_id_host: string | null; registration: string;
  reported: { client_name: string | null }; suggested_scopes: string[]; ignored_scopes: number; domains: string[];
  defaults: { name: string; expires_in_days: number; spend_cap_minor: number };
}

export const listVisitors = () => api<VisitorList>("GET", "/api/v1/visitors");
export const listPending = () => api<{ approvals: RequestSummary[] }>("GET", "/api/v1/approvals?state=pending");
export const listApproved = () => api<{ approvals: RequestSummary[] }>("GET", "/api/v1/approvals?state=approved");
export const getCard = (id: string) => api<Card>("GET", `/api/v1/approvals/${encodeURIComponent(id)}`);
export const decline = (id: string) => api("POST", `/api/v1/approvals/${encodeURIComponent(id)}/decline`, {});
export const decide = (id: string, actionId: string) => api<{ state: string; order_id: string | null; checkout_url: string | null }>("POST", `/api/v1/approvals/${encodeURIComponent(id)}/decide`, {}, gated(actionId));
export const approveDns = (id: string, actionId: string) => api<{ state: string }>("POST", `/api/v1/approvals/${encodeURIComponent(id)}/approve-dns`, {}, gated(actionId));
export const resolveScope = (id: string) => api<{ state: string }>("POST", `/api/v1/approvals/${encodeURIComponent(id)}/resolve`, {});
export const payNow = (id: string) => api<{ order_id: string | null; checkout_url: string | null }>("POST", `/api/v1/approvals/${encodeURIComponent(id)}/checkout`, {});
export const sendHome = () => api<{ revoked: number }>("POST", "/api/v1/visitors/send-home", {});
export const revokeVisitor = (id: string) => api("DELETE", `/api/v1/bindings/${encodeURIComponent(id)}`);
export const createToken = (actionId: string) => api<{ id: string; token: string; prefix: string; expires_at: string; scopes: string[] }>("POST", "/api/v1/bindings", {}, gated(actionId));
export const widenToken = (id: string, actionId: string) => api("POST", `/api/v1/bindings/${encodeURIComponent(id)}/widen`, {}, gated(actionId));
/** Stops a token at once (no passkey: it only takes access away). Resuming is a widen with the same access, behind the passkey. */
export const pauseToken = (id: string) => api<{ binding: { paused: boolean } }>("POST", `/api/v1/bindings/${encodeURIComponent(id)}/pause`, {});
export interface ActivityEntry { at: string; actor: string; action: string; resource_kind: string | null; resource_id: string | null; domain: string | null; op: string | null; outcome: string | null }
export const getActivity = async (id: string) => (await api<{ activity: ActivityEntry[] }>("GET", `/api/v1/bindings/${encodeURIComponent(id)}/activity`)).activity;

const OP: Record<string, string> = {
  search_names: "searched names", get_quote: "asked for a price", list_domains: "listed your names", get_domain: "read a name", dns_list: "read DNS records",
  dns_upsert: "changed DNS records", nest_names: "listed secret names", secrets_get: "read a secret", secrets_set: "stored a secret",
  propose_registration: "suggested a name to buy", propose: "suggested a name to buy", propose_renewal: "suggested a renewal", request_scope: "asked for more access",
  get_proposal: "checked a request", transfer_status: "checked a transfer", list_recipes: "listed recipes", plan_recipe: "planned a recipe",
  apply_recipe: "applied a recipe", get_recipe_application: "checked a recipe",
};
const ACTION: Record<string, string> = {
  "binding.created": "Created", "binding.granted": "Created", "binding.widened": "Given more access, or resumed", "binding.narrowed": "Given less access", "binding.paused": "Paused",
  "binding.revoked": "Revoked", "binding.refreshed": "Signed in again", "binding.leak_reported": "Reported as published, and revoked", "mcp.client_seen": "Connected",
  "agent.request.created": "Asked for your decision", "agent.request.approved": "You approved its request", "agent.request.declined": "Its request was declined",
  "agent.request.void": "Its request was cancelled", "agent.scope_denied": "Tried something it may not do", "secret.read": "Read a secret", "secret.write": "Stored a secret",
  "recipe.planned": "Planned a recipe", "recipe.apply_requested": "Started a recipe", "recipe.applied": "A recipe finished", "recipe.failed": "A recipe failed",
};
/** One line of a token's activity, in words. Unknown entries keep their code, so nothing is hidden. */
export function describeActivity(a: ActivityEntry): string {
  if ((a.action === "mcp.tool_call" || a.action === "agent.call") && a.op) {
    const did = OP[a.op] ?? a.op;
    const how = a.outcome === "ok" ? "" : a.outcome === "scope_denied" ? " (not allowed)" : " (refused)";
    return `${did[0]!.toUpperCase()}${did.slice(1)}${a.domain ? ` on ${a.domain}` : ""}${a.action === "mcp.tool_call" ? " through MCP" : ""}${how}`;
  }
  return `${ACTION[a.action] ?? a.action}${a.domain ? `: ${a.domain}` : ""}`;
}
export const getConsent = (id: string) => api<Consent>("GET", `/api/v1/oauth/requests/${encodeURIComponent(id)}`);
export const approveConsent = (id: string, actionId: string) => api<{ redirect_to: string }>("POST", `/api/v1/oauth/requests/${encodeURIComponent(id)}/approve`, {}, gated(actionId));
export const denyConsent = (id: string) => api<{ redirect_to: string }>("POST", `/api/v1/oauth/requests/${encodeURIComponent(id)}/deny`, {});

export type ScopesToSign =
  | { ok: true; card: Card; scopes: string[] }
  | { ok: false; card: Card; reason: "changed" | "request_unavailable" | "binding_unavailable" };

/**
 * What approving a scope request signs (ST-72): the token's access as the server has it now, plus exactly the scopes the card shows.
 * Both are fetched again right before the passkey step, so a list loaded earlier (a token narrowed since, in another tab) can never
 * widen the token past what is shown. A request that no longer matches the shown scopes is refused, and its current version returned
 * for the card to show instead. The server's step-up summary then names the whole resulting set before the passkey is touched.
 */
export async function scopesToSign(id: string, shown: readonly string[], io: { getCard: typeof getCard; listVisitors: typeof listVisitors } = { getCard, listVisitors }): Promise<ScopesToSign> {
  const [card, list] = await Promise.all([io.getCard(id), io.listVisitors()]);
  if (card.kind !== "scope" || card.state !== "pending") return { ok: false, card, reason: "request_unavailable" };
  const asks = [...new Set(card.scopes ?? [])].sort();
  const seen = [...new Set(shown)].sort();
  if (asks.length !== seen.length || asks.some((s, i) => s !== seen[i])) return { ok: false, card, reason: "changed" };
  const token = list.visitors.find((v) => v.id === card.requester.binding_id && !v.revoked_at);
  if (!token) return { ok: false, card, reason: "binding_unavailable" };
  return { ok: true, card, scopes: [...new Set([...token.scopes, ...asks])] };
}

/** PUT and PATCH are not in the shared helper; the same guard headers, the same error shape. */
async function send<T>(method: "PUT" | "PATCH", path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json", "X-MH-Client": "web" }, body: JSON.stringify(body) });
  } catch { throw new ApiError(0, "network"); }
  const text = await res.text();
  let json: { error?: { code?: string; reason?: string } } & Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, json.error?.code ?? "error", json.error?.reason);
  return json as T;
}
/** A change that only narrows is applied at once; anything wider answers 403 `step_up_required` and needs the passkey. */
export const narrowToken = (id: string, body: { scopes?: string[]; spend_cap_minor?: number; expires_in_days?: number }) => send<{ binding: Visitor }>("PATCH", `/api/v1/bindings/${encodeURIComponent(id)}`, body);
export const setThreshold = (minor: number) => send<{ confirm_threshold_minor: string }>("PUT", "/api/v1/visitors/threshold", { confirm_threshold_minor: minor });
export const setDeviceLogin = (enabled: boolean) => send<{ device_login_enabled: boolean }>("PUT", "/api/v1/bindings/device-login", { enabled });

export const usd = (minor: string | number) => { const n = BigInt(minor); const s = n.toString().padStart(3, "0"); return `$${s.slice(0, -2)}.${s.slice(-2)}`; };
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "Never");
export const ago = (seconds: number) => (seconds < 90 ? "just now" : seconds < 5400 ? `${Math.round(seconds / 60)} minutes ago` : seconds < 129_600 ? `${Math.round(seconds / 3600)} hours ago` : `${Math.round(seconds / 86_400)} days ago`);

/** Plain words for the codes these screens can meet. Never echoes server text. */
export function explainVisitor(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "typed_confirmation_required": return "Type the name exactly as shown to approve it.";
      case "price_changed": return "The price changed since the request, so it was cancelled. Nothing was charged. The token can ask again.";
      case "request_unavailable": return "This request was already decided, or it was cancelled.";
      case "request_expired": return "This request expired. Nothing was charged.";
      case "binding_unavailable": return "The token that asked was revoked or paused, so this cannot be approved.";
      case "zone_changed": return "The DNS records changed since the request, so it was cancelled and nothing was written.";
      case "not_widened": return "The token does not have that access yet.";
      case "invalid_scope": return "One of those scopes is not valid. Scopes look like dns.read:example.com or secrets.read:example.com:dev.";
      case "scope_conflict": return "A token cannot read secrets and change DNS at the same time. Split them into two tokens.";
      case "step_up_required": return "That needs your passkey.";
      case "name_unavailable": return "Someone else took that name. Nothing was charged.";
      case "contact_required": return "Add your registrant contact first, from any name's Hatch sheet.";
      case "documents_unavailable": return "The terms are being updated. Try again in a few minutes.";
      case "not_found": return "This is no longer here.";
    }
  }
  return explainDomain(e);
}
