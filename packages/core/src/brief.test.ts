import { describe, expect, it } from "vitest";
import { BriefSchema, briefFromToolInput, cleanText, revisionFromToolInput } from "./brief.ts";
import { contrast, defaultPalette, hslToHex, voiceFor, SPECIES_VOICE } from "./launcher.ts";
import { sanitizeSpec } from "./spec.ts";
import { deriveCreatureSpec } from "./traits.ts";
import { parseCreatureSpec } from "./spec-schema.ts";

const own = { domain: "moonfern.com", creature: { species: "fox" as const, speciesName: "Ember Fox" }, palette: { primary: "#aa5522", accent: "#22aa88", background: "#120d0a", text: "#f7f4ec" } };
const input = { name: "Moonfern", oneLiner: "Small-batch tea.", audience: "Tea lovers", goal: "Order a tin", pages: ["Home"], sections: [], tone: "calm, warm", palette: { primary: "#AA5522", accent: "#22aa88", background: "#000000", text: "#ffffff" }, notes: "" };

describe("Brief", () => {
  it("turns the creature's tool input into a Brief with the server's domain and creature", () => {
    const r = briefFromToolInput(input, own);
    expect(r.ok && r.brief).toEqual({ domain: "moonfern.com", name: "Moonfern", oneLiner: "Small-batch tea.", audience: "Tea lovers", goal: "Order a tin", pages: ["Home"], tone: "calm, warm",
      palette: { primary: "#aa5522", accent: "#22aa88", background: "#000000", text: "#ffffff" }, creature: own.creature });
    expect(BriefSchema.safeParse(r.ok && r.brief).success).toBe(true);
  });
  it("replaces an invalid palette with the creature's default instead of failing", () => {
    const r = briefFromToolInput({ ...input, palette: { primary: "red", accent: "#22aa88", background: "#000", text: "#fff" } }, own);
    expect(r.ok && r.brief.palette).toEqual(own.palette);
  });
  it("reports field names and limits (never the text) when something is too long or missing", () => {
    const r = briefFromToolInput({ ...input, name: "x".repeat(81), pages: [] }, own);
    expect(r).toEqual({ ok: false, problems: ["name: required, at most 80 characters", "pages: required, at most 8 items or characters each"] });
    expect(briefFromToolInput({ ...input, extra: 1 }, own)).toEqual({ ok: false, problems: ["the input did not match the propose_brief schema"] });
    expect(briefFromToolInput({ ...input, pages: Array(9).fill("A") }, own).ok).toBe(false);
  });
  it("strips control and bidi characters and collapses whitespace", () => {
    expect(cleanText("  a‮b\u0000c\n\nd  ")).toBe("a b c d");
    const r = briefFromToolInput({ ...input, name: "Moon​fern⁦" }, own);
    expect(r.ok && r.brief.name).toBe("Moon fern");
  });
  it("never lets the model set the domain or the creature", () => {
    const r = briefFromToolInput({ ...input, domain: "evil.com" }, own);
    expect(r.ok).toBe(false);
  });
  it("validates revise_site instructions", () => {
    expect(revisionFromToolInput({ instruction: " make it warmer " })).toEqual({ ok: true, instruction: "make it warmer" });
    expect(revisionFromToolInput({ instruction: "" }).ok).toBe(false);
    expect(revisionFromToolInput({ instruction: "x".repeat(501) }).ok).toBe(false);
  });
});

describe("palette and voice", () => {
  it("derives a readable default palette from the creature's own hues", () => {
    for (const d of ["moonfern.com", "tinkerdeep.dev", "lanternwick.ai", "x.io", "stillwater.studio"]) {
      const p = defaultPalette(deriveCreatureSpec(d));
      for (const v of Object.values(p)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(p.text, p.background)).toBeGreaterThanOrEqual(7);
    }
    expect(hslToHex({ h: 0, s: 1, l: 0.5 })).toBe("#ff0000");
    expect(hslToHex({ h: 120, s: 1, l: 0.25 })).toBe("#008000");
  });
  it("gives every species a voice profile, scaled by the creature's pitch, and keeps derived specs unchanged", () => {
    const s = deriveCreatureSpec("moonfern.com");
    expect(s).not.toHaveProperty("voice");
    const v = voiceFor(s);
    expect(v.timbre).toBe(SPECIES_VOICE[s.species].timbre);
    expect(v.pitch).toBeCloseTo(SPECIES_VOICE[s.species].pitch * s.choreography.pitch, 2);
    const withVoice = sanitizeSpec({ ...s, voice: { timbre: "low", rate: 9, pitch: 1 } });
    expect(withVoice.voice).toEqual({ timbre: "low", rate: 1.4, pitch: 1 });
    expect(parseCreatureSpec(withVoice).voice?.timbre).toBe("low");
    expect(voiceFor(withVoice)).toEqual(withVoice.voice);
  });
});
