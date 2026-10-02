import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withNoUser, withUser } from "@mosshatch/db";
import type { Quote, RegistrarPort } from "@mosshatch/registrar/port";
import { createTestApp, type TestApp } from "./testing/app.ts";
import { buildRouter } from "./routes.ts";
import { signUp, type Person } from "./auth/testkit.ts";
import { buildQuote, PricingError, quoteToJson, verifyQuoteJson } from "./pricing/quote.ts";
import { configurePriceTables, priceTableFor, resetPriceTables } from "./pricing/registrar.ts";
import { chipPrices } from "./search/service.ts";
import { checkNewAccountLimits, spendFuseFromEnv } from "./compliance/velocity.ts";
import { liveGateFromEnv } from "./waitlist/gate.ts";
import { Router } from "./http/router.ts";
import { json } from "./http/router.ts";

/**
 * Go-live (docs/GO-LIVE.md), offline: Openprovider live pricing with the renewal floor, the D-031 price guard against a fake live registrar,
 * the dogfood spend fuse, and the invite-only live gate on every purchase route. No network.
 */
let app: TestApp;
beforeAll(async () => { app = await createTestApp(buildRouter()); }, 120_000);
afterAll(async () => { resetPriceTables(); await app?.drop(); });
afterEach(() => { (app.ctx.services as { liveGate?: boolean }).liveGate = false; });

const LIVE_ROUTING = { MH_REGISTRAR_MODE: "live", MH_REGISTRAR_PROVIDER: "openprovider" };
const ON = new Date("2026-10-02T12:00:00Z");
const quote = (fqdn: string, kind: "register" | "renew" | "transfer" | "restore" = "register", years?: number, registrar?: Pick<RegistrarPort, "quote">) =>
  withNoUser(app.ctx.runtime, (c) => buildQuote(c, { fqdn, kind, ...(years ? { years } : {}) }, ON, registrar ? { registrar } : {}));

/** A live registrar that quotes Openprovider's non-member .com prices (create 11.98, renew 16.98), or whatever `over` says. */
const liveRegistrar = (over: { create?: bigint; renew?: bigint } = {}): Pick<RegistrarPort, "quote"> => ({
  async quote(fqdn, years, kind): Promise<Quote> {
    const m = (minor: bigint) => ({ minor: minor * BigInt(years), currency: "usd" as const, source: "live" as const });
    return { fqdn, tld: "com", years, wholesale: m(kind === "renew" ? over.renew ?? 1698n : over.create ?? 1198n), renewalWholesale: m(over.renew ?? 1698n), isRegistryPremium: false, quotedAt: ON };
  },
});

describe("Openprovider live pricing (migration 1120) with the renewal floor", () => {
  it("routes the price table by the registrar setting", () => {
    configurePriceTables(LIVE_ROUTING);
    expect(priceTableFor("com")).toBe("openprovider");
    configurePriceTables({ MH_REGISTRAR_MODE: "mock" });
    expect(priceTableFor("com")).toBe("opensrs");
    configurePriceTables({ MH_REGISTRAR_MODE: "sandbox", MH_REGISTRAR_PROVIDER: "opensrs", MH_REGISTRAR_PROVIDER_BY_TLD: "com=openprovider" });
    expect([priceTableFor("com"), priceTableFor("io")]).toEqual(["openprovider", "opensrs"]);
  });

  it(".com: the customer pays 20.98 the first year and 20.98 at renewal (renew 16.98 + fee 4.00), never below cost", async () => {
    configurePriceTables(LIVE_ROUTING);
    const reg = await quote("moonfern.com");
    expect(reg).toMatchObject({ wholesaleMinor: 1198n, renewalLevelMinor: 500n, feeMinor: 400n, subtotalMinor: 2098n, taxCeilingMinor: 210n, totalMinor: 2308n });
    const ren = await quote("moonfern.com", "renew");
    expect(ren).toMatchObject({ wholesaleMinor: 1698n, renewalLevelMinor: 0n, feeMinor: 400n, subtotalMinor: 2098n });
    expect(ren.subtotalMinor).toBe(reg.subtotalMinor);
    // The margin on a renewal is the fee, before Stripe's cut: the renewal is never sold below what Openprovider charges for it.
    expect(ren.subtotalMinor - ren.wholesaleMinor).toBe(400n);
    // A transfer-in (Openprovider 11.98, includes a year) is held at the renewal price too.
    expect((await quote("moonfern.com", "transfer")).subtotalMinor).toBe(2098n);
    // The JSON the order stores carries the floor, shows the registrar price the customer pays for, and still verifies.
    const j = quoteToJson(reg);
    expect(j).toMatchObject({ wholesale_minor: "1198", renewal_level_minor: "500", registrar_price_minor: "1698", subtotal_minor: "2098" });
    expect(verifyQuoteJson(j, ON)).toEqual({ ok: true });
    expect(verifyQuoteJson({ ...j, renewal_level_minor: "0" }, ON)).toEqual({ ok: false, reason: "hash" });
  });

  it("every launch extension: first year equals renewal, and the D-003 fee level follows the higher price", async () => {
    configurePriceTables(LIVE_ROUTING);
    const want: Record<string, { years: number; subtotal: bigint }> = {
      com: { years: 1, subtotal: 1698n + 400n }, dev: { years: 1, subtotal: 2398n + 400n }, app: { years: 1, subtotal: 2698n + 400n },
      studio: { years: 1, subtotal: 4600n + 400n }, io: { years: 1, subtotal: 8998n + 900n }, ai: { years: 2, subtotal: 2n * (13400n + 1000n) },
    };
    const chips = await withNoUser(app.ctx.runtime, (c) => chipPrices(c, Object.keys(want), ON));
    for (const [tld, w] of Object.entries(want)) {
      const reg = await quote(`moonfern.${tld}`);
      const ren = await quote(`moonfern.${tld}`, "renew", w.years);
      expect([tld, reg.years, reg.subtotalMinor]).toEqual([tld, w.years, w.subtotal]);
      expect([tld, ren.subtotalMinor]).toEqual([tld, w.subtotal]);
      expect([tld, chips.get(tld)?.subtotalMinor]).toEqual([tld, w.subtotal]);
    }
    // Restore has no Openprovider row yet: refused (no_price), never guessed.
    await expect(quote("moonfern.com", "restore")).rejects.toMatchObject({ code: "no_price" });
  });

  it("the price guard passes Openprovider's live quote and refuses any difference, including a dearer renewal", async () => {
    configurePriceTables(LIVE_ROUTING);
    expect((await quote("moonfern.com", "register", 1, liveRegistrar())).subtotalMinor).toBe(2098n);
    for (const over of [{ create: 1250n }, { renew: 1798n }]) {
      const e = await quote("moonfern.com", "register", 1, liveRegistrar(over)).catch((x) => x);
      expect(e).toBeInstanceOf(PricingError);
      expect((e as PricingError).code).toBe("price_mismatch");
    }
  });

  it("the sample (OpenSRS) table is unchanged for the mock: renew equals register, so no floor is added", async () => {
    resetPriceTables();
    expect(await quote("moonfern.com")).toMatchObject({ renewalLevelMinor: 0n });
  });
});

describe("the dogfood spend fuse", () => {
  it("defaults to 3 a day and 10 in total in a live process, and to nothing otherwise", () => {
    expect(spendFuseFromEnv({}, true)).toEqual({ daily: 3, total: 10 });
    expect(spendFuseFromEnv({}, false)).toEqual({ daily: null, total: null });
    expect(spendFuseFromEnv({ MH_LIVE_DAILY_REGISTRATIONS: "1", MH_LIVE_TOTAL_REGISTRATIONS: "0" }, true)).toEqual({ daily: 1, total: 0 });
    expect(spendFuseFromEnv({ MH_LIVE_DAILY_REGISTRATIONS: "-1" }, true)).toEqual({ daily: 3, total: 10 });
  });
  it("caps registrations a day and in total below the flags", async () => {
    resetPriceTables();
    const user = (await app.db.owner.query("insert into users (email, status, email_verified_at, created_at) values ('fuse@example.test','active',now(), now() - interval '90 days') returning id")).rows[0].id as string;
    const decide = (fuse: { daily: number | null; total: number | null }) => withUser(app.ctx.runtime, user, (c) => checkNewAccountLimits(c, user, { wholesaleMinor: 1198n }, app.clock.now(), fuse));
    expect((await decide({ daily: 1, total: 2 })).allowed).toBe(true);
    const q = await withUser(app.ctx.runtime, user, (c) => buildQuote(c, { fqdn: "fuse1.com" }, app.clock.now()));
    await app.db.owner.query(
      `insert into orders (user_id, kind, fqdn_ascii, years, state, idempotency_key, request_hash, quote, subtotal_minor, tax_ceiling_minor, total_minor, livemode, created_at)
       values ($1,'register','fuse1.com',1,'captured','fuse-k1','\\x00',$2,$3,$4,$5,true,$6)`, [user, quoteToJson(q), q.subtotalMinor, q.taxCeilingMinor, q.totalMinor, app.clock.now()]);
    expect(await decide({ daily: 1, total: 5 })).toMatchObject({ allowed: false, reasons: ["global_daily_cap"] });
    expect(await decide({ daily: 5, total: 1 })).toMatchObject({ allowed: false, reasons: ["global_total_cap"] });
    expect((await decide({ daily: 5, total: 5 })).allowed).toBe(true);
    // The total also reads the flag, and the lower of the two wins.
    await app.db.owner.query("update flags set value = '1' where name = 'limits.total_live_registrations'");
    expect(await decide({ daily: 5, total: 5 })).toMatchObject({ allowed: false, reasons: ["global_total_cap"] });
    await app.db.owner.query("update flags set value = '10' where name = 'limits.total_live_registrations'");
  });
});

describe("the invite-only live gate", () => {
  let uninvited: Person, invited: Person;
  beforeAll(async () => {
    uninvited = await signUp(app, "visitor@example.test");
    invited = await signUp(app, "owner@example.test");
    // An invite that was used by this account (the waitlist flow writes the same row; gate.test.ts covers that flow end to end).
    const w = (await app.db.owner.query("insert into waitlist (email, consent_hash, consented_at, source, created_at, confirmed_at, invited_at) values ('owner@example.test', $1, now(), 'page', now(), now(), now()) returning id", [Buffer.alloc(32, 1)])).rows[0].id;
    await app.db.owner.query("insert into waitlist_invites (waitlist_id, token_hash, created_at, expires_at, used_at, used_by) values ($1, $2, now(), now() + interval '14 days', now(), $3)", [w, Buffer.alloc(32, 2), invited.userId]);
  }, 120_000);
  const gate = (on: boolean) => { (app.ctx.services as { liveGate?: boolean }).liveGate = on; };
  const PURCHASE: [string, string][] = [
    ["GET", "/api/v1/search?name=moonfern&tlds=com"], ["GET", "/api/v1/quote?domain=moonfern.com"], ["POST", "/api/v1/orders"],
    ["POST", "/api/v1/orders/00000000-0000-0000-0000-000000000000/pay-link"], ["POST", "/api/v1/transfers"],
    ["POST", "/api/v1/transfers/00000000-0000-0000-0000-000000000000/confirm"], ["POST", "/api/v1/domains/00000000-0000-0000-0000-000000000000/renew"],
    ["POST", "/api/v1/approvals/00000000-0000-0000-0000-000000000000/decide"],
    ["POST", "/api/v1/approvals/00000000-0000-0000-0000-000000000000/checkout"],
  ];

  it("defaults: on in production (even with invite-only sign-up off), off elsewhere; MH_LIVE_GATE overrides", () => {
    expect(liveGateFromEnv({}, "production")).toBe(true);
    expect(liveGateFromEnv({ MH_INVITE_ONLY: "0" }, "production")).toBe(true);
    expect(liveGateFromEnv({}, "staging")).toBe(false);
    expect(liveGateFromEnv({ MH_LIVE_GATE: "0" }, "production")).toBe(false);
    expect(liveGateFromEnv({ MH_LIVE_GATE: "1" }, "local")).toBe(true);
  });

  it("with the gate on, visitors and uninvited accounts get 403 invite_required on every purchase route", async () => {
    gate(true);
    for (const [m, p] of PURCHASE) {
      const anon = await app.call(m, p, { body: m === "POST" ? {} : undefined });
      // Session-only routes answer 401 to a visitor before the gate; the shop routes visitors can reach answer invite_required.
      expect([p, anon.status === 401 ? "unauthorized" : anon.json?.error?.code]).toEqual([p, anon.status === 401 ? "unauthorized" : "invite_required"]);
      const r = await app.call(m, p, { cookie: uninvited.cookie, body: m === "POST" ? {} : undefined });
      expect([p, r.status, r.json?.error?.code]).toEqual([p, 403, "invite_required"]);
    }
  });

  it("an invited account passes the gate on every purchase route (and the next check answers instead)", async () => {
    gate(true);
    for (const [m, p] of PURCHASE) {
      const r = await app.call(m, p, { cookie: invited.cookie, body: m === "POST" ? {} : undefined });
      expect([p, r.json?.error?.code]).not.toEqual([p, "invite_required"]);
    }
  });

  it("the session tells the web who gets the shop, so one build serves the demo and the live site", async () => {
    gate(true);
    expect((await app.call("GET", "/api/v1/session")).json).toMatchObject({ signedIn: false, live_gate: true });
    expect((await app.call("GET", "/api/v1/session", { cookie: uninvited.cookie })).json).toMatchObject({ signedIn: true, live_gate: true, live_access: false });
    expect((await app.call("GET", "/api/v1/session", { cookie: invited.cookie })).json).toMatchObject({ signedIn: true, live_gate: true, live_access: true });
    gate(false);
    expect((await app.call("GET", "/api/v1/session", { cookie: uninvited.cookie })).json).toMatchObject({ live_gate: false, live_access: true });
    // Gate off: an uninvited account is not stopped by it.
    const r = await app.call("POST", "/api/v1/orders", { cookie: uninvited.cookie, body: {} });
    expect(r.json?.error?.code).not.toBe("invite_required");
  });

  it("a router without the gate check fails closed while the gate is on", async () => {
    gate(true);
    const bare = new Router().add({ method: "GET", path: "/api/v1/shop", principals: ["anonymous"], liveGate: true, handler: async () => json({ ok: true }) });
    const r = await bare.dispatch(app.ctx, new Request("https://mosshatch.test/api/v1/shop"));
    expect([r.status, (await r.json()).error.code]).toEqual([503, "live_gate_unavailable"]);
  });
});
