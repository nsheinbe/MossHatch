import crypto from "node:crypto";
import type { PoolClient } from "@mosshatch/db";
import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import { parseFqdn } from "../search/labels.ts";
import { feePerYearMinor } from "./fee.ts";
import { priceTableFor } from "./registrar.ts";

/** The default price table; quotes read the table for the extension's registrar (`priceTableFor`, pricing/registrar.ts). */
export const REGISTRAR = "opensrs";
export const QUOTE_TTL_MS = 30 * 60_000;
export const DEFAULT_TAX_CEILING_BPS = 1000;

export type QuoteKind = "register" | "renew" | "transfer" | "restore";
export type PricingErrorCode = "invalid_fqdn" | "unexpected_field" | "unsupported_tld" | "invalid_term" | "no_price" | "premium_refused" | "price_mismatch";
export class PricingError extends Error {
  constructor(public code: PricingErrorCode) { super(code); this.name = "PricingError"; }
}

/** The only things a client may send. Anything else (a price, an amount, a total) is refused, never ignored. */
export interface QuoteInput { fqdn: string; years?: number; kind?: QuoteKind }
const ALLOWED_KEYS = new Set(["fqdn", "years", "kind"]);

export interface PricedQuote {
  fqdn: string;
  tld: string;
  kind: QuoteKind;
  years: number;
  /** The effective-dated wholesale row this quote was priced from; pinned so a later price change cannot alter an open order. */
  wholesalePriceId: string;
  wholesalePerYearMinor: bigint;
  wholesaleMinor: bigint;
  /**
   * Renewal floor (Mosshatch charges the same price every year): when the upstream's renewal price is above this operation's price
   * (Openprovider non-member .com: create 11.98, renew 16.98), the difference is charged from the first year so a renewal is never sold
   * below cost and the price never jumps. Zero when the renewal costs no more. Not part of `wholesaleMinor`, which stays the upstream
   * charge for this operation (the D-031 price guard and the funding gates compare it with the registrar).
   */
  renewalLevelMinor: bigint;
  feePerYearMinor: bigint;
  feeMinor: bigint;
  subtotalMinor: bigint;
  /** Upper bound on tax Checkout may add: taxCeilingBps of the subtotal, rounded up. It is a ceiling, not a tax rate or a tax estimate. */
  taxCeilingMinor: bigint;
  taxCeilingBps: number;
  /** Highest amount the customer can be charged: subtotal plus tax ceiling. */
  totalMinor: bigint;
  currency: "usd";
  quotedAt: Date;
  expiresAt: Date;
  quoteHash: string;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

interface Policy { tld: string; minTerm: number; maxTerm: number }
export async function loadPolicy(c: PoolClient, tld: string): Promise<Policy | null> {
  const r = await c.query("select min_term_years, max_term_years from tld_policy where registrar = $1 and tld = $2", [priceTableFor(tld), tld]);
  const row = r.rows[0];
  return row ? { tld, minTerm: row.min_term_years as number, maxTerm: row.max_term_years as number } : null;
}

export async function taxCeilingBps(c: PoolClient): Promise<number> {
  const r = await c.query("select value from flags where name = 'pricing.tax_ceiling_bps'");
  const v = r.rows[0]?.value;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10000 ? v : DEFAULT_TAX_CEILING_BPS;
}

/**
 * Pure amount arithmetic shared by quotes and by the search price chips, so both always agree.
 * `renewPerYearMinor` (the extension's renewal price) sets the renewal floor: the customer's per-year price is never below
 * max(this operation, renewal) + fee, so the first year and every renewal cost the same and no renewal is sold below cost.
 * The D-003 fee level is read from the higher of the standard and the renewal price.
 */
export function computeAmounts(p: { wholesalePerYearMinor: bigint; standardWholesalePerYearMinor: bigint; renewPerYearMinor?: bigint; years: number; taxCeilingBps: number }) {
  const y = BigInt(p.years);
  const wholesaleMinor = p.wholesalePerYearMinor * y;
  const renew = p.renewPerYearMinor ?? 0n;
  const levelPerYear = renew > p.wholesalePerYearMinor ? renew - p.wholesalePerYearMinor : 0n;
  const renewalLevelMinor = levelPerYear * y;
  const fee = feePerYearMinor(renew > p.standardWholesalePerYearMinor ? renew : p.standardWholesalePerYearMinor);
  const feeMinor = fee * y;
  const subtotalMinor = wholesaleMinor + renewalLevelMinor + feeMinor;
  const taxCeilingMinor = (subtotalMinor * BigInt(p.taxCeilingBps) + 9999n) / 10000n;
  return { wholesaleMinor, renewalLevelMinor, feePerYearMinor: fee, feeMinor, subtotalMinor, taxCeilingMinor, totalMinor: subtotalMinor + taxCeilingMinor };
}

/** Effective price rows on `now`'s UTC date for a set of (tld, kind), each extension from its registrar's table. One query. */
export async function loadPriceRows(c: PoolClient, tlds: string[], kinds: string[], now: Date): Promise<Map<string, { id: string; amount: bigint }>> {
  const r = await c.query(
    `select distinct on (w.tld, w.kind) w.id, w.tld, w.kind, w.amount_minor from wholesale_prices w
     join unnest($1::text[], $2::text[]) as t(tld, registrar) on t.tld = w.tld and t.registrar = w.registrar
     where w.kind = any($3) and w.effective_from <= $4::date
     order by w.tld, w.kind, w.effective_from desc`,
    [tlds, tlds.map(priceTableFor), kinds, dayOf(now)],
  );
  return new Map(r.rows.map((x) => [`${x.tld}:${x.kind}`, { id: x.id as string, amount: BigInt(x.amount_minor) }]));
}

export function hashQuote(q: Omit<PricedQuote, "quoteHash">): string {
  // The renewal floor joins the hash only when it is charged, so quotes priced before it existed still verify.
  const parts = [q.fqdn, q.kind, q.years, q.wholesalePriceId, q.wholesaleMinor, ...(q.renewalLevelMinor > 0n ? [`level:${q.renewalLevelMinor}`] : []), q.feeMinor, q.subtotalMinor, q.taxCeilingBps, q.taxCeilingMinor, q.totalMinor, q.currency, q.quotedAt.toISOString(), q.expiresAt.toISOString()];
  return crypto.createHash("sha256").update(parts.map(String).join("\n")).digest("hex");
}

/**
 * Build a quote from the database only. The client contributes `fqdn` and `years` and nothing else; the price comes from the
 * effective-dated `wholesale_prices` row pinned into the quote. With `opts.registrar` the D-031 price guard also runs: a
 * registry-premium quote, or a registrar quote that differs from our standard price, is refused before payment.
 */
export async function buildQuote(c: PoolClient, input: QuoteInput, now: Date, opts: { registrar?: Pick<RegistrarPort, "quote"> } = {}): Promise<PricedQuote> {
  for (const k of Object.keys(input)) if (!ALLOWED_KEYS.has(k)) throw new PricingError("unexpected_field");
  const parsed = typeof input.fqdn === "string" ? parseFqdn(input.fqdn) : null;
  if (!parsed) throw new PricingError("invalid_fqdn");
  const kind: QuoteKind = input.kind ?? "register";
  if (!["register", "renew", "transfer", "restore"].includes(kind)) throw new PricingError("invalid_term");
  const policy = await loadPolicy(c, parsed.tld);
  if (!policy) throw new PricingError("unsupported_tld");
  let years = input.years === undefined ? policy.minTerm : input.years;
  if (kind === "restore") { if (input.years !== undefined && input.years !== 1) throw new PricingError("invalid_term"); years = 1; }
  // A restore is one transaction whatever the extension's minimum term (.ai's two-year minimum applies to registration and renewal only).
  if (!Number.isInteger(years) || (kind !== "restore" && years < policy.minTerm) || years > policy.maxTerm) throw new PricingError("invalid_term");

  const rows = await loadPriceRows(c, [parsed.tld], [kind, "register", "renew"], now);
  const row = rows.get(`${parsed.tld}:${kind}`);
  const standard = rows.get(`${parsed.tld}:register`);
  if (!row || !standard) throw new PricingError("no_price");
  const bps = await taxCeilingBps(c);
  const fqdn = `${parsed.label}.${parsed.tld}`;
  // A restore is a one-off fee, not a year of the name: no renewal floor.
  const renew = kind === "restore" ? undefined : rows.get(`${parsed.tld}:renew`)?.amount;
  const amounts = computeAmounts({ wholesalePerYearMinor: row.amount, standardWholesalePerYearMinor: standard.amount, ...(renew !== undefined ? { renewPerYearMinor: renew } : {}), years, taxCeilingBps: bps });

  if (opts.registrar && (kind === "register" || kind === "renew")) {
    let rq;
    try { rq = await opts.registrar.quote(fqdn, years, kind); } catch (e) {
      if (e instanceof RegistrarError && e.code === "premium_refused") throw new PricingError("premium_refused");
      throw e;
    }
    if (rq.isRegistryPremium) throw new PricingError("premium_refused");
    if (rq.wholesale.minor !== amounts.wholesaleMinor) throw new PricingError("price_mismatch");
    // The renewal floor is only honest if our renewal row is not below the registrar's renewal price: a higher upstream renewal refuses too.
    if (renew !== undefined && rq.renewalWholesale && rq.renewalWholesale.minor > renew * BigInt(years)) throw new PricingError("price_mismatch");
  }

  const base = {
    fqdn, tld: parsed.tld, kind, years, wholesalePriceId: row.id, wholesalePerYearMinor: row.amount, ...amounts,
    taxCeilingBps: bps, currency: "usd" as const, quotedAt: now, expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
  };
  return { ...base, quoteHash: hashQuote(base) };
}

/** JSON form stored in `orders.quote` and returned by the API: bigints as decimal strings. */
export function quoteToJson(q: PricedQuote) {
  return {
    fqdn: q.fqdn, tld: q.tld, kind: q.kind, years: q.years, wholesale_price_id: q.wholesalePriceId,
    wholesale_per_year_minor: q.wholesalePerYearMinor.toString(), wholesale_minor: q.wholesaleMinor.toString(),
    // What the customer is shown as the registrar price: this operation's upstream price plus the renewal floor (equal to the renewal price when that is higher).
    renewal_level_minor: q.renewalLevelMinor.toString(), registrar_price_minor: (q.wholesaleMinor + q.renewalLevelMinor).toString(),
    fee_per_year_minor: q.feePerYearMinor.toString(), fee_minor: q.feeMinor.toString(), subtotal_minor: q.subtotalMinor.toString(),
    tax_ceiling_bps: q.taxCeilingBps, tax_ceiling_minor: q.taxCeilingMinor.toString(), total_minor: q.totalMinor.toString(), currency: q.currency,
    quoted_at: q.quotedAt.toISOString(), expires_at: q.expiresAt.toISOString(), quote_hash: q.quoteHash,
  };
}
export type QuoteJson = ReturnType<typeof quoteToJson>;

/** A stored quote can be paid only until it expires, and only if its hash still verifies. */
export function verifyQuoteJson(j: QuoteJson, now: Date): { ok: boolean; reason?: "expired" | "hash" } {
  const q = {
    fqdn: j.fqdn, tld: j.tld, kind: j.kind as QuoteKind, years: j.years, wholesalePriceId: j.wholesale_price_id, wholesalePerYearMinor: BigInt(j.wholesale_per_year_minor),
    wholesaleMinor: BigInt(j.wholesale_minor), renewalLevelMinor: BigInt(j.renewal_level_minor ?? "0"), feePerYearMinor: BigInt(j.fee_per_year_minor), feeMinor: BigInt(j.fee_minor), subtotalMinor: BigInt(j.subtotal_minor),
    taxCeilingMinor: BigInt(j.tax_ceiling_minor), taxCeilingBps: j.tax_ceiling_bps, totalMinor: BigInt(j.total_minor), currency: j.currency, quotedAt: new Date(j.quoted_at), expiresAt: new Date(j.expires_at),
  };
  if (hashQuote(q) !== j.quote_hash) return { ok: false, reason: "hash" };
  if (new Date(j.expires_at) <= now) return { ok: false, reason: "expired" };
  return { ok: true };
}
