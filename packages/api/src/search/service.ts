import type { PoolClient } from "@mosshatch/db";
import { withNoUser } from "@mosshatch/db";
import type { Availability, AvailabilityKind, RegistrarPort } from "@mosshatch/registrar/port";
import { RegistrarError } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { reserveLookups } from "./budget.ts";
import { computeAmounts, loadPriceRows, REGISTRAR, taxCeilingBps } from "../pricing/quote.ts";
import type { LaunchTld } from "./labels.ts";

export const CACHE_TTL_MS = 60_000;

/** Result cache keyed by fqdn, in memory only (search text is never written to a durable store). */
export class SearchCache {
  private m = new Map<string, { a: Availability; exp: number }>();
  private flights = new Map<string, Promise<Availability | null>>();
  constructor(private max = 20000) {}
  get(fqdn: string, now: number): Availability | undefined {
    const e = this.m.get(fqdn);
    if (!e) return undefined;
    if (e.exp <= now) { this.m.delete(fqdn); return undefined; }
    return e.a;
  }
  set(fqdn: string, a: Availability, now: number) {
    if (this.m.size >= this.max) { const first = this.m.keys().next(); if (!first.done) this.m.delete(first.value); }
    this.m.set(fqdn, { a, exp: now + CACHE_TTL_MS });
  }
  flight(fqdn: string): Promise<Availability | null> | undefined { return this.flights.get(fqdn); }
  setFlight(fqdn: string, p: Promise<Availability | null>) { this.flights.set(fqdn, p); void p.finally(() => this.flights.delete(fqdn)); }
  get size() { return this.m.size; }
}

export interface SearchResultItem { fqdn: string; tld: string; kind: AvailabilityKind; source: "live" | "sample"; unconfirmed: boolean }

/**
 * One label against several extensions. Cache first; then singleflight; then a budget reservation for the remaining misses. When the
 * search pool is spent (or the registrar errors) the item is `unknown` and `unconfirmed`: never an invented "available".
 */
export async function searchAvailability(
  ctx: Pick<AppContext, "runtime" | "clock">, deps: { registrar: RegistrarPort; cache: SearchCache }, label: string, tlds: readonly LaunchTld[],
): Promise<{ items: SearchResultItem[]; degraded: boolean }> {
  const now = ctx.clock.now().getTime();
  const items = new Map<string, SearchResultItem>();
  const waits: { fqdn: string; tld: string; p: Promise<Availability | null> }[] = [];
  const misses: { fqdn: string; tld: string }[] = [];
  for (const tld of tlds) {
    const fqdn = `${label}.${tld}`;
    const hit = deps.cache.get(fqdn, now);
    if (hit) { items.set(fqdn, { fqdn, tld, kind: hit.kind, source: hit.source, unconfirmed: false }); continue; }
    const fl = deps.cache.flight(fqdn);
    if (fl) { waits.push({ fqdn, tld, p: fl }); continue; }
    misses.push({ fqdn, tld });
  }
  let degraded = false;
  if (misses.length) {
    // Register the flights before any await, so a concurrent request for the same name joins instead of looking it up again.
    const leads = misses.map((m) => {
      let resolve!: (a: Availability | null) => void;
      const p = new Promise<Availability | null>((r) => { resolve = r; });
      deps.cache.setFlight(m.fqdn, p);
      waits.push({ fqdn: m.fqdn, tld: m.tld, p });
      return { ...m, resolve };
    });
    let ok = false;
    try { ok = await withNoUser(ctx.runtime, (c) => reserveLookups(c, "search", misses.length, ctx.clock.now())); }
    catch (e) { for (const l of leads) l.resolve(null); throw e; }
    if (!ok) for (const l of leads) l.resolve(null);
    else {
      await Promise.all(leads.map((l) => deps.registrar.checkAvailability(l.fqdn).then(
        (a) => { if (a.kind !== "unknown") deps.cache.set(l.fqdn, a, ctx.clock.now().getTime()); l.resolve(a); },
        (e) => { l.resolve(null); if (!(e instanceof RegistrarError)) throw e; },
      )));
    }
  }
  for (const w of waits) {
    const a = await w.p;
    if (!a || a.kind === "unknown") { degraded = true; items.set(w.fqdn, { fqdn: w.fqdn, tld: w.tld, kind: "unknown", source: a?.source ?? "live", unconfirmed: true }); }
    else items.set(w.fqdn, { fqdn: w.fqdn, tld: w.tld, kind: a.kind, source: a.source, unconfirmed: false });
  }
  return { items: tlds.map((t) => items.get(`${label}.${t}`)!), degraded };
}

export type CheckoutPurpose = "checkout" | "renewal" | "agent";
export class LookupBudgetError extends Error { constructor() { super("lookup_budget_exhausted"); this.name = "LookupBudgetError"; } }

/**
 * The authoritative check at checkout, renewal or agent purchase: `noCache: true`, taken from the 30% checkout pool, so search
 * traffic (which draws only from the 70% search pool) cannot starve it. Never reads the search cache.
 */
export async function checkoutAvailability(ctx: Pick<AppContext, "clock">, c: PoolClient, registrar: RegistrarPort, fqdn: string, _purpose: CheckoutPurpose = "checkout"): Promise<Availability> {
  if (!(await reserveLookups(c, "checkout", 1, ctx.clock.now()))) throw new LookupBudgetError();
  return registrar.checkAvailability(fqdn, { noCache: true });
}

/** Price chips: the first-order subtotal per extension at the current effective wholesale (same arithmetic as buildQuote). */
export async function chipPrices(c: PoolClient, tlds: readonly string[], now: Date): Promise<Map<string, { years: number; subtotalMinor: bigint }>> {
  const rows = await loadPriceRows(c, [...tlds], ["register"], now);
  const bps = await taxCeilingBps(c);
  const out = new Map<string, { years: number; subtotalMinor: bigint }>();
  const pol = new Map((await c.query("select tld, min_term_years from tld_policy where registrar = $1 and tld = any($2)", [REGISTRAR, [...tlds]])).rows.map((r) => [r.tld as string, r.min_term_years as number]));
  for (const tld of tlds) {
    const row = rows.get(`${tld}:register`); const minTerm = pol.get(tld);
    if (!row || minTerm === undefined) continue;
    const a = computeAmounts({ wholesalePerYearMinor: row.amount, standardWholesalePerYearMinor: row.amount, years: minTerm, taxCeilingBps: bps });
    out.set(tld, { years: minTerm, subtotalMinor: a.subtotalMinor });
  }
  return out;
}
