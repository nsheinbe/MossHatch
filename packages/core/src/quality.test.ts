import { describe, expect, it } from "vitest";
import { stream, fnv1a } from "./hash.ts";
import { nameQuality, TIERS, type Tier } from "./quality.ts";
import { deriveCreatureSpec } from "./traits.ts";
import { SPECIES, SPECIES_INFO, type Species } from "./spec.ts";
import { WORDS } from "./words.ts";

const words = [...WORDS];
const SYL_ON = ["b", "d", "f", "g", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z", "br", "gl", "st", "tr", "wh", "sh", "ch", "fl", ""];
const SYL_NU = ["a", "e", "i", "o", "u", "ai", "ee", "oo", "y"];
const SYL_CO = ["", "", "n", "r", "l", "st", "m", "x", "ck"];
const TLDS = [["com", 50], ["ai", 14], ["io", 10], ["dev", 10], ["app", 10], ["studio", 6]] as const;

/**
 * Realistic searches: mostly two-word compounds and invented brandable words, some with digits or hyphens, a few single words and a
 * few very short strings. Seeded, so the test is stable.
 */
function realisticNames(n: number): string[] {
  const r = stream(fnv1a("realistic-names"));
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const tld = () => { let x = r() * 100; for (const [t, w] of TLDS) { x -= w; if (x < 0) return t; } return "com"; };
  const invented = (syl: number) => Array.from({ length: syl }, () => pick(SYL_ON) + pick(SYL_NU) + pick(SYL_CO)).join("");
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = r();
    let label: string;
    if (k < 0.4) label = pick(words) + pick(words);
    else if (k < 0.72) label = invented(2 + Math.floor(r() * 2));
    else if (k < 0.8) label = pick(words) + "-" + pick(words);
    else if (k < 0.88) label = pick(words) + String(Math.floor(r() * 100));
    else if (k < 0.93) label = pick(words) + pick(words) + pick(words);
    else if (k < 0.97) label = pick(words);
    else label = Array.from({ length: 2 + Math.floor(r() * 4) }, () => pick([..."abcdefghijklmnopqrstuvwxyz0123456789"])).join("");
    out.push(`${label}.${tld()}`);
  }
  return out;
}

describe("nameQuality", () => {
  it("scores the signals it explains", () => {
    expect(nameQuality("fox.com").tier).toBe("legendary");
    expect(nameQuality("moss.ai").tier).toBe("rare");
    expect(nameQuality("owl.io").tier).toBe("legendary");
    expect(nameQuality("lantern.com").tier).toBe("rare");
    expect(nameQuality("moonfern.com").tier).toBe("uncommon");
    expect(nameQuality("quiet-fern-42.com").tier).toBe("common");
    expect(nameQuality("bramblewick.dev").tier).toBe("common");
    expect(nameQuality("moss.ai").reasons).toContain("A real word");
    expect(nameQuality("moonfern.com").reasons).toContain("Two words joined");
    expect(nameQuality("quiet-fern-42.com").reasons).toContain("Has digits and hyphens");
  });
  it("prefers shorter, cleaner, easier names", () => {
    expect(nameQuality("fern.com").score).toBeGreaterThan(nameQuality("fernfern.com").score);
    expect(nameQuality("fernhill.com").score).toBeGreaterThan(nameQuality("fern-hill.com").score);
    expect(nameQuality("fernhill.com").score).toBeGreaterThan(nameQuality("fernhill7.com").score);
    expect(nameQuality("velora.com").score).toBeGreaterThan(nameQuality("vxlqrt.com").score);
    expect(nameQuality("level.dev").reasons).toContain("Reads the same both ways");
    expect(nameQuality("fern.com").score).toBeGreaterThan(nameQuality("fern.studio").score);
  });
  it("is deterministic and case-insensitive", () => {
    expect(nameQuality("MoonFern.COM")).toEqual(nameQuality("moonfern.com"));
  });

  it("lands realistic searches at about 75 / 20 / 4 / under 1 percent, species even within each tier", () => {
    const names = realisticNames(10_000);
    const tiers: Record<Tier, number> = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
    const species = Object.fromEntries(SPECIES.map((s) => [s, 0])) as Record<Species, number>;
    for (const d of names) { const s = deriveCreatureSpec(d); tiers[s.tier]++; species[s.species]++; }
    const pct = (n: number) => (n / names.length) * 100;
    const report = Object.fromEntries(TIERS.map((t) => [t, pct(tiers[t]).toFixed(2)]));
    console.log("tiers %", JSON.stringify(report), "species", JSON.stringify(species));
    expect(pct(tiers.common)).toBeGreaterThanOrEqual(70); expect(pct(tiers.common)).toBeLessThanOrEqual(80);
    expect(pct(tiers.uncommon)).toBeGreaterThanOrEqual(15); expect(pct(tiers.uncommon)).toBeLessThanOrEqual(25);
    expect(pct(tiers.rare)).toBeGreaterThanOrEqual(3); expect(pct(tiers.rare)).toBeLessThanOrEqual(6);
    expect(pct(tiers.legendary)).toBeGreaterThan(0); expect(pct(tiers.legendary)).toBeLessThan(1);
    // Within a tier each species gets an equal share, give or take 20 percent of that share.
    for (const t of TIERS) {
      const pool = SPECIES.filter((s) => SPECIES_INFO[s].tier === t);
      for (const s of pool) {
        const share = species[s] / tiers[t];
        expect(share, `${s} in ${t}`).toBeGreaterThan((1 / pool.length) * 0.8);
        expect(share, `${s} in ${t}`).toBeLessThan((1 / pool.length) * 1.2);
      }
    }
  });

  it("gives every species to more than one extension (the extension never picks the species)", () => {
    const names = realisticNames(4000);
    const seen = new Map<Species, Set<string>>();
    for (const d of names) { const s = deriveCreatureSpec(d); const t = d.slice(d.indexOf(".") + 1); (seen.get(s.species) ?? seen.set(s.species, new Set()).get(s.species)!).add(t); }
    for (const s of SPECIES.filter((x) => x !== "spiritfox")) expect(seen.get(s)?.size ?? 0, s).toBeGreaterThanOrEqual(4);
    const comSpecies = new Set(names.filter((d) => d.endsWith(".com")).map((d) => deriveCreatureSpec(d).species));
    expect(comSpecies.size).toBeGreaterThanOrEqual(8);
  });
});
