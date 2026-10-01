import { describe, expect, it } from "vitest";
import { deriveTraits, deriveCreatureState, deriveCreatureSpec, sanitizeSpec, cardTraits, CARD_TRAIT_RE, portraitSvg, SPECIES, mossFromAge, feePerYear, usd, formatUsd } from "./index.ts";
import { parseCreatureSpec } from "./spec-schema.ts";

describe("deriveTraits", () => {
  it("is deterministic and case-insensitive", () => {
    expect(deriveTraits("Moonfern.com")).toEqual(deriveTraits("moonfern.com"));
  });
  it("never picks the species from the extension", () => {
    const species = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((x) => deriveTraits(`${x}name${x}ly.com`).family));
    expect(species.size).toBeGreaterThan(2);
    // The extension paints the egg and the charm only.
    expect(deriveTraits("moonfern.com").spec.choreography.hatch.shell).toEqual(deriveTraits("zzzqqq.com").spec.choreography.hatch.shell);
    expect(deriveTraits("moonfern.com").spec.choreography.hatch.shell).not.toEqual(deriveTraits("moonfern.ai").spec.choreography.hatch.shell);
    expect(deriveTraits("moonfern.dev").spec.charm.shape).toBe("gear");
  });
  it("differs across names", () => {
    expect(deriveTraits("moonfern.com").spec.body.h).not.toBe(deriveTraits("marrowbrook.com").spec.body.h);
  });
  it("produces specs that pass the strict schema and survive sanitising unchanged", () => {
    for (const d of ["fox.com", "moss.ai", "lantern.com", "moonfern.com", "quiet-fern-42.com", "bramblewick.dev", "x.io", "hatchkind.studio"]) {
      const s = deriveCreatureSpec(d);
      expect(() => parseCreatureSpec(s)).not.toThrow();
      expect(sanitizeSpec(JSON.parse(JSON.stringify(s)))).toEqual(s);
      expect(cardTraits(s).every((t) => CARD_TRAIT_RE.test(t))).toBe(true);
    }
  });
  // Golden values: any change here changes every creature ever hatched.
  it("matches the golden fixture", () => {
    expect(deriveTraits("moonfern.com")).toMatchSnapshot();
    expect(deriveTraits("hatchkind.studio")).toMatchSnapshot();
    expect(deriveCreatureSpec("fox.com")).toMatchSnapshot();
  });
});

describe("CreatureSpec from untrusted input", () => {
  const junk: unknown[] = [null, 7, "x", [], { species: "dragon", size: 1e9, body: { h: -720, s: 9, l: NaN } },
    { speciesName: "<script>alert(1)</script>", bio: "</svg><img src=x onerror=alert(1)>", accessories: ["scarf", "scarf", "crown", "leaf", "lantern"], choreography: { hatch: { duration: 99, crack: "boom" }, idle: [{ kind: "rm -rf", weight: 5 }, { kind: "hop", weight: -1 }, { kind: "hop" }], pitch: Infinity } },
    { seed: -5.5, coat: { pattern: "plaid", count: 99 }, charm: { shape: "skull", hue: 1e12 } }];
  it("clamps anything into a valid spec", () => {
    for (const j of junk) {
      const s = sanitizeSpec(j);
      expect(() => parseCreatureSpec(s)).not.toThrow();
    }
    const s = sanitizeSpec(junk[5]);
    expect(s.speciesName).toBe("scriptalertscript");
    expect(s.bio).not.toMatch(/[<>=/]/);
    expect(s.accessories).toEqual(["scarf", "leaf"]);
    expect(s.choreography.hatch.duration).toBe(5);
    expect(s.choreography.idle).toEqual([{ kind: "hop", weight: 0.1 }]);
  });
  it("the strict schema rejects what sanitising would clamp", () => {
    const good = deriveCreatureSpec("moonfern.com");
    expect(() => parseCreatureSpec({ ...good, size: 3 })).toThrow();
    expect(() => parseCreatureSpec({ ...good, speciesName: "Fox<b>" })).toThrow();
    expect(() => parseCreatureSpec({ ...good, extra: 1 })).toThrow();
    expect(() => parseCreatureSpec({ ...good, choreography: { ...good.choreography, hatch: { ...good.choreography.hatch, duration: 6 } } })).toThrow();
  });
  it("draws the portrait from the spec alone, with no text from it", () => {
    const a = deriveCreatureSpec("moonfern.com");
    expect(portraitSvg(a)).toBe(portraitSvg(JSON.parse(JSON.stringify(a))));
    const svg = portraitSvg(sanitizeSpec({ ...a, speciesName: "Evil Name", bio: "Hello there" }));
    expect(svg).not.toContain("Evil");
    expect(svg).not.toContain("Hello");
    for (const j of junk) expect(portraitSvg(j as never)).toMatch(/^<svg [^]*<\/svg>\n$/);
    for (const sp of SPECIES) expect(portraitSvg({ ...a, species: sp })).not.toContain("NaN");
  });
});

describe("deriveCreatureState", () => {
  const base = { daysToExpiry: 200, transferLock: false, ageDays: 400 };
  it("prioritises", () => {
    expect(deriveCreatureState({ ...base, registering: true }).state).toBe("egg");
    expect(deriveCreatureState({ ...base, daysToExpiry: 12 }).text).toBe("Renews in 12 days");
    expect(deriveCreatureState({ ...base, transferLock: true }).state).toBe("armored");
    expect(deriveCreatureState({ ...base, daysToExpiry: -3 }).state).toBe("sleeping");
    expect(deriveCreatureState({ ...base, attentionReason: "Verify your email" }).state).toBe("attention");
    expect(deriveCreatureState({ ...base, dnsWriteInFlight: true }).state).toBe("shedding");
  });
  it("moss grows with age", () => {
    expect(mossFromAge(0)).toBe(0);
    expect(mossFromAge(2000)).toBeGreaterThan(mossFromAge(200));
  });
});

describe("money", () => {
  it("applies the D-003 fee bands", () => {
    expect(feePerYear(usd(1450)).cents).toBe(400);
    expect(feePerYear(usd(6000)).cents).toBe(900);
    expect(feePerYear(usd(11100)).cents).toBe(1000);
    expect(formatUsd(usd(1925))).toBe("$19.25");
  });
});
