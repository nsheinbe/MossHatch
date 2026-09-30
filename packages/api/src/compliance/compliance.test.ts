import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUser } from "@mosshatch/db";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { LocalFixtureSanctions, screenSanctions, screeningBlocks } from "./sanctions.ts";
import { checkNewAccountLimits } from "./velocity.ts";
import { buildQuote, quoteToJson } from "../pricing/quote.ts";

let app: TestApp;
let seq = 0;
beforeAll(async () => { app = await createTestApp(); }, 60_000);
afterAll(async () => { await app?.drop(); });

async function newUser(opts: { ageDays?: number; risk?: "normal" | "review" } = {}) {
  const created = new Date(app.clock.now().getTime() - (opts.ageDays ?? 0) * 86_400_000);
  return (await app.db.owner.query("insert into users (email, status, email_verified_at, created_at, risk_state) values ($1,'active',now(),$2,$3) returning id", [`u${++seq}-${Math.random().toString(36).slice(2)}@example.test`, created, opts.risk ?? "normal"])).rows[0].id as string;
}
async function placeOrder(userId: string, fqdn: string, state = "authorized", createdAt = app.clock.now()) {
  const q = await withUser(app.ctx.runtime, userId, (c) => buildQuote(c, { fqdn }, app.clock.now()));
  await app.db.owner.query(
    `insert into orders (user_id, kind, fqdn_ascii, years, state, idempotency_key, request_hash, quote, subtotal_minor, tax_ceiling_minor, total_minor, livemode, created_at)
     values ($1,'register',$2,$3,$4,$5,'\\x00',$6,$7,$8,$9,false,$10)`,
    [userId, fqdn, q.years, state, `k-${++seq}-${Math.random()}`, quoteToJson(q), q.subtotalMinor, q.taxCeilingMinor, q.totalMinor, createdAt],
  );
  return q;
}
const decide = (userId: string, wholesaleMinor: bigint) => withUser(app.ctx.runtime, userId, (c) => checkNewAccountLimits(c, userId, { wholesaleMinor }, app.clock.now()));

describe("sanctions screening", () => {
  const port = new LocalFixtureSanctions();
  it("matches listed names, near names go to review, unlisted are clear, embargoed countries match", async () => {
    expect(await port.screen({ name: "Test Sanctioned Person" })).toBe("match");
    expect(await port.screen({ name: "  TEST   sanctioned person " })).toBe("match");
    expect(await port.screen({ name: "Mr Test Sanctioned Person Jr" })).toBe("match");
    expect(await port.screen({ name: "Test Sanctioned Persan" })).toBe("review");
    expect(await port.screen({ name: "Ada Lovelace", country: "GB" })).toBe("clear");
    expect(await port.screen({ name: "Ada Lovelace", country: "ir" })).toBe("match");
    expect(await port.screen({ organization: "Blocked Trading Company Ltd" })).toBe("match");
    expect(screeningBlocks("clear")).toBe(false); expect(screeningBlocks("review")).toBe(true);
  });
  it("logs the opaque ref, list version and result, and never the name or country", async () => {
    const uid = await newUser();
    const r = await app.ctx.cron.connect().then(async (c) => { try { return await screenSanctions(port, c, { kind: "user", ref: uid, name: "Test Sanctioned Person", country: "US" }, app.clock.now()); } finally { c.release(); } });
    expect(r.result).toBe("match");
    const row = (await app.db.owner.query("select * from sanctions_screenings where id = $1", [r.id])).rows[0];
    expect(row).toMatchObject({ subject_kind: "user", subject_ref: uid, list_version: "fixture-2026-09-29", result: "match" });
    expect(JSON.stringify(row).toLowerCase()).not.toContain("sanctioned");
  });
});

describe("new-account limits", () => {
  it("blocks the sixth registration in a day for an account in its first 30 days, not for an older one", async () => {
    const u = await newUser();
    for (let i = 0; i < 5; i++) { expect((await decide(u, 1525n)).allowed, `#${i + 1}`).toBe(true); await placeOrder(u, `daily${++seq}${i}.com`, "captured"); }
    expect(await decide(u, 1525n)).toMatchObject({ allowed: false, newAccount: true, reasons: ["new_account_daily_registrations"] });
    app.clock.advance(25 * 3600_000);
    expect((await decide(u, 1525n)).allowed).toBe(true);
    const old = await newUser({ ageDays: 60 });
    for (let i = 0; i < 6; i++) await placeOrder(old, `older${++seq}${i}.com`, "captured", app.clock.now());
    expect(await decide(old, 1525n)).toMatchObject({ allowed: true, newAccount: false });
  });
  it("counts orders that were never authorized as not registrations", async () => {
    const u = await newUser();
    for (let i = 0; i < 8; i++) await placeOrder(u, `draft${++seq}${i}.com`, i % 2 ? "checkout_open" : "checkout_expired");
    expect((await decide(u, 1525n)).allowed).toBe(true);
  });
  it("caps wholesale exposure in flight at USD 300 for a new account and releases it on capture", async () => {
    const u = await newUser();
    await placeOrder(u, `exp${++seq}a.ai`, "authorized"); // 222.00 wholesale for two years
    expect(await decide(u, 22200n)).toMatchObject({ allowed: false, reasons: ["new_account_exposure"] });
    expect((await decide(u, 7800n)).allowed).toBe(true);   // exactly 300.00 total
    expect((await decide(u, 7801n)).allowed).toBe(false);  // one cent over
    await app.db.owner.query("update orders set state = 'captured' where user_id = $1", [u]);
    expect((await decide(u, 22200n)).allowed).toBe(true);
  });
  it("risk_state review blocks orders above USD 50 wholesale but not at or below it, for any account age", async () => {
    const u = await newUser({ ageDays: 90, risk: "review" });
    expect(await decide(u, 5001n)).toMatchObject({ allowed: false, reasons: ["review_hold"] });
    expect((await decide(u, 5000n)).allowed).toBe(true);
    const normal = await newUser({ ageDays: 90 });
    expect((await decide(normal, 22200n)).allowed).toBe(true);
  });
  it("enforces the global daily cap from flags across all accounts", async () => {
    const before = (await app.db.owner.query("select value from flags where name = 'limits.daily_registrations'")).rows[0].value;
    const base = (await app.db.owner.query("select velocity_global_registrations($1) as n", [new Date(app.clock.now().getTime() - 86_400_000)])).rows[0].n as number;
    await app.db.owner.query("update flags set value = to_jsonb($1::int) where name = 'limits.daily_registrations'", [base + 2]);
    try {
      const a = await newUser({ ageDays: 90 }), b = await newUser({ ageDays: 90 });
      expect((await decide(a, 1525n)).allowed).toBe(true); await placeOrder(a, `cap${++seq}.com`, "captured");
      expect((await decide(b, 1525n)).allowed).toBe(true); await placeOrder(b, `cap${++seq}.com`, "captured");
      expect(await decide(a, 1525n)).toMatchObject({ allowed: false, reasons: ["global_daily_cap"] });
    } finally { await app.db.owner.query("update flags set value = $1::jsonb where name = 'limits.daily_registrations'", [JSON.stringify(before)]); }
  });
  it("the runtime role cannot read other accounts' orders, only the aggregate function", async () => {
    const a = await newUser(), b = await newUser();
    await placeOrder(b, `priv${++seq}.com`, "captured");
    const seen = await withUser(app.ctx.runtime, a, (c) => c.query("select count(*)::int as n from orders where user_id = $1", [b]));
    expect(seen.rows[0].n).toBe(0);
  });
});

describe("ST-132: velocity limits and sanctions screening block a scripted bulk registration by new accounts", () => {
  it("a script that registers 20 names from each of five new accounts is stopped by screening, per-account velocity and the global cap", async () => {
    const port = new LocalFixtureSanctions();
    const before = (await app.db.owner.query("select value from flags where name = 'limits.daily_registrations'")).rows[0].value;
    const base = (await app.db.owner.query("select velocity_global_registrations($1) as n", [new Date(app.clock.now().getTime() - 86_400_000)])).rows[0].n as number;
    const GLOBAL = 12;
    await app.db.owner.query("update flags set value = to_jsonb($1::int) where name = 'limits.daily_registrations'", [base + GLOBAL]);
    try {
      const accounts = [
        { id: await newUser(), name: "Test Sanctioned Person", country: "US" },   // listed name
        { id: await newUser(), name: "Ordinary Bot One", country: "KP" },         // embargoed country
        { id: await newUser(), name: "Ordinary Bot Two", country: "US" },
        { id: await newUser(), name: "Ordinary Bot Three", country: "US" },
        { id: await newUser(), name: "Ordinary Bot Four", country: "US" },
      ];
      const registered: Record<string, number> = {}; const blockedBy = new Map<string, number>();
      const bump = (k: string) => blockedBy.set(k, (blockedBy.get(k) ?? 0) + 1);
      for (const a of accounts) {
        registered[a.id] = 0;
        for (let i = 0; i < 20; i++) {
          const screened = await withUser(app.ctx.runtime, a.id, (c) => screenSanctions(port, c, { kind: "user", ref: a.id, name: a.name, country: a.country }, app.clock.now()));
          if (screeningBlocks(screened.result)) { bump("screening"); continue; }
          const d = await decide(a.id, 1525n);
          if (!d.allowed) { for (const r of d.reasons) bump(r); continue; }
          await placeOrder(a.id, `bulk${++seq}x${i}.com`, "authorized");
          registered[a.id]!++;
        }
      }
      const perAccount = accounts.map((a) => registered[a.id]!);
      expect(perAccount[0]).toBe(0);                 // sanctioned name never gets past screening
      expect(perAccount[1]).toBe(0);                 // embargoed country never gets past screening
      for (const n of perAccount) expect(n).toBeLessThanOrEqual(5);
      expect(perAccount).toEqual([0, 0, 5, 5, 2]); // three clean accounts could each do 5 (15); the global cap of 12 stops the last one at 2
      expect(perAccount.reduce((x, y) => x + y, 0)).toBe(GLOBAL);
      expect(blockedBy.get("screening")).toBe(40);
      expect(blockedBy.get("new_account_daily_registrations")).toBeGreaterThan(0);
      expect(blockedBy.get("global_daily_cap")).toBeGreaterThan(0);
      // Without the guards the same script would have registered 100 names.
    } finally { await app.db.owner.query("update flags set value = $1::jsonb where name = 'limits.daily_registrations'", [JSON.stringify(before)]); }
  });
});
