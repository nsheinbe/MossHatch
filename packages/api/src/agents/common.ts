import { domainToUnicode } from "node:url";
import type { PoolClient } from "@mosshatch/db";
import { HttpError } from "../http/router.ts";
import type { HandlerReq } from "../http/types.ts";
import { storedScopes, type Scope } from "../bindings/scopes.ts";

/** Shared pieces of the agent surface (PLAN 4.5 "Agent purchases and the approval card"). */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** Requests expire after 72 hours and never after the binding (plan 4.5, own target). */
export const REQUEST_TTL_MS = 72 * HOUR_MS;
/** Approval-proposal limits (plan 4.5 rate-limit table; own targets). The daily ceiling is C-24's per-account velocity limit. */
export const LIMITS = { pendingPerBinding: 3, pendingPerUser: 10, perBindingHour: 5, perUserDay: 30 } as const;

export const notFound = () => new HttpError(404, "not_found");

/** The calling binding (bearer principals only). */
export interface Caller { userId: string; bindingId: string; kind: "agent" | "cli"; scopes: Scope[]; ipPrefix: string }

export function callerOf(req: HandlerReq): Caller {
  const p = req.principal;
  if (p.kind !== "binding" || !p.userId || !p.bindingId || !p.bindingKind) throw new HttpError(403, "forbidden_principal");
  return { userId: p.userId, bindingId: p.bindingId, kind: p.bindingKind, scopes: storedScopes(p.scopes), ipPrefix: req.ipPrefix };
}

export function sessionUserOf(req: HandlerReq): string {
  const p = req.principal;
  if (p.kind !== "session" || !p.userId) throw new HttpError(401, "unauthorized");
  return p.userId;
}

/** A binding that may still act: not revoked, not paused (a freeze pauses), not expired. */
export async function liveBinding(c: PoolClient, userId: string, bindingId: string, now: Date, lock = false) {
  const b = (await c.query(`select * from bindings where id = $1 and user_id = $2${lock ? " for update" : ""}`, [bindingId, userId])).rows[0];
  if (!b || b.revoked_at || b.paused_at || new Date(b.family_expires_at ?? b.expires_at) <= now) return null;
  return b as Record<string, any>;
}

/** The `agent_purchases_paused` kill switch (PLAN 4.3b Release, 4.4 `flags`): read on every agent purchase path, changed by SQL. */
export async function assertAgentPurchasesOpen(c: PoolClient): Promise<void> {
  if ((await c.query("select value from flags where name = 'agent_purchases_paused'")).rows[0]?.value === true) throw new HttpError(503, "agent_purchases_paused");
}

/** Per-user serialization of proposals and approvals (the reservation arithmetic runs under it). */
export const lockUser = (c: PoolClient, userId: string) => c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`mh.agents:${userId}`]);

/**
 * Text that came from outside (DNS values, registry text, names a client chose): control characters removed and length
 * capped. It is still data, never an instruction; callers mark it as untrusted where they return it.
 */
export function untrusted(s: unknown, max = 512): string {
  const t = typeof s === "string" ? s : String(s ?? "");
  // eslint-disable-next-line no-control-regex
  const clean = t.normalize("NFC").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "");
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

const SCRIPTS: [string, RegExp][] = [
  ["latin", /\p{Script=Latin}/u], ["cyrillic", /\p{Script=Cyrillic}/u], ["greek", /\p{Script=Greek}/u], ["armenian", /\p{Script=Armenian}/u],
  ["hebrew", /\p{Script=Hebrew}/u], ["arabic", /\p{Script=Arabic}/u], ["cjk", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u], ["hangul", /\p{Script=Hangul}/u],
  ["thai", /\p{Script=Thai}/u], ["devanagari", /\p{Script=Devanagari}/u], ["georgian", /\p{Script=Georgian}/u], ["cherokee", /\p{Script=Cherokee}/u],
];
/** The Unicode form of a name and whether any of its labels mixes scripts (a look-alike warning on the card, threat row 18). */
export function displayName(fqdnAscii: string): { unicode: string; ascii: string; mixed_script: boolean; has_unicode: boolean } {
  let unicode = fqdnAscii;
  try { unicode = domainToUnicode(fqdnAscii) || fqdnAscii; } catch { /* keep ascii */ }
  let mixed = false;
  for (const label of unicode.split(".")) {
    const seen = new Set<string>();
    for (const ch of label) for (const [name, re] of SCRIPTS) if (re.test(ch)) seen.add(name);
    if (seen.size > 1) mixed = true;
  }
  return { unicode, ascii: fqdnAscii, mixed_script: mixed, has_unicode: unicode !== fqdnAscii };
}

/** Agent-visible state (plan 4.5): never "paid" before "registered". */
export type AgentState = "pending_human_approval" | "declined" | "expired" | "void" | "failed" | "approved" | "approved_awaiting_payment" | "payment_authorized" | "registering" | "registered" | "applied";

export function agentState(r: { kind: string; state: string }, orderState: string | null): AgentState {
  switch (r.state) {
    case "pending": return "pending_human_approval";
    case "declined": case "expired": case "void": case "failed": return r.state;
    case "completed": return r.kind === "dns_change" || r.kind === "scope" ? "applied" : "registered";
  }
  if (r.kind === "dns_change" || r.kind === "scope") return "applied";
  if (!orderState) return "approved_awaiting_payment";
  if (["draft", "checkout_open"].includes(orderState)) return "approved_awaiting_payment";
  if (["review_hold", "authorized"].includes(orderState)) return "payment_authorized";
  if (["registering", "outcome_unknown", "registrar_unavailable", "paid_before_registration", "renewing_upstream"].includes(orderState)) return "registering";
  if (["registered", "capturing", "captured", "capture_failed", "renewed"].includes(orderState)) return "registered";
  if (["voided", "checkout_expired", "payment_failed", "registration_failed", "refunded", "refund_pending"].includes(orderState)) return "failed";
  return "approved";
}

export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
