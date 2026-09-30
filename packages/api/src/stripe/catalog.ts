/**
 * The Stripe catalog, statement descriptor and Radar notes as config (C-39, C-40, C-44).
 *
 * C-44: registration, renewal, transfer and restore are separate Stripe Products so the accountant can give each its own
 * tax code, per state, as each state comes into scope. The Product ids are fixed strings (Stripe accepts a caller-chosen
 * `id` on Product create), so test mode and live mode use the same ids and no per-environment id has to be configured.
 * `ensureCatalog` creates them once per mode (an operator step in the live-mode parity checklist, PLAN Phase 6). The
 * amount stays a server-computed `price_data` line on the Product: prices vary by TLD and term, and a client never
 * sends a Price id (ST-97).
 */
export type StripeOperation = "register" | "renew" | "transfer" | "restore";
export const STRIPE_OPERATIONS: StripeOperation[] = ["register", "renew", "transfer", "restore"];

export interface CatalogProduct {
  id: string;
  name: string;
  /**
   * Stripe product tax code, or null while the accountant has not decided (C-44: txcd_10000000 taxes a domain like generic
   * digital goods and txcd_20030000 turns EU consumer sales origin-based, so neither is a safe default). Null leaves the
   * Product without a code and Stripe Tax falls back to the account's preset code.
   */
  taxCode: string | null;
  /** The dynamic part of the card statement descriptor for this operation. */
  descriptorSuffix: string;
}

export const CATALOG: Record<StripeOperation, CatalogProduct> = {
  register: { id: "mh_domain_register", name: "Domain registration", taxCode: null, descriptorSuffix: "REGISTER" },
  renew: { id: "mh_domain_renew", name: "Domain renewal", taxCode: null, descriptorSuffix: "RENEWAL" },
  transfer: { id: "mh_domain_transfer", name: "Domain transfer", taxCode: null, descriptorSuffix: "TRANSFER" },
  restore: { id: "mh_domain_restore", name: "Domain restore", taxCode: null, descriptorSuffix: "RESTORE" },
};

/** The order kind stored on `orders.kind` to the Stripe operation. */
export function operationForOrderKind(kind: "register" | "renew" | "transfer_in" | "restore"): StripeOperation {
  return kind === "transfer_in" ? "transfer" : kind;
}

/**
 * C-40: ONE static statement-descriptor prefix, set on the account (Dashboard, Settings > Public details; it has no
 * per-charge override), plus a per-operation suffix sent as `statement_descriptor_suffix`. The card statement then reads
 * `MOSSHATCH* RENEWAL`. A charge-level `statement_descriptor` is never sent for cards (Stripe refuses it for card charges).
 * Rules applied here (Stripe docs, UNVERIFIED against the live API): prefix 2 to 10 characters; prefix, `* ` and suffix
 * together at most 22; Latin letters, digits and spaces only (no `< > \ ' " *`); at least one letter.
 */
export const STATEMENT_DESCRIPTOR_PREFIX = "MOSSHATCH";
const FORBIDDEN = /[<>\\'"*]/;

export function descriptorProblem(prefix: string, suffix: string): string | null {
  if (prefix.length < 2 || prefix.length > 10) return "prefix_length";
  if (!suffix.trim()) return "suffix_empty";
  if (FORBIDDEN.test(prefix) || FORBIDDEN.test(suffix)) return "forbidden_character";
  if (!/^[A-Za-z0-9 .\-]+$/.test(prefix + suffix)) return "non_latin";
  if (!/[A-Za-z]/.test(suffix)) return "suffix_needs_letter";
  if (`${prefix}* ${suffix}`.length > 22) return "too_long";
  return null;
}

export function descriptorSuffix(op: StripeOperation): string {
  const s = CATALOG[op].descriptorSuffix;
  const p = descriptorProblem(STATEMENT_DESCRIPTOR_PREFIX, s);
  if (p) throw new Error(`statement descriptor for ${op}: ${p}`);
  return s;
}

/**
 * Radar rules as notes (C-40; PLAN 4.6 row 25). Radar custom rules have no API: an operator enters these in the Dashboard
 * and the live-mode parity checklist compares the Dashboard with this list. Rule syntax is UNVERIFIED until entered in
 * test mode. Nothing here evades monitoring (C-40 forbids it): the rules decline, review or step up, never split or retry.
 */
export interface RadarRuleNote { id: string; rule: string; action: "block" | "review" | "request_3ds" | "allow"; why: string }
export const RADAR_RULES: RadarRuleNote[] = [
  { id: "default-highest", rule: "Block if :risk_level: = 'highest'", action: "block", why: "Stripe default; a lost dispute costs about USD 51 on a .com order (PLAN unit economics)." },
  { id: "elevated-3ds", rule: "Request 3D Secure if :risk_level: = 'elevated'", action: "request_3ds", why: "Liability shift on fraud disputes; the code also asks for 3-D Secure on an account's first two orders and above USD 100." },
  { id: "cvc-fail", rule: "Block if :cvc_check: = 'fail'", action: "block", why: "Card testing and stolen numbers." },
  { id: "zip-fail", rule: "Block if :address_zip_check: = 'fail'", action: "block", why: "US-only launch with the billing address collected at Checkout (C-42)." },
  { id: "non-us-card", rule: "Review if :card_country: != 'US'", action: "review", why: "US-only launch; a review holds the uncaptured authorization (review_hold) instead of declining a traveller." },
  { id: "ip-velocity", rule: "Block if :total_charges_per_ip_address_hourly: > 5", action: "block", why: "Card testing (PLAN 4.6 row 25); order creation is also rate limited per user and per address." },
  { id: "card-velocity", rule: "Review if :total_charges_per_card_number_daily: > 3", action: "review", why: "A burst on one card; the account limits cap exposure in the first 30 days." },
];

/** The minimal Product surface the adapters implement for `ensureCatalog`. */
export interface ProductSpec { id: string; name: string; taxCode: string | null; metadata: Record<string, string> }

/**
 * Create (or confirm) the four Products in the Stripe mode `stripe` talks to. Idempotent: keys are per product id, and an
 * existing Product is read back. Run once per mode before the first Checkout; a Session naming a missing Product is refused.
 */
export async function ensureCatalog(stripe: { ensureProduct?(spec: ProductSpec, idem: string): Promise<{ id: string; created: boolean }> }): Promise<{ id: string; created: boolean }[]> {
  if (!stripe.ensureProduct) throw new Error("stripe adapter cannot manage products");
  const out: { id: string; created: boolean }[] = [];
  for (const op of STRIPE_OPERATIONS) {
    const p = CATALOG[op];
    out.push(await stripe.ensureProduct({ id: p.id, name: p.name, taxCode: p.taxCode, metadata: { operation: op } }, `product:${p.id}:v1`));
  }
  return out;
}
