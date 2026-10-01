import crypto from "node:crypto";
import { withNoUser, type PoolClient } from "@mosshatch/db";
import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import type { HandlerReq } from "../http/types.ts";
import { hit } from "../ratelimit.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { notifyUser } from "../auth/mail.ts";
import { emailActionUrl, FREEZE_TTL_MS, mintEmailActionToken } from "../auth/email-actions.ts";
import { auditUser } from "../auth/common.ts";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
/** C-07: the inter-registrar lock after a change of registrant. */
export const COR_LOCK_MS = 60 * DAY_MS;
/** The code nobody saw is replaced 24 hours after it was issued (ST-120). */
export const CODE_LIFETIME_MS = 24 * HOUR_MS;
/** Own targets from plan 4.3b (velocity fuse across all customers). Kept in step with the adapter's fuse. */
export const FUSE_LIMITS = { code_issue: 5, unlock: 10, ns_change: 20, contact_change: 10 } as const;
export type FuseClass = keyof typeof FUSE_LIMITS;

export interface DomainRow {
  id: string; user_id: string; fqdn_ascii: string; tld: string; state: string; locked: boolean; nameservers: string[];
  ds_present: boolean; dns_hosted_here: boolean; dispute_lock_state: string | null; released_at: Date | null; livemode: boolean;
  auto_renew: boolean; expires_at: Date | null; registry_created_at: Date | null;
}

const FQDN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export function normalizeFqdn(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\.$/, "");
  return FQDN_RE.test(s) ? s : null;
}

export const notFound = () => new HttpError(404, "not_found");

/** The caller's live domain by name. Unowned, released, malformed and nonexistent all end in the same 404 (one code path). */
export async function ownedDomain(c: PoolClient, userId: string, fqdn: string): Promise<DomainRow> {
  const name = normalizeFqdn(fqdn);
  const row = name ? (await c.query("select * from domains where user_id = $1 and fqdn_ascii = $2 and released_at is null", [userId, name])).rows[0] as DomainRow | undefined : undefined;
  if (!row) throw notFound();
  return row;
}

export const userIdOf = (r: HandlerReq): string => {
  if (r.principal.kind !== "session" || !r.principal.userId) throw new HttpError(401, "unauthorized");
  return r.principal.userId;
};

/** The registrar port, from the services the orders module or the boot code installed. Read on every call so a swapped port is honoured. */
export function registrarOf(ctx: Pick<AppContext, "services">): RegistrarPort {
  const s = ctx.services as { domainMgmt?: { registrar?: RegistrarPort }; orders?: { registrar?: RegistrarPort }; registrar?: RegistrarPort };
  const r = s.domainMgmt?.registrar ?? s.orders?.registrar ?? s.registrar;
  if (!r) throw new HttpError(503, "registrar_unavailable");
  return r;
}

/** Kill switch `registrar_writes_paused`: fails closed for code, unlock, nameserver, contact, DS and DNS writes. */
export async function assertWritesOpen(c: PoolClient): Promise<void> {
  let open = false;
  try { open = (await c.query("select value from flags where name = 'registrar_writes_paused'")).rows[0]?.value === false; } catch { open = false; }
  if (!open) throw new HttpError(503, "registrar_writes_paused");
}

/** Plain codes for what the registrar can say. Messages never carry record values or codes. */
const REJECTED: Record<string, [number, string]> = {
  dnssec_would_break: [409, "dnssec_would_break"], bad_nameservers: [422, "bad_nameservers"], code_by_support: [409, "code_by_support"],
  dns_readback_mismatch: [502, "dns_write_failed"], txt_too_long: [422, "txt_too_long"], unsupported_record_type: [422, "unsupported_record_type"],
  empty_value: [422, "empty_value"], not_found: [404, "not_found"], dnssec_unsupported: [409, "dnssec_unsupported"], bad_ds: [422, "bad_ds"],
  dns_not_hosted: [409, "dns_not_hosted"],
};
export function mapRegistrarError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof RegistrarError) {
    if (e.outcomeUnknown) return new HttpError(502, "outcome_unknown");
    if (e.kind === "maintenance" || e.kind === "unavailable") return new HttpError(503, "registrar_unavailable");
    if (e.kind === "rate_limited") return new HttpError(429, e.code?.startsWith("fuse_") ? "fuse_tripped" : "rate_limited");
    const m = e.code ? REJECTED[e.code] : undefined;
    if (m) return new HttpError(m[0], m[1]);
    return new HttpError(502, "registrar_rejected");
  }
  return new HttpError(500, "internal");
}

/**
 * Route-level velocity fuse across all customers (ST-115). It counts in its own committed statement, so a refused request
 * still costs a slot, and it alerts the operator when it trips. The adapter has its own fuse; this one also covers the mock.
 */
export async function takeFuse(ctx: AppContext, cls: FuseClass): Promise<void> {
  const r = await withNoUser(ctx.runtime, (c) => hit(ctx, c, `registrar:fuse:${cls}`, { bucket: `fuse.${cls}`, max: FUSE_LIMITS[cls], windowSeconds: 3600 }));
  if (r.allowed) return;
  await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "registrar.fuse_tripped", subject: cls, detail: { limit: FUSE_LIMITS[cls] } });
  throw new HttpError(429, "fuse_tripped", "fuse_tripped", { "Retry-After": String(r.retryAfterSeconds) });
}

/**
 * The notice every gated domain event sends (ST-123, threat rows 32-34): every notification address, each with a freeze link.
 * Runs inside the caller's transaction and is the last thing it does. The body never carries an authorization code.
 */
export async function notifyDomainEvent(ctx: AppContext, c: PoolClient, userId: string, n: { kind: string; domainId: string; subject: string; text: string }): Promise<void> {
  const eventId = crypto.randomUUID();
  const { token } = await mintEmailActionToken(ctx, c, { userId, purpose: "freeze", eventId: n.domainId, ttlMs: FREEZE_TTL_MS });
  const text = `${n.text}\n\nIf this was not you, freeze your account now. Nothing will be unlocked or changed, and renewals continue:\n${emailActionUrl(ctx, token)}\n\nThe link works once and expires in 72 hours.`;
  await notifyUser(ctx, c, userId, { kind: n.kind, immediate: true, dedupeKey: `${n.kind}:${eventId}`, subject: n.subject, text });
}

export const audit = auditUser;

export async function ensureSecurityRow(c: PoolClient, d: Pick<DomainRow, "id" | "user_id">): Promise<void> {
  await c.query("insert into domain_security (domain_id, user_id) values ($1,$2) on conflict (domain_id) do nothing", [d.id, d.user_id]);
}

export const sha256hex = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
export const emailHash = (email: string): string => sha256hex(email.trim().toLowerCase());

/** Whether these nameservers are the ones that serve the zone we can edit (SystemDNS). */
export const isHostedNs = (ns: readonly string[]): boolean => ns.length > 0 && ns.every((n) => n.toLowerCase().endsWith(".systemdns.com"));

/** Add whole business days (Monday to Friday). Holidays are not modelled. C-23 gives two. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return d;
}
