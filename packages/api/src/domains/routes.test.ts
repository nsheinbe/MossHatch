import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "../util/token.ts";
import { at, autoRenewOn, buyDomain, days, domainRow, makeDomainsHarness, makeOwner, relogin, settle, type DomainsHarness, type Owner } from "./testkit.ts";

let h: DomainsHarness; let ada: Owner; let eve: Owner;
let dev: Awaited<ReturnType<typeof buyDomain>>; let com: Awaited<ReturnType<typeof buyDomain>>;
beforeAll(async () => {
  h = await makeDomainsHarness();
  ada = await makeOwner(h, "routes-ada@example.com"); eve = await makeOwner(h, "routes-eve@example.com");
  dev = await buyDomain(h, ada, "free-routes.dev");
  com = await buyDomain(h, ada, "free-routes.com");
  await autoRenewOn(h, ada, dev.id);
}, 120_000);
afterAll(async () => { await h?.app.drop(); });

const get = (o: Owner, path: string) => h.app.call("GET", path, { cookie: o.cookie });
const NONE = "018f0000-0000-7000-8000-000000000000";
const same = (a: { status: number; json: unknown; headers: Headers }, b: { status: number; json: unknown; headers: Headers }) =>
  expect([a.status, JSON.stringify(a.json), a.headers.get("content-type"), a.headers.get("cache-control")]).toEqual([b.status, JSON.stringify(b.json), b.headers.get("content-type"), b.headers.get("cache-control")]);

describe("GET /api/v1/domains: the Grove", () => {
  it("lists the caller's domains with derived state, traits inputs, expiry, auto-renew and the renewal price, and nobody else's", async () => {
    const r = await get(ada, "/api/v1/domains");
    expect(r.status).toBe(200);
    expect(r.json.domains.map((d: { fqdn: string }) => d.fqdn).sort()).toEqual(["free-routes.com", "free-routes.dev"]);
    const d = r.json.domains.find((x: { fqdn: string }) => x.fqdn === "free-routes.dev");
    expect(d).toMatchObject({
      id: dev.id, tld: "dev", state: "armored", armored: true, locked: true, auto_renew: true, adapter_state: "active", source: "adapter", confirmed: true,
      renewal: { price_minor: "2100", wholesale_minor: "1700", fee_minor: "400", years: 1, currency: "usd", tax: "excluded", auto_renew: true, price_ceiling_minor: "2100", state: "scheduled" },
    });
    expect(d.traits_inputs).toMatchObject({ domain: "free-routes.dev", age_days: 0 });
    expect(d.traits).toBeTruthy();
    expect(d.days_to_expiry).toBeGreaterThanOrEqual(364);
    expect(new Date(d.expires_at).getTime()).toBe(new Date((await domainRow(h, dev.id)).expires_at).getTime());
    const com1 = r.json.domains.find((x: { fqdn: string }) => x.fqdn === "free-routes.com");
    expect(com1.auto_renew).toBe(false);
    expect(com1.renewal.auto_renew).toBe(false);
    expect((await get(eve, "/api/v1/domains")).json).toEqual({ domains: [], eggs: [] });
    expect(JSON.stringify(r.json)).not.toMatch(/pm_|cus_|payment_method|mh_live/);
  });

  it("anonymous callers and bearer tokens are refused on the session routes", async () => {
    const m = mintToken("live");
    await h.app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, expires_at) values ($1,'agent','b',$2,$3,'[]', now() + interval '30 days')", [ada.userId, m.prefix, m.hash]);
    for (const [method, path] of [["GET", "/api/v1/domains"], ["GET", `/api/v1/domains/${dev.id}`], ["GET", `/api/v1/domains/${dev.id}/export`], ["GET", "/api/v1/ledger"], ["POST", `/api/v1/domains/${dev.id}/renew`], ["POST", `/api/v1/orders/${dev.orderId}/refund`]] as const) {
      expect((await h.app.call(method, path, { body: method === "POST" ? {} : undefined })).status, `anonymous ${method} ${path}`).toBe(401);
      expect([401, 403], `bearer ${method} ${path}`).toContain((await h.app.call(method, path, { authorization: `Bearer ${m.token}`, body: method === "POST" ? {} : undefined, browser: false })).status);
    }
  });
});

describe("GET /api/v1/domains/:id and the other id routes: unowned and nonexistent are one answer", () => {
  it("the overview holds the mandate, the orders and the registry data", async () => {
    const r = await get(ada, `/api/v1/domains/${dev.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: dev.id, fqdn: "free-routes.dev", released: null, ds_present: false, privacy_status: "redacted_default", transfer_away: false, dispute_lock_state: null });
    expect(r.json.nameservers.length).toBeGreaterThan(0);
    expect(r.json.mandate).toMatchObject({ price_ceiling_minor: "2100", term_years: 1, charge_days_before_expiry: 10 });
    expect(r.json.orders.map((o: { kind: string }) => o.kind)).toEqual(["register"]);
  });

  it("another person's id, a nonexistent id and a malformed id return the same status, headers and body on every id route", async () => {
    const eveCookie = (await relogin(h, eve)).cookie;
    const probe = async (method: string, path: (id: string) => string, body?: unknown) => {
      const call = (id: string) => h.app.call(method, path(id), { cookie: eveCookie, body });
      const owned = await call(dev.id), none = await call(NONE);
      same(owned, none);
      expect(owned.status, `${method} ${path("x")}`).toBe(404);
      expect((await call("not-a-uuid")).status).toBe(404);
    };
    await probe("GET", (id) => `/api/v1/domains/${id}`);
    await probe("GET", (id) => `/api/v1/domains/${id}/export`);
    await probe("POST", (id) => `/api/v1/domains/${id}/renew`, {});
    await probe("DELETE", (id) => `/api/v1/domains/${id}/auto-renew`, {});
    await probe("POST", (id) => `/api/v1/orders/${id}/refund`, {});
    // The step-up route answers 403 step_up_required for both, before it can say which ids exist.
    const a = await h.app.call("POST", `/api/v1/domains/${dev.id}/auto-renew`, { cookie: eveCookie, body: { consent_hash: "x".repeat(20) } });
    const b = await h.app.call("POST", `/api/v1/domains/${NONE}/auto-renew`, { cookie: eveCookie, body: { consent_hash: "x".repeat(20) } });
    same(a, b);
    // Nothing of Ada's changed.
    expect((await domainRow(h, dev.id)).auto_renew).toBe(true);
  });

  it("Renew now is refused for a name that cannot be renewed (redemption), with a plain code", async () => {
    const d = await buyDomain(h, ada, "free-routes2.dev");
    await h.app.db.owner.query("update domains set state = 'redemption' where id = $1", [d.id]);
    const r = await h.app.call("POST", `/api/v1/domains/${d.id}/renew`, { cookie: (await relogin(h, ada)).cookie, body: {} });
    expect(r.status).toBe(409); expect(r.json.error.code).toBe("not_renewable");
  });
});

describe("GET /api/v1/ledger", () => {
  it("lists the user's orders with their payments and refunds, and only theirs", async () => {
    const click = await h.app.call("POST", `/api/v1/domains/${com.id}/renew`, { cookie: (await relogin(h, ada)).cookie, body: {} });
    expect(click.status, JSON.stringify(click.json)).toBe(200);
    const c = await get(await relogin(h, ada), "/api/v1/ledger");
    expect(c.status).toBe(200);
    const kinds = c.json.entries.map((e: { kind: string; fqdn: string }) => `${e.kind}:${e.fqdn}`);
    expect(kinds).toEqual(expect.arrayContaining(["register:free-routes.dev", "register:free-routes.com", "renew:free-routes.com"]));
    const reg = c.json.entries.find((e: { kind: string; fqdn: string }) => e.kind === "register" && e.fqdn === "free-routes.dev");
    expect(reg).toMatchObject({ state: "captured", payment_status: "succeeded", refunded_minor: "0", domain_id: dev.id });
    expect(BigInt(reg.charged_minor)).toBeGreaterThanOrEqual(BigInt(reg.subtotal_minor));
    const ren = c.json.entries.find((e: { kind: string }) => e.kind === "renew");
    expect(ren).toMatchObject({ state: "renewed", years: 1, tax_minor: "0", payment_status: "succeeded" });
    expect(ren.charged_minor).toBe(ren.subtotal_minor);
    // Refund the .dev registration through the route; the ledger shows the refund row and the payment total.
    const rf = await h.app.call("POST", `/api/v1/orders/${dev.orderId}/refund`, { cookie: (await relogin(h, ada)).cookie, body: {} });
    expect(rf.status, JSON.stringify(rf.json)).toBe(200);
    const after = await get(await relogin(h, ada), "/api/v1/ledger");
    expect(after.json.refunds).toHaveLength(1);
    expect(after.json.refunds[0]).toMatchObject({ order_id: dev.orderId });
    expect(after.json.entries.find((e: { order_id: string }) => e.order_id === dev.orderId)).toMatchObject({ state: "refunded" });
    const theirs = await get(eve, "/api/v1/ledger");
    expect(theirs.json).toEqual({ entries: [], refunds: [] });
    void at; void days; void settle;
  });
});
