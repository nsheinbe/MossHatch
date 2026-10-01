import type { Money } from "@mosshatch/core";

export type Availability = "available" | "taken" | "premium" | "unsupported";

export interface Quote {
  domain: string;
  availability: Availability;
  /** Present only when available. All-in first-year price (wholesale plus flat fee). */
  firstYear?: Money;
  /** Renewal price, the same as first year for standard names. */
  renewal?: Money;
  years: number;
  /** Phase 1 only: prices are sample prices, never a real quote. */
  sample: boolean;
}

export interface RegistrarAdapter {
  readonly extensions: readonly string[];
  quote(domain: string): Promise<Quote>;
  suggestAlternatives(label: string, count: number): Promise<string[]>;
}
