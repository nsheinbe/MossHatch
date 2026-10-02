import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withNoUser } from "@mosshatch/db";
import type { Balance, Quote, RegistrarPort } from "@mosshatch/registrar/port";
import { RegistrarError } from "@mosshatch/registrar/port";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { buildRouter } from "../routes.ts";
import { configurePriceTables, resetPriceTables } from "../pricing/registrar.ts";
import { formatPreflight, registrarPreflight, STRIPE_PROBES, stripePreflight, type StripeHttp } from "./preflight.ts";

/** The read-only live preflight (docs/GO-LIVE.md step 8a), offline: a fake live registrar and a fake Stripe API. */
let app: TestApp;
let prices: Map<string, bigint>;
const ON = new Date("2026-10-02T12:00:00Z");
beforeAll(async () => {
  app = await createTestApp(buildRouter());
  configurePriceTables({ MH_REGISTRAR_MODE: "live", MH_REGISTRAR_PROVIDER: "openprovider" });
  const rows = (await app.ctx.cron.query("select distinct on (tld, kind) tld, kind, amount_minor from wholesale_prices where registrar = 'openprovider' and effective_from <= $1::date order by tld, kind, effective_from desc", [ON])).rows;
  prices = new Map(rows.map((r) => [`${r.tld}:${r.kind}`, BigInt(r.amount_minor)]));
}, 120_000);
afterAll(async () => { resetPriceTables(); await app?.drop(); });

const usd = (minor: bigint) => ({ minor, currency: "usd" as const, source: "live" as const });
/** Quotes exactly the price table unless `over` says otherwise for a tld; `calls` records every method name used. */
function fakeRegistrar(o: { over?: Record<string, bigint>; balance?: bigint; health?: "ok" | "degraded"; calls?: string[] } = {}): RegistrarPort {
  const port: Partial<RegistrarPort> = {
    async health() { return { status: o.health ?? "ok" }; },
    async quote(fqdn, years, kind = "register"): Promise<Quote> {
      const tld = fqdn.split(".").pop()!;
      const per = (k: string) => o.over?.[`${tld}:${k}`] ?? prices.get(`${tld}:${k}`)!;
      return { fqdn, tld, years, wholesale: usd(per(kind) * BigInt(years)), renewalWholesale: usd(per("renew") * BigInt(years)), isRegistryPremium: false, quotedAt: ON };
    },
    async getBalance(): Promise<Balance> { const b = o.balance ?? 2000n; return { balance: usd(b), held: usd(0n), available: usd(b) }; },
  };
  return new Proxy(port as RegistrarPort, { get(t, p) { if (typeof p === "string") o.calls?.push(p); const v = Reflect.get(t, p); if (v === undefined && typeof p === "string") throw new Error(`preflight called ${p}`); return v; } });
}
const run = (r: RegistrarPort) => withNoUser(app.ctx.runtime, (c) => registrarPreflight(c as never, r, ON));

describe("registrar preflight", () => {
  it("passes when every live price matches the table and the balance covers the floor; uses read-only calls only", async () => {
    await app.ctx.cron.query("insert into flags (name, value, updated_by, updated_at) values ('sell_gate.min_funds_minor', '500', 'test', now()) on conflict (name) do update set value = excluded.value");
    const calls: string[] = [];
    const checks = await run(fakeRegistrar({ calls }));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.find((c) => c.name === ".com")?.detail).toContain("USD 20.98");
    expect(new Set(calls)).toEqual(new Set(["health", "quote", "getBalance"]));
    expect(formatPreflight(checks).ok).toBe(true);
  });

  it("names the extension whose live price differs, a balance under the floor, and a registrar that is down", async () => {
    const checks = await run(fakeRegistrar({ over: { "com:register": 1298n }, balance: 900n, health: "degraded" }));
    const bad = Object.fromEntries(checks.filter((c) => !c.ok).map((c) => [c.name, c.detail]));
    expect(bad[".com"]).toMatch(/^price_mismatch/);
    expect(bad.balance).toMatch(/available USD 9\.00/);
    expect(bad.health).toBe("degraded");
    expect(formatPreflight(checks).ok).toBe(false);
  });

  it("reports a refused RPC hop as a code, never a value", async () => {
    const r = fakeRegistrar();
    const failing = new Proxy(r, { get(t, p) { if (p === "getBalance") return async () => { throw new RegistrarError("unavailable", "x", { retryable: false, outcomeUnknown: false, code: "openprovider_credentials_missing" }); }; return Reflect.get(t, p); } });
    const checks = await run(failing);
    expect(checks.find((c) => c.name === "balance")).toMatchObject({ ok: false, detail: "unavailable:openprovider_credentials_missing" });
  });
});

describe("Stripe preflight", () => {
  const fake = (deny: string[] = [], products: Record<string, boolean | null> = {}): StripeHttp & { seen: string[] } => {
    const seen: string[] = [];
    const f = (async (method, path) => {
      seen.push(`${method} ${path}`);
      const m = /^\/v1\/products\/(mh_domain_\w+)$/.exec(path);
      if (m && method === "GET") { const a = m[1]! in products ? products[m[1]!]! : true; return a === null ? { status: 404, body: { error: { code: "resource_missing" } } } : { status: 200, body: { id: m[1], active: a } }; }
      const probe = STRIPE_PROBES.find((p) => p.path === path && p.method === method)!;
      return deny.includes(probe.name) ? { status: 403, body: { error: { type: "invalid_request_error", message: "The provided key does not have the required permissions" } } } : { status: 404, body: { error: { code: "resource_missing" } } };
    }) as StripeHttp & { seen: string[] };
    f.seen = seen; return f;
  };

  it("passes a restricted live key with every permission and the four products", async () => {
    const http = fake();
    const checks = await stripePreflight(http, "rk_live_x");
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    // Writes only ever target ids that cannot exist.
    for (const s of http.seen.filter((s) => s.startsWith("POST"))) expect(s).toMatch(/missing/);
  });

  it("names each missing permission, a missing product, and a full secret key", async () => {
    const checks = await stripePreflight(fake(["Refunds write", "Radar reviews read"], { mh_domain_restore: null }), "sk_live_x");
    const bad = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    expect(bad).toEqual([
      "key: a full secret key: use the restricted key (GO-LIVE step 5.3)",
      "Refunds write: missing: add it to the restricted key",
      "Radar reviews read: missing: add it to the restricted key",
      "product mh_domain_restore: missing: run scripts/stripe-catalog.mjs",
    ]);
  });

  it("an answer that is neither granted nor denied is unknown, not a pass", async () => {
    const checks = await stripePreflight(async () => ({ status: 400, body: { error: { code: "parameter_missing" } } }), "rk_live_x");
    expect(checks.find((c) => c.name === "Customers write")).toMatchObject({ ok: false, detail: "unknown (HTTP 400 parameter_missing)" });
  });
});
