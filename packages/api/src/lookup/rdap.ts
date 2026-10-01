import { LAUNCH_TLDS, type LaunchTld } from "../search/labels.ts";

/**
 * Registered or not, from each registry's public RDAP service (RFC 9082/9083). Used only by the preview's /api/lookup
 * (lookup/http.ts): it answers "is this name in the registry", never "can you buy it" or "for how much".
 *   200 -> registered, 404 -> unregistered, anything else (429, 5xx, a timeout, a network error) -> unknown. Never a guess.
 */
export type LookupStatus = "registered" | "unregistered" | "unknown";
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** IANA's RDAP bootstrap file for DNS (RFC 9224). */
export const IANA_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";

/**
 * Baked-in RDAP base URLs for the six preview extensions, used until (and whenever) the IANA file cannot be read. Checked live on
 * 2026-10-01 against the IANA file published 2026-09-30 (a registered and an unregistered name each). `.io` is a country-code
 * extension and is not in the IANA file; its registry operator (Identity Digital) answers for it at the same service as `.ai`.
 */
export const FALLBACK_RDAP: Readonly<Record<LaunchTld, string>> = {
  com: "https://rdap.verisign.com/com/v1/",
  dev: "https://pubapi.registry.google/rdap/",
  app: "https://pubapi.registry.google/rdap/",
  studio: "https://rdap.identitydigital.services/rdap/",
  io: "https://rdap.identitydigital.services/rdap/",
  ai: "https://rdap.identitydigital.services/rdap/",
};

const withSlash = (u: string) => (u.endsWith("/") ? u : u + "/");

/** The launch extensions' base URLs from an IANA bootstrap document (https only; the first https URL listed wins). */
export function parseBootstrap(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const services = (json as { services?: unknown })?.services;
  if (!Array.isArray(services)) return out;
  for (const s of services) {
    if (!Array.isArray(s) || !Array.isArray(s[0]) || !Array.isArray(s[1])) continue;
    const url = (s[1] as unknown[]).find((u): u is string => typeof u === "string" && /^https:\/\/[^\s/]+\//.test(withSlash(u)));
    if (!url) continue;
    for (const t of s[0] as unknown[]) {
      if (typeof t === "string" && (LAUNCH_TLDS as readonly string[]).includes(t.toLowerCase())) out.set(t.toLowerCase(), withSlash(url));
    }
  }
  return out;
}

export interface DirectoryDeps { fetch: Fetch; now: () => number; timeoutMs: number; ttlMs?: number; retryMs?: number; warn?: (line: string) => void }

/**
 * Which RDAP server answers for an extension. The IANA file is read in the background on first use and then once a day (a failed
 * read is retried after ten minutes); until it has been read, and for any extension it does not list, the baked-in map answers.
 */
export class RdapDirectory {
  private map: Map<string, string> | null = null;
  private loadedAt = 0;
  private nextTry = 0;
  private loading: Promise<void> | null = null;
  private d: DirectoryDeps;
  constructor(d: DirectoryDeps) { this.d = d; }

  base(tld: string): string | null {
    const now = this.d.now();
    const stale = !this.map || now - this.loadedAt > (this.d.ttlMs ?? 24 * 3600_000);
    if (stale && !this.loading && now >= this.nextTry) this.loading = this.load().finally(() => { this.loading = null; });
    return this.map?.get(tld) ?? (FALLBACK_RDAP as Record<string, string>)[tld] ?? null;
  }

  /** Tests: wait for a background read of the IANA file to finish. */
  async settled(): Promise<void> { await this.loading; }

  private async load(): Promise<void> {
    try {
      const res = await withTimeout(this.d.fetch, IANA_BOOTSTRAP, { headers: { accept: "application/json" } }, this.d.timeoutMs);
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new Error("status " + res.status); }
      const map = parseBootstrap(await res.json());
      if (map.size === 0) throw new Error("empty");
      this.map = map;
      this.loadedAt = this.d.now();
    } catch (e) {
      this.nextTry = this.d.now() + (this.d.retryMs ?? 10 * 60_000);
      this.d.warn?.(`lookup.bootstrap_failed ${(e as Error).name}`);
    }
  }
}

/** A fetch that gives up after `ms`, whether or not the fetch honours the abort signal. */
export async function withTimeout(f: Fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error("timeout")); }, ms); });
  try { return await Promise.race([f(url, { ...init, signal: ac.signal }), timeout]); }
  finally { clearTimeout(timer); }
}

/** One RDAP domain query. `retryAfterMs` is set when the server said 429 (how long to leave that server alone). */
export async function rdapStatus(f: Fetch, base: string, fqdn: string, timeoutMs: number): Promise<{ status: LookupStatus; retryAfterMs?: number }> {
  let res: Response;
  try { res = await withTimeout(f, `${base}domain/${fqdn}`, { headers: { accept: "application/rdap+json, application/json" }, redirect: "follow" }, timeoutMs); }
  catch { return { status: "unknown" }; }
  // The body is not needed: the status code is the answer. Drop it so the connection is freed.
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 200) return { status: "registered" };
  if (res.status === 404) return { status: "unregistered" };
  if (res.status === 429) {
    const s = Number(res.headers.get("retry-after"));
    return { status: "unknown", retryAfterMs: Math.min(Math.max(Number.isFinite(s) && s > 0 ? s * 1000 : 60_000, 30_000), 3600_000) };
  }
  return { status: "unknown" };
}
