import { fnv1a, formatUsd, splitDomain, usd, normalizeDomain, type Money } from "@mosshatch/core";
import type { Quote, RegistrarAdapter } from "./types";

/** Sample all-in first-year prices in cents (plan section 4.2). Labelled "sample price" in the UI. */
const SAMPLE_PRICE: Record<string, { cents: number; years: number }> = {
  com: { cents: 1925, years: 1 },
  dev: { cents: 2100, years: 1 },
  app: { cents: 2500, years: 1 },
  studio: { cents: 6000, years: 1 },
  io: { cents: 6900, years: 1 },
  ai: { cents: 24200, years: 2 },
};

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
