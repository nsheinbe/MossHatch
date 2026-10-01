import type { Pool, PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import type { HandlerReq } from "../http/types.ts";
import { HttpError } from "../http/router.ts";

export type Q = Pick<Pool | PoolClient, "query">;

export const DAY_MS = 86_400_000;
/**
 * The cooling-off after a closure request (own target). A passkey sign-in before it ends cancels the closure. 14 days leaves time to
 * notice an unwanted closure and to transfer names out, and keeps registry deletion well inside C-28's 45 days.
 */
export const COOLING_OFF_MS = 14 * DAY_MS;
/** An export can be downloaded for 7 days after it is ready (design section 4). */
export const EXPORT_TTL_MS = 7 * DAY_MS;
/** Target: ready within 24 hours; the deadline after which a stuck request is failed and an operator told (design: within 30 days). */
export const EXPORT_BUILD_DEADLINE_MS = 24 * 3_600_000;
/** A one-time download ticket lives 5 minutes. */
export const TICKET_TTL_MS = 5 * 60_000;
/** At most this many export requests per rolling 30 days, and one in flight (own targets). */
export const EXPORTS_PER_30_DAYS = 3;
export const TICKETS_PER_HOUR = { bucket: "account.export.ticket", max: 10, windowSeconds: 3600 } as const;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const notFound = () => new HttpError(404, "not_found");

/** Orders whose money or registration is still moving. `draft` renewals never charged (a release voids them) and do not count. */
export const OPEN_ORDER_STATES = [
  "checkout_open", "review_hold", "authorized", "registering", "registered", "capturing", "capture_failed", "registrar_unavailable",
  "outcome_unknown", "canceling", "refund_pending", "refund_failed", "dispute_open", "paid_before_registration", "renewing_upstream",
] as const;
export const OPEN_TRANSFER_IN_STATES = ["awaiting_payment", "submitting", "submitted", "pending_owner_approval", "pending_registry"] as const;

export function sessionUser(req: HandlerReq): string {
  const p = req.principal;
  if (p.kind !== "session" || !p.userId) throw new HttpError(401, "unauthorized");
  return p.userId;
}

export type Blocker = "open_order" | "open_transfer_in" | "open_dispute" | "open_refund" | "live_domain" | "transfer_out" | "legal_hold";

/**
 * What keeps an account from moving on. `request` is checked before a closure is accepted (money or a registration in flight could add a
 * name after the person left); `close` is checked before `closed` (design: no open order, refund or dispute, every name gone).
 */
export async function blockersOf(q: Q, userId: string, stage: "request" | "close"): Promise<Blocker[]> {
  const out: Blocker[] = [];
  const orders = (await q.query("select state from orders where user_id = $1 and state = any($2::text[])", [userId, OPEN_ORDER_STATES])).rows.map((r) => r.state as string);
  if (orders.some((s) => s !== "refund_pending" && s !== "refund_failed" && s !== "dispute_open")) out.push("open_order");
  if ((await q.query("select 1 from transfers_in where user_id = $1 and state = any($2::text[]) limit 1", [userId, OPEN_TRANSFER_IN_STATES])).rowCount) out.push("open_transfer_in");
  if (stage === "close") {
    if (orders.some((s) => s === "refund_pending" || s === "refund_failed")) out.push("open_refund");
    const dispute = await q.query("select 1 from payments where user_id = $1 and dispute_state = 'open' limit 1", [userId]);
    if ((dispute.rowCount ?? 0) > 0 || orders.includes("dispute_open")) out.push("open_dispute");
    const live = (await q.query("select id, transfer_away from domains where user_id = $1 and released_at is null", [userId])).rows;
    if (live.length) out.push("live_domain");
    const away = await q.query("select 1 from domain_transfers_away t join domains d on d.id = t.domain_id where t.user_id = $1 and d.released_at is null and t.state in ('open','stopped') limit 1", [userId]);
    if ((away.rowCount ?? 0) > 0 || live.some((d) => d.transfer_away)) out.push("transfer_out");
  }
  return out;
}

/** Names still in the account (not released), oldest first. */
export async function liveDomains(q: Q, userId: string): Promise<{ id: string; fqdn: string; transferAway: boolean }[]> {
  const r = await q.query("select id, fqdn_ascii, transfer_away from domains where user_id = $1 and released_at is null order by created_at, id", [userId]);
  return r.rows.map((x) => ({ id: x.id as string, fqdn: x.fqdn_ascii as string, transferAway: !!x.transfer_away }));
}

/**
 * Rows the law or an operator holds (C-19): a legal hold on any of the person's consents, notices, mandates, transfer log rows or
 * audit rows, or on the closure itself. While one exists the identifying rows are kept (the design: erase "when there is no legal hold").
 */
export async function legalHoldOf(q: Q, userId: string): Promise<boolean> {
  const r = await q.query(
    `select exists (select 1 from consents where user_id = $1 and legal_hold)
         or exists (select 1 from notices where user_id = $1 and legal_hold)
         or exists (select 1 from renewal_mandates where user_id = $1 and legal_hold)
         or exists (select 1 from audit_log where chain_id = $1 and legal_hold)
         or exists (select 1 from account_closures where user_id = $1 and legal_hold and state <> 'cancelled')
         or exists (select 1 from transfer_log where user_id = $1 and legal_hold) as held`,
    [userId]);
  return !!r.rows[0]?.held;
}

/** Verified notification addresses, resolved at send time (never stored with the mail). */
export async function verifiedAddresses(q: Q, userId: string): Promise<{ id: string; address: string }[]> {
  const r = await q.query("select id, address::text as address from notification_addresses where user_id = $1 and removed_at is null and verified_at is not null order by created_at, id", [userId]);
  return r.rows as { id: string; address: string }[];
}

export type Ctx = AppContext;
export const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
