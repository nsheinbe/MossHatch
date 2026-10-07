import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withNoUser } from "@mosshatch/db";
import { MockRegistrarPort } from "@mosshatch/registrar/mock-port";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { Router } from "../http/router.ts";
import { createSession } from "../http/session.ts";
import { registerSearchRoutes } from "./routes.ts";
import { checkoutAvailability, LookupBudgetError, SearchCache } from "./service.ts";
import { budgetUsed, poolLimits } from "./budget.ts";

let app: TestApp; let mock: MockRegistrarPort;
const ip = (n: number) => ({ "x-forwarded-for": `10.${(n >> 8) & 255}.${n & 255}.7` });
const get = (path: string, headers: Record<string, string> = ip(1), cookie?: string) => app.call("GET", path, { headers, cookie });
const post = (path: string, body: unknown, headers: Record<string, string> = ip(1)) => app.call("POST", path, { body, headers });

beforeAll(async () => {
  mock = new MockRegistrarPort();
  const router = new Router();
  registerSearchRoutes(router, { registrar: mock, cache: new SearchCache() });
  app = await createTestApp(router);
  (app.ctx.services as Record<string, unknown>)["registrar"] = mock;
  mock = new MockRegistrarPort({ clock: app.clock });
}, 60_000);
afterAll(async () => { await app?.drop(); });

// Fresh router, mock and cache per test so counters and caches never leak between tests.
let seqIp = 1000;
async function fresh(budget?: number) {
  mock = new MockRegistrarPort({ clock: app.clock });
  const r = new Router(); registerSearchRoutes(r, { registrar: mock, cache: new SearchCache() });
  app.router = r;
  await app.db.owner.query("delete from rate_counters"); await app.db.owner.query("delete from lookup_budget");
  await app.db.owner.query("update flags set value = to_jsonb($1::int) where name = 'limits.lookup_budget_daily'", [budget ?? 20000]);
}
beforeEach(() => fresh());

describe("search: validation", () => {
  it("returns 400 for bad names and never calls the registrar", async () => {
    const bad = ["", "a b", "-abc", "abc-", "a.b", "münchen", "xn--mnchen-3ya", "ab--cd", "a".repeat(64), "日本語", "ａｂｃ", "abc!", "%00"];
    for (const name of bad) {
      const r = await get(`/api/v1/search?name=${encodeURIComponent(name)}`);
      expect(r.status, JSON.stringify(name)).toBe(400); expect(r.json.error.code).toBe("bad_name");
    }
    expect((await get("/api/v1/search")).status).toBe(400);
    expect(mock.calls.checkAvailability).toBe(0);
  });
  it("accepts 1 to 63 letters, digits and hyphens, lower-cases and trims", async () => {
    for (const name of ["a", "a".repeat(63), "a-b-c", "123", " MoonFern "]) expect((await get(`/api/v1/search?name=${encodeURIComponent(name)}&tlds=com`)).status, name).toBe(200);
    expect((await get(`/api/v1/search?name=${encodeURIComponent(" MoonFern ")}&tlds=com`)).json.results[0].fqdn).toBe("moonfern.com");
  });
  it("ST-134: a 500-entry tlds list returns 400, as does any unknown, empty-entry or repeated-over-six list, without touching the registrar or the limits", async () => {
    const tlds500 = Array.from({ length: 500 }, (_, i) => (i % 2 ? "com" : "ai")).join(",");
    const r = await get(`/api/v1/search?name=moonfern&tlds=${tlds500}`);
    expect(r.status).toBe(400); expect(r.json.error.code).toBe("bad_tlds");
    for (const t of ["xyz", "com,xyz", "com,,ai", "com,com,com,com,com,com,com", "co.uk", "../etc"]) expect((await get(`/api/v1/search?name=moonfern&tlds=${encodeURIComponent(t)}`)).status, t).toBe(400);
    expect(mock.calls.checkAvailability).toBe(0);
    expect((await app.db.owner.query("select count(*)::int as n from rate_counters")).rows[0].n).toBe(0);
    expect((await get("/api/v1/search?name=moonfern&other=1")).status).toBe(400);
  });
  it("accepts a subset of the six launch extensions and defaults to all six", async () => {
    const all = await get("/api/v1/search?name=moonfern");
    expect(all.json.results.map((x: { tld: string }) => x.tld).sort()).toEqual(["ai", "app", "com", "dev", "io", "studio"]);
    const some = await get("/api/v1/search?name=moonfern&tlds=io,.AI,io");
    expect(some.json.results.map((x: { tld: string }) => x.tld)).toEqual(["io", "ai"]);
  });
});

describe("search: results", () => {
  it("labels every result as sample, carries price chips at the current wholesale, and never shows a price for taken names", async () => {
    const r = await get("/api/v1/search?name=moonfern");
    expect(r.status).toBe(200);
    const byTld = Object.fromEntries(r.json.results.map((x: any) => [x.tld, x]));
    expect(byTld.com).toMatchObject({ fqdn: "moonfern.com", kind: "available", source: "sample", unconfirmed: false, price: { years: 1, subtotal_minor: "1850", currency: "usd" } });
    for (const x of r.json.results) if (x.kind === "available") expect(x.price).not.toBeNull();
    for (const x of r.json.results) if (x.kind === "taken" || x.kind === "reserved" || x.kind === "premium") expect(x.price).toBeNull();
    const g = await get("/api/v1/search?name=google&tlds=com");
    expect(g.json.results[0]).toMatchObject({ kind: "taken", price: null });
  });
  it("shows premium and reserved as not sold and unknown as unconfirmed, never as available", async () => {
    const p = await get("/api/v1/search?name=premium-shop&tlds=com");
    expect(p.json.results[0]).toMatchObject({ kind: "premium", price: null });
    const r = await get("/api/v1/search?name=reserved-x&tlds=com");
    expect(r.json.results[0]).toMatchObject({ kind: "reserved", price: null });
    mock.faults.set("unknownAvailability");
    const u = await get("/api/v1/search?name=freshname&tlds=com");
    expect(u.json.degraded).toBe(true);
    expect(u.json.results[0]).toMatchObject({ kind: "unknown", unconfirmed: true });
  });
  it("prices the .ai chip for its two-year minimum", async () => {
    const r = await get("/api/v1/search?name=free-x&tlds=ai");
    expect(r.json.results[0].price).toEqual({ years: 2, subtotal_minor: String(2 * (11100 + 1000)), currency: "usd" });
  });
});

describe("search: cache", () => {
  it("serves a repeat within 60 seconds from cache (keyed by fqdn, so case and spaces do not matter) and refreshes after", async () => {
    await get("/api/v1/search?name=cachename&tlds=com,dev");
    expect(mock.calls.checkAvailability).toBe(2);
    await get("/api/v1/search?name=CacheName&tlds=com", ip(2)); // another address, same fqdn
    expect(mock.calls.checkAvailability).toBe(2);
    app.clock.advance(59_000);
    await get("/api/v1/search?name=cachename&tlds=dev");
    expect(mock.calls.checkAvailability).toBe(2);
    app.clock.advance(2_000);
    await get("/api/v1/search?name=cachename&tlds=dev");
    expect(mock.calls.checkAvailability).toBe(3);
    expect(mock.calls.checkAvailabilityNoCache).toBe(0); // search never asks for no_cache
  });
  it("collapses concurrent searches for the same name into one lookup per extension (singleflight)", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => get("/api/v1/search?name=flightname&tlds=com,io", ip(50 + i))));
    expect(mock.calls.checkAvailability).toBe(2);
  });
  it("does not cache registrar errors or unknown answers", async () => {
    mock.faults.set("rateLimited", { times: 1 });
    const a = await get("/api/v1/search?name=errname&tlds=com");
    expect(a.status).toBe(200); expect(a.json.results[0]).toMatchObject({ kind: "unknown", unconfirmed: true });
    const b = await get("/api/v1/search?name=errname&tlds=com");
    expect(b.json.results[0].unconfirmed).toBe(false);
  });
});

describe("search: rate limits (PLAN 4.5)", () => {
  it("anonymous: 30 searches per 10 minutes per address, then 429 with Retry-After; a new window lets it through", async () => {
    for (let i = 0; i < 30; i++) expect((await get("/api/v1/search?name=ratename&tlds=com", ip(7))).status, `#${i}`).toBe(200);
    const r = await get("/api/v1/search?name=ratename&tlds=com", ip(7));
    expect(r.status).toBe(429); expect(r.json.error.code).toBe("rate_limited");
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await get("/api/v1/search?name=ratename&tlds=com", ip(8))).status).toBe(200); // another address in another /24
    app.clock.advance(10 * 60_000);
    expect((await get("/api/v1/search?name=ratename&tlds=com", ip(7))).status).toBe(200);
  });
  it("anonymous: 100 an hour per /24 across addresses", async () => {
    const net = (host: number) => ({ "x-forwarded-for": `192.0.2.${host}` });
    let ok = 0; let blocked = 0;
    for (let i = 0; i < 110; i++) { const r = await get("/api/v1/search?name=netname&tlds=com", net(i % 10 + 1)); if (r.status === 200) ok++; else if (r.status === 429) blocked++; }
    expect(ok).toBe(100); expect(blocked).toBe(10);
    expect((await get("/api/v1/search?name=netname&tlds=com", { "x-forwarded-for": "198.51.100.1" })).status).toBe(200);
  });
  it("verified users get 300 an hour and are not bound by the anonymous address limit", async () => {
    const uid = (await app.db.owner.query("insert into users (email, status, email_verified_at) values ('v@example.test','active',now()) returning id")).rows[0].id as string;
    const { cookie } = await createSession(app.ctx, uid, {});
    const h = ip(9);
    for (let i = 0; i < 300; i++) { const r = await get("/api/v1/search?name=usrname&tlds=com", h, cookie); if (r.status !== 200) throw new Error(`request ${i} got ${r.status}`); }
    expect((await get("/api/v1/search?name=usrname&tlds=com", h, cookie)).status).toBe(429);
    // The same address without a session still has its own anonymous allowance.
    expect((await get("/api/v1/search?name=usrname&tlds=com", h)).status).toBe(200);
  }, 60_000);
  it("an unverified session is limited like an anonymous caller", async () => {
    const uid = (await app.db.owner.query("insert into users (email, status) values ('pending@example.test','pending') returning id")).rows[0].id as string;
    const { cookie } = await createSession(app.ctx, uid, {});
    const h = ip(10);
    let last = 0; for (let i = 0; i < 31; i++) last = (await get("/api/v1/search?name=unvname&tlds=com", h, cookie)).status;
    expect(last).toBe(429);
  });
});

describe("search: degraded mode and budget", () => {
  it("with the search pool spent it answers from cached prices with unconfirmed unknown chips and makes no registrar call", async () => {
    await fresh(0);
    const r = await get("/api/v1/search?name=nobudget&tlds=com,io");
    expect(r.status).toBe(200); expect(r.json.degraded).toBe(true);
    for (const x of r.json.results) { expect(x.kind).toBe("unknown"); expect(x.unconfirmed).toBe(true); expect(x.price).not.toBeNull(); }
    expect(mock.calls.checkAvailability).toBe(0);
  });
  it("splits the daily budget 70% search and 30% checkout", () => {
    expect(poolLimits(20000)).toEqual({ search: 14000, checkout: 6000 });
    expect(poolLimits(1000)).toEqual({ search: 700, checkout: 300 });
  });
});

describe("search: no durable text (front-running commitment)", () => {
  it("writes the searched name to no table, no log line and no audit row", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const needle = "zqxneedlelabel";
    await get(`/api/v1/search?name=${needle}&tlds=com,io`);
    await get(`/api/v1/quote?domain=${needle}.com`);
    await get(`/api/v1/search?name=${needle}${"x".repeat(70)}`); // rejected
    await post("/api/v1/search", { name: needle, tlds: "com" });
    await post("/api/v1/quote", { domain: `${needle}.com` });
    const logged = spies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(" ")).join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(logged.toLowerCase()).not.toContain(needle);
    const tables = (await app.db.owner.query("select tablename from pg_tables where schemaname = 'public'")).rows.map((r) => r.tablename as string);
    for (const t of tables) {
      const rows = (await app.db.owner.query(`select t::text as x from "${t}" t`)).rows;
      for (const row of rows) expect(String(row.x).toLowerCase(), `table ${t}`).not.toContain(needle);
    }
    const rc = (await app.db.owner.query("select count(*)::int as n from rate_counters")).rows[0].n;
    expect(rc).toBeGreaterThan(0); // counters exist, keyed by HMAC
  });
});

describe("AUD-V1: the web app's POST form keeps the searched name out of every URL", () => {
  it("search and quote answer exactly as the GET form does, with the name only in the body", async () => {
    const g = await get("/api/v1/search?name=moonfern&tlds=com,io");
    const p = await post("/api/v1/search", { name: "moonfern", tlds: "com,io" }, ip(3));
    expect(p.status).toBe(200); expect(p.json.results).toEqual(g.json.results);
    const q = await post("/api/v1/quote", { domain: "moonfern.com", years: 1 }, ip(3));
    expect(q.status).toBe(200);
    expect(q.json.quote).toMatchObject({ fqdn: "moonfern.com", years: 1, subtotal_minor: "1850" });
    expect((await post("/api/v1/quote", { domain: "free-y.ai" }, ip(3))).json.quote).toMatchObject({ years: 2 });
  });
  it("refuses unknown fields, non-string values, query parameters and a missing name, and keeps the CSRF guard", async () => {
    expect((await post("/api/v1/quote", { domain: "moonfern.com", price: "1" })).json.error.code).toBe("unexpected_param");
    expect((await post("/api/v1/search", { name: ["moonfern"] })).status).toBe(400);
    expect((await post("/api/v1/search", "moonfern")).status).toBe(400);
    expect((await post("/api/v1/search", {})).json.error.code).toBe("bad_name");
    for (const years of [1.5, "0", "abc", true]) expect((await post("/api/v1/quote", { domain: "moonfern.com", years })).status, String(years)).toBe(400);
    expect((await app.call("POST", "/api/v1/search?name=moonfern", { body: { name: "moonfern" }, headers: ip(4) })).json.error.code).toBe("unexpected_param");
    expect((await app.call("POST", "/api/v1/search", { body: { name: "moonfern" }, headers: { ...ip(5), "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await app.call("POST", "/api/v1/search", { body: { name: "moonfern" }, headers: ip(6), browser: false })).status).toBe(403);
    expect(mock.calls.checkAvailability).toBe(0);
  });
});

describe("quote route", () => {
  it("returns a priced, hashed, expiring quote and defaults .ai to two years", async () => {
    const r = await get("/api/v1/quote?domain=moonfern.com");
    expect(r.status).toBe(200);
    expect(r.json.availability).toMatchObject({ kind: "available", source: "sample" });
    expect(r.json.quote).toMatchObject({ fqdn: "moonfern.com", years: 1, subtotal_minor: "1850", tax_ceiling_minor: "185", total_minor: "2035", currency: "usd" });
    expect(r.json.quote.quote_hash).toMatch(/^[0-9a-f]{64}$/);
    const ai = await get("/api/v1/quote?domain=free-y.ai");
    expect(ai.json.quote).toMatchObject({ years: 2, subtotal_minor: "24200" });
  });
  it("AUD-P5/F3: carries the checkout facts from the server: whether sales are open, the registrar of record and the refund window", async () => {
    const r = await get("/api/v1/quote?domain=moonfern.com");
    expect(r.json.sales_open).toBe(true);
    expect(r.json.registrar).toMatchObject({ iana_id: 69 });                     // the sample table: OpenSRS (Tucows)
    expect(r.json.refund).toEqual({ refundable: true, window_days: 5 });
    const ai = await get("/api/v1/quote?domain=free-y.ai");
    expect(ai.json.refund).toEqual({ refundable: false, window_days: 0 });
    await app.db.owner.query("update flags set value = 'true' where name = 'registrar_writes_paused'");
    try { expect((await get("/api/v1/quote?domain=moonfern.com", ip(2))).json.sales_open).toBe(false); }
    finally { await app.db.owner.query("update flags set value = 'false' where name = 'registrar_writes_paused'"); }
  });
  it("refuses a one-year .ai, an unsupported extension, and any client-supplied price or unknown parameter", async () => {
    expect((await get("/api/v1/quote?domain=free-y.ai&years=1")).json.error.code).toBe("invalid_term");
    expect((await get("/api/v1/quote?domain=moonfern.xyz")).json.error.code).toBe("unsupported_tld");
    for (const extra of ["price=1", "total_minor=1", "amount=1", "wholesale=1", "fee=0", "tax=0"]) {
      const r = await get(`/api/v1/quote?domain=moonfern.com&${extra}`);
      expect(r.status, extra).toBe(400); expect(r.json.error.code).toBe("unexpected_param");
    }
    for (const y of ["0", "11", "-1", "1.5", "abc", "999"]) expect((await get(`/api/v1/quote?domain=moonfern.com&years=${y}`)).status, y).toBe(400);
    expect((await get("/api/v1/quote?domain=münchen.com")).status).toBe(400);
    expect((await get("/api/v1/quote?domain=moonfern.com&years=1&years=2")).status).toBe(400);
  });
  it("gives no quote for taken, reserved or premium names", async () => {
    for (const [d, k] of [["google.com", "taken"], ["premium-abc.com", "premium"], ["reserved-abc.dev", "reserved"]] as const) {
      const r = await get(`/api/v1/quote?domain=${d}`);
      expect(r.status).toBe(200); expect(r.json.availability.kind).toBe(k); expect(r.json.quote).toBeNull();
    }
  });
  it("shares the search rate limit", async () => {
    for (let i = 0; i < 30; i++) await get("/api/v1/quote?domain=moonfern.com", ip(20));
    expect((await get("/api/v1/quote?domain=moonfern.com", ip(20))).status).toBe(429);
    expect((await get("/api/v1/search?name=moonfern&tlds=com", ip(20))).status).toBe(429);
  });
});

describe("ST-134: search abuse cannot exhaust the registrar budget or starve checkout", () => {
  it("10,000 unique labels from 200 addresses stay within the search share while every checkout check still succeeds", async () => {
    const BUDGET = 1000;
    await fresh(BUDGET);
    const searchShare = poolLimits(BUDGET).search;
    const requests: { path: string; headers: Record<string, string> }[] = [];
    for (let i = 0; i < 10_000; i++) requests.push({ path: `/api/v1/search?name=abuse${i}x`, headers: ip(100 + (i % 200)) });
    const statuses = new Map<number, number>(); let unconfirmedAvailable = 0;
    for (let i = 0; i < requests.length; i += 100) {
      const batch = await Promise.all(requests.slice(i, i + 100).map((q) => app.call("GET", q.path, { headers: q.headers })));
      for (const r of batch) {
        statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
        if (r.status === 200) for (const x of r.json.results) if (x.unconfirmed && x.kind !== "unknown") unconfirmedAvailable++;
      }
    }
    // Per-address limit: 30 in the 10-minute window from each of 200 addresses.
    expect(statuses.get(200)).toBe(30 * 200);
    expect(statuses.get(429)).toBe(10_000 - 30 * 200);
    expect(unconfirmedAvailable).toBe(0);
    // The registrar saw no more than the search share, and search never asked for no_cache.
    expect(mock.calls.checkAvailability).toBeLessThanOrEqual(searchShare);
    expect(mock.calls.checkAvailability).toBeGreaterThan(searchShare - 6); // reservations are per search of up to six extensions, all or nothing
    expect(mock.calls.checkAvailabilityNoCache).toBe(0);
    const used = await withNoUser(app.ctx.runtime, (c) => budgetUsed(c, app.clock.now()));
    expect(used.search).toBe(mock.calls.checkAvailability); expect(used.checkout).toBe(0);

    // Checkout, renewal and agent checks draw only from the 30% pool and use no_cache.
    const { checkout } = poolLimits(BUDGET);
    for (let i = 0; i < checkout; i++) {
      const a = await withNoUser(app.ctx.runtime, (c) => checkoutAvailability(app.ctx, c, mock, `free-co${i}.com`));
      expect(a.kind).toBe("available");
    }
    expect(mock.calls.checkAvailabilityNoCache).toBe(checkout);
    await expect(withNoUser(app.ctx.runtime, (c) => checkoutAvailability(app.ctx, c, mock, "free-over.com"))).rejects.toBeInstanceOf(LookupBudgetError);
    expect(mock.calls.checkAvailability).toBeLessThanOrEqual(searchShare + checkout);
  }, 180_000);

  it("the checkout check bypasses the mock's stale lookup cache", async () => {
    await get("/api/v1/search?name=racename&tlds=com"); // caches "available" upstream and in our cache
    mock.registerAsOther("racename.com");
    const stale = await get("/api/v1/search?name=racename&tlds=com", ip(3));
    expect(stale.json.results[0].kind).toBe("available"); // served from our 60 s cache
    const a = await withNoUser(app.ctx.runtime, (c) => checkoutAvailability(app.ctx, c, mock, "racename.com"));
    expect(a.kind).toBe("taken");
  });
});
