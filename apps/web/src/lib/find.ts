import { formatUsd, feePerYear, usd, splitDomain } from "@mosshatch/core";
import { EXTENSIONS, MockRegistrar, SAMPLE_WHOLESALE_CENTS } from "@mosshatch/registrar";
import type { Result } from "../store";
import { api } from "./api";

const registrar = new MockRegistrar();

/** Lowercase letters, digits and hyphens; 1 to 63 characters; no leading or trailing hyphen. */
export function parseQuery(raw: string): { label: string; tld?: string } | null {
  let v = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\s+/g, "");
  const { label, tld } = splitDomain(v);
  v = label.replace(/[^a-z0-9-]/g, "");
  v = v.replace(/^-+/, "").replace(/-+$/, "").slice(0, 63);
  if (!v) return null;
  return { label: v, tld: (EXTENSIONS as readonly string[]).includes(tld) ? tld : undefined };
}

export async function search(raw: string): Promise<{ results: Result[]; alternatives: string[] } | null> {
  const q = parseQuery(raw);
  if (!q) return null;
  const order = q.tld ? [q.tld, ...EXTENSIONS.filter((e) => e !== q.tld)] : [...EXTENSIONS];
  const quotes = await Promise.all(order.map((tld) => registrar.quote(`${q.label}.${tld}`)));
  const results: Result[] = quotes.map((qt) => {
    const tld = splitDomain(qt.domain).tld;
    const avail = qt.availability === "available";
    const w = SAMPLE_WHOLESALE_CENTS[tld] ?? 0;
    return {
      domain: qt.domain, tld, available: avail, sample: true,
      price: avail && qt.firstYear ? formatUsd(qt.firstYear) : undefined,
      years: qt.years,
      wholesale: avail ? formatUsd(usd(w * qt.years)) : undefined,
      fee: avail ? formatUsd(usd(feePerYear(usd(w)).cents * qt.years)) : undefined,
    };
  });
  const primary = results[0]!;
  const alternatives = primary.available ? [] : await registrar.suggestAlternatives(q.label, 3);
  return { results, alternatives };
}

export function staticPrices(): { tld: string; price: string; years: number }[] {
  return EXTENSIONS.map((tld) => {
    const w = SAMPLE_WHOLESALE_CENTS[tld]!;
    const years = tld === "ai" ? 2 : 1;
    return { tld, years, price: formatUsd(usd((w + feePerYear(usd(w)).cents) * years)) };
  });
}

interface ServerSearch { results: { fqdn: string; tld: string; kind: string; source: string; unconfirmed?: boolean; price: { years: number; subtotal_minor: string } | null }[] }

/** With a backend behind the page, prices come from the server (the effective-dated table), never from the sample table. */
export async function searchLive(raw: string): Promise<{ results: Result[]; alternatives: string[] } | null> {
  const q = parseQuery(raw);
  if (!q) return null;
  const order = q.tld ? [q.tld, ...EXTENSIONS.filter((e) => e !== q.tld)] : [...EXTENSIONS];
  const out = await api<ServerSearch>("GET", `/api/v1/search?name=${encodeURIComponent(q.label)}&tlds=${order.join(",")}`);
  const byTld = new Map(out.results.map((r) => [r.tld, r]));
  const results: Result[] = order.filter((t) => byTld.has(t)).map((tld) => {
    const r = byTld.get(tld)!;
    const avail = r.kind === "available" && !!r.price;
    return {
      domain: r.fqdn, tld, available: avail, sample: r.source === "sample",
      price: avail ? formatUsd(usd(Number(r.price!.subtotal_minor))) : undefined, years: r.price?.years ?? 1,
    };
  });
  return { results, alternatives: [] };
}

export interface LiveQuote { subtotal: string; wholesale: string; fee: string; taxCeiling: string; years: number }
export async function liveQuote(fqdn: string, years: number): Promise<LiveQuote | null> {
  const out = await api<{ quote: { subtotal_minor: string; wholesale_minor: string; fee_minor: string; tax_ceiling_minor: string; years: number } | null }>("GET", `/api/v1/quote?domain=${encodeURIComponent(fqdn)}&years=${years}`);
  if (!out.quote) return null;
  const f = (m: string) => formatUsd(usd(Number(m)));
  return { subtotal: f(out.quote.subtotal_minor), wholesale: f(out.quote.wholesale_minor), fee: f(out.quote.fee_minor), taxCeiling: f(out.quote.tax_ceiling_minor), years: out.quote.years };
}
