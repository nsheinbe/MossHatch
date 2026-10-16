import { describe, expect, it } from "vitest";
import { ideasFor, nameCost, similarNames } from "./names";

describe("AUD-D1: name ideas from a brief (docs/AUDIT-2026-10-07.md)", () => {
  const brief = "A memorable, friendly name for a children's art studio.";

  it("uses what the brief is about, not how it should feel: no idea is built from 'memorable', 'friendly' or 'name'", () => {
    const labels = ideasFor(brief).map((i) => i.label);
    expect(labels.length).toBeGreaterThanOrEqual(6);
    for (const l of labels) expect(l).not.toMatch(/memorable|friendly|name/);
    // Every idea draws on the art, children or studio vocabulary.
    for (const l of labels) expect(l, l).toMatch(/paint|doodle|crayon|color|brush|easel|sketch|art|little|tiny|kids|cub|sprout|studio|lab|nook|corner|workshop/);
  });

  it("returns short, readable, varied labels: letters only, at most 20, no word leading more than twice, deterministic", () => {
    const a = ideasFor(brief), b = ideasFor(brief);
    expect(a).toEqual(b);
    for (const { label } of a) { expect(label).toMatch(/^[a-z]{3,20}$/); expect(label).not.toMatch(/(.)\1\1/); }
    const leads = new Map<string, number>();
    for (const { parts } of a) leads.set(parts[0]!, (leads.get(parts[0]!) ?? 0) + 1);
    for (const n of leads.values()) expect(n).toBeLessThanOrEqual(2);
    expect(new Set(a.map((i) => i.label)).size).toBe(a.length);
  });

  it("puts audience adjectives first ('tiny' leads, never trails) and handles other briefs sensibly", () => {
    for (const { parts } of ideasFor(brief, 30)) expect(["little", "tiny", "young"]).not.toContain(parts.at(-1));
    expect(ideasFor("a coastal ceramics studio").map((i) => i.label).some((l) => /clay|glaze|kiln|pottery/.test(l))).toBe(true);
    expect(ideasFor("A modern bookkeeping service for small farms").map((i) => i.label).some((l) => /ledger|tally/.test(l) && /acre|field|harvest|barn|grove/.test(l))).toBe(true);
    expect(ideasFor("the and for")).toEqual([]);
    expect(ideasFor("")).toEqual([]);
    for (const { label } of ideasFor("x".repeat(500))) expect(label.length).toBeLessThanOrEqual(20);
  });

  it("scores awkward joins worse than clean ones", () => {
    expect(nameCost(["doodle", "kids"])).toBeLessThan(nameCost(["kids", "studio"]));      // s-st at the join
    expect(nameCost(["paint", "nook"])).toBeLessThan(nameCost(["paint", "studio"]));     // n-t-st reads badly
    expect(nameCost(["tiny", "brush"])).toBeLessThan(nameCost(["tiny", "yarn"]));        // a doubled letter across the join
  });
});

describe("AUD-D2: names close to a taken one", () => {
  it("offers plain affixes, never the taken name itself or a misspelling, and uses the brief when there is one", () => {
    const s = similarNames("moonfern.com");
    expect(s.length).toBeGreaterThan(4);
    expect(s).not.toContain("moonfern");
    for (const n of s) expect(n).toContain("moonfern");
    expect(similarNames("moonfern", "a cozy plant shop").some((n) => /bloom|sprout|petal|fern|leaf|shop|market|goods/.test(n.replace("moonfern", "")))).toBe(true);
    expect(similarNames("")).toEqual([]);
    for (const n of similarNames("x".repeat(100))) expect(n.length).toBeLessThanOrEqual(63);
  });
});
