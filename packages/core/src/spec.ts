import { TIERS, type Tier } from "./quality.ts";
import type { VoiceProfile } from "./launcher.ts";

/**
 * CreatureSpec: everything the renderer, the card snapshot and the card portrait need to draw and animate one creature. It is plain
 * data (JSON-serialisable), so a spec from another source renders exactly like one derived from a name. Every consumer passes input
 * through `sanitizeSpec` first: unknown enum values fall back, numbers are clamped, text is reduced to a plain character set.
 * The strict (rejecting) zod schema for the same shape lives in `spec-schema.ts`.
 */

export const SPECIES = ["fox", "hare", "beetle", "hedgehog", "owl", "koi", "moth", "salamander", "spiritfox"] as const;
export type Species = (typeof SPECIES)[number];
export const COAT_PATTERNS = ["plain", "stripes", "mask", "socks", "speckles", "twotone"] as const;
export type CoatPattern = (typeof COAT_PATTERNS)[number];
export const EARS = ["pointed", "round", "tufted", "lop"] as const;
export type EarShape = (typeof EARS)[number];
export const TAILS = ["brush", "curl", "stub", "plume"] as const;
export type TailShape = (typeof TAILS)[number];
export const WINGS = ["kite", "round", "swallow"] as const;
export type WingShape = (typeof WINGS)[number];
export const ACCESSORIES = ["leaf", "scarf", "lantern", "flower", "acorn"] as const;
export type Accessory = (typeof ACCESSORIES)[number];
export const VOICE_TIMBRES = ["bright", "warm", "hushed", "chime", "low"] as const;
export const EFFECTS = ["none", "moonrim", "iridescent", "glow"] as const;
export type Effect = (typeof EFFECTS)[number];
export const CHARMS = ["none", "bell", "star", "gear", "drop", "ring"] as const;
export type Charm = (typeof CHARMS)[number];
export const EGG_PATTERNS = ["plain", "speckle", "band", "zigzag", "dapple"] as const;
export type EggPattern = (typeof EGG_PATTERNS)[number];
export const CRACKS = ["veins", "spiral", "zigzag", "burst", "ring"] as const;
export type Crack = (typeof CRACKS)[number];
export const EMERGES = ["unfurl", "shoulder-out", "peek-then-leap", "drift-up", "burrow-up"] as const;
export type Emerge = (typeof EMERGES)[number];
export const PARTICLES = ["sparks", "dust", "petals", "bubbles", "motes"] as const;
export type Particle = (typeof PARTICLES)[number];
export const IDLES = ["preen", "sniff", "hover", "hop", "curl-sleep", "tail-flick", "look-around", "flutter", "thump", "bask", "surface"] as const;
export type Idle = (typeof IDLES)[number];
export const REACTS = ["hop", "spin", "squash", "flutter", "curl", "sparkle"] as const;
export type Reaction = (typeof REACTS)[number];
export { TIERS, type Tier };

export interface Hsl { h: number; s: number; l: number }

export interface Choreography {
  hatch: {
    /** The egg before it hatches: set by the extension, never by the species. */
    shell: { base: Hsl; mark: Hsl; pattern: EggPattern; glow: number };
    crack: Crack;
    emerge: Emerge;
    particles: { kind: Particle; hue: number };
    /** Seconds from the first wobble until the creature stands free of the shell, 2.5..5. */
    duration: number;
  };
  /** One to three idle moves with relative weights. */
  idle: { kind: Idle; weight: number }[];
  react: Reaction;
  /** Voice pitch multiplier, 0.8..1.35. */
  pitch: number;
}

export interface CreatureSpec {
  v: 1;
  species: Species;
  /** Up to 32 plain letters and spaces. */
  speciesName: string;
  /** Up to 120 characters of plain text. */
  bio: string;
  tier: Tier;
  /** Places speckles and similar small marks; any 32-bit unsigned integer. */
  seed: number;
  /** Overall scale 0.8..1.3 and build 0.8 (slender) .. 1.25 (stocky). */
  size: number;
  build: number;
  body: Hsl;
  accent: Hsl;
  coat: { pattern: CoatPattern; color: Hsl; count: number };
  ears: EarShape;
  earSize: number;
  tail: TailShape;
  tailSize: number;
  wings: WingShape;
  accessories: Accessory[];
  effect: Effect;
  /** A small charm on the collar, from the extension. */
  charm: { shape: Charm; hue: number };
  choreography: Choreography;
  /**
   * How this creature sounds once voice output exists (data only; no speech provider is wired). Absent on every derived spec: the
   * species profile applies (`voiceFor` in launcher.ts). A stored spec may carry its own.
   */
  voice?: VoiceProfile;
}

export type Locomotion = "walk" | "fly" | "swim";

export interface SpeciesInfo {
  name: string;
  tier: Tier;
  locomotion: Locomotion;
  /** Centre of the natural hue range, and how far it may wander either side. */
  hue: number;
  hueSpread: number;
  ears: readonly EarShape[];
  tails: readonly TailShape[];
  idle: readonly Idle[];
  react: Reaction;
  emerge: readonly Emerge[];
  particles: readonly Particle[];
  blurb: string;
}

export const SPECIES_INFO: Record<Species, SpeciesInfo> = {
  fox: { name: "Ember Fox", tier: "common", locomotion: "walk", hue: 24, hueSpread: 60, ears: ["pointed", "tufted", "round"], tails: ["brush", "plume", "curl"], idle: ["sniff", "tail-flick", "look-around"], react: "hop", emerge: ["shoulder-out", "peek-then-leap"], particles: ["sparks", "dust"], blurb: "It pounces on moths it never catches." },
  hare: { name: "Moss Hare", tier: "common", locomotion: "walk", hue: 34, hueSpread: 70, ears: ["pointed", "lop", "round"], tails: ["stub", "curl"], idle: ["thump", "hop", "preen"], react: "hop", emerge: ["peek-then-leap", "burrow-up"], particles: ["dust", "petals"], blurb: "It thumps a hind foot when it is happy." },
  beetle: { name: "Tinkerbeetle", tier: "common", locomotion: "walk", hue: 150, hueSpread: 110, ears: ["pointed", "round", "tufted", "lop"], tails: ["stub"], idle: ["preen", "sniff", "look-around"], react: "squash", emerge: ["burrow-up", "shoulder-out"], particles: ["sparks", "dust"], blurb: "Its brass gear ticks when it thinks." },
  hedgehog: { name: "Bramble Hedgehog", tier: "common", locomotion: "walk", hue: 30, hueSpread: 40, ears: ["round"], tails: ["stub"], idle: ["curl-sleep", "sniff", "bask"], react: "curl", emerge: ["unfurl", "burrow-up"], particles: ["dust", "petals"], blurb: "It rolls into a ball at the first surprise." },
  owl: { name: "Dusk Owl", tier: "uncommon", locomotion: "walk", hue: 32, hueSpread: 90, ears: ["tufted", "round"], tails: ["stub", "plume"], idle: ["look-around", "preen", "flutter"], react: "flutter", emerge: ["unfurl", "shoulder-out"], particles: ["motes", "dust"], blurb: "It turns its head almost all the way round." },
  koi: { name: "Clockwork Koi", tier: "uncommon", locomotion: "swim", hue: 18, hueSpread: 120, ears: ["round"], tails: ["brush", "plume", "curl"], idle: ["surface", "tail-flick"], react: "spin", emerge: ["drift-up", "unfurl"], particles: ["bubbles"], blurb: "It circles the pool and keeps perfect time." },
  moth: { name: "Lantern Moth", tier: "uncommon", locomotion: "fly", hue: 48, hueSpread: 150, ears: ["pointed", "tufted"], tails: ["stub"], idle: ["hover", "flutter"], react: "flutter", emerge: ["drift-up", "unfurl"], particles: ["motes", "sparks"], blurb: "It glows brighter when lanterns are near." },
  salamander: { name: "Glimmer Salamander", tier: "rare", locomotion: "walk", hue: 12, hueSpread: 180, ears: ["round", "tufted"], tails: ["curl", "brush"], idle: ["bask", "tail-flick", "look-around"], react: "sparkle", emerge: ["shoulder-out", "burrow-up"], particles: ["sparks", "motes"], blurb: "It basks on warm stones and shimmers." },
  spiritfox: { name: "Spirit Fox", tier: "legendary", locomotion: "walk", hue: 190, hueSpread: 180, ears: ["pointed", "tufted"], tails: ["plume", "brush"], idle: ["hover", "tail-flick", "look-around"], react: "sparkle", emerge: ["drift-up", "unfurl"], particles: ["motes"], blurb: "Its tails glow like lanterns in the moss." },
};

export const SPECIES_NAMES: readonly string[] = SPECIES.map((s) => SPECIES_INFO[s].name);

/** The four tiers, as shown on a card. */
export const TIER_LABEL: Record<Tier, string> = { common: "Common find", uncommon: "Uncommon find", rare: "Rare find", legendary: "Legendary find" };

// ---- sanitising -------------------------------------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const obj = (x: unknown): Record<string, unknown> => (isObj(x) ? x : {});
function oneOf<T extends string>(x: unknown, list: readonly T[], fallback: T): T {
  return typeof x === "string" && (list as readonly string[]).includes(x) ? (x as T) : fallback;
}
function num(x: unknown, min: number, max: number, fallback: number, places = 3): number {
  const n = typeof x === "number" && Number.isFinite(x) ? x : fallback;
  const f = 10 ** places;
  return Math.round(Math.min(max, Math.max(min, n)) * f) / f;
}
function hue(x: unknown, fallback: number): number {
  const n = typeof x === "number" && Number.isFinite(x) ? x : fallback;
  return Math.round((((n % 360) + 360) % 360) * 10) / 10 % 360;
}
function hsl(x: unknown, fb: Hsl): Hsl {
  const o = obj(x);
  return { h: hue(o.h, fb.h), s: num(o.s, 0, 1, fb.s), l: num(o.l, 0.15, 0.9, fb.l) };
}
/** Letters and spaces only, single-spaced, at most `max` characters. */
export function plainName(x: unknown, max: number): string {
  if (typeof x !== "string") return "";
  return x.replace(/[^A-Za-z ]+/g, "").replace(/ +/g, " ").trim().slice(0, max).trim();
}
/** Letters, digits, spaces and . , ' ! ? - only, at most `max` characters. */
export function plainText(x: unknown, max: number): string {
  if (typeof x !== "string") return "";
  return x.replace(/[^A-Za-z0-9 .,'!?-]+/g, "").replace(/ +/g, " ").trim().slice(0, max).trim();
}

export const NAME_RE = /^[A-Za-z]+(?: [A-Za-z]+)*$/;
export const BIO_RE = /^[A-Za-z0-9 .,'!?-]*$/;

/** Clamp any input into a valid CreatureSpec. Never throws; the result always passes the strict schema. */
export function sanitizeSpec(input: unknown): CreatureSpec {
  const o = obj(input);
  const species = oneOf(o.species, SPECIES, "fox");
  const info = SPECIES_INFO[species];
  const name = plainName(o.speciesName, 32);
  const coat = obj(o.coat);
  const charm = obj(o.charm);
  const ch = obj(o.choreography);
  const hatch = obj(ch.hatch);
  const shell = obj(hatch.shell);
  const parts = obj(hatch.particles);
  const acc: Accessory[] = [];
  if (Array.isArray(o.accessories)) for (const a of o.accessories) {
    const v = oneOf(a, ACCESSORIES, "leaf");
    if (a === v && !acc.includes(v) && acc.length < 2) acc.push(v);
  }
  const idle: { kind: Idle; weight: number }[] = [];
  if (Array.isArray(ch.idle)) for (const it of ch.idle) {
    const io = obj(it);
    const k = typeof io.kind === "string" && (IDLES as readonly string[]).includes(io.kind) ? (io.kind as Idle) : null;
    if (k && !idle.some((x) => x.kind === k) && idle.length < 3) idle.push({ kind: k, weight: num(io.weight, 0.1, 1, 0.5, 2) });
  }
  if (!idle.length) idle.push({ kind: info.idle[0]!, weight: 1 });
  return {
    v: 1,
    species,
    speciesName: name && NAME_RE.test(name) ? name : info.name,
    bio: plainText(o.bio, 120),
    tier: oneOf(o.tier, TIERS, info.tier),
    seed: typeof o.seed === "number" && Number.isFinite(o.seed) ? Math.floor(Math.abs(o.seed)) % 4294967296 : 0,
    size: num(o.size, 0.8, 1.3, 1),
    build: num(o.build, 0.8, 1.25, 1),
    body: hsl(o.body, { h: info.hue, s: 0.55, l: 0.55 }),
    accent: hsl(o.accent, { h: (info.hue + 180) % 360, s: 0.55, l: 0.62 }),
    coat: { pattern: oneOf(coat.pattern, COAT_PATTERNS, "plain"), color: hsl(coat.color, { h: 40, s: 0.3, l: 0.85 }), count: Math.round(num(coat.count, 0, 8, 0)) },
    ears: oneOf(o.ears, EARS, info.ears[0]!),
    earSize: num(o.earSize, 0.6, 1.5, 1),
    tail: oneOf(o.tail, TAILS, info.tails[0]!),
    tailSize: num(o.tailSize, 0.6, 1.5, 1),
    wings: oneOf(o.wings, WINGS, "kite"),
    accessories: acc,
    effect: oneOf(o.effect, EFFECTS, "none"),
    charm: { shape: oneOf(charm.shape, CHARMS, "none"), hue: hue(charm.hue, 40) },
    choreography: {
      hatch: {
        shell: { base: hsl(shell.base, { h: 40, s: 0.35, l: 0.88 }), mark: hsl(shell.mark, { h: 20, s: 0.4, l: 0.5 }), pattern: oneOf(shell.pattern, EGG_PATTERNS, "plain"), glow: num(shell.glow, 0, 1, 0.1) },
        crack: oneOf(hatch.crack, CRACKS, "veins"),
        emerge: oneOf(hatch.emerge, EMERGES, "unfurl"),
        particles: { kind: oneOf(parts.kind, PARTICLES, "sparks"), hue: hue(parts.hue, 34) },
        duration: num(hatch.duration, 2.5, 5, 3.4, 2),
      },
      idle,
      react: oneOf(ch.react, REACTS, info.react),
      pitch: num(ch.pitch, 0.8, 1.35, 1),
    },
    // Only a spec that carries a voice keeps one (derived specs never do, so their serialised form is unchanged).
    ...(isObj(o.voice) ? { voice: { timbre: oneOf(o.voice.timbre, VOICE_TIMBRES, "warm"), rate: num(o.voice.rate, 0.7, 1.4, 1), pitch: num(o.voice.pitch, 0.7, 1.4, 1) } } : {}),
  };
}

/** A stable key for caches (geometry per spec). */
export function specKey(s: CreatureSpec): string {
  return JSON.stringify(s);
}
