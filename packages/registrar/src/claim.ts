import type { RegistrarPort, UpstreamOrder } from "./port.ts";

/**
 * The OpenSRS claim rule (plan 4.3b, "Order state machine"): OpenSRS has no idempotency key and `get_orders_by_domain`
 * filters only by domain, date, status and type, so an upstream order is ours only when ALL of these hold:
 *   1. the domain's profile username equals the `reg_username` we generated for this order;
 *   2. a `type=new` order exists whose profile username matches and whose orderDate >= sentAt - 5 s (clock skew);
 *   3. the registrant fingerprint on that order equals the one we sent.
 * A domain under another profile is never ours, whatever its dates say.
 */
export const CLAIM_SKEW_MS = 5_000;

/** Canonical registrant fingerprint: a lower-cased, trimmed join of the fields we send. Never logged. */
export function registrantFingerprint(r: { name: string; email: string; phone: string; street: string; city: string; region: string; postalCode: string; country: string }): string {
  return [r.name, r.email, r.phone, r.street, r.city, r.region, r.postalCode, r.country].map((s) => s.trim().toLowerCase().replace(/\s+/g, " ")).join("|");
}

export type ClaimResult =
  | { ours: true; state: "registered" | "pending" | "cancelled"; order: UpstreamOrder }
  | { ours: false; reason: "no_order" | "other_profile" | "stale_order" | "registrant_mismatch" | "registrant_unverifiable" };

/** An order as returned by an adapter that can also report the registrant fingerprint (the mock does; a real adapter reads contacts). */
export type UpstreamOrderWithRegistrant = UpstreamOrder & { registrantFingerprint?: string };

export async function claimRegistration(
  port: Pick<RegistrarPort, "getDomain" | "getOrdersByDomain">,
  q: { fqdn: string; regUsername: string; sentAt: Date; registrantFingerprint: string },
): Promise<ClaimResult> {
  const [dom, orders] = await Promise.all([port.getDomain(q.fqdn), port.getOrdersByDomain(q.fqdn)]);
  if (dom && dom.profileUsername && dom.profileUsername !== q.regUsername) return { ours: false, reason: "other_profile" };
  const news = (orders as UpstreamOrderWithRegistrant[]).filter((o) => o.type === "new");
  if (news.length === 0) return { ours: false, reason: "no_order" };
  const mine = news.filter((o) => o.profileUsername === q.regUsername);
  if (mine.length === 0) return { ours: false, reason: "other_profile" };
  const fresh = mine.filter((o) => o.orderDate.getTime() >= q.sentAt.getTime() - CLAIM_SKEW_MS);
  if (fresh.length === 0) return { ours: false, reason: "stale_order" };
  const withFp = fresh.filter((o) => o.registrantFingerprint !== undefined);
  if (withFp.length === 0) return { ours: false, reason: "registrant_unverifiable" };
  const match = withFp.filter((o) => o.registrantFingerprint === q.registrantFingerprint);
  if (match.length === 0) return { ours: false, reason: "registrant_mismatch" };
  // Prefer a completed order, then the newest.
  const rank = (o: UpstreamOrder) => (o.status === "completed" ? 0 : o.status === "pending" || o.status === "waiting" ? 1 : 2);
  const best = [...match].sort((a, b) => rank(a) - rank(b) || b.orderDate.getTime() - a.orderDate.getTime())[0]!;
  const state = best.status === "completed" ? "registered" : best.status === "cancelled" ? "cancelled" : "pending";
  return { ours: true, state, order: best };
}
