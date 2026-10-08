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
/** The day after the Openprovider membership began (migration 1220): member prices, equal for register, renew and transfer. */
const MEMBER_ON = new Date("2026-10-08T12:00:00Z");
const quoteOn = (at: Date, fqdn: string, kind: "register" | "renew" | "transfer" | "restore" = "register", years?: number, registrar?: Pick<RegistrarPort, "quote">) =>
  withNoUser(app.ctx.runtime, (c) => buildQuote(c, { fqdn, kind, ...(years ? { years } : {}) }, at, registrar ? { registrar } : {}));
const quote = (fqdn: string, kind: "register" | "renew" | "transfer" | "restore" = "register", years?: number, registrar?: Pick<RegistrarPort, "quote">) =>
  quoteOn(ON, fqdn, kind, years, registrar);

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

  it(".com on the non-member rows: the customer pays 19.98 the first year and 19.98 at renewal (renew 16.98 + fee 3.00), never below cost", async () => {
    configurePriceTables(LIVE_ROUTING);
    const reg = await quote("moonfern.com");
    expect(reg).toMatchObject({ wholesaleMinor: 1198n, renewalLevelMinor: 500n, feeMinor: 300n, subtotalMinor: 1998n, taxCeilingMinor: 200n, totalMinor: 2198n });
    const ren = await quote("moonfern.com", "renew");
    expect(ren).toMatchObject({ wholesaleMinor: 1698n, renewalLevelMinor: 0n, feeMinor: 300n, subtotalMinor: 1998n });
    expect(ren.subtotalMinor).toBe(reg.subtotalMinor);
    // The margin on a renewal is the fee, before Stripe's cut: the renewal is never sold below what Openprovider charges for it.
    expect(ren.subtotalMinor - ren.wholesaleMinor).toBe(300n);
    // A transfer-in (Openprovider 11.98, includes a year) is held at the renewal price too.
    expect((await quote("moonfern.com", "transfer")).subtotalMinor).toBe(1998n);
    // The JSON the order stores carries the floor, shows the registrar price the customer pays for, and still verifies.
    const j = quoteToJson(reg);
    expect(j).toMatchObject({ wholesale_minor: "1198", renewal_level_minor: "500", registrar_price_minor: "1698", subtotal_minor: "1998" });
    expect(verifyQuoteJson(j, ON)).toEqual({ ok: true });
    expect(verifyQuoteJson({ ...j, renewal_level_minor: "0" }, ON)).toEqual({ ok: false, reason: "hash" });
  });

  it("every launch extension: first year equals renewal, and the D-003 fee level follows the higher price", async () => {
    configurePriceTables(LIVE_ROUTING);
    const want: Record<string, { years: number; subtotal: bigint }> = {
      com: { years: 1, subtotal: 1698n + 300n }, dev: { years: 1, subtotal: 2398n + 300n }, app: { years: 1, subtotal: 2698n + 300n },
      studio: { years: 1, subtotal: 4600n + 300n }, io: { years: 1, subtotal: 8998n + 900n }, ai: { years: 2, subtotal: 2n * (13400n + 1000n) },
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
    expect((await quote("moonfern.com", "register", 1, liveRegistrar())).subtotalMinor).toBe(1998n);
    for (const over of [{ create: 1250n }, { renew: 1798n }]) {
      const e = await quote("moonfern.com", "register", 1, liveRegistrar(over)).catch((x) => x);
      expect(e).toBeInstanceOf(PricingError);
      expect((e as PricingError).code).toBe("price_mismatch");
    }
  });

  it("member prices from 2026-10-07 (migration 1220, D-062): every extension costs the member price plus the fee, the same every year", async () => {
    configurePriceTables(LIVE_ROUTING);
    // Member register = renew = transfer, so no renewal floor. The fee band reads the member price: .io (50.00) and .ai (80.00) pay 9.00.
    const want: Record<string, { years: number; subtotal: bigint; fee: bigint }> = {
      com: { years: 1, subtotal: 1046n + 300n, fee: 300n }, dev: { years: 1, subtotal: 1220n + 300n, fee: 300n }, app: { years: 1, subtotal: 1420n + 300n, fee: 300n },
      studio: { years: 1, subtotal: 3120n + 300n, fee: 300n }, io: { years: 1, subtotal: 5000n + 900n, fee: 900n }, ai: { years: 2, subtotal: 2n * (8000n + 900n), fee: 900n },
    };
    const chips = await withNoUser(app.ctx.runtime, (c) => chipPrices(c, Object.keys(want), MEMBER_ON));
    for (const [tld, w] of Object.entries(want)) {
      const reg = await quoteOn(MEMBER_ON, `moonfern.${tld}`);
      const ren = await quoteOn(MEMBER_ON, `moonfern.${tld}`, "renew", w.years);
      const xfer = await quoteOn(MEMBER_ON, `moonfern.${tld}`, "transfer", w.years);
      expect([tld, reg.years, reg.subtotalMinor, reg.renewalLevelMinor, reg.feePerYearMinor]).toEqual([tld, w.years, w.subtotal, 0n, w.fee]);
      expect([tld, ren.subtotalMinor, xfer.subtotalMinor]).toEqual([tld, w.subtotal, w.subtotal]);
      expect([tld, chips.get(tld)?.subtotalMinor]).toEqual([tld, w.subtotal]);
    }
    // The day before the membership the non-member rows still price the order.
    expect((await quoteOn(new Date("2026-10-06T12:00:00Z"), "moonfern.com")).subtotalMinor).toBe(1698n + 300n);
  });

  it("the price guard passes the member .com price and refuses a non-member one (a lapsed membership fails closed)", async () => {
    configurePriceTables(LIVE_ROUTING);
    const member = liveRegistrar({ create: 1046n, renew: 1046n });
    expect((await quoteOn(MEMBER_ON, "moonfern.com", "register", 1, member)).subtotalMinor).toBe(1346n);
    for (const lapsed of [liveRegistrar(), liveRegistrar({ create: 1046n, renew: 1698n })]) {
      const e = await quoteOn(MEMBER_ON, "moonfern.com", "register", 1, lapsed).catch((x) => x);
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
  it("commercial policy replaces seeded global count flags while retaining explicit operator stops", async () => {
    const user = (await app.db.owner.query("insert into users (email, status, email_verified_at, created_at) values ('commercial@example.test','active',now(), now() - interval '90 days') returning id")).rows[0].id as string;
    const saved = (await app.db.owner.query("select name, value from flags where name = any($1)", [["limits.daily_registrations", "limits.total_live_registrations"]])).rows;
    await app.db.owner.query("update flags set value = '0' where name = any($1)", [["limits.daily_registrations", "limits.total_live_registrations"]]);
    const decide = (env: Record<string, string | undefined>) => withUser(app.ctx.runtime, user, (c) => checkNewAccountLimits(c, user, { wholesaleMinor: 1198n }, app.clock.now(), spendFuseFromEnv(env, true)));
    try {
      expect((await decide({})).allowed).toBe(false);
      expect((await decide({ MH_REGISTRATION_POLICY: "commercial" })).allowed).toBe(true);
      expect(await decide({ MH_REGISTRATION_POLICY: "commercial", MH_LIVE_DAILY_REGISTRATIONS: "0" })).toMatchObject({ allowed: false, reasons: ["global_daily_cap"] });
      expect(await decide({ MH_REGISTRATION_POLICY: "commercial", MH_LIVE_TOTAL_REGISTRATIONS: "0" })).toMatchObject({ allowed: false, reasons: ["global_total_cap"] });
    } finally {
      for (const row of saved) await app.db.owner.query("update flags set value = $2::jsonb where name = $1", [row.name, JSON.stringify(row.value)]);
    }
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
    ["GET", "/api/v1/search?name=moonfern&tlds=com"], ["GET", "/api/v1/quote?domain=moonfern.com"], ["POST", "/api/v1/search"], ["POST", "/api/v1/quote"], ["POST", "/api/v1/orders"],
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
