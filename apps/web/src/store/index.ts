import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The preview's registered-or-not answer from the public registry (packages/api/src/lookup). */
export type LookupStatus = "registered" | "unregistered" | "unknown";

export interface Result {
  domain: string;
  tld: string;
  /** Hatchable: free at the registrar (live), or not in the public registry (preview, `status` "unregistered"). */
  available: boolean;
  /** Preview only: what the public registry said. Absent in live mode, where the registrar answers. */
  status?: LookupStatus;
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
  tier: "common" | "uncommon" | "rare" | "legendary";
  tierLabel: string;
  bio: string;
  traits: string[];
  hatchedOn: string;
  moss: string;
  address: string;
  /** A practice hatch an account with the live shop ran on purpose (nothing bought): the card says so. */
  practice?: boolean;
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
  /** The API answered (an invite build can reach it while `apiReady`, the live shop, stays false for a visitor). */
  apiReachable: boolean | null;
  account: Me | null;
  accountOpen: boolean;
  /** The Visitors view (tokens, connected apps, requests waiting for a decision). Never persisted. */
  visitorsOpen: boolean;
  orderId: string | null;
  /** Stripe Checkout Session id from the return URL; the server checks it belongs to the order. */
  orderSession: string | null;
  /** The domain whose panel is open: an id and its name, nothing else. */
  domainPanel: { id: string; fqdn: string } | null;
  /** Bumped when a change in the panel means the grove should re-read the domains. */
  groveRev: number;
  /** The Rescue (transfer in) panel: the name typed in Find and, once started, the transfer's opaque ids. Never a code. */
  rescue: { fqdn: string; transferId: string | null; orderId?: string } | null;
  /** The launcher conversation that is open: the domain whose creature talks, and how the page reached it. Never persisted. */
  talk: { domain: string; source: "owned" | "practice" } | null;
  calm: boolean;
  sound: boolean;
  rehideSeconds: number;
  set: (p: Partial<UiState>) => void;
}

export const PERSISTED_KEYS = ["calm", "sound", "rehideSeconds"] as const;
type Prefs = Pick<UiState, (typeof PERSISTED_KEYS)[number]>;

/**
 * The only way stored preferences come back (the read side of the store contract): the three keys, each type-checked, and
 * `rehideSeconds` as a whole number from 5 to 100 (the most a value or code may stay up); anything else in the entry is ignored,
 * so nothing stored can open a panel, name an account or keep a value on screen.
 */
export function restorePrefs(stored: unknown): Partial<Prefs> {
  const o = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const out: Partial<Prefs> = {};
  if (typeof o.calm === "boolean") out.calm = o.calm;
  if (typeof o.sound === "boolean") out.sound = o.sound;
  if ("rehideSeconds" in o) {
    const n = o.rehideSeconds;
    out.rehideSeconds = typeof n === "number" && Number.isFinite(n) ? Math.min(100, Math.max(5, Math.round(n))) : 30;
  }
  return out;
}

const prefersReduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      view: "find", query: "", checking: false, results: [], alternatives: [], demo: "idle", selected: null,
      hatchPhase: "none", card: null, groveNames: [], dealOpen: false, flash: 0, apiReady: null, apiReachable: null, account: null, accountOpen: false, visitorsOpen: false, orderId: null, orderSession: null, domainPanel: null, groveRev: 0,
      calm: prefersReduced, sound: false, rehideSeconds: 30,
      rescue: null, talk: null,
      set: (p) => set(p),
    }),
    {
      name: "mosshatch.prefs",
      partialize: (s) => Object.fromEntries(PERSISTED_KEYS.map((k) => [k, s[k]])) as Prefs,
      merge: (stored, current) => ({ ...current, ...restorePrefs(stored) }),
      version: 1,
    },
  ),
);
