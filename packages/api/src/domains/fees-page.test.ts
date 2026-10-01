import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@mosshatch/db/testing";
import { buildQuote, PricingError } from "../pricing/index.ts";
import { configurePriceTables, resetPriceTables } from "../pricing/registrar.ts";

/**
 * C-27 (fee page), C-28 (deletion and auto-renew policy), C-26 (ERRP notice schedule), C-29 (refund windows), C-59/C-60 (.ai and .io terms),
 * C-13 (registrar of record) and C-53/C-62 (commitments). The public pages are static HTML under the strict CSP, so this test holds them to the
 * price table and the notice code: a price or a date on the page that the system would not charge or send fails the build.
 */
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../apps/web/public");
const read = (f: string) => fs.readFileSync(path.join(WEB, f), "utf8");
const dollars = (minor: bigint) => `$${(minor / 100n).toString()}.${(minor % 100n).toString().padStart(2, "0")}`;

// The page shows what production charges: the live registrar's table (Openprovider, migration 1120).
const REGISTRAR = "openprovider";
let db: TestDb;
beforeAll(async () => { db = await createTestDb(); configurePriceTables({ MH_REGISTRAR_MODE: "live", MH_REGISTRAR_PROVIDER: REGISTRAR }); }, 60_000);
afterAll(async () => { resetPriceTables(); await db?.drop(); });

async function quote(fqdn: string, kind: "register" | "renew" | "restore", at: string) {
  const c = await db.owner.connect();
  try { return await buildQuote(c, { fqdn, kind }, new Date(at)); } finally { c.release(); }
}

describe("public fee page (C-27, C-28, C-29, C-26)", () => {
  const html = read("fees.html");
  const row = (tld: string) => { const m = new RegExp(`<tr data-tld="${tld}">([\\s\\S]*?)</tr>`).exec(html); expect(m, tld).toBeTruthy(); return m![1]!; };
  const cell = (tld: string, kind: string) => new RegExp(`data-kind="${kind}">([^<]*)<`).exec(row(tld))?.[1] ?? "";

  it("every register, renew and restore price on the page equals the quote the system builds on the price date", async () => {
    const date = /id="price-date">(\d{4}-\d\d-\d\d)</.exec(html)![1]!;
    for (const tld of ["com", "dev", "app", "studio", "io", "ai"]) {
      for (const kind of ["register", "renew", "restore"] as const) {
        const q = await quote(`fees-check.${tld}`, kind, `${date}T12:00:00Z`).catch((e) => e);
        // No upstream price yet (restore at Openprovider): the page says it is not sold online, and nothing can be charged for it.
        if (q instanceof PricingError && q.code === "no_price") { expect(cell(tld, kind), `${tld} ${kind}`).toMatch(/^Not sold online yet/); continue; }
        expect(cell(tld, kind), `${tld} ${kind}`).toContain(dollars(q.subtotalMinor));
      }
    }
    expect(cell("ai", "register")).toMatch(/for 2 years \(2 years minimum\)/);
  });

  it("every announced price change on the page matches the effective-dated table", async () => {
    for (const m of html.matchAll(/data-change="([a-z]+):(\d{4}-\d\d-\d\d)">([^<]*)</g)) {
      const [, tld, day, text] = m;
      const reg = await quote(`fees-check.${tld}`, "register", `${day}T12:00:00Z`);
      const before = await quote(`fees-check.${tld}`, "register", new Date(new Date(`${day}T12:00:00Z`).getTime() - 86_400_000).toISOString());
      expect(reg.subtotalMinor, `${tld} changes on ${day}`).not.toBe(before.subtotalMinor);
      expect(text, tld).toContain(dollars(reg.subtotalMinor));
      if (/to restore/.test(text!)) expect(text).toContain(dollars((await quote(`fees-check.${tld}`, "restore", `${day}T12:00:00Z`)).subtotalMinor));
    }
    // Every future row in the price table is announced on the page.
    const future = (await db.owner.query("select distinct tld, effective_from::text as d from wholesale_prices where registrar = $1 and kind = 'register' and effective_from > '2026-10-01'", [REGISTRAR])).rows;
    for (const f of future) expect(html, `${f.tld} ${f.d}`).toContain(`data-change="${f.tld}:${f.d}"`);
  });

  it("refund windows match refund_policy; the deletion range is at most 10 days (RAA 3.7.5.4) and matches tld_policy", async () => {
    const rp = (await db.owner.query("select tld, refundable, window_days from refund_policy where registrar = $1", [REGISTRAR])).rows;
    expect(rp.length).toBe(6);
    for (const r of rp) expect(row(r.tld), r.tld).toContain(`data-refund="${r.refundable ? r.window_days : 0}"`);
    const pol = (await db.owner.query("select tld, expiry_grace_days, redemption_days, auction_from_day from tld_policy where registrar = $1 and tld in ('com','dev','app','studio')", [REGISTRAR])).rows;
    expect(pol.length).toBe(4);
    for (const p of pol) {
      expect(html).toContain(`Days 1 to ${p.expiry_grace_days}`);
      expect(html).toContain(`Days ${p.auction_from_day} to`);
      expect(html).toContain(`redemption for ${p.redemption_days} days`);
    }
    const range = /between day (\d+) and day (\d+) after it expires/.exec(html)!;
    expect(Number(range[2]) - Number(range[1])).toBeLessThanOrEqual(10);
  });

  it("the notice schedule on the page is the one the jobs send (E-43, E-32, C-8 = E-18, E-7, E+1, E+7/21/35)", async () => {
    const { RENEWAL_STAGES, LASTCHANCE_STAGES, ICANN_E7 } = await import("./notices.ts");
    const { CHARGE_DAYS_BEFORE_EXPIRY } = await import("./common.ts");
    for (const s of RENEWAL_STAGES) {
      if (s.from < 0) expect(html).toContain(`${-s.from} days before expiry`);
      else expect(html).toContain(`${s.from} day after expiry`);
    }
    expect(html).toContain(`${-ICANN_E7.from} days before expiry`);
    expect(html).toContain(`${LASTCHANCE_STAGES.map((s) => s.from).join(", ").replace(/, (\d+)$/, " and $1")} days after expiry`);
    expect(html).toContain(`${18 - CHARGE_DAYS_BEFORE_EXPIRY} days before an automatic charge`);
    expect(html).toContain("ten days before the domain expires");
  });

  it("C-13: the registrar of record, the ICANN lookup and benefits links and the complaints path are on the page; no ICANN logo is used", () => {
    expect(html).toContain("Hosting Concepts B.V., trading as Registrar.eu and Openprovider (IANA ID 1647)");
    expect(html).toContain("https://lookup.icann.org/");
    expect(html).toContain("https://www.icann.org/resources/pages/benefits-2013-09-16-en");
    expect(html).toMatch(/complain/i);
    expect(html).not.toMatch(/<img/i);
    // The Openprovider reseller account exists and sells live (docs/GO-LIVE.md): the page names it as the registrar of record, not a plan.
    expect(html).toMatch(/The registrar of record for names you buy here is Hosting Concepts B\.V\./);
    expect(html).not.toMatch(/planned registrar of record/i);
    expect(read("commitments.html")).toContain("Hosting Concepts B.V., trading as Registrar.eu and Openprovider (IANA ID 1647)");
    expect(read("commitments.html")).toContain('href="/fees.html"');
  });

  it("C-59, C-60: the .ai and .io addenda state the two-year term, public contacts, no refund, the .io rules and the sovereignty risk", () => {
    const ai = read("legal/tld-addendum-ai.html"), io = read("legal/tld-addendum-io.html");
    expect(ai).toMatch(/at least 2 years/); expect(ai).toMatch(/no contact privacy/); expect(ai).toMatch(/cannot be refunded/);
    expect(io).toMatch(/at least two nameservers/); expect(io).toMatch(/no sexual or pornographic use/); expect(io).toMatch(/Chagos/); expect(io).toMatch(/cannot be refunded/);
  });

  it("C-53, C-62: the commitments page says who sees a search, never registers on search, and keeps registry lookups off the keystroke path", () => {
    const c = read("commitments.html");
    expect(c).toMatch(/never register a name because you searched/);
    expect(c).toMatch(/They see the name/);
    expect(c).toMatch(/do not send your searches to public WHOIS or RDAP services in bulk/);
    // The preview's registered-or-not check (packages/api/src/lookup) is described, and nothing says searches stay in the browser.
    expect(c).toMatch(/our server asks each extension's registry through its public RDAP service/);
    expect(c).toMatch(/at most ten minutes in the preview/);
    expect(c).not.toMatch(/stays in your browser/);
    // And the code agrees: the only RDAP client is that preview check (rate-limited and cached); none in the web app or elsewhere in the API.
    const grep = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" ? [] : grep(path.join(dir, e.name))) : e.name.endsWith(".ts") || e.name.endsWith(".tsx") ? [path.join(dir, e.name)] : []);
    const offenders = [...grep(path.resolve(WEB, "../src")), ...grep(path.resolve(WEB, "../../../packages/api/src"))]
      .filter((f) => !f.endsWith(".test.ts") && !f.includes(`${path.sep}lookup${path.sep}`) && /https?:\/\/[^"'\s]*rdap/i.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
