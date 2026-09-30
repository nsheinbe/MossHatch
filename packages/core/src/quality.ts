import { normalizeDomain } from "./hash.ts";
import { WORDS } from "./words.ts";

export const TIERS = ["common", "uncommon", "rare", "legendary"] as const;
export type Tier = (typeof TIERS)[number];

export interface NameQuality {
  /** 0..100. Higher reads as a rarer, cleaner name. */
  score: number;
  tier: Tier;
  /** Plain reasons, in the order they were scored, e.g. "Short: 4 letters". */
  reasons: string[];
}

/** Tier cut-offs on the score. Tuned so realistic searches land about 75 / 20 / 4 / under 1 percent (see quality.test.ts). */
export const TIER_MIN: Record<Tier, number> = { common: 0, uncommon: 44, rare: 58, legendary: 93 };

const LENGTH_POINTS = [50, 50, 50, 48, 44, 32, 22, 16, 12, 9, 6, 3, 3];
const TLD_POINTS: Record<string, number> = { com: 6, ai: 5, io: 3, app: 2, dev: 2 };
const VOWELS = /[aeiouy]/;
/** Consonant clusters of three that English speakers say without trouble. */
const EASY_TRIPLES = new Set(["str", "scr", "spl", "spr", "thr", "chr", "shr", "sch", "nth", "ght", "tch", "ngl", "nch", "rst", "rth", "lth", "mbl", "ndl", "ntl", "rch", "rsh", "wsh"]);

function splitLabel(d: string): { label: string; tld: string } {
  const i = d.indexOf(".");
  return i < 0 ? { label: d, tld: "" } : { label: d.slice(0, i), tld: d.slice(i + 1) };
}

/** Longest run of consonants, ignoring runs that are easy clusters. */
function hardConsonantRun(s: string): number {
  let best = 0, run = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (VOWELS.test(ch) || !/[a-z]/.test(ch)) { run = 0; continue; }
    run++;
    if (run === 3 && EASY_TRIPLES.has(s.slice(i - 2, i + 1))) run = 2;
    best = Math.max(best, run);
  }
  return best;
}

function compoundOf(s: string): [string, string] | null {
  for (let i = 3; i <= s.length - 3; i++) {
    const a = s.slice(0, i), b = s.slice(i);
    if (WORDS.has(a) && WORDS.has(b)) return [a, b];
  }
  return null;
}

/**
 * How rare a name feels, from signals anyone can check: length, digits and hyphens, how easily it is said, whether it is a real word,
 * small bonuses for palindromes and repeats, and a nudge for sought-after extensions. Pure and deterministic.
 */
export function nameQuality(domain: string): NameQuality {
  const { label, tld } = splitLabel(normalizeDomain(domain));
  const reasons: string[] = [];
  let score = 0;
  const len = label.length;
  const lp = LENGTH_POINTS[len] ?? 0;
  score += lp;
  if (len <= 4) reasons.push(`Very short: ${len} ${len === 1 ? "character" : "characters"}`);
  else if (len <= 6) reasons.push(`Short: ${len} characters`);
  else if (len <= 9) reasons.push(`Medium length: ${len} characters`);
  else reasons.push(`Long: ${len} characters`);

  const digits = (label.match(/[0-9]/g) ?? []).length;
  const hyphens = (label.match(/-/g) ?? []).length;
  if (!digits && !hyphens) { score += 10; reasons.push("No digits or hyphens"); }
  else {
    score -= Math.min(30, (digits ? 12 : 0) + hyphens * 10);
    reasons.push(digits && hyphens ? "Has digits and hyphens" : digits ? "Has digits" : "Has hyphens");
  }

  const letters = label.replace(/[^a-z]/g, "");
  if (letters.length) {
    const v = (letters.match(/[aeiouy]/g) ?? []).length / letters.length;
    const run = hardConsonantRun(label);
    if (v === 0) { score -= 15; reasons.push("No vowels"); }
    else if (run >= 4) { score -= 12; reasons.push("Hard to say"); }
    else if (run === 3) { score -= 4; reasons.push("A little hard to say"); }
    else if (v >= 0.25 && v <= 0.67) { score += 10; reasons.push("Easy to say"); }
  }

  if (letters === label && WORDS.has(label)) { score += 22; reasons.push("A real word"); }
  else if (letters === label && compoundOf(label)) { score += 10; reasons.push("Two words joined"); }

  if (letters === label && len >= 3 && label === [...label].reverse().join("")) { score += 6; reasons.push("Reads the same both ways"); }
  else if (len >= 4 && len % 2 === 0 && label.slice(0, len / 2) === label.slice(len / 2)) { score += 3; reasons.push("A repeated sound"); }

  const tp = TLD_POINTS[tld] ?? 0;
  if (tp) { score += tp; reasons.push(`.${tld} is sought after`); }

  score = Math.max(0, Math.min(100, score));
  const tier: Tier = score >= TIER_MIN.legendary ? "legendary" : score >= TIER_MIN.rare ? "rare" : score >= TIER_MIN.uncommon ? "uncommon" : "common";
  return { score, tier, reasons };
}
