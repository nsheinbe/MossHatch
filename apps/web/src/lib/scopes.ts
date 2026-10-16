/**
 * The everyday access choices for a token or a connected app, in plain words, shared by the token form and the consent screen.
 * Each choice is one or more scope strings for one name or for every name (`*`); anything narrower or rarer goes in Advanced as
 * typed scopes. The server parses and lints every string again (bindings/scopes.ts), so nothing here is trusted.
 */
export interface Choice { id: string; label: string; hint?: string; scopes: (name: string) => string[] }

export const CHOICES: readonly Choice[] = [
  { id: "see", label: "See my names", hint: "Names, expiry dates and settings.", scopes: (n) => [`domains.read:${n}`] },
  { id: "dns-read", label: "Read DNS records", scopes: (n) => [`dns.read:${n}`] },
  { id: "dns-write", label: "Change DNS records", hint: "Changes to mail, nameservers and other sensitive records still wait for your passkey.", scopes: (n) => [`dns.write:${n}`] },
  {
    id: "recipes", label: "Connect names to Vercel, Resend or Neon",
    hint: "Runs the recipes on a name's Connect tab: it writes their DNS records and stores the keys they need in your Nest, for development and preview only. Anything sensitive waits for your passkey.",
    scopes: (n) => [`recipes.plan:${n}`, `recipes.apply:${n}:*`, `dns.write:${n}`, `secrets.write:${n}:*`],
  },
  // Buying is about names you do not own yet, so this one always covers every name.
  { id: "buy", label: "Suggest names to buy", hint: "Nothing is bought until you approve it with your passkey and pay on Stripe.", scopes: () => ["register.propose:*"] },
  { id: "renew", label: "Suggest renewals", hint: "You approve each one.", scopes: (n) => [`renew.propose:${n}`] },
  { id: "transfer", label: "Check transfers in progress", scopes: (n) => [`transfer.status:${n}`] },
];

/** The scope strings for the ticked choices, on one name or `*`. */
export const scopesFor = (picks: readonly string[], name: string): string[] => [...new Set(CHOICES.filter((c) => picks.includes(c.id)).flatMap((c) => c.scopes(name)))];

/** Whether any of these scopes lets the token ask you to pay, so a spend cap means something. */
export const canSpend = (scopes: readonly string[]) => scopes.some((x) => /^(register|renew)\.propose:/.test(x));

/** Split scopes an app asked for into ticked choices (on `*` or one name) and the rest, which go to Advanced as typed. */
export function picksFrom(scopes: readonly string[]): { picks: string[]; name: string; rest: string[] } {
  const res = [...new Set(scopes.map((s) => s.split(":")[1] ?? "").filter((r) => r && r !== "*"))];
  const name = res.length === 1 ? res[0]! : "*";
  // Each choice is matched against the whole request: two choices may share a scope (dns.write is in both DNS and recipes).
  const asked = new Set(scopes);
  const chosen = CHOICES.filter((c) => c.scopes(name).every((s) => asked.has(s)));
  const covered = new Set(chosen.flatMap((c) => c.scopes(name)));
  return { picks: chosen.map((c) => c.id), name, rest: [...asked].filter((s) => !covered.has(s)) };
}

/** Lines of a textarea or a list typed with commas. */
export const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
/** Dollars typed by a person, in cents (an empty or unreadable entry is 0). */
export const minor = (dollars: string) => { const n = Number((dollars || "0").replace(/[$,\s]/g, "")); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0; };

const WORDS: Record<string, string> = {
  "domains.read": "See names", "dns.read": "Read DNS", "dns.write": "Change DNS", "nest.names": "List secret names", "secrets.read": "Read secrets",
  "secrets.write": "Write secrets", "recipes.plan": "Plan recipes", "recipes.apply": "Run recipes", "register.propose": "Suggest names to buy",
  "renew.propose": "Suggest renewals", "transfer.status": "Check transfers", "mandate.off": "Turn auto-renew off",
};
const ENV_WORD: Record<string, string> = { "*": "development and preview", dev: "development", preview: "preview", prod: "production" };
/** "dns.write:example.com" reads as "Change DNS on example.com"; the raw scope is still shown next to it. */
export function describeScope(raw: string): string {
  const [cap = "", res = "", env] = raw.split(":");
  if (cap === "domains.read") return res === "*" ? "See all names" : `See ${res}`;
  if (cap === "register.propose") return "Suggest names to buy";
  return `${WORDS[cap] ?? cap} ${res === "*" ? "on all names" : `on ${res}`}${env ? `, ${ENV_WORD[env] ?? env}` : ""}`;
}
