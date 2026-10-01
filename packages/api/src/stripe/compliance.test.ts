import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/app.ts";
import { Router } from "../http/router.ts";
import { tx } from "@mosshatch/db";
import { FakeStripe } from "./fake.ts";
import { StripeReal } from "./real.ts";
import type { CreateSessionInput } from "./port.ts";
import { toStripeSessionParams } from "./params.ts";
import { CATALOG, RADAR_RULES, STATEMENT_DESCRIPTOR_PREFIX, STRIPE_OPERATIONS, descriptorProblem, descriptorSuffix, ensureCatalog, operationForOrderKind } from "./catalog.ts";
import { DISPUTE_TIERS, checkDisputeRates, recordRiskEvent } from "./disputes.ts";

const input = (o: Partial<CreateSessionInput> = {}, op?: CreateSessionInput["lineItem"]["operation"]): CreateSessionInput => ({
  customer: "cus_1", clientReferenceId: "ord_1", successUrl: "https://mosshatch.test/ok", cancelUrl: "https://mosshatch.test/no", expiresAt: 0, metadata: { order_id: "ord_1" },
  lineItem: { name: "moss.com for 1 year", unitAmount: 1925, currency: "usd", ...(op ? { operation: op } : {}) }, captureMethod: "manual", requestThreeDSecure: "any", ...o,
});

describe("C-44: one Stripe Product per operation", () => {
  it("C-44: register, renew, transfer and restore map to four distinct fixed Product ids, and order kinds map onto them", () => {
    expect(new Set(STRIPE_OPERATIONS.map((op) => CATALOG[op].id)).size).toBe(4);
    for (const op of STRIPE_OPERATIONS) expect(toStripeSessionParams(input({}, op)).line_items[0]!.price_data.product).toBe(CATALOG[op].id);
    expect(operationForOrderKind("transfer_in")).toBe("transfer");
    expect(operationForOrderKind("restore")).toBe("restore");
    // A renewal Checkout that predates the field is recognised by its purpose; anything else is a registration.
    expect(toStripeSessionParams(input({ metadata: { order_id: "o", purpose: "renewal" } })).line_items[0]!.price_data.product).toBe(CATALOG.renew.id);
    expect(toStripeSessionParams(input()).line_items[0]!.price_data.product).toBe(CATALOG.register.id);
    // C-44: no default tax code is guessed; the accountant decides per operation.
    for (const op of STRIPE_OPERATIONS) expect(CATALOG[op].taxCode).toBeNull();
  });

  it("C-44: the fake refuses a Session for a Product that does not exist; ensureCatalog creates the four once and is idempotent", async () => {
    const clock = { t: new Date("2026-10-01T12:00:00Z"), now() { return this.t; } };
    const s = new FakeStripe(clock, { catalog: "empty" });
    const exp = Math.floor(clock.now().getTime() / 1000) + 31 * 60;
    await expect(s.createCheckoutSession(input({ expiresAt: exp }), "k1")).rejects.toMatchObject({ kind: "invalid_request", code: "resource_missing" });
    expect((await ensureCatalog(s)).map((r) => r.created)).toEqual([true, true, true, true]);
    // Within 24 hours the same idempotency keys replay the first answers (as Stripe does): nothing new is created.
    await ensureCatalog(s);
    expect(s.products.size).toBe(4);
    clock.t = new Date(clock.t.getTime() + 25 * 3600_000);                    // keys expired: the Products are found, not re-created
    expect((await ensureCatalog(s)).map((r) => r.created)).toEqual([false, false, false, false]);
    expect([...s.products.values()].map((p) => p.metadata.operation).sort()).toEqual(["register", "renew", "restore", "transfer"]);
    const exp2 = Math.floor(clock.now().getTime() / 1000) + 31 * 60;
    const sess = await s.createCheckoutSession(input({ expiresAt: exp2 }, "restore"), "k2");
    expect(s.sessionParams(sess.id).stripe.line_items[0]!.price_data.product).toBe("mh_domain_restore");
    s.products.get("mh_domain_renew")!.active = false;                        // archived in the Dashboard
    await expect(s.createCheckoutSession(input({ expiresAt: exp2 }, "renew"), "k3")).rejects.toMatchObject({ code: "resource_missing" });
  });

  it("C-44: the real adapter creates each Product under its fixed id and reads back one that exists (stub client; never called against Stripe)", async () => {
    const created: any[] = [];
    const client = {
      products: {
        create: async (p: any) => { if (p.id === "mh_domain_renew") throw Object.assign(new Error("exists"), { type: "StripeInvalidRequestError", statusCode: 400, code: "resource_already_exists" }); created.push(p); return { id: p.id, active: true }; },
        retrieve: async (id: string) => ({ id, active: true }),
      },
    };
    const real = new StripeReal({ apiKey: "sk_test_x", mode: "local", registrarMode: "mock", client: client as never });
    expect(await ensureCatalog(real)).toEqual([
      { id: "mh_domain_register", created: true }, { id: "mh_domain_renew", created: false }, { id: "mh_domain_transfer", created: true }, { id: "mh_domain_restore", created: true },
    ]);
    expect(created[0]).toEqual({ id: "mh_domain_register", name: "Domain registration", metadata: { operation: "register" } });
  });
});

describe("C-40: statement descriptor and Radar notes as config", () => {
  it("C-40: one static prefix and a per-operation suffix that fits Stripe's 22-character rule; a charge-level descriptor is never sent for cards", () => {
    expect(STATEMENT_DESCRIPTOR_PREFIX).toBe("MOSSHATCH");
    for (const op of STRIPE_OPERATIONS) {
      expect(descriptorProblem(STATEMENT_DESCRIPTOR_PREFIX, CATALOG[op].descriptorSuffix)).toBeNull();
      expect(`${STATEMENT_DESCRIPTOR_PREFIX}* ${descriptorSuffix(op)}`.length).toBeLessThanOrEqual(22);
      const p = toStripeSessionParams(input({}, op)).payment_intent_data;
      expect(p.statement_descriptor_suffix).toBe(CATALOG[op].descriptorSuffix);
      expect(p).not.toHaveProperty("statement_descriptor");
    }
    expect(descriptorProblem("MOSSHATCH", "DOMAIN RENEWAL")).toBe("too_long");
    expect(descriptorProblem("MOSSHATCH", "REG*1")).toBe("forbidden_character");
    expect(descriptorProblem("MOSSHATCH", "2026")).toBe("suffix_needs_letter");
    expect(descriptorProblem("M", "RENEWAL")).toBe("prefix_length");
  });

  it("C-40: off-session renewals carry the RENEWAL suffix in the fake and in the real adapter's parameters", async () => {
    const clock = { now: () => new Date("2026-10-01T12:00:00Z") };
    const s = new FakeStripe(clock);
    s.attachCard("pm_saved", "cus_1");
    const pi = await s.createOffSessionPaymentIntent({ customer: "cus_1", paymentMethod: "pm_saved", amount: 1925, currency: "usd", metadata: {} }, "os1");
    expect(s.descriptors.get(pi.id)).toBe("RENEWAL");
    expect(pi.card_brand).toBe("visa");
    const sent: any[] = [];
    const real = new StripeReal({ apiKey: "sk_test_x", mode: "local", registrarMode: "mock", client: { paymentIntents: { create: async (p: any) => { sent.push(p); return { id: "pi_1", status: "succeeded", amount: 1925, currency: "usd", livemode: false, capture_method: "automatic", created: 1 }; } } } as never });
    await real.createOffSessionPaymentIntent({ customer: "cus_1", paymentMethod: "pm_saved", amount: 1925, currency: "usd", metadata: {}, operation: "restore" }, "os2");
    expect(sent[0].statement_descriptor_suffix).toBe("RESTORE");
    expect(sent[0]).not.toHaveProperty("statement_descriptor");
  });

  it("C-40: the Radar rules are documented as config with a reason each, and none of them evades monitoring", () => {
    expect(new Set(RADAR_RULES.map((r) => r.id)).size).toBe(RADAR_RULES.length);
    for (const r of RADAR_RULES) { expect(r.rule).toMatch(/^(Block|Review|Request 3D Secure|Allow) if /); expect(r.why.length).toBeGreaterThan(10); }
    expect(RADAR_RULES.filter((r) => r.action === "allow")).toEqual([]);
    expect(RADAR_RULES.map((r) => r.id)).toEqual(expect.arrayContaining(["default-highest", "elevated-3ds", "cvc-fail"]));
  });
});

describe("C-40: dispute-rate alarm through ops/alerts", () => {
  let app: TestApp; let userId: string; let orderId: string;
  const q = <T = any>(sql: string, p: unknown[] = []) => app.db.owner.query(sql, p).then((r) => r.rows as T[]);
  let seq = 0;
  const pay = async (brand: string | null, at: Date, livemode = false) =>
    (await q("insert into payments (order_id, user_id, stripe_payment_intent_id, amount_minor, currency, status, captured_at, livemode, card_brand) values ($1,$2,$3,1925,'usd','succeeded',$4,$5,$6) returning stripe_payment_intent_id as pi",
      [orderId, userId, `pi_dr_${++seq}`, at, livemode, brand]))[0].pi as string;
  const risk = (type: "charge.dispute.created" | "radar.early_fraud_warning.created", pi: string, at: Date, brand?: string) => tx(app.ctx.cron, (c) => recordRiskEvent(c, {
    id: `evt_dr_${++seq}`, type, livemode: false, created: Math.floor(at.getTime() / 1000),
    data: { object: { id: `dp_${seq}`, payment_intent: pi, ...(brand ? { payment_method_details: { type: "card", card: { brand } } } : {}) } },
  }, orderId));
  const alertsOf = async () => (await q("select severity, subject from alerts where kind = 'stripe.dispute_rate' order by subject")).map((a) => `${a.severity}:${a.subject}`);

  beforeAll(async () => {
    app = await createTestApp(new Router());
    userId = (await q("insert into users (email, status, email_verified_at) values ('dr@example.com','active',now()) returning id"))[0].id;
    orderId = (await q("insert into orders (user_id, kind, fqdn_ascii, years, state, idempotency_key, request_hash, quote, subtotal_minor, total_minor, livemode) values ($1,'register','dr.com',1,'captured','k','\\x00','{}',1925,1925,false) returning id", [userId]))[0].id;
  }, 60_000);
  afterAll(async () => { await app?.drop(); });
  beforeEach(async () => { await q("delete from alerts; delete from payment_risk_events; delete from payments"); app.clock.set(new Date("2026-10-20T12:00:00Z")); });

  it("C-40: tiers are config at the documented thresholds (own 0.5%, Stripe 0.75%, VAMP 0.5% and 5, VAMP Excessive 1.5% and 1,500, ECM 1.5% and 100)", () => {
    const t = Object.fromEntries(DISPUTE_TIERS.map((x) => [x.id, [x.minRatio, x.minEvents, x.network]]));
    expect(t).toEqual({
      own_target: [0.005, 1, "all"], stripe_review: [0.0075, 1, "all"], visa_vamp_non_compliant: [0.005, 5, "visa"],
      visa_vamp_excessive: [0.015, 1500, "visa"], mastercard_ecm: [0.015, 100, "mastercard"],
    });
  });

  it("C-40: one dispute in 150 card payments trips the own 0.5% target only; five Visa events (a TC40 and TC15 on one charge count twice) trip VAMP Non-compliant", async () => {
    const d = new Date("2026-10-05T10:00:00Z");
    const visa: string[] = [];
    for (let i = 0; i < 100; i++) visa.push(await pay("visa", d));
    for (let i = 0; i < 50; i++) await pay("mastercard", d);
    await pay("visa", d, true);                                                   // a live-mode row never counts in a test-mode process
    expect(await checkDisputeRates(app.ctx)).toSatisfy((r: any[]) => r.every((x) => !x.tripped));
    await risk("charge.dispute.created", visa[0]!, d, "visa");
    let r = await checkDisputeRates(app.ctx);
    const oct = (id: string) => r.find((x) => x.tier === id && x.month === "2026-10")!;
    expect(oct("own_target")).toMatchObject({ events: 1, transactions: 150, tripped: true });
    expect(oct("stripe_review").tripped).toBe(false);                            // 0.67% < 0.75%
    expect(oct("visa_vamp_non_compliant")).toMatchObject({ events: 1, transactions: 100, tripped: false });
    expect(await alertsOf()).toEqual(["page:own_target:2026-10"]);

    await risk("radar.early_fraud_warning.created", visa[0]!, d);                // no brand on an EFW: taken from the payment
    for (let i = 1; i < 4; i++) await risk("charge.dispute.created", visa[i]!, d, "visa");
    r = await checkDisputeRates(app.ctx);
    expect(oct("visa_vamp_non_compliant")).toMatchObject({ events: 5, transactions: 100, tripped: true });
    expect(oct("mastercard_ecm")).toMatchObject({ events: 0, tripped: false });
    expect(await alertsOf()).toEqual(["page:own_target:2026-10", "page:stripe_review:2026-10", "page:visa_vamp_non_compliant:2026-10"]);

    // One alert per tier and month: closing them does not re-raise them on the next hourly run.
    await q("update alerts set state = 'closed'");
    await checkDisputeRates(app.ctx);
    expect((await q("select count(*)::int n from alerts where state = 'open'"))[0].n).toBe(0);
  });

  it("C-40: a dispute ratio at the own 0.5% target pages (PLAN Operations: \"dispute ratio at 0.5%\" is S1), before any network tier", async () => {
    const d = new Date("2026-10-05T10:00:00Z");
    const mc: string[] = [];
    for (let i = 0; i < 150; i++) mc.push(await pay("mastercard", d));
    await risk("charge.dispute.created", mc[0]!, d, "mastercard");                 // 0.67%: over the own target, under Stripe's 0.75% line
    const r = await checkDisputeRates(app.ctx);
    expect(r.filter((x) => x.tripped && x.month === "2026-10").map((x) => x.tier)).toEqual(["own_target"]);
    expect(await alertsOf()).toEqual(["page:own_target:2026-10"]);
  });

  it("C-40: Mastercard ECM divides this month's chargebacks by last month's transactions, EFWs do not count for it, and events are recorded once", async () => {
    for (let i = 0; i < 40; i++) await pay("mastercard", new Date("2026-09-10T10:00:00Z"));
    const pi = await pay("mastercard", new Date("2026-10-02T10:00:00Z"));
    await risk("charge.dispute.created", pi, new Date("2026-10-06T10:00:00Z"), "mastercard");
    await risk("radar.early_fraud_warning.created", pi, new Date("2026-10-06T11:00:00Z"));
    const ecm = (await checkDisputeRates(app.ctx)).find((x) => x.tier === "mastercard_ecm" && x.month === "2026-10")!;
    expect(ecm).toMatchObject({ events: 1, transactions: 40, tripped: false });   // 2.5%, but below 100 chargebacks
    const ev = { id: "evt_once", type: "charge.dispute.created", livemode: false, created: 1_790_000_000, data: { object: { payment_intent: pi } } };
    expect(await tx(app.ctx.cron, (c) => recordRiskEvent(c, ev, orderId))).toBe(true);
    expect(await tx(app.ctx.cron, (c) => recordRiskEvent(c, ev, orderId))).toBe(false);
    expect(await tx(app.ctx.cron, (c) => recordRiskEvent(c, { ...ev, id: "evt_other", type: "charge.refunded" }, orderId))).toBe(false);
  });
});
