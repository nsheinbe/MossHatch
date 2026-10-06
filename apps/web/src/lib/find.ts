import { formatUsd, usd, splitDomain } from "@mosshatch/core";
import { EXTENSIONS } from "@mosshatch/registrar";
import type { LookupStatus, Result } from "../store";
import { api } from "./api";

/** Lowercase letters, digits and hyphens; 1 to 63 characters; no leading or trailing hyphen. */
export function parseQuery(raw: string): { label: string; tld?: string } | null {
  let v = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\s+/g, "");
  const { label, tld } = splitDomain(v);
  v = label.replace(/[^a-z0-9-]/g, "");
  v = v.replace(/^-+/, "").replace(/-+$/, "").slice(0, 63);
  if (!v) return null;
  return { label: v, tld: (EXTENSIONS as readonly string[]).includes(tld) ? tld : undefined };
}

/**
 * Whether each extension of a name is already registered, from our /api/lookup (which asks each registry's public RDAP service:
 * packages/api/src/lookup). Anything it cannot answer, or a failed request, is "unknown"; this never guesses. Answers are kept in
 * memory for five minutes so retyping a name does not ask again.
 */
const memo = new Map<string, { at: number; statuses: Map<string, LookupStatus> }>();
async function lookup(label: string): Promise<Map<string, LookupStatus>> {
  const hit = memo.get(label);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.statuses;
  const statuses = new Map<string, LookupStatus>();
  try {
    const res = await fetch(`/api/lookup?name=${encodeURIComponent(label)}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!res.ok) return statuses;
    const body = (await res.json()) as { results?: { tld?: unknown; status?: unknown }[] };
    for (const r of body.results ?? []) {
      if (typeof r.tld === "string" && (r.status === "registered" || r.status === "unregistered" || r.status === "unknown")) statuses.set(r.tld, r.status);
    }
  } catch { return statuses; }
  if ([...statuses.values()].every((s) => s !== "unknown") && statuses.size > 0) {
    if (memo.size >= 50) memo.delete(memo.keys().next().value!);
    memo.set(label, { at: Date.now(), statuses });
  }
  return statuses;
}

/** The preview's search: real registered-or-not answers from the public registries, and no price (prices are set at launch). */
export async function search(raw: string): Promise<{ results: Result[]; alternatives: string[] } | null> {
  const q = parseQuery(raw);
  if (!q) return null;
  const order = q.tld ? [q.tld, ...EXTENSIONS.filter((e) => e !== q.tld)] : [...EXTENSIONS];
  const statuses = await lookup(q.label);
  const results: Result[] = order.map((tld) => {
    const status = statuses.get(tld) ?? "unknown";
    const published = staticPrices().find(p => p.tld === tld);
    return { price: published?.price, renewal: published?.renewal, domain: `${q.label}.${tld}`, tld, status, available: status === "unregistered", sample: true, years: tld === "ai" ? 2 : 1 };
  });
  return { results, alternatives: [] };
}

export function staticPrices(): { tld: string; price: string; years: number; renewal: string }[] {
  return __MH_PREVIEW_PRICES__.map(p => ({...p}));
}

interface ServerSearch { results: { fqdn: string; tld: string; kind: string; source: string; unconfirmed?: boolean; price: { years: number; subtotal_minor: string } | null }[] }

/** With a backend behind the page, prices come from the server (the effective-dated table), never from the sample table. */
export async function searchLive(raw: string, onlyCom = false): Promise<{ results: Result[]; alternatives: string[] } | null> {
  const q = parseQuery(raw);
  if (!q) return null;
  const order = onlyCom ? ["com"] : q.tld ? [q.tld, ...EXTENSIONS.filter((e) => e !== q.tld)] : [...EXTENSIONS];
  const out = await api<ServerSearch>("GET", `/api/v1/search?name=${encodeURIComponent(q.label)}&tlds=${order.join(",")}`);
  const byTld = new Map(out.results.map((r) => [r.tld, r]));
  const results: Result[] = order.filter((t) => byTld.has(t)).map((tld) => {
    const r = byTld.get(tld)!;
    const avail = r.kind === "available" && !!r.price && !r.unconfirmed;
    return {
      domain: r.fqdn, tld, available: avail, sample: r.source === "sample",
      status: r.kind === "taken" ? "registered" : avail ? "unregistered" : "unknown",
      price: avail ? formatUsd(usd(Number(r.price!.subtotal_minor))) : undefined, years: r.price?.years ?? 1,
    };
  });
  return { results, alternatives: [] };
}

/** `wholesale` is the registrar price the customer pays for: this year's upstream price raised to the renewal price when that is higher (`heldAtRenewal`). */
export interface LiveQuote { domain: string; expiresAt: string; subtotal: string; wholesale: string; fee: string; taxCeiling: string; years: number; heldAtRenewal: boolean }
export async function liveQuote(fqdn: string, years: number): Promise<LiveQuote | null> {
  const out = await api<{ availability?: { kind: string; unconfirmed?: boolean }; quote: { fqdn: string; expires_at: string; subtotal_minor: string; wholesale_minor: string; registrar_price_minor?: string; renewal_level_minor?: string; fee_minor: string; tax_ceiling_minor: string; years: number } | null }>("GET", `/api/v1/quote?domain=${encodeURIComponent(fqdn)}&years=${years}`);
  if (!out.quote || out.quote.fqdn !== fqdn || out.availability?.kind !== "available" || out.availability.unconfirmed) return null;
  const f = (m: string) => formatUsd(usd(Number(m)));
  return {
    domain: out.quote.fqdn, expiresAt: out.quote.expires_at, subtotal: f(out.quote.subtotal_minor), wholesale: f(out.quote.registrar_price_minor ?? out.quote.wholesale_minor), fee: f(out.quote.fee_minor), taxCeiling: f(out.quote.tax_ceiling_minor), years: out.quote.years,
    heldAtRenewal: Number(out.quote.renewal_level_minor ?? "0") > 0,
  };
}

