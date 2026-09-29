import { fnv1a, normalizeDomain, stream } from "./hash.ts";

export type Family = "fox" | "moth" | "beetle" | "koi";
export type Rarity = "common" | "uncommon" | "rare";

export interface Traits {
  domain: string;
  label: string;
  tld: string;
  family: Family;
  /** Body color as HSL, hue in degrees, s and l in 0..1. */
  hue: number;
  sat: number;
  light: number;
  accentHue: number;
  size: number;
  earLength: number;
  tailLength: number;
  spots: number;
  /** Voice pitch multiplier, 0.8..1.35. */
  pitch: number;
  rarity: Rarity;
  speciesName: string;
}

const FAMILY_BY_TLD: Record<string, Family> = {
  com: "fox",
  ai: "moth",
  dev: "beetle",
  io: "koi",
  app: "moth",
  studio: "fox",
};

const SPECIES: Record<Family, string> = {
  fox: "Ember Fox",
  moth: "Lantern Moth",
  beetle: "Tinkerbeetle",
  koi: "Clockwork Koi",
};

/** Base hue range per extension, so `.app` and `.studio` stay distinct from their family. */
const HUE_BASE: Record<string, number> = { com: 22, ai: 48, dev: 30, io: 190, app: 285, studio: 335 };

export function splitDomain(domain: string): { label: string; tld: string } {
  const d = normalizeDomain(domain);
  const i = d.indexOf(".");
  return i < 0 ? { label: d, tld: "" } : { label: d.slice(0, i), tld: d.slice(i + 1) };
}

export function familyFor(tld: string): Family {
  return FAMILY_BY_TLD[tld] ?? "fox";
}

/** Deterministic from the full domain name. Same input, same creature, everywhere. */
export function deriveTraits(domain: string): Traits {
  const d = normalizeDomain(domain);
  const { label, tld } = splitDomain(d);
  const rnd = stream(fnv1a(d));
  const family = familyFor(tld);
  const base = HUE_BASE[tld] ?? 30;
  const hue = (base + (rnd() - 0.5) * 36 + 360) % 360;
  const sat = round(0.42 + rnd() * 0.3);
  const light = round(0.5 + rnd() * 0.14);
  const accentHue = (hue + 150 + rnd() * 60) % 360;
  const size = round(0.85 + rnd() * 0.4);
  const earLength = round(0.7 + rnd() * 0.7);
  const tailLength = round(0.7 + rnd() * 0.8);
  const spots = Math.floor(rnd() * 6);
  const pitch = round(0.8 + rnd() * 0.55);
  const r = rnd();
  const rarity: Rarity = r > 0.96 ? "rare" : r > 0.8 ? "uncommon" : "common";
  return {
    domain: d, label, tld, family,
    hue: round(hue, 1), sat, light, accentHue: round(accentHue, 1),
    size, earLength, tailLength, spots, pitch, rarity,
    speciesName: SPECIES[family],
  };
}

function round(n: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
