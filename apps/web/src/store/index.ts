import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Result {
  domain: string;
  tld: string;
  available: boolean;
  /** Formatted all-in first-year price, present only when available. */
  price?: string;
  years?: number;
  sample: boolean;
  /** Breakdown for "How the price is made" (sample data in Phase 1). */
  wholesale?: string;
  fee?: string;
}

import type { Me } from "../lib/account";

export type View = "find" | "grove" | "ledger";
export type HatchPhase = "none" | "sheet" | "hatching" | "card";

export interface Card {
  domain: string;
  image: string;
  species: string;
  traits: string[];
  hatchedOn: string;
  moss: string;
  address: string;
}

/**
 * View state only. Nothing here holds secrets, tokens or values fetched from the server;
 * only `calm`, `sound` and `rehideSeconds` may be persisted (checked in tests).
 */
export interface UiState {
  view: View;
  query: string;
  checking: boolean;
  results: Result[];
  alternatives: string[];
  demo: "idle" | "playing" | "done";
  selected: Result | null;
  hatchPhase: HatchPhase;
  card: Card | null;
  groveNames: string[];
  dealOpen: boolean;
  flash: number;
  /** null = not asked yet, false = accounts are not connected in this deployment. */
  apiReady: boolean | null;
  account: Me | null;
  accountOpen: boolean;
  orderId: string | null;
  /** Stripe Checkout Session id from the return URL; the server checks it belongs to the order. */
  orderSession: string | null;
  /** The domain whose panel is open: an id and its name, nothing else. */
  domainPanel: { id: string; fqdn: string } | null;
  /** Bumped when a change in the panel means the grove should re-read the domains. */
  groveRev: number;
  calm: boolean;
  sound: boolean;
  rehideSeconds: number;
  set: (p: Partial<UiState>) => void;
}

export const PERSISTED_KEYS = ["calm", "sound", "rehideSeconds"] as const;

const prefersReduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      view: "find", query: "", checking: false, results: [], alternatives: [], demo: "idle", selected: null,
      hatchPhase: "none", card: null, groveNames: [], dealOpen: false, flash: 0, apiReady: null, account: null, accountOpen: false, orderId: null, orderSession: null, domainPanel: null, groveRev: 0,
      calm: prefersReduced, sound: false, rehideSeconds: 30,
      set: (p) => set(p),
    }),
    {
      name: "mosshatch.prefs",
      partialize: (s) => Object.fromEntries(PERSISTED_KEYS.map((k) => [k, s[k]])) as Pick<UiState, (typeof PERSISTED_KEYS)[number]>,
      version: 1,
    },
  ),
);
