import { fnv1a, normalizeDomain, splitDomain, stream } from "./hash.ts";
import { nameQuality, type NameQuality, type Tier } from "./quality.ts";
import {
  ACCESSORIES, CRACKS, SPECIES, SPECIES_INFO, WINGS, sanitizeSpec,
  type Accessory, type Charm, type CoatPattern, type CreatureSpec, type EggPattern, type Effect, type Hsl, type Idle, type Species,
} from "./spec.ts";

export type { Tier } from "./quality.ts";
/** Kept for older callers: a family is a species id. */
export type Family = Species;
export type Rarity = Tier;

export interface Traits {
  domain: string;
  label: string;
  tld: string;
  family: Species;
  rarity: Tier;
  speciesName: string;
  /** Voice pitch multiplier, 0.8..1.35. */
  pitch: number;
  quality: NameQuality;
  spec: CreatureSpec;
}


export interface EggStyle { base: Hsl; mark: Hsl; pattern: EggPattern; glow: number; charm: Charm }

/** The extension is only a hint: it paints the egg and picks the small collar charm. It never picks the species. */
const EGG_BY_TLD: Record<string, EggStyle> = {
  com: { base: { h: 40, s: 0.4, l: 0.88 }, mark: { h: 18, s: 0.55, l: 0.45 }, pattern: "speckle", glow: 0.06, charm: "bell" },
  ai: { base: { h: 262, s: 0.35, l: 0.86 }, mark: { h: 272, s: 0.5, l: 0.52 }, pattern: "band", glow: 0.1, charm: "star" },
  dev: { base: { h: 150, s: 0.28, l: 0.84 }, mark: { h: 172, s: 0.5, l: 0.36 }, pattern: "zigzag", glow: 0.06, charm: "gear" },
  io: { base: { h: 200, s: 0.4, l: 0.86 }, mark: { h: 212, s: 0.55, l: 0.46 }, pattern: "dapple", glow: 0.08, charm: "drop" },
  app: { base: { h: 18, s: 0.55, l: 0.86 }, mark: { h: 4, s: 0.6, l: 0.55 }, pattern: "band", glow: 0.07, charm: "ring" },
  studio: { base: { h: 335, s: 0.4, l: 0.87 }, mark: { h: 318, s: 0.42, l: 0.42 }, pattern: "zigzag", glow: 0.07, charm: "star" },
};
const EGG_PATTERN_LIST: EggPattern[] = ["speckle", "band", "zigzag", "dapple", "plain"];
const CHARM_LIST: Charm[] = ["bell", "star", "gear", "drop", "ring"];

export function eggStyle(tld: string): EggStyle {
  const known = EGG_BY_TLD[tld];
  if (known) return known;
  const r = stream(fnv1a("egg-tld:" + tld));
  const h = Math.round(r() * 360);
  return {
    base: { h, s: 0.3, l: 0.87 }, mark: { h: (h + 20) % 360, s: 0.5, l: 0.45 },
    pattern: EGG_PATTERN_LIST[Math.floor(r() * EGG_PATTERN_LIST.length)]!, glow: 0.06, charm: CHARM_LIST[Math.floor(r() * CHARM_LIST.length)]!,
  };
}

const EFFECT_BY_TIER: Record<Tier, Effect> = { common: "none", uncommon: "moonrim", rare: "iridescent", legendary: "glow" };
/** Coat pattern weights per tier: plain, stripes, mask, socks, speckles, twotone. */
const PATTERN_WEIGHTS: Record<Tier, number[]> = {
  common: [30, 18, 17, 18, 17, 0],
  uncommon: [14, 20, 18, 18, 18, 12],
  rare: [0, 14, 12, 12, 12, 50],
  legendary: [0, 20, 0, 0, 30, 50],
};
const PATTERNS: CoatPattern[] = ["plain", "stripes", "mask", "socks", "speckles", "twotone"];
const ACCESSORY_CHANCE: Record<Tier, number> = { common: 0.3, uncommon: 0.5, rare: 0.75, legendary: 1 };

function pickWeighted<T>(items: readonly T[], weights: readonly number[], r: number): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r * total;
  for (let i = 0; i < items.length; i++) { x -= weights[i]!; if (x < 0) return items[i]!; }
  return items[items.length - 1]!;
}
const pick = <T,>(items: readonly T[], r: number): T => items[Math.min(items.length - 1, Math.floor(r * items.length))]!;
const wrap = (h: number) => ((h % 360) + 360) % 360;
/** Move hue `a` toward `b` by k along the short way round. */
const mixHue = (a: number, b: number, k: number) => wrap(a + ((((b - a) % 360) + 540) % 360 - 180) * k);

const PATTERN_WORD: Record<CoatPattern, string> = { plain: "plain", stripes: "striped", mask: "masked", socks: "sock-footed", speckles: "speckled", twotone: "two-tone" };

/**
 * The creature for a name. Species comes from the name's hash, drawn from the pool of its tier; the tier comes from how rare the name
 * reads (nameQuality). The extension paints the egg and the charm only. Same input, same spec, in the browser and in Node.
 */
export function deriveCreatureSpec(domain: string): CreatureSpec {
  const d = normalizeDomain(domain);
  const { tld } = splitDomain(d);
  const q = nameQuality(d);
  // A fixed number of draws in a fixed order, so no branch shifts the ones after it.
  const r = stream(fnv1a(d));
  const R = Array.from({ length: 40 }, () => r());
  const at = (i: number) => R[i]!;
  const pool = SPECIES.filter((s) => SPECIES_INFO[s].tier === q.tier);
  const species = pick(pool, at(0));
  const info = SPECIES_INFO[species];
  const egg = eggStyle(tld);

  const wild = at(1) < 0.15;
  const h = wild ? at(2) * 360 : info.hue + (at(2) - 0.5) * 2 * info.hueSpread;
  const body: Hsl = { h: wrap(h), s: 0.32 + at(3) * 0.45, l: 0.4 + at(4) * 0.26 };
  // The extension tints the accent a little toward the egg's mark colour.
  const accent: Hsl = { h: mixHue(wrap(h + 150 + at(5) * 60), egg.mark.h, 0.2), s: 0.45 + at(6) * 0.3, l: 0.55 + at(7) * 0.15 };
  const pattern = pickWeighted(PATTERNS, PATTERN_WEIGHTS[q.tier], at(8));
  const coatColor: Hsl = body.l > 0.54
    ? { h: wrap(h + (at(9) - 0.5) * 40), s: body.s * 0.8, l: body.l * 0.45 }
    : { h: wrap(h + (at(9) - 0.5) * 30), s: 0.25, l: 0.86 };
  if (pattern === "twotone") { coatColor.h = wrap(accent.h + 20); coatColor.s = 0.5; coatColor.l = body.l > 0.54 ? 0.32 : 0.74; }
  const count = pattern === "stripes" ? 3 + Math.floor(at(10) * 4) : pattern === "speckles" ? 4 + Math.floor(at(10) * 5) : 0;

  const accessories: Accessory[] = [];
  if (at(11) < ACCESSORY_CHANCE[q.tier]) {
    const w = q.tier === "rare" || q.tier === "legendary" ? [2, 2, 5, 2, 1] : [3, 3, 1, 2, 2];
    accessories.push(pickWeighted(ACCESSORIES, w, at(12)));
    if (q.tier !== "common" && at(13) < 0.2) {
      const second = pickWeighted(ACCESSORIES, [3, 3, 1, 2, 2], at(14));
      if (second !== accessories[0]) accessories.push(second);
    }
  }

  const idleCount = Math.min(info.idle.length, 2 + (at(15) < 0.5 ? 1 : 0));
  const start = Math.floor(at(16) * info.idle.length);
  const idle: { kind: Idle; weight: number }[] = [];
  for (let i = 0; i < idleCount; i++) idle.push({ kind: info.idle[(start + i) % info.idle.length]!, weight: Math.round((0.3 + at(17 + i) * 0.7) * 100) / 100 });

  const build = 0.8 + at(20) * 0.45;
  const stature = build >= 1.1 ? "stocky" : build <= 0.9 ? "slender" : "small";
  const bio = `A ${stature} ${PATTERN_WORD[pattern]} ${info.name.toLowerCase()}. ${info.blurb}`;
  const durationBonus = q.tier === "legendary" ? 0.8 : q.tier === "rare" ? 0.4 : 0;

  return sanitizeSpec({
    v: 1,
    species,
    speciesName: info.name,
    bio,
    tier: q.tier,
    seed: fnv1a(d + ":coat"),
    size: 0.85 + at(21) * 0.35,
    build,
    body, accent,
    coat: { pattern, color: coatColor, count },
    ears: pick(info.ears, at(22)),
    earSize: 0.7 + at(23) * 0.7,
    tail: pick(info.tails, at(24)),
    tailSize: 0.7 + at(25) * 0.7,
    wings: pick(WINGS, at(26)),
    accessories,
    effect: EFFECT_BY_TIER[q.tier],
    charm: { shape: egg.charm, hue: egg.mark.h },
    choreography: {
      hatch: {
        shell: { base: egg.base, mark: egg.mark, pattern: egg.pattern, glow: egg.glow },
        crack: pick(CRACKS, at(27)),
        emerge: pick(info.emerge, at(28)),
        particles: { kind: pick(info.particles, at(29)), hue: accent.h },
        duration: 2.8 + at(30) * 1.4 + durationBonus,
      },
      idle,
      react: at(31) < 0.75 ? info.react : pick(["hop", "squash", "spin"] as const, at(32)),
      pitch: 0.8 + at(33) * 0.55,
    },
  });
}

/** Everything about a name's creature: the spec plus the name-quality explanation. */
export function deriveTraits(domain: string): Traits {
  const d = normalizeDomain(domain);
  const { label, tld } = splitDomain(d);
  const spec = deriveCreatureSpec(d);
  return {
    domain: d, label, tld, family: spec.species, rarity: spec.tier, speciesName: spec.speciesName,
    pitch: spec.choreography.pitch, quality: nameQuality(d), spec,
  };
}

const EARED = new Set<Species>(["fox", "hare", "hedgehog", "owl", "spiritfox"]);
const TAILED = new Set<Species>(["fox", "hare", "owl", "koi", "salamander", "spiritfox"]);
const COAT_PHRASE: Record<CoatPattern, string> = { plain: "plain coat", stripes: "striped coat", mask: "face mask", socks: "coat with socks", speckles: "speckled coat", twotone: "two-tone coat" };
const ACC_PHRASE: Record<Accessory, string> = { leaf: "wears a leaf", scarf: "wears a scarf", flower: "wears a flower", lantern: "carries a lantern", acorn: "carries an acorn" };
const EFFECT_PHRASE: Record<Effect, string | null> = { none: null, moonrim: "moonlit rim", iridescent: "iridescent sheen", glow: "soft glow" };

/** Short card phrases from a fixed vocabulary (CARD_TRAIT_RE). Never free text. */
export function cardTraits(input: CreatureSpec): string[] {
  const s = sanitizeSpec(input);
  const out = [COAT_PHRASE[s.coat.pattern]];
  if (EARED.has(s.species)) out.push(`${s.ears} ears`);
  if (TAILED.has(s.species)) out.push(`${s.tail} tail`);
  if (s.build >= 1.1) out.push("stocky build"); else if (s.build <= 0.9) out.push("slender build");
  for (const a of s.accessories) out.push(ACC_PHRASE[a]);
  const e = EFFECT_PHRASE[s.effect];
  if (e) out.push(e);
  return out.slice(0, 8);
}

/** Every phrase a published card's traits may hold, including the older vocabulary of cards published before species by name. */
export const CARD_TRAIT_RE = /^(?:(?:plain|striped|speckled|two-tone) coat|face mask|coat with socks|(?:pointed|round|tufted|lop) ears|(?:brush|curl|stub|plume) tail|(?:stocky|slender) build|wears a (?:leaf|scarf|flower)|carries (?:a lantern|an acorn)|moonlit rim|iridescent sheen|soft glow|(?:common|uncommon|rare) coat|(?:long|short) (?:ears|tail)|\d spots?)$/;
