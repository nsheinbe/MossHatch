import { z } from "zod";
import {
  ACCESSORIES, BIO_RE, CHARMS, COAT_PATTERNS, CRACKS, EARS, EFFECTS, EGG_PATTERNS, EMERGES, IDLES, NAME_RE, PARTICLES, REACTS, SPECIES,
  TAILS, TIERS, WINGS, type CreatureSpec,
} from "./spec.ts";

/**
 * The strict schema for a CreatureSpec from outside (a stored spec, a future designer). It rejects instead of clamping; renderers
 * still pass everything through `sanitizeSpec`. Kept out of the package index so the web bundle never carries zod.
 */
const hue = z.number().min(0).lt(360);
const hsl = z.strictObject({ h: hue, s: z.number().min(0).max(1), l: z.number().min(0.15).max(0.9) });

export const CreatureSpecSchema = z.strictObject({
  v: z.literal(1),
  species: z.enum(SPECIES),
  speciesName: z.string().min(1).max(32).regex(NAME_RE),
  bio: z.string().max(120).regex(BIO_RE),
  tier: z.enum(TIERS),
  seed: z.number().int().min(0).max(4294967295),
  size: z.number().min(0.8).max(1.3),
  build: z.number().min(0.8).max(1.25),
  body: hsl,
  accent: hsl,
  coat: z.strictObject({ pattern: z.enum(COAT_PATTERNS), color: hsl, count: z.number().int().min(0).max(8) }),
  ears: z.enum(EARS),
  earSize: z.number().min(0.6).max(1.5),
  tail: z.enum(TAILS),
  tailSize: z.number().min(0.6).max(1.5),
  wings: z.enum(WINGS),
  accessories: z.array(z.enum(ACCESSORIES)).max(2).refine((a) => new Set(a).size === a.length, "duplicate accessory"),
  effect: z.enum(EFFECTS),
  charm: z.strictObject({ shape: z.enum(CHARMS), hue }),
  choreography: z.strictObject({
    hatch: z.strictObject({
      shell: z.strictObject({ base: hsl, mark: hsl, pattern: z.enum(EGG_PATTERNS), glow: z.number().min(0).max(1) }),
      crack: z.enum(CRACKS),
      emerge: z.enum(EMERGES),
      particles: z.strictObject({ kind: z.enum(PARTICLES), hue }),
      duration: z.number().min(2.5).max(5),
    }),
    idle: z.array(z.strictObject({ kind: z.enum(IDLES), weight: z.number().min(0.1).max(1) })).min(1).max(3)
      .refine((a) => new Set(a.map((x) => x.kind)).size === a.length, "duplicate idle"),
    react: z.enum(REACTS),
    pitch: z.number().min(0.8).max(1.35),
  }),
}) satisfies z.ZodType<CreatureSpec>;

export function parseCreatureSpec(input: unknown): CreatureSpec {
  return CreatureSpecSchema.parse(input);
}
