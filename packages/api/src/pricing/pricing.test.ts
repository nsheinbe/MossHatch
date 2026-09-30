import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { feePerYear, usd } from "@mosshatch/core";
import { SAMPLE_PRICE } from "@mosshatch/registrar";
import { MockRegistrarPort } from "@mosshatch/registrar/mock-port";
import { withNoUser } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { buildQuote, feePerYearMinor, PricingError, quoteToJson, verifyQuoteJson, QUOTE_TTL_MS } from "./index.ts";

let app: TestApp;
beforeAll(async () => { app = await createTestApp(); }, 60_000);
afterAll(async () => { await app?.drop(); });

const at = (s: string) => new Date(s);
const q = (input: Parameters<typeof buildQuote>[1], now: string, opts?: Parameters<typeof buildQuote>[3]) => withNoUser(app.ctx.runtime, (c) => buildQuote(c, input, at(now), opts));
const fail = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as PricingError | null;

describe("pricing: D-003 fee bands and the plan's first-order prices", () => {
  it("reproduces the first-order prices at November 2026 wholesale, exactly", async () => {
    const want: Record<string, { total: bigint; years: number }> = {
      com: { total: 1925n, years: 1 }, dev: { total: 2100n, years: 1 }, app: { total: 2500n, years: 1 },
      studio: { total: 6000n, years: 1 }, io: { total: 6900n, years: 1 }, ai: { total: 24200n, years: 2 },
    };
    for (const [tld, w] of Object.entries(want)) {
      const r = await q({ fqdn: `moonfern.${tld}` }, "2026-11-07T00:00:00Z");
      expect(r.years, tld).toBe(w.years);
      expect(r.subtotalMinor, tld).toBe(w.total);
      expect(typeof r.subtotalMinor).toBe("bigint");
    }
  });
  it("applies the fee per domain-year: .ai for 2 years is 2 x (111.00 + 10.00) and 3 years is 3 x", async () => {
    const two = await q({ fqdn: "x1.ai", years: 2 }, "2026-11-07T00:00:00Z");
    expect([two.wholesaleMinor, two.feeMinor, two.subtotalMinor]).toEqual([22200n, 2000n, 24200n]);
    const three = await q({ fqdn: "x1.com", years: 3 }, "2026-11-07T00:00:00Z");
    expect([three.wholesaleMinor, three.feeMinor, three.subtotalMinor]).toEqual([4575n, 1200n, 5775n]);
  });
  it("matches the Phase 1 sample prices shown in the UI", async () => {
    for (const tld of ["com", "dev", "app", "studio", "io", "ai"]) {
      const r = await q({ fqdn: `moonfern.${tld}` }, "2026-11-07T00:00:00Z");
      expect(Number(r.subtotalMinor), tld).toBe(SAMPLE_PRICE[tld]!.cents);
    }
  });
  it("fee bands agree with packages/core feePerYear across the thresholds", () => {
    for (const w of [0, 1450, 4999, 5000, 5100, 9999, 10000, 11100, 50000]) expect(feePerYearMinor(BigInt(w))).toBe(BigInt(feePerYear(usd(w)).cents));
  });
  it("steps .com from 14.50 to 15.25 on 2026-11-01 UTC, and .studio from 42 to 51 on 2026-10-06 (which moves it to the 9.00 band)", async () => {
    const before = await q({ fqdn: "moonfern.com" }, "2026-10-31T23:59:59Z");
    const after = await q({ fqdn: "moonfern.com" }, "2026-11-01T00:00:00Z");
    expect([before.wholesalePerYearMinor, before.subtotalMinor]).toEqual([1450n, 1850n]);
    expect([after.wholesalePerYearMinor, after.subtotalMinor]).toEqual([1525n, 1925n]);
    expect(after.wholesalePriceId).not.toBe(before.wholesalePriceId);
    const s1 = await q({ fqdn: "moonfern.studio" }, "2026-10-05T23:59:59Z");
    const s2 = await q({ fqdn: "moonfern.studio" }, "2026-10-06T00:00:00Z");
    expect([s1.wholesalePerYearMinor, s1.feePerYearMinor, s1.subtotalMinor]).toEqual([4200n, 400n, 4600n]);
    expect([s2.wholesalePerYearMinor, s2.feePerYearMinor, s2.subtotalMinor]).toEqual([5100n, 900n, 6000n]);
  });
  it("pins the wholesale price row id into the quote and refuses a date with no price", async () => {
    const r = await q({ fqdn: "moonfern.dev" }, "2026-10-01T00:00:00Z");
    const row = (await app.db.owner.query("select id, amount_minor, source from wholesale_prices where id = $1", [r.wholesalePriceId])).rows[0];
    expect(BigInt(row.amount_minor)).toBe(1700n);
    expect(row.source).toContain("2026-09-29");
    expect((await fail(q({ fqdn: "moonfern.dev" }, "2026-09-01T00:00:00Z")))?.code).toBe("no_price");
  });
  it("prices a renewal from the renew row, not the register row", async () => {
    const id = (await app.db.owner.query("insert into wholesale_prices (registrar, tld, kind, amount_minor, effective_from, source) values ('opensrs','dev','renew',1800,'2026-12-01','test row') returning id")).rows[0].id;
    try {
      const reg = await q({ fqdn: "moonfern.dev", kind: "register" }, "2026-12-05T00:00:00Z");
      const ren = await q({ fqdn: "moonfern.dev", kind: "renew" }, "2026-12-05T00:00:00Z");
      expect(reg.subtotalMinor).toBe(2100n);
      expect(ren.subtotalMinor).toBe(2200n); expect(ren.wholesalePriceId).toBe(id); expect(ren.kind).toBe("renew");
      const early = await q({ fqdn: "moonfern.dev", kind: "renew" }, "2026-11-05T00:00:00Z");
      expect(early.subtotalMinor).toBe(2100n);
    } finally { await app.db.owner.query("delete from wholesale_prices where id = $1", [id]); }
  });
  it("prices restore at the upstream restore fee plus the same fee, one year only", async () => {
    const r = await q({ fqdn: "moonfern.com", kind: "restore" }, "2026-11-07T00:00:00Z");
    expect(r.subtotalMinor).toBe(8000n + 400n);
    expect((await fail(q({ fqdn: "moonfern.com", kind: "restore", years: 2 }, "2026-11-07T00:00:00Z")))?.code).toBe("invalid_term");
  });
});

describe("pricing: terms", () => {
  it("defaults to the extension minimum and refuses a one-year .ai", async () => {
    expect((await q({ fqdn: "moonfern.ai" }, "2026-11-07T00:00:00Z")).years).toBe(2);
    expect((await q({ fqdn: "moonfern.com" }, "2026-11-07T00:00:00Z")).years).toBe(1);
    expect((await fail(q({ fqdn: "moonfern.ai", years: 1 }, "2026-11-07T00:00:00Z")))?.code).toBe("invalid_term");
    for (const y of [0, 11, 1.5, -1, Number.NaN]) expect((await fail(q({ fqdn: "moonfern.com", years: y }, "2026-11-07T00:00:00Z")))?.code, String(y)).toBe("invalid_term");
  });
});

describe("pricing: refusals", () => {
  it("refuses unsupported extensions and malformed names", async () => {
    expect((await fail(q({ fqdn: "moonfern.xyz" }, "2026-11-07T00:00:00Z")))?.code).toBe("unsupported_tld");
    expect((await fail(q({ fqdn: "moon fern.com" }, "2026-11-07T00:00:00Z")))?.code).toBe("invalid_fqdn");
    expect((await fail(q({ fqdn: "xn--nxasmq6b.com" }, "2026-11-07T00:00:00Z")))?.code).toBe("invalid_fqdn");
  });
  it("refuses any client-supplied price field instead of ignoring it", async () => {
    for (const extra of [{ price: 1 }, { total: 1 }, { amount_minor: 1 }, { wholesale: 1 }, { fee: 0 }]) {
      const err = await fail(q({ fqdn: "moonfern.com", ...extra } as never, "2026-11-07T00:00:00Z"));
      expect(err?.code).toBe("unexpected_field");
    }
  });
  it("D-031: refuses a registry-premium quote and a quote at a non-standard price", async () => {
    const reg = new MockRegistrarPort({ wholesalePerYear: { com: 1525n, dev: 1700n, app: 2100n, studio: 5100n, io: 6000n, ai: 11100n } });
    expect((await fail(q({ fqdn: "premium-shop.com" }, "2026-11-07T00:00:00Z", { registrar: reg })))?.code).toBe("premium_refused");
    reg.overrideQuote("cheapish.com", 10890n);
    expect((await fail(q({ fqdn: "cheapish.com" }, "2026-11-07T00:00:00Z", { registrar: reg })))?.code).toBe("price_mismatch");
    const ok = await q({ fqdn: "plainname.com" }, "2026-11-07T00:00:00Z", { registrar: reg });
    expect(ok.subtotalMinor).toBe(1925n);
  });
});

describe("pricing: tax ceiling, hash and expiry", () => {
  it("adds a 10% ceiling of the subtotal rounded up, from the flag", async () => {
    const r = await q({ fqdn: "moonfern.com" }, "2026-11-07T00:00:00Z");
    expect([r.taxCeilingBps, r.subtotalMinor, r.taxCeilingMinor, r.totalMinor]).toEqual([1000, 1925n, 193n, 2118n]);
    await app.db.owner.query("update flags set value = '500' where name = 'pricing.tax_ceiling_bps'");
    try {
      const r2 = await q({ fqdn: "moonfern.com" }, "2026-11-07T00:00:00Z");
      expect([r2.taxCeilingMinor, r2.totalMinor]).toEqual([97n, 2022n]);
    } finally { await app.db.owner.query("update flags set value = '1000' where name = 'pricing.tax_ceiling_bps'"); }
  });
  it("hashes deterministically, expires in 30 minutes, and rejects a tampered or expired stored quote", async () => {
    const a = await q({ fqdn: "moonfern.io" }, "2026-11-07T00:00:00Z");
    const b = await q({ fqdn: "MoonFern.io" }, "2026-11-07T00:00:00Z");
    expect(a.quoteHash).toBe(b.quoteHash);
    expect(a.quoteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.expiresAt.getTime() - a.quotedAt.getTime()).toBe(QUOTE_TTL_MS);
    const j = quoteToJson(a);
    expect(verifyQuoteJson(j, new Date("2026-11-07T00:29:59Z")).ok).toBe(true);
    expect(verifyQuoteJson(j, new Date("2026-11-07T00:30:00Z"))).toEqual({ ok: false, reason: "expired" });
    expect(verifyQuoteJson({ ...j, total_minor: "1" }, new Date("2026-11-07T00:01:00Z"))).toEqual({ ok: false, reason: "hash" });
    expect(JSON.stringify(j)).toContain('"total_minor":"'); // bigint travels as a string
    const c = await q({ fqdn: "moonfern.io" }, "2026-11-07T00:00:01Z");
    expect(c.quoteHash).not.toBe(a.quoteHash);
  });
});
