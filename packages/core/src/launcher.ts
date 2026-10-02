import type { CreatureSpec, Hsl, Species } from "./spec.ts";

/**
 * The brand launcher's plain helpers (no zod, so the web bundle can carry them): the brief's default palette from the creature's hues,
 * and the per-species voice profile that voice output will read once a speech provider is wired (data only today, docs/LAUNCHER.md).
 * The strict Brief schema lives in `brief.ts`, outside the package index.
 */

export interface Palette { primary: string; accent: string; background: string; text: string }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** HSL (h in degrees, s and l in 0..1) to `#rrggbb`. Integer output, so browser and Node agree. */
export function hslToHex(c: Hsl): string {
  const h = ((c.h % 360) + 360) % 360, s = clamp01(c.s), l = clamp01(c.l);
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) => Math.round(clamp01(x) * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

export const HEX_RE = /^#[0-9a-f]{6}$/;

/**
 * The brief's starting palette, read from the creature: primary from its body, accent from its accent hue, a deep background tinted
 * by the body hue and text that keeps at least 7:1 against it. The owner (through the creature) may change any of them.
 */
export function defaultPalette(spec: Pick<CreatureSpec, "body" | "accent">): Palette {
  const primary = hslToHex({ h: spec.body.h, s: Math.max(0.45, spec.body.s), l: 0.46 });
  const accent = hslToHex({ h: spec.accent.h, s: Math.max(0.55, spec.accent.s), l: 0.6 });
  const background = hslToHex({ h: spec.body.h, s: 0.32, l: 0.1 });
  let text = hslToHex({ h: spec.body.h, s: 0.3, l: 0.94 });
  if (contrast(text, background) < 7) text = "#f7f4ec";
  return { primary, accent, background, text };
}

/**
 * How a species sounds once voice output exists (no speech provider is wired yet). `timbre` names a voice family a TTS adapter maps
 * to its own voices; `rate` and `pitch` are multipliers around 1; `pitch` is further scaled by the creature's own choreography pitch.
 */
export interface VoiceProfile { timbre: "bright" | "warm" | "hushed" | "chime" | "low"; rate: number; pitch: number }

export const SPECIES_VOICE: Record<Species, VoiceProfile> = {
  fox: { timbre: "bright", rate: 1.08, pitch: 1.05 },
  hare: { timbre: "bright", rate: 1.15, pitch: 1.12 },
  beetle: { timbre: "chime", rate: 0.98, pitch: 1.0 },
  hedgehog: { timbre: "warm", rate: 0.92, pitch: 0.96 },
  owl: { timbre: "hushed", rate: 0.88, pitch: 0.9 },
  koi: { timbre: "chime", rate: 0.94, pitch: 1.02 },
  moth: { timbre: "hushed", rate: 1.0, pitch: 1.1 },
  salamander: { timbre: "warm", rate: 1.0, pitch: 0.95 },
  spiritfox: { timbre: "low", rate: 0.9, pitch: 0.88 },
};

/** The voice for one creature: its own `voice` when a spec carries one, else its species' profile with the creature's pitch applied. */
export function voiceFor(spec: Pick<CreatureSpec, "species" | "choreography"> & { voice?: VoiceProfile }): VoiceProfile {
  if (spec.voice) return spec.voice;
  const v = SPECIES_VOICE[spec.species];
  return { ...v, pitch: Math.round(v.pitch * spec.choreography.pitch * 1000) / 1000 };
}
