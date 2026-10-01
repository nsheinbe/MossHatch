import { afterEach, describe, expect, it, vi } from "vitest";
import { createLookup, networkKey, type LookupOptions, type LookupReply } from "./http.ts";
import { FALLBACK_RDAP, IANA_BOOTSTRAP, RdapDirectory, parseBootstrap, type Fetch } from "./rdap.ts";
import { fakeRdapFetch } from "./fake.ts";

/** No network: every test hands the handler its own fetch. */
type Script = (url: string, init?: RequestInit) => Promise<Response> | Response;
function rig(script: Script, opts: Partial<LookupOptions> = {}) {
  const calls: string[] = [];
  const f: Fetch = async (u, i) => { calls.push(u); return script(u, i); };
  let t = 1_000_000;
  const warn = vi.fn<(l: string) => void>();
  const h = createLookup({ fetch: f, now: () => t, timeoutMs: 50, warn, ...opts });
  const get = async (q: string, headers: Record<string, string> = {}) => (await h(new Request(`https://mosshatch.com/api/lookup${q}`, { headers: { "x-forwarded-for": "203.0.113.7", ...headers } })))!;
  return { calls, warn, get, h, advance: (ms: number) => { t += ms; } };
}
const iana503: Script = (u) => (u === IANA_BOOTSTRAP ? new Response(null, { status: 503 }) : new Response(null, { status: 404 }));
const statusOf = async (r: Response) => Object.fromEntries(((await r.json()) as LookupReply).results.map((x) => [x.tld, x.status]));
const rdapCalls = (calls: string[]) => calls.filter((c) => c !== IANA_BOOTSTRAP);

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("GET /api/lookup", () => {
  it("200 means registered and 404 means unregistered, for each of the six extensions, from the right RDAP server", async () => {
    const { get, calls } = rig((u) => u === IANA_BOOTSTRAP ? new Response(null, { status: 503 }) : new Response("{}", { status: /moonfern\.(com|studio)$/.test(u) ? 200 : 404 }));
    const r = await get("?name=MoonFern");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toBe("application/json");
    const body = (await r.clone().json()) as LookupReply;
    expect(body.name).toBe("moonfern");
    expect(await statusOf(r)).toEqual({ com: "registered", studio: "registered", dev: "unregistered", app: "unregistered", io: "unregistered", ai: "unregistered" });
    expect(rdapCalls(calls).sort()).toEqual(Object.entries(FALLBACK_RDAP).map(([t, b]) => `${b}domain/moonfern.${t}`).sort());
  });

  it("429, 5xx, a timeout and a network error are unknown, never a guess; a 429 leaves that server alone for a while", async () => {
    const script: Script = (u, init) => {
      if (u === IANA_BOOTSTRAP) return new Response(null, { status: 503 });
      if (u.endsWith(".com")) return new Response(null, { status: 429, headers: { "retry-after": "40" } });
      if (u.endsWith(".dev")) return new Response(null, { status: 500 });
      if (u.endsWith(".app")) return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      if (u.endsWith(".studio")) return new Promise<Response>(() => undefined);   // never answers and ignores the signal
      if (u.endsWith(".io")) throw new TypeError("fetch failed");
      return new Response(null, { status: 302 });
    };
    const { get, calls, advance } = rig(script);
    expect(await statusOf(await get("?name=fernlight"))).toEqual({ com: "unknown", dev: "unknown", app: "unknown", studio: "unknown", io: "unknown", ai: "unknown" });
    // Unknown answers are not cached; the 429'd server is not asked again during its back-off.
    const before = rdapCalls(calls).length;
    await get("?name=fernlight");
    const again = rdapCalls(calls).slice(before);
    expect(again.some((u) => u.includes("verisign"))).toBe(false);
    expect(again.length).toBeGreaterThan(0);
    advance(41_000);
    const n = rdapCalls(calls).length;
    await get("?name=fernlight");
    expect(rdapCalls(calls).slice(n).some((u) => u.includes("verisign"))).toBe(true);
  });

  it("refuses bad input: missing, empty, too long, dots, spaces, Unicode, punycode, hyphen ends, extra parameters, other methods", async () => {
    const { get, h, calls } = rig(iana503);
    for (const q of ["", "?name=", "?name=" + "a".repeat(64), "?name=moon.fern", "?name=moon%20fern", "?name=m%C3%B6%C3%B6n", "?name=xn--mn-fka", "?name=-moon", "?name=moon-",
      "?name=moon&name=fern", "?name=moon&tlds=com", "?name=%3Cscript%3E"]) {
      const r = await get(q);
      expect(r.status, q).toBe(400);
    }
    expect((await get("?name=" + "a".repeat(63))).status).toBe(200);
    // As Vercel delivers it in production: the rewrite of /api/:path* to the one function appends `path=lookup`.
    expect((await get("?name=moon&path=lookup")).status).toBe(200);
    const post = await h(new Request("https://mosshatch.com/api/lookup?name=moon", { method: "POST" }));
    expect(post!.status).toBe(405);
    const cross = await get("?name=moon", { "sec-fetch-site": "cross-site" });
    expect(cross.status).toBe(403);
    expect(await h(new Request("https://mosshatch.com/api/lookups?name=moon"))).toBeNull();
    expect(await h(new Request("https://mosshatch.com/api/waitlist"))).toBeNull();
    expect(rdapCalls(calls).every((u) => /domain\/a{63}\.|domain\/moon\./.test(u))).toBe(true);
  });

  it("rate limit: 20 lookups a minute and 200 an hour per network, then 429 with Retry-After; other networks are unaffected", async () => {
    const { get, advance } = rig(iana503);
    for (let i = 0; i < 20; i++) expect((await get(`?name=fern${i}`)).status).toBe(200);
    const over = await get("?name=fern99");
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await get("?name=fern99", { "x-forwarded-for": "198.51.100.1" })).status).toBe(200);
    advance(60_000);
    expect((await get("?name=fern99")).status).toBe(200);
    // The hourly ceiling.
    for (let m = 0; m < 12; m++) { for (let i = 0; i < 20; i++) await get(`?name=h${m}x${i}`); advance(60_000); }
    const hour = await get("?name=late");
    expect(hour.status).toBe(429);
    expect(Number(hour.headers.get("retry-after"))).toBeGreaterThan(60);
  });

  it("caches answers for 10 minutes (not unknowns) and shares one registry query between concurrent lookups", async () => {
    const { get, calls, advance } = rig(iana503);
    await Promise.all([get("?name=fernlight"), get("?name=fernlight", { "x-forwarded-for": "198.51.100.2" })]);
    expect(rdapCalls(calls)).toHaveLength(6);
    advance(9 * 60_000);
    await get("?name=fernlight");
    expect(rdapCalls(calls)).toHaveLength(6);
    advance(2 * 60_000);
    await get("?name=fernlight");
    expect(rdapCalls(calls)).toHaveLength(12);
  });

  it("bounds concurrency: never more than 2 queries in flight per registry server, 12 overall", async () => {
    let now = 0, peak = 0;
    const perHost = new Map<string, number>(); let peakHost = 0;
    const script: Script = async (u) => {
      if (u === IANA_BOOTSTRAP) return new Response(null, { status: 503 });
      const host = new URL(u).host;
      now++; perHost.set(host, (perHost.get(host) ?? 0) + 1);
      peak = Math.max(peak, now); peakHost = Math.max(peakHost, perHost.get(host)!);
      await new Promise((r) => setTimeout(r, 5));
      now--; perHost.set(host, perHost.get(host)! - 1);
      return new Response(null, { status: 404 });
    };
    const { get } = rig(script, { timeoutMs: 2000, perMinute: 1000, perHour: 1000 });
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => get(`?name=burst${i}`)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(peakHost).toBeLessThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(12);
  });

  it("a service-wide ceiling on registry queries: past it, answers are unknown without asking", async () => {
    const { get, calls } = rig(iana503, { upstreamPerMinute: 6, perMinute: 100 });
    expect(Object.values(await statusOf(await get("?name=first")))).toEqual(Array(6).fill("unregistered"));
    const n = rdapCalls(calls).length;
    expect(Object.values(await statusOf(await get("?name=second")))).toEqual(Array(6).fill("unknown"));
    expect(rdapCalls(calls).length).toBe(n);
  });

  it("never logs, or puts in an error, the searched name", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const needle = "secretcanaryfern";
    const { get, warn } = rig((u) => {
      if (u === IANA_BOOTSTRAP) throw new TypeError("fetch failed " + u);
      if (u.endsWith(".com")) throw new Error("boom " + u);
      return new Response(null, { status: u.endsWith(".dev") ? 429 : 404 });
    });
    const bodies: string[] = [];
    for (const q of [`?name=${needle}`, `?name=${needle}&x=1`, `?name=${needle}.com`]) bodies.push(await (await get(q)).text());
    for (let i = 0; i < 25; i++) bodies.push(await (await get(`?name=${needle}${i}`)).text());
    const logged = [...spies.flatMap((s) => s.mock.calls), ...warn.mock.calls].map((c) => c.map(String).join(" ")).join("\n");
    expect(logged.toLowerCase()).not.toContain(needle);
    expect(bodies.filter((b) => b.includes("error")).join("\n")).not.toContain(needle);
  });
});

describe("RDAP directory", () => {
  it("reads the IANA bootstrap file (https only) and prefers it; keeps the baked-in map for extensions it does not list", async () => {
    const doc = { services: [[["com", "net"], ["http://insecure.example/", "https://rdap.example-com.test/v1"]], [["dev", "app"], ["https://rdap.example-google.test/"]], [["zz"], ["https://nope.test/"]]] };
    const m = parseBootstrap(doc);
    expect(Object.fromEntries(m)).toEqual({ com: "https://rdap.example-com.test/v1/", dev: "https://rdap.example-google.test/", app: "https://rdap.example-google.test/" });
    expect(parseBootstrap({}).size).toBe(0);
    expect(parseBootstrap({ services: [[["com"], ["javascript:alert(1)"]]] }).size).toBe(0);

    let t = 0, reads = 0;
    const f: Fetch = async (u) => { if (u === IANA_BOOTSTRAP) { reads++; return Response.json(doc); } return new Response(null, { status: 404 }); };
    const dir = new RdapDirectory({ fetch: f, now: () => t, timeoutMs: 50 });
    expect(dir.base("com")).toBe(FALLBACK_RDAP.com);   // before the file is read
    await dir.settled();
    expect(dir.base("com")).toBe("https://rdap.example-com.test/v1/");
    expect(dir.base("io")).toBe(FALLBACK_RDAP.io);
    expect(dir.base("xyz")).toBeNull();
    t += 23 * 3600_000; dir.base("com"); await dir.settled();
    expect(reads).toBe(1);
    t += 2 * 3600_000; dir.base("com"); await dir.settled();
    expect(reads).toBe(2);
  });

  it("a failed read of the IANA file falls back to the baked-in map and is retried after ten minutes, not on every lookup", async () => {
    let t = 0, reads = 0;
    const warn = vi.fn();
    const dir = new RdapDirectory({ fetch: async () => { reads++; return new Response(null, { status: 500 }); }, now: () => t, timeoutMs: 50, warn });
    dir.base("com"); await dir.settled();
    dir.base("com"); await dir.settled();
    expect(reads).toBe(1);
    expect(dir.base("ai")).toBe(FALLBACK_RDAP.ai);
    t += 10 * 60_000 + 1; dir.base("com"); await dir.settled();
    expect(reads).toBe(2);
    expect(warn).toHaveBeenCalledWith("lookup.bootstrap_failed Error");
  });
});

describe("network key and the dev fake", () => {
  it("keys IPv4 by address and IPv6 by /64", () => {
    const k = (ip: string) => networkKey(new Request("https://x/", { headers: { "x-forwarded-for": ip } }));
    expect(k("203.0.113.9, 10.0.0.1")).toBe("203.0.113.9");
    expect(k("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(k("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(k("")).toBe("unknown");
  });

  it("the fake says moonfern.com is registered, a nocheck label cannot be checked, and is deterministic", async () => {
    const h = createLookup({ fetch: fakeRdapFetch, timeoutMs: 50 });
    const s = async (n: string) => statusOf((await h(new Request(`https://x/api/lookup?name=${n}`)))!);
    expect((await s("moonfern")).com).toBe("registered");
    expect((await s("moonfern")).dev).toBe("unregistered");
    expect(Object.values(await s("google"))).toEqual(Array(6).fill("registered"));
    expect(Object.values(await s("nocheckfern"))).toEqual(Array(6).fill("unknown"));
    expect(await s("emberwick")).toEqual(await s("emberwick"));
  });
});
