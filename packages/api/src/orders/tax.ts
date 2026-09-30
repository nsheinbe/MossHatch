import type { PoolClient } from "@mosshatch/db";
import { HttpError } from "../http/router.ts";

/**
 * C-42 tax-region gate. The tax location is the billing address (Stripe Tax uses the address typed at Checkout), so the
 * gate runs twice, both server-side:
 * 1. before a Checkout Session is created: refused when no region is open at all, or when the person's last known billing
 *    region (their latest payment) is not enabled;
 * 2. when the payment is authorized: the address Checkout collected must be in an enabled `tax_regions` row, else the order
 *    is voided before capture (`region_not_enabled`) and the hold is released, so nothing is charged.
 * Launch is US-only (0750 enables the 50 states and DC); everything else, including US territories, is refused with a
 * waitlist message. Region codes are ISO 3166-2 ("US-CA"); a non-US address is its country code ("GB").
 */
export const REGION_NOT_AVAILABLE_MESSAGE = "We sell only to billing addresses in the United States for now. Nothing was charged. Join the waitlist and we will email you when we open in your region.";
export const REGIONS_CLOSED_MESSAGE = "New orders are paused for a short while. Nothing was charged.";

type Q = Pick<PoolClient, "query">;

export function billingRegion(addr: { country: string | null; state: string | null } | null | undefined): string | null {
  const country = addr?.country?.trim().toUpperCase();
  if (!country || !/^[A-Z]{2}$/.test(country)) return null;
  if (country !== "US") return country;
  const st = addr?.state?.trim().toUpperCase();
  return st && /^[A-Z]{2}$/.test(st) ? `US-${st}` : null;
}

export async function regionEnabled(q: Q, region: string | null): Promise<boolean> {
  if (!region) return false;
  return (await q.query("select 1 from tax_regions where state = $1 and enabled", [region])).rowCount === 1;
}

/** Gate 1, inside the order-creation transaction (runtime role, RLS on payments). Throws before any Stripe call. */
export async function preCheckoutRegionGate(c: Q, userId: string): Promise<void> {
  if ((await c.query("select 1 from tax_regions where enabled limit 1")).rowCount === 0) throw new HttpError(503, "orders_paused", REGIONS_CLOSED_MESSAGE);
  const last = (await c.query(
    "select billing_country, billing_state from payments where user_id = $1 and (billing_state is not null or billing_country is not null) order by created_at desc limit 1", [userId])).rows[0];
  if (!last) return;
  const region = last.billing_state ?? billingRegion({ country: last.billing_country, state: null });
  if (!(await regionEnabled(c, region))) throw new HttpError(422, "region_not_available", REGION_NOT_AVAILABLE_MESSAGE);
}
