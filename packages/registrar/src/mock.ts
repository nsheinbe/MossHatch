import { feePerYear, fnv1a, formatUsd, splitDomain, usd, normalizeDomain, type Money } from "@mosshatch/core";
import type { Quote, RegistrarAdapter } from "./types.ts";

/** Sample per-year wholesale (USD cents; plan 4.1, `.com` and `.studio` at their announced next prices). */
export const SAMPLE_WHOLESALE_CENTS: Record<string, number> = { com: 1525, dev: 1700, app: 2100, studio: 5100, io: 6000, ai: 11100 };
const YEARS: Record<string, number> = { ai: 2 };

/** Sample all-in first-order price = (wholesale + D-003 flat fee) x years. Labelled "sample price" in the UI. */
export const SAMPLE_PRICE: Record<string, { cents: number; years: number }> = Object.fromEntries(
  Object.entries(SAMPLE_WHOLESALE_CENTS).map(([tld, w]) => {
    const years = YEARS[tld] ?? 1;
    return [tld, { cents: (w + feePerYear(usd(w)).cents) * years, years }];
  }),
);

export const EXTENSIONS = ["com", "ai", "dev", "io", "app", "studio"] as const;

/** Names the demo and tests rely on. */
const ALWAYS_TAKEN = new Set(["google.com", "example.com", "mosshatch.com", "hatchkind.com", "moonfern.io"]);

const SUFFIXES = ["den", "wick", "nook", "brook", "hollow", "glen"];

export class MockRegistrar implements RegistrarAdapter {
  readonly extensions = EXTENSIONS;

  async quote(input: string): Promise<Quote> {
    const domain = normalizeDomain(input);
    const { tld } = splitDomain(domain);
    const price = SAMPLE_PRICE[tld];
    if (!price) return { domain, availability: "unsupported", years: 1, sample: true };
    // Deterministic: about one in four names is taken, plus the fixed set.
    const taken = ALWAYS_TAKEN.has(domain) || fnv1a("taken:" + domain) % 4 === 0;
    if (taken) return { domain, availability: "taken", years: price.years, sample: true };
    const m: Money = usd(price.cents);
    return { domain, availability: "available", firstYear: m, renewal: m, years: price.years, sample: true };
  }

  async suggestAlternatives(label: string, count: number): Promise<string[]> {
    const out: string[] = [];
    for (const s of SUFFIXES) {
      const q = await this.quote(`${label}${s}.com`);
      if (q.availability === "available") out.push(q.domain);
      if (out.length >= count) break;
    }
    return out;
  }
}

export const priceLabel = (m: Money) => formatUsd(m);
