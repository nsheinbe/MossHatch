import { domainToUnicode } from "node:url";

/**
 * The publish gate's name screen (C-68, PLAN 4.8, threat row 42). Two parts:
 *   1. In-house: mixed-script and look-alike labels, and names that imitate a known brand or pair one with a sign-in word.
 *   2. Google Web Risk Lookup (the Safe Browsing API is non-commercial only). The verdict is used and dropped: Web Risk terms forbid
 *      redistributing it, so only a monthly lookup count is stored.
 * A refusal names a reason code, never the matched brand.
 */

export type ScreenReason = "mixed_script" | "brand_lookalike" | "web_risk_flagged";
export type ScreenVerdict = { ok: true } | { ok: false; reason: ScreenReason };

/** Brands commonly imitated in phishing, plus our own two names. Kept short on purpose: this is a floor, not a trade-mark register. */
export const BRANDS: readonly string[] = [
  "paypal", "google", "apple", "icloud", "microsoft", "outlook", "office365", "amazon", "facebook", "instagram", "whatsapp", "netflix",
  "stripe", "coinbase", "binance", "metamask", "github", "gitlab", "vercel", "cloudflare", "openai", "anthropic", "linkedin", "dropbox",
  "docusign", "chase", "wellsfargo", "bankofamerica", "citibank", "americanexpress", "mosshatch", "hatchkind",
];
const LURE_WORDS = ["login", "signin", "logon", "secure", "verify", "verification", "account", "support", "wallet", "update", "billing", "recovery", "unlock", "auth"];

/** Characters that read as Latin letters: digits and symbols people substitute, and Cyrillic and Greek look-alikes. */
const CONFUSABLE: Record<string, string> = {
  "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "$": "s", "@": "a",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "һ": "h", "ԁ": "d", "ӏ": "l", "ԛ": "q", "ԝ": "w",
  "α": "a", "ο": "o", "ρ": "p", "ν": "v", "τ": "t", "ι": "i", "κ": "k", "χ": "x", "ε": "e",
};

export function skeleton(label: string): string {
  let s = "";
  for (const ch of label.normalize("NFKC").toLowerCase()) s += CONFUSABLE[ch] ?? ch;
  return s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d").replace(/-/g, "");
}

function scripts(label: string): Set<string> {
  const out = new Set<string>();
  for (const ch of label) {
    if (/[0-9-]/.test(ch)) continue;
    if (/\p{Script=Latin}/u.test(ch)) out.add("latin");
    else if (/\p{Script=Cyrillic}/u.test(ch)) out.add("cyrillic");
    else if (/\p{Script=Greek}/u.test(ch)) out.add("greek");
    else if (/\p{Script=Han}/u.test(ch)) out.add("han");
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) out.add("kana");
    else if (/\p{Script=Hangul}/u.test(ch)) out.add("hangul");
    else if (/\p{Script=Arabic}/u.test(ch)) out.add("arabic");
    else out.add("other");
  }
  return out;
}

/** Restricted Damerau-Levenshtein distance, stopping early above `max`. */
export function distance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

const BRAND_SKELETONS = BRANDS.map(skeleton);

/** The in-house screen over an ASCII (punycode) name. */
export function screenName(fqdnAscii: string): ScreenVerdict {
  const unicode = domainToUnicode(fqdnAscii) || fqdnAscii;
  const labels = unicode.split(".");
  const registrable = labels.slice(0, -1);
  for (const label of registrable) {
    const s = scripts(label);
    // Latin mixed with any other script is the classic homograph. A wholly non-Latin label is allowed but still meets the brand check below.
    if (s.size > 1) return { ok: false, reason: "mixed_script" };
  }
  for (const label of registrable) {
    const sk = skeleton(label);
    for (const brand of BRAND_SKELETONS) {
      // The brand itself or a disguised copy of it (not ours to show), a one-edit typo of it, or the brand beside a sign-in word.
      if (sk === brand) return { ok: false, reason: "brand_lookalike" };
      if (brand.length >= 5 && distance(sk, brand, 1) <= 1) return { ok: false, reason: "brand_lookalike" };
      if (sk.includes(brand) && LURE_WORDS.some((w) => sk.includes(w))) return { ok: false, reason: "brand_lookalike" };
    }
  }
  return { ok: true };
}

/** Google Web Risk Lookup. */
export interface WebRiskPort {
  readonly kind: "fake" | "google";
  /** true when the URL is on a threat list. Throws when the service cannot answer (the gate then fails closed). */
  isFlagged(url: string): Promise<boolean>;
}

export class FakeWebRisk implements WebRiskPort {
  readonly kind = "fake" as const;
  flagged = new Set<string>();
  down = false;
  lookups = 0;
  async isFlagged(url: string) { this.lookups++; if (this.down) throw new Error("web_risk_unavailable"); return this.flagged.has(url); }
}

/**
 * The real adapter. NEVER CALLED here (no API key exists in this container). Request shape from Google's documentation as read,
 * unverified: GET https://webrisk.googleapis.com/v1/uris:search?threatTypes=MALWARE&threatTypes=SOCIAL_ENGINEERING&threatTypes=UNWANTED_SOFTWARE&uri=<url>&key=<key>,
 * answering `{}` when clean and `{ "threat": { "threatTypes": [...], "expireTime": ... } }` when listed.
 */
export class GoogleWebRisk implements WebRiskPort {
  readonly kind = "google" as const;
  constructor(private key: string, private f: typeof fetch = fetch) { if (!key || key.length < 20) throw new Error("web_risk_not_configured"); }
  async isFlagged(url: string) {
    const q = new URLSearchParams();
    for (const t of ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"]) q.append("threatTypes", t);
    q.set("uri", url); q.set("key", this.key);
    const res = await this.f(`https://webrisk.googleapis.com/v1/uris:search?${q}`, { method: "GET" });
    if (!res.ok) throw new Error(`web_risk_${res.status}`);
    const j = (await res.json()) as { threat?: unknown };
    return j.threat !== undefined && j.threat !== null;
  }
}
