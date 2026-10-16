import type { PoolClient } from "pg";
import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import { buildQuote, PricingError } from "../pricing/quote.ts";
import { floorMinor } from "../domains/gate.ts";
import { CATALOG } from "../stripe/catalog.ts";
import { STRIPE_API_VERSION } from "../stripe/real.ts";

/**
 * The read-only live preflight (docs/GO-LIVE.md step 8a): what the first real purchase would trip over, found before a card is charged.
 * Nothing here creates, changes or pays for anything. The registrar side is reached through the same signed RPC the shop uses, and every
 * price is checked with the shop's own quote and price guard (`buildQuote` with the registrar), so a pass means the hatch sheet will not
 * answer `price_not_standard` for that extension today. Prints codes and numbers only, never a secret.
 */
export interface PreflightCheck { area: "registrar" | "prices" | "stripe"; name: string; ok: boolean; detail: string }

const usd = (minor: bigint) => `USD ${(Number(minor) / 100).toFixed(2)}`;
const code = (e: unknown) => e instanceof RegistrarError ? `${e.kind}:${e.code ?? "registrar_error"}` : e instanceof PricingError ? e.code : (e as Error)?.name ?? "error";

/** A name nobody will have registered, so the registrar quotes the standard price. Availability does not matter to a price call. */
export const probeName = (tld: string) => `mosshatch-preflight-probe.${tld}`;

export async function registrarPreflight(c: PoolClient, registrar: RegistrarPort, now: Date): Promise<PreflightCheck[]> {
  const out: PreflightCheck[] = [];
  try {
    const h = await registrar.health();
    out.push({ area: "registrar", name: "health", ok: h.status === "ok", detail: h.status });
  } catch (e) { out.push({ area: "registrar", name: "health", ok: false, detail: code(e) }); }

  const tlds = (await c.query("select distinct tld from wholesale_prices where registrar = 'openprovider' and effective_from <= $1::date order by tld", [now.toISOString().slice(0, 10)])).rows.map((r) => r.tld as string);
  if (!tlds.length) out.push({ area: "prices", name: "price rows", ok: false, detail: "no openprovider rows in wholesale_prices (run scripts/go-live-db.mjs)" });
  let cheapest: bigint | null = null;
  for (const tld of tlds) {
    try {
      const q = await buildQuote(c, { fqdn: probeName(tld) }, now, { registrar });
      out.push({ area: "prices", name: `.${tld}`, ok: true, detail: `${q.years}y upstream ${usd(q.wholesaleMinor)} matches; customer pays ${usd(q.subtotalMinor)} before tax` });
      if (cheapest === null || q.wholesaleMinor < cheapest) cheapest = q.wholesaleMinor;
    } catch (e) {
      const hint = e instanceof PricingError && e.code === "price_mismatch" ? " (the live price differs from wholesale_prices: add a dated row, GO-LIVE step 9)" : "";
      out.push({ area: "prices", name: `.${tld}`, ok: false, detail: code(e) + hint });
    }
  }

  try {
    const b = await registrar.getBalance();
    if (b.available.currency.toUpperCase() !== "USD") out.push({ area: "registrar", name: "balance", ok: false, detail: `account currency ${b.available.currency}, the shop sells in USD only` });
    else {
      const floor = await floorMinor(c);
      const need = floor + (cheapest ?? 0n);
      out.push({ area: "registrar", name: "balance", ok: b.available.minor >= need, detail: `available ${usd(b.available.minor)} (held ${usd(b.held.minor)}); the sell gate needs ${usd(need)} for the cheapest name (floor ${usd(floor)})` });
    }
  } catch (e) { out.push({ area: "registrar", name: "balance", ok: false, detail: code(e) }); }
  return out;
}

/** One HTTP call to the Stripe API with the key under test. Tests pass a fake. */
export type StripeHttp = (method: "GET" | "POST", path: string) => Promise<{ status: number; body: unknown }>;

export function stripeHttp(key: string, fetchImpl: typeof fetch = fetch): StripeHttp {
  return async (method, path) => {
    const res = await fetchImpl(`https://api.stripe.com${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${key}`, "stripe-version": STRIPE_API_VERSION, ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(method === "POST" ? { body: "" } : {}),
    });
    let body: unknown = null; try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
  };
}

/**
 * What the restricted key may do (GO-LIVE step 5.3), probed on ids that cannot exist: a granted permission answers 404 resource_missing,
 * a missing one 403 (or 401 naming permissions). A POST to an id that does not exist changes nothing. UNVERIFIED against the live API:
 * that Stripe checks the key's permission before it looks the object up; an answer that is neither is reported as unknown, not as a pass.
 */
export const STRIPE_PROBES: { name: string; method: "GET" | "POST"; path: string }[] = [
  { name: "Customers write", method: "POST", path: "/v1/customers/cus_mhpreflightmissing" },
  { name: "Checkout Sessions write", method: "POST", path: "/v1/checkout/sessions/cs_mhpreflightmissing/expire" },
  { name: "Checkout Sessions read", method: "GET", path: "/v1/checkout/sessions/cs_mhpreflightmissing" },
  { name: "PaymentIntents write", method: "POST", path: "/v1/payment_intents/pi_mhpreflightmissing" },
  { name: "PaymentIntents read", method: "GET", path: "/v1/payment_intents/pi_mhpreflightmissing" },
  { name: "PaymentMethods write", method: "POST", path: "/v1/payment_methods/pm_mhpreflightmissing" },
  { name: "Refunds write", method: "POST", path: "/v1/refunds/re_mhpreflightmissing" },
  { name: "Refunds read", method: "GET", path: "/v1/refunds/re_mhpreflightmissing" },
  { name: "Products write", method: "POST", path: "/v1/products/mh_preflight_missing" },
  { name: "Charges read", method: "GET", path: "/v1/charges/ch_mhpreflightmissing" },
  { name: "Radar reviews read", method: "GET", path: "/v1/reviews/prv_mhpreflightmissing" },
];

const errOf = (body: unknown) => ((body as { error?: { code?: string; type?: string; message?: string } } | null)?.error) ?? {};

export async function stripePreflight(http: StripeHttp, key: string): Promise<PreflightCheck[]> {
  const out: PreflightCheck[] = [];
  const live = /^(sk|rk)_live_/.test(key);
  out.push({ area: "stripe", name: "key", ok: /^rk_live_/.test(key), detail: /^rk_live_/.test(key) ? "restricted live key" : live ? "a full secret key: use the restricted key (GO-LIVE step 5.3)" : "not a live key" });
  for (const p of STRIPE_PROBES) {
    try {
      const r = await http(p.method, p.path); const e = errOf(r.body);
      const denied = r.status === 403 || (r.status === 401 && /permission/i.test(e.message ?? ""));
      if (r.status === 404 && e.code === "resource_missing") out.push({ area: "stripe", name: p.name, ok: true, detail: "granted" });
      else if (denied) out.push({ area: "stripe", name: p.name, ok: false, detail: "missing: add it to the restricted key" });
      else out.push({ area: "stripe", name: p.name, ok: false, detail: `unknown (HTTP ${r.status}${e.code ? ` ${e.code}` : ""})` });
    } catch (e) { out.push({ area: "stripe", name: p.name, ok: false, detail: `unreachable (${(e as Error).name})` }); }
  }
  // The catalog (scripts/stripe-catalog.mjs): Checkout refuses a Session naming a missing Product.
  for (const prod of Object.values(CATALOG)) {
    try {
      const r = await http("GET", `/v1/products/${prod.id}`);
      const active = (r.body as { active?: boolean } | null)?.active;
      out.push({ area: "stripe", name: `product ${prod.id}`, ok: r.status === 200 && active === true, detail: r.status === 200 ? (active ? "present" : "archived") : r.status === 404 ? "missing: run scripts/stripe-catalog.mjs" : `HTTP ${r.status}` });
    } catch (e) { out.push({ area: "stripe", name: `product ${prod.id}`, ok: false, detail: `unreachable (${(e as Error).name})` }); }
  }
  return out;
}

export function formatPreflight(checks: PreflightCheck[]): { text: string; ok: boolean } {
  const ok = checks.length > 0 && checks.every((c) => c.ok);
  const lines = checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.area.padEnd(9)} ${c.name.padEnd(26)} ${c.detail}`);
  lines.push(!checks.length ? "preflight: nothing was checked" : ok ? "preflight passed: nothing above stops the first purchase" : `preflight: ${checks.filter((c) => !c.ok).length} problem(s); fix them before the first purchase`);
  return { text: lines.join("\n"), ok };
}
