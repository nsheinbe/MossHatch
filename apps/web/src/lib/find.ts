import { formatUsd, feePerYear, usd, splitDomain } from "@mosshatch/core";
import { EXTENSIONS, MockRegistrar, SAMPLE_WHOLESALE_CENTS } from "@mosshatch/registrar";
import type { Result } from "../store";

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
