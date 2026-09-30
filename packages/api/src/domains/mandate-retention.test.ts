import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { Router } from "../http/router.ts";
import { purgeExpired } from "../ops/retention.ts";
import { DISPUTE_WINDOW_MS, MANDATE_KEEP_AFTER_CHARGE_MS, MANDATE_RETAIN_MS } from "./mandate.ts";

/**
 * C-19 / C-31 / C-38 review: a revoked auto-renew mandate and the consent that proves it are evidence for every renewal charged under
 * it. They were kept three years from the signature only, so a mandate revoked after a late renewal lost its record while that charge
 * could still be disputed. They are now kept at least three years after the last renewal charge (COMPLIANCE C-31: "kept at least 3
 * years after the last renewal"), which also covers the 540-day card dispute window (no dispute-window figure is stated in PLAN or
 * COMPLIANCE; 540 days is the longest card-network window and is an unverified own figure).
 */

let app: TestApp;
const DAY = 86_400_000;
const q = <T = any>(sql: string, p: unknown[] = []) => app.db.owner.query(sql, p).then((r) => r.rows as T[]);
const T0 = new Date("2026-10-01T12:00:00Z");
const at = (d: number) => new Date(T0.getTime() + d * DAY);
let seq = 0;

beforeAll(async () => { app = await createTestApp(new Router()); }, 60_000);
afterAll(async () => { await app?.drop(); });
beforeEach(async () => { await q("delete from renewal_mandates; delete from consents;"); app.clock.set(T0); });

/** A person, a domain, and a mandate signed at T0 with its consent, both kept three years from the signature (as mandate.ts writes them). */
async function mandateAtT0() {
  const u = (await q("insert into users (email, status, email_verified_at) values ($1,'active',now()) returning id", [`mr${++seq}-${Date.now()}@example.com`]))[0].id as string;
  const fqdn = `mandate-ret-${seq}-${Date.now().toString(36)}.com`;
  const d = (await q("insert into domains (user_id, fqdn_ascii, tld, registrar, livemode) values ($1,$2,'com','mock',false) returning id", [u, fqdn]))[0].id as string;
  const retain = new Date(T0.getTime() + MANDATE_RETAIN_MS);
  const consent = (await q("insert into consents (user_id, kind, document_hash, version, accepted_at, domain_id, actor_kind, retain_until) values ($1,'auto_renew_mandate','h','v',$2,$3,'user',$4) returning id", [u, T0, d, retain]))[0].id as string;
  const mandate = (await q("insert into renewal_mandates (domain_id, user_id, price_ceiling_minor, text_hash, accepted_at, retain_until, consent_id) values ($1,$2,1000,'t',$3,$4,$5) returning id", [d, u, T0, retain, consent]))[0].id as string;
  return { u, d, fqdn, consent, mandate };
}

/** A renewal charged off-session for the domain on day `day` (the payment row the renewal job writes). */
async function renewalCharge(m: { u: string; d: string; fqdn: string }, day: number) {
  const o = (await q(
    `insert into orders (user_id, kind, fqdn_ascii, domain_id, years, state, idempotency_key, request_hash, quote, subtotal_minor, total_minor, livemode, target_expiry_year, created_at)
     values ($1,'renew',$2,$3,1,'renewed',$4,'\\x00','{}',1000,1000,false,$5,$6) returning id`, [m.u, m.fqdn, m.d, `renew-${m.d}-${day}`, 2027 + Math.floor(day / 365), at(day)]))[0].id as string;
  await q("insert into payments (order_id, user_id, stripe_payment_intent_id, amount_minor, tax_minor, currency, status, captured_at, livemode, created_at) values ($1,$2,$3,1000,0,'usd','succeeded',$4,false,$4)",
    [o, m.u, `pi_ret_${o}`, at(day)]);
}

const kept = async (m: { mandate: string; consent: string }) => ({
  mandate: (await q("select count(*)::int n from renewal_mandates where id = $1", [m.mandate]))[0].n === 1,
  consent: (await q("select count(*)::int n from consents where id = $1", [m.consent]))[0].n === 1,
});

describe("C-19 / C-38: a revoked mandate and its consent outlive the last charge made under it", () => {
  it("C-19: a mandate revoked after a late renewal is kept past three years from the signature, until three years after that charge", async () => {
    const m = await mandateAtT0();
    await renewalCharge(m, 1060);                                          // the third renewal, days before the old three-year mark
    await q("update renewal_mandates set revoked_at = $2, revoked_by = 'user' where id = $1", [m.mandate, at(1065)]);
    app.clock.set(at(1096));                                                // past signature + 3 years
    await purgeExpired(app.ctx);
    expect(await kept(m)).toEqual({ mandate: true, consent: true });
    app.clock.set(at(1060 + 541));                                          // the charge's 540-day dispute window has closed
    await purgeExpired(app.ctx);
    expect(await kept(m)).toEqual({ mandate: true, consent: true });
    const row = (await q("select retain_until from renewal_mandates where id = $1", [m.mandate]))[0];
    expect(new Date(row.retain_until).getTime()).toBeGreaterThanOrEqual(at(1060).getTime() + 3 * 365 * DAY);
    const c = (await q("select retain_until from consents where id = $1", [m.consent]))[0];
    expect(new Date(c.retain_until).getTime()).toBeGreaterThanOrEqual(at(1060).getTime() + 540 * DAY);
    app.clock.set(at(1060 + 3 * 365 + 1));                                  // three years after the last renewal
    await purgeExpired(app.ctx);
    expect(await kept(m)).toEqual({ mandate: false, consent: false });
  });

  it("C-38: a charge that settles after the mandate was revoked still extends what is kept; a mandate never charged keeps its three years", async () => {
    const m = await mandateAtT0();
    await q("update renewal_mandates set revoked_at = $2, revoked_by = 'user' where id = $1", [m.mandate, at(1000)]);
    await renewalCharge(m, 1001);                                           // started before the switch-off, settled the day after
    const idle = await mandateAtT0();
    await q("update renewal_mandates set revoked_at = $2, revoked_by = 'user' where id = $1", [idle.mandate, at(30)]);
    app.clock.set(at(1096));
    await purgeExpired(app.ctx);
    expect(await kept(m)).toEqual({ mandate: true, consent: true });
    expect(await kept(idle)).toEqual({ mandate: false, consent: false });
    app.clock.set(at(1001 + 3 * 365 + 1));
    await purgeExpired(app.ctx);
    expect(await kept(m)).toEqual({ mandate: false, consent: false });
  });

  it("C-31: the kept period after a charge is three years (the figure migration 0670 uses) and outlasts the dispute window", () => {
    expect(MANDATE_KEEP_AFTER_CHARGE_MS).toBe(1095 * DAY);
    expect(MANDATE_KEEP_AFTER_CHARGE_MS).toBeGreaterThanOrEqual(DISPUTE_WINDOW_MS);
    expect(DISPUTE_WINDOW_MS).toBe(540 * DAY);
  });

  it("C-19: a legal hold still keeps a mandate past every clock", async () => {
    const m = await mandateAtT0();
    await renewalCharge(m, 100);
    await q("update renewal_mandates set revoked_at = $2, legal_hold = true where id = $1", [m.mandate, at(120)]);
    app.clock.set(at(100 + 3 * 365 + 10));
    await purgeExpired(app.ctx);
    expect(await kept(m)).toEqual({ mandate: true, consent: true });
  });
});
