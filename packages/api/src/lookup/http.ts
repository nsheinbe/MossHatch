import { LAUNCH_TLDS, normalizeLabel } from "../search/labels.ts";
import { RdapDirectory, rdapStatus, type Fetch, type LookupStatus } from "./rdap.ts";

/**
 * GET /api/lookup?name=<label> (or POST {"name": "<label>"}, the web app's form) — the preview's "is this name already registered?" check, served by api/index.ts before (and
 * independently of) the full API boot. No database, no registrar, no price: for each of the six preview extensions it asks that
 * registry's public RDAP service and answers `registered`, `unregistered` or `unknown` (lookup/rdap.ts).
 *
 * Limits (per function instance, in memory):
 *   - each network (an IPv4 address, or an IPv6 /64) may make 20 lookups a minute and 200 an hour; over that: 429 with Retry-After;
 *   - an answer is cached for 10 minutes (an `unknown` is not cached), so a repeat search does not ask the registry again;
 *   - at most 12 registry queries in flight, at most 2 per registry server, each given up after 3 seconds;
 *   - at most 300 registry queries a minute and 20,000 a day; past that every answer is `unknown` until the window turns;
 *   - a registry server that answers 429 is left alone for 30 seconds to an hour (its Retry-After, clamped).
 * Privacy: the searched name is never logged, stored or put in an error. It lives only in the in-memory answer cache above.
 */
export const LOOKUP_PATH = "/api/lookup";

export interface LookupOptions {
  fetch?: Fetch;
  now?: () => number;
  timeoutMs?: number;
  perMinute?: number;
  perHour?: number;
  cacheMs?: number;
  cacheMax?: number;
  maxInFlight?: number;
  perServerInFlight?: number;
  upstreamPerMinute?: number;
  upstreamPerDay?: number;
  warn?: (line: string) => void;
}

export interface LookupReply { name: string; results: { tld: string; fqdn: string; status: LookupStatus }[] }

const HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });

/** The rate-limit key: an IPv4 address or an IPv6 /64 (one household's or one phone's whole prefix). */
export function networkKey(r: Request): string {
  const ip = ((r.headers.get("x-forwarded-for") ?? "").split(",")[0] ?? "").trim() || (r.headers.get("x-real-ip") ?? "").trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  if (ip.includes(":")) {
    const head = ip.split("::")[0]!.split(":");
    return head.slice(0, 4).join(":") + "::/64";
  }
  return "unknown";
}

/** The one `name` of a small JSON body, or nothing (which the caller answers as bad_name). */
async function nameFromBody(request: Request): Promise<string[]> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return [];
  const text = await request.text();
  if (text.length > 512) return [];
  try {
    const b = JSON.parse(text) as unknown;
    if (b === null || typeof b !== "object" || Array.isArray(b)) return [];
    const keys = Object.keys(b);
    const v = (b as { name?: unknown }).name;
    return keys.length === 1 && typeof v === "string" ? [v] : [];
  } catch { return []; }
}

/** A counting semaphore whose waiters give up at a deadline. */
class Gate {
  private n = 0;
  private q: (() => void)[] = [];
  private max: number;
  constructor(max: number) { this.max = max; }
  async enter(deadline: number, now: () => number): Promise<boolean> {
    if (this.n < this.max) { this.n++; return true; }
    return new Promise<boolean>((resolve) => {
      const go = () => { clearTimeout(t); this.n++; resolve(true); };
      const t = setTimeout(() => { const i = this.q.indexOf(go); if (i >= 0) this.q.splice(i, 1); resolve(false); }, Math.max(0, deadline - now()));
      this.q.push(go);
    });
  }
  leave() { this.n--; const next = this.q.shift(); if (next) next(); }
}

interface Window { start: number; count: number }

/** One label's answers, for callers inside the API (the public MCP search): the same limits, cache and registry budget as the page's. */
export type LabelLookup = { ok: true; results: LookupReply["results"] } | { ok: false; retryAfter: number };
export interface LookupService {
  /** The /api/lookup route: null for any other path. */
  handle(request: Request): Promise<Response | null>;
  /** Look up one normalized label for the given extensions (default: all six), counted against `key`'s network limits. */
  label(label: string, key: string, tlds?: readonly string[]): Promise<LabelLookup>;
}

export function createLookup(o: LookupOptions = {}): (request: Request) => Promise<Response | null> {
  return createLookupService(o).handle;
}

export function createLookupService(o: LookupOptions = {}): LookupService {
  const f: Fetch = o.fetch ?? ((u, i) => fetch(u, i));
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 3000;
  const perMinute = o.perMinute ?? 20, perHour = o.perHour ?? 200;
  const cacheMs = o.cacheMs ?? 10 * 60_000, cacheMax = o.cacheMax ?? 10_000;
  const upstreamPerMinute = o.upstreamPerMinute ?? 300, upstreamPerDay = o.upstreamPerDay ?? 20_000;
  const dir = new RdapDirectory({ fetch: f, now, timeoutMs, warn: o.warn });
  const all = new Gate(o.maxInFlight ?? 12);
  const servers = new Map<string, Gate>();
  const backoff = new Map<string, number>();
  const cache = new Map<string, { status: LookupStatus; until: number }>();
  const inflight = new Map<string, Promise<LookupStatus>>();
  const rate = new Map<string, { minute: Window; hour: Window }>();
  const up = { minute: { start: 0, count: 0 }, day: { start: 0, count: 0 } };
  let lastSweep = 0;

  const tick = (w: Window, len: number, t: number) => { if (t - w.start >= len) { w.start = t; w.count = 0; } };

  /** Count one lookup for a network. Returns seconds to wait when over a limit. */
  function admit(key: string): number | null {
    const t = now();
    if (t - lastSweep > 60_000 || rate.size > 50_000) {
      lastSweep = t;
      for (const [k, v] of rate) if (t - v.hour.start >= 3600_000) rate.delete(k);
      for (const [k, v] of cache) if (v.until <= t) cache.delete(k);
    }
    let r = rate.get(key);
    if (!r) { r = { minute: { start: t, count: 0 }, hour: { start: t, count: 0 } }; rate.set(key, r); }
    tick(r.minute, 60_000, t); tick(r.hour, 3600_000, t);
    if (r.hour.count >= perHour) return Math.ceil((r.hour.start + 3600_000 - t) / 1000);
    if (r.minute.count >= perMinute) return Math.ceil((r.minute.start + 60_000 - t) / 1000);
    r.minute.count++; r.hour.count++;
    return null;
  }

  function upstreamAllowed(): boolean {
    const t = now();
    tick(up.minute, 60_000, t); tick(up.day, 24 * 3600_000, t);
    if (up.minute.count >= upstreamPerMinute || up.day.count >= upstreamPerDay) return false;
    up.minute.count++; up.day.count++;
    return true;
  }

  async function check(tld: string, fqdn: string): Promise<LookupStatus> {
    const hit = cache.get(fqdn);
    if (hit && hit.until > now()) return hit.status;
    const base = dir.base(tld);
    if (!base) return "unknown";
    const server = new URL(base).host;
    if ((backoff.get(server) ?? 0) > now()) return "unknown";
    const deadline = now() + timeoutMs;
    if (!(await all.enter(deadline, now))) return "unknown";
    try {
      let g = servers.get(server);
      if (!g) { g = new Gate(o.perServerInFlight ?? 2); servers.set(server, g); }
      if (!(await g.enter(deadline, now))) return "unknown";
      try {
        if ((backoff.get(server) ?? 0) > now() || !upstreamAllowed()) return "unknown";
        const r = await rdapStatus(f, base, fqdn, timeoutMs);
        if (r.retryAfterMs) backoff.set(server, now() + r.retryAfterMs);
        if (r.status !== "unknown") {
          if (cache.size >= cacheMax) cache.delete(cache.keys().next().value!);
          cache.set(fqdn, { status: r.status, until: now() + cacheMs });
        }
        return r.status;
      } finally { g.leave(); }
    } finally { all.leave(); }
  }

  /** Concurrent lookups of the same name share one registry query. */
  function checkOnce(tld: string, fqdn: string): Promise<LookupStatus> {
    const p = inflight.get(fqdn);
    if (p) return p;
    const q = check(tld, fqdn).catch(() => "unknown" as const).finally(() => inflight.delete(fqdn));
    inflight.set(fqdn, q);
    return q;
  }

  async function label(raw: string, key: string, tlds: readonly string[] = LAUNCH_TLDS): Promise<LabelLookup> {
    const wait = admit(key);
    if (wait !== null) return { ok: false, retryAfter: Math.max(1, wait) };
    const want = LAUNCH_TLDS.filter((t) => tlds.includes(t));
    const results = await Promise.all(want.map(async (tld) => {
      const fqdn = `${raw}.${tld}`;
      return { tld, fqdn, status: await checkOnce(tld, fqdn) };
    }));
    return { ok: true, results };
  }

  const handle = async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname.replace(/\/$/, "") !== LOOKUP_PATH) return null;
    try {
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") return json(405, { error: { code: "method_not_allowed" } }, { allow: "GET, POST" });
      // Same-site use only: the page calls this; another site's page may not use it as an RDAP relay. (curl sends no such header.)
      const site = request.headers.get("sec-fetch-site");
      if (site && site !== "same-origin" && site !== "none") return json(403, { error: { code: "cross_site" } });
      // Vercel's rewrite (vercel.json "/api/:path*" -> "/api/index") adds the captured segment as `path`; it carries nothing of the caller's.
      const post = request.method === "POST";
      for (const k of url.searchParams.keys()) if ((post || k !== "name") && k !== "path") return json(400, { error: { code: "bad_request" } });
      // The web app POSTs {"name": "..."} so the name is never part of a URL, and so never in our host's request logs
      // (docs/AUDIT-2026-10-07.md V1). GET ?name= still works for anyone calling it by hand.
      const raw = post ? await nameFromBody(request) : url.searchParams.getAll("name");
      const name = raw.length === 1 ? normalizeLabel(raw[0]!) : ({ ok: false } as const);
      if (!name.ok) return json(400, { error: { code: "bad_name" } });
      const out = await label(name.label, networkKey(request));
      if (!out.ok) return json(429, { error: { code: "rate_limited" } }, { "retry-after": String(out.retryAfter) });
      const body: LookupReply = { name: name.label, results: out.results };
      return json(200, body);
    } catch (e) {
      o.warn?.(`lookup.error ${(e as Error).name}`);
      return json(500, { error: { code: "internal" } });
    }
  };
  return { handle, label };
}

let shared: LookupService | undefined;

/** The one lookup of this function instance: the page's route and the public MCP search share its limits, cache and registry budget. */
export function sharedLookup(): LookupService {
  shared ??= createLookupService({ warn: (l) => console.warn(l) });
  return shared;
}
/** Tests: replace the shared instance (a fake registry fetch); `undefined` puts the default back on next use. */
export function setSharedLookup(s: LookupService | undefined): void { shared = s; }

/** api/index.ts: answer /api/lookup here, or return null to let the full API (or its 503) answer. */
export function handleLookup(request: Request, _env: Record<string, string | undefined> = {}): Promise<Response | null> {
  if (new URL(request.url).pathname.replace(/\/$/, "") !== LOOKUP_PATH) return Promise.resolve(null);
  return sharedLookup().handle(request);
}
