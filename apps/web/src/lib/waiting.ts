import { api } from "./api";

/**
 * What waits for the owner's decision, from either source: a token's request (register, renew, sensitive DNS, more access) and a
 * recipe plan a token made that needs the passkey. Server values only, shown as text. Small on purpose: it is in the first load,
 * because the Account button and the page show the count.
 */
export interface Waiting { id: string; source: "request" | "recipe"; fqdn: string | null; domainId: string | null; requester: string | null; what: string; at: number }

const RECIPE_TITLE: Record<string, string> = { "hosting-vercel": "Host on Vercel", "email-resend": "Email with Resend", "postgres-neon": "Postgres on Neon" };
interface Req { id: string; kind: string; domain: { unicode: string; ascii: string } | null; years: number | null; requester: { name: string }; requested_at?: string }
interface Plan { id: string; recipe: string; domain: string; domain_id: string; requester: string | null; created_at?: string }
const time = (s: string | undefined) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : 0; };

function words(r: Req): string {
  const d = r.domain?.unicode ?? "a name";
  if (r.kind === "register") return `register ${d}`;
  if (r.kind === "renew") return `renew ${d}`;
  if (r.kind === "dns_change") return `change DNS records on ${d}`;
  return "get more access";
}

export async function loadWaiting(): Promise<Waiting[]> {
  const [a, b] = await Promise.allSettled([
    api<{ approvals: Req[] }>("GET", "/api/v1/approvals?state=pending"),
    api<{ applications: Plan[] }>("GET", "/api/v1/recipe-applications/waiting"),
  ]);
  const out: Waiting[] = [];
  if (a.status === "fulfilled") for (const r of a.value.approvals ?? []) out.push({ id: r.id, source: "request", fqdn: r.domain?.ascii ?? null, domainId: null, requester: r.requester?.name ?? null, what: words(r), at: time(r.requested_at) });
  if (b.status === "fulfilled") for (const p of b.value.applications ?? []) out.push({ id: p.id, source: "recipe", fqdn: p.domain, domainId: p.domain_id, requester: p.requester, what: `run ${RECIPE_TITLE[p.recipe] ?? "a recipe"} on ${p.domain}`, at: time(p.created_at) });
  // Newest first, whichever kind it is: the page's notice names the first one as the newest.
  return out.sort((x, y) => y.at - x.at);
}

/** One line for a person: who asks, and for what. */
export const sayWaiting = (w: Waiting) => `${w.requester ? `Your token "${w.requester}"` : "One of your tokens"} asks to ${w.what}.`;
