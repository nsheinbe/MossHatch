import type { PoolClient } from "@mosshatch/db";
import { PricingError, buildQuote, type PricedQuote } from "../pricing/index.ts";
import { CHARGE_DAYS_BEFORE_EXPIRY, addDays, yearOf, type DomainRow, type Q } from "./common.ts";

export type TermState = "scheduled" | "held" | "charging" | "payment_failed" | "renewing" | "renewed" | "refunded" | "lapsed" | "skipped";
export const OPEN_TERM_STATES: TermState[] = ["scheduled", "held", "charging", "payment_failed"];

export interface TermRow {
  id: string; domainId: string; userId: string; termEnd: Date; targetExpiryYear: number; chargeAt: Date; state: TermState; heldReason: string | null;
  orderId: string | null; baselinePriceMinor: bigint; currentPriceMinor: bigint; currentWholesaleMinor: bigint; notifiedPriceMinor: bigint; priceNoticeAt: Date | null; priceCheckedAt: Date | null;
  tryCount: number; nextTryAt: Date | null; livemode: boolean;
}
const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date));
export function rowToTerm(r: Record<string, any>): TermRow {
  return {
    id: r.id, domainId: r.domain_id, userId: r.user_id, termEnd: new Date(r.term_end), targetExpiryYear: r.target_expiry_year, chargeAt: new Date(r.charge_at), state: r.state,
    heldReason: r.held_reason, orderId: r.order_id, baselinePriceMinor: BigInt(r.baseline_price_minor), currentPriceMinor: BigInt(r.current_price_minor), currentWholesaleMinor: BigInt(r.current_wholesale_minor),
    notifiedPriceMinor: BigInt(r.notified_price_minor), priceNoticeAt: date(r.price_notice_at), priceCheckedAt: date(r.price_checked_at), tryCount: r.try, nextTryAt: date(r.next_try_at), livemode: r.livemode,
  };
}
export async function loadTerm(q: Q, id: string): Promise<TermRow | null> {
  const r = await q.query("select * from renewal_terms where id = $1", [id]);
  return r.rows[0] ? rowToTerm(r.rows[0]) : null;
}

/** The renewal quote for a domain: the price table only (never the client). Null when no price exists. */
export async function renewalQuote(c: PoolClient, fqdn: string, now: Date): Promise<PricedQuote | null> {
  try { return await buildQuote(c, { fqdn, kind: "renew" }, now); }
  catch (e) { if (e instanceof PricingError) return null; throw e; }
}

/**
 * The term a domain is in: one row per (domain, expiry it extends). Created when the domain is first seen with that expiry, priced at
 * once, so the notice policy and the price-change reminder have a baseline to compare with. A renewal moves the expiry, which starts the next term.
 */
export async function ensureTerm(c: PoolClient, d: DomainRow, now: Date): Promise<TermRow | null> {
  if (!d.expiresAt || d.releasedAt || d.state === "pending") return null;
  const have = (await c.query("select * from renewal_terms where domain_id = $1 and term_end = $2", [d.id, d.expiresAt])).rows[0];
  if (have) return rowToTerm(have);
  const q = await renewalQuote(c, d.fqdn, now);
  if (!q) return null;
  const r = await c.query(
    `insert into renewal_terms (domain_id, user_id, term_end, target_expiry_year, charge_at, baseline_price_minor, current_price_minor, notified_price_minor, price_checked_at, livemode, current_wholesale_minor)
     values ($1,$2,$3,$4,$5,$6,$6,$6,$7,$8,$9) on conflict (domain_id, term_end) do nothing returning *`,
    [d.id, d.userId, d.expiresAt, yearOf(d.expiresAt), addDays(d.expiresAt, -CHARGE_DAYS_BEFORE_EXPIRY), q.subtotalMinor, now, d.livemode, q.wholesaleMinor]);
  if (r.rows[0]) {
    // An earlier term that never ran (the name was renewed somewhere else) is closed.
    await c.query("update renewal_terms set state = 'skipped', held_reason = 'renewed_elsewhere' where domain_id = $1 and term_end < $2 and state in ('scheduled','held','payment_failed')", [d.id, d.expiresAt]);
    return rowToTerm(r.rows[0]);
  }
  const again = (await c.query("select * from renewal_terms where domain_id = $1 and term_end = $2", [d.id, d.expiresAt])).rows[0];
  return again ? rowToTerm(again) : null;
}

export async function termForDomain(q: Q, d: Pick<DomainRow, "id" | "expiresAt">): Promise<TermRow | null> {
  if (!d.expiresAt) return null;
  const r = await q.query("select * from renewal_terms where domain_id = $1 and term_end = $2", [d.id, d.expiresAt]);
  return r.rows[0] ? rowToTerm(r.rows[0]) : null;
}
