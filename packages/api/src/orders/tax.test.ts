import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { machine, requestRefund } from "./machine.ts";
import { buyAndPay, deliver, deliverAll, drain, makeBuyer, makeHarness, orderRow, postOrder, type Buyer, type OrdersHarness } from "./testkit.ts";
import { REGION_NOT_AVAILABLE_MESSAGE, billingRegion } from "./tax.ts";
import { nexusReadings, recordSales } from "./sales-ledger.ts";
import { voidMessage } from "./support.ts";
import { CATALOG } from "../stripe/catalog.ts";

let h: OrdersHarness; let ada: Buyer;
const q = <T = any>(sql: string, p: unknown[] = []) => h.app.db.owner.query(sql, p).then((r) => r.rows as T[]);
let n = 0;
const fq = (p: string) => `free-${p}-tax-${++n}.com`;
beforeAll(async () => { h = await makeHarness(); ada = await makeBuyer(h, "ada-tax@example.com"); }, 90_000);
afterAll(async () => { await h?.app.drop(); });
beforeEach(async () => { await q("delete from rate_counters"); await q("update tax_regions set enabled = true where country = 'US'"); });

async function paidThrough(b: Buyer, billing: { country: string | null; state: string | null } | null) {
  const r = await buyAndPay(h, b, fq("b"), { pay: { billingAddress: billing } });
  await deliverAll(h); await drain(h);
  return { ...r, order: await orderRow(h, r.id) };
}

describe("C-42: the server-side tax-region gate", () => {
  it("C-42: an enabled US state authorizes and registers, and the payment records its billing region and card brand", async () => {
    const { id, order } = await paidThrough(ada, { country: "US", state: "CA" });
    expect(order.state).toBe("captured");
    const pay = (await q("select billing_state, billing_country, card_brand from payments where order_id = $1", [id]))[0];
    expect(pay).toEqual({ billing_state: "US-CA", billing_country: "US", card_brand: "visa" });
  });

  it("C-42: a billing address outside the enabled regions (another country, a US territory, a disabled state, none) voids before capture: nothing charged, no registration", async () => {
    await q("update tax_regions set enabled = false where state = 'US-TX'");
    const regBefore = h.registrar.calls.register ?? 0;
    const capturesBefore = h.stripe.created.captures;
    for (const billing of [{ country: "GB", state: null }, { country: "US", state: "PR" }, { country: "US", state: "TX" }, null]) {
      const b = await makeBuyer(h, `abroad-${++n}@example.com`);
      const { id, order } = await paidThrough(b, billing);
      expect(order.state, JSON.stringify(billing)).toBe("voided");
      expect(order.void_reason).toBe("region_not_enabled");
      const pi = [...h.stripe.paymentIntents.values()].find((p) => p.metadata.order_id === id)!;
      expect(pi.status).toBe("canceled");                                       // the hold is released, never captured
      const mail = h.app.email.sent.filter((m) => m.kind === "order.voided").at(-1)!;
      expect(mail.text).toContain(voidMessage("region_not_enabled"));
    }
    expect(h.stripe.created.captures).toBe(capturesBefore);
    expect(h.registrar.calls.register ?? 0).toBe(regBefore);
    expect(voidMessage("region_not_enabled")).toMatch(/^We sell only to billing addresses in the United States for now.*Nothing was charged\.$/);
  });

  it("C-42: before any Checkout, a buyer whose last billing region is disabled is refused with plain copy, and no region open pauses orders", async () => {
    const b = await makeBuyer(h, `wa-${++n}@example.com`);
    await paidThrough(b, { country: "US", state: "WA" });
    await q("update tax_regions set enabled = false where state = 'US-WA'");
    const sessions = h.stripe.created.sessions;
    const res = await postOrder(h, b, { fqdn: fq("refused"), years: 1 }, `wa-${n}`);
    expect(res.status).toBe(422);
    expect(res.json.error).toEqual({ code: "region_not_available", message: REGION_NOT_AVAILABLE_MESSAGE });
    expect(h.stripe.created.sessions).toBe(sessions);
    await q("update tax_regions set enabled = false");
    const closed = await postOrder(h, ada, { fqdn: fq("closed"), years: 1 }, `closed-${n}`);
    expect(closed.status).toBe(503);
    expect(closed.json.error.code).toBe("orders_paused");
    expect(h.stripe.created.sessions).toBe(sessions);
  });

  it("C-42: region codes are ISO 3166-2 for the US and the country code elsewhere; malformed input is no region", () => {
    expect(billingRegion({ country: "us", state: "ca" })).toBe("US-CA");
    expect(billingRegion({ country: "DE", state: "BE" })).toBe("DE");
    expect(billingRegion({ country: "US", state: null })).toBeNull();
    expect(billingRegion({ country: "USA", state: "CA" })).toBeNull();
    expect(billingRegion(null)).toBeNull();
  });
});

describe("C-44 and C-40: each operation has its own Stripe Product and descriptor suffix", () => {
  it("C-44: a registration Checkout names the registration Product (no inline product, no client price id) and the REGISTER suffix", async () => {
    const res = await postOrder(h, ada, { fqdn: fq("prod"), years: 2 }, `prod-${n}`);
    expect(res.status, res.text).toBe(201);
    const p = h.stripe.sessionParams((await orderRow(h, res.json.order_id)).stripe_checkout_session_id).stripe;
    expect(p.line_items[0]!.price_data).toMatchObject({ product: CATALOG.register.id, tax_behavior: "exclusive" });
    expect(p.line_items[0]!.price_data).not.toHaveProperty("product_data");
    expect(p.custom_text.submit.message).toMatch(/-tax-\d+\.com for 2 years$/);
    expect(p.payment_intent_data.statement_descriptor_suffix).toBe("REGISTER");
    expect(p.payment_intent_data).not.toHaveProperty("statement_descriptor");
  });
});

describe("C-43: the sales ledger per billing region, and nexus alerts at 60% and 80%", () => {
  it("C-43: a captured payment adds gross before tax and one transaction to its region and month; a refund subtracts pro-rated gross and tax; the job is idempotent", async () => {
    await q("delete from sales_ledger; delete from sales_ledger_entries");
    const b = await makeBuyer(h, `ledger-${++n}@example.com`);
    const { id } = await paidThrough(b, { country: "US", state: "OR" });
    await recordSales(h.app.ctx);   // the earlier tests' captured payments are entered too
    const pay = (await q("select id, amount_minor::int as amount, tax_minor::int as tax, captured_at from payments where order_id = $1", [id]))[0];
    const month = new Date(Date.UTC(pay.captured_at.getUTCFullYear(), pay.captured_at.getUTCMonth(), 1));
    const or = async () => (await q("select gross_minor::int as gross, tax_minor::int as tax, txn_count from sales_ledger where state = 'US-OR' and period = $1", [month]))[0];
    expect(await or()).toEqual({ gross: pay.amount - pay.tax, tax: pay.tax, txn_count: 1 });

    const again = await recordSales(h.app.ctx);
    expect(again).toMatchObject({ payments: 0, refunds: 0 });
    expect(await or()).toEqual({ gross: pay.amount - pay.tax, tax: pay.tax, txn_count: 1 });

    await requestRefund(machine(h.app.ctx), id, { reason: "customer", hasDnsOrConnections: false });
    const r = await recordSales(h.app.ctx);
    expect(r.refunds).toBe(1);
    expect(await or()).toEqual({ gross: 0, tax: 0, txn_count: 1 });            // a full refund nets the money out; the sale still counted as a transaction
    const ent = await q("select source_kind, gross_minor::int as gross, txn_delta from sales_ledger_entries where region = 'US-OR' order by source_kind");
    expect(ent).toEqual([{ source_kind: "payment", gross: pay.amount - pay.tax, txn_delta: 1 }, { source_kind: "refund", gross: -(pay.amount - pay.tax), txn_delta: 0 }]);
  });

  it("C-43: Dashboard refunds after a partial one reach the payment total and the ledger, once each, whatever order they arrive in", async () => {
    const b = await makeBuyer(h, `ledger-dash-${++n}@example.com`);
    const { id } = await paidThrough(b, { country: "US", state: "ID" });
    const pi = (await orderRow(h, id)).stripe_payment_intent_id as string;
    const amount = Number((await q("select amount_minor from payments where order_id = $1 and status = 'succeeded'", [id]))[0].amount_minor);
    h.stripe.takeEvents();
    await h.stripe.createRefund({ paymentIntent: pi, amount: 500 }, `dash-a-${n}`);            // an operator refunds part in the Dashboard
    await deliverAll(h);
    expect((await orderRow(h, id)).state).toBe("partially_refunded");
    await h.stripe.createRefund({ paymentIntent: pi, amount: 300 }, `dash-b-${n}`);            // then a bit more
    const second = h.stripe.takeEvents();
    await h.stripe.createRefund({ paymentIntent: pi }, `dash-c-${n}`);                         // then the rest
    const third = h.stripe.takeEvents();
    for (const ev of [...third, ...second, ...third]) expect((await deliver(h, ev)).status).toBe(200);   // out of order, and a replay
    expect((await orderRow(h, id)).state).toBe("refunded");
    expect(Number((await q("select refunded_minor from payments where order_id = $1 and status = 'succeeded'", [id]))[0].refunded_minor)).toBe(amount);
    expect((await q("select amount_minor::int as a from refunds where order_id = $1 order by created_at, id", [id])).map((r) => r.a)).toEqual([500, amount - 500]);
    await recordSales(h.app.ctx);
    const net = (await q("select sum(gross_minor + tax_minor)::int as net, sum(txn_delta)::int as txns from sales_ledger_entries where region = 'US-ID'"))[0];
    expect(net).toEqual({ net: 0, txns: 1 });
  });

  it("C-43: an off-session charge with no Checkout address takes the buyer's last known region; with none it is entered as unknown and an operator is told", async () => {
    const b = await makeBuyer(h, `offsession-${++n}@example.com`);
    const { id } = await paidThrough(b, { country: "US", state: "NV" });
    const o = await orderRow(h, id);
    const at = h.app.clock.now();
    await q("insert into payments (order_id, user_id, stripe_payment_intent_id, amount_minor, tax_minor, currency, status, captured_at, livemode) values ($1,$2,'pi_renewal_nv',2000,0,'usd','succeeded',$3,false)", [o.id, b.userId, at]);
    const c = await makeBuyer(h, `nowhere-${++n}@example.com`);
    await q("insert into payments (order_id, user_id, stripe_payment_intent_id, amount_minor, tax_minor, currency, status, captured_at, livemode) values ($1,$2,'pi_nowhere',1500,0,'usd','succeeded',$3,false)", [o.id, c.userId, at]);
    const r = await recordSales(h.app.ctx);
    expect(r.unattributed).toBe(1);
    const reg = Object.fromEntries((await q("select p.stripe_payment_intent_id as pi, e.region from sales_ledger_entries e join payments p on p.id = e.source_id where p.stripe_payment_intent_id in ('pi_renewal_nv','pi_nowhere')")).map((x) => [x.pi, x.region]));
    expect(reg).toEqual({ pi_renewal_nv: "US-NV", pi_nowhere: "unknown" });
    expect((await q("select severity from alerts where kind = 'sales.unattributed_region'"))[0].severity).toBe("warn");
  });

  it("C-43: rolling 12 months against each state's rule: the 200-transaction prong, New York's AND rule, and one alert per level", async () => {
    const now = h.app.clock.now();
    const month = (back: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    await q("delete from sales_ledger where state in ('US-GA','US-NY','US-FL')");
    // Georgia: USD 100,000 or 200 transactions. 121 transactions this year is 60.5%.
    await q("insert into sales_ledger (state, period, gross_minor, txn_count) values ('US-GA',$1,150000,70),('US-GA',$2,150000,51),('US-GA',$3,99999999,500)", [month(0), month(5), month(12)]);
    // New York: USD 500,000 AND 100 sales. 90% of the sales prong with 10 transactions is only 10%.
    await q("insert into sales_ledger (state, period, gross_minor, txn_count) values ('US-NY',$1,45000000,10)", [month(1)]);
    // Florida: USD 100,000 only. USD 85,000 is 85%.
    await q("insert into sales_ledger (state, period, gross_minor, txn_count) values ('US-FL',$1,8500000,3)", [month(2)]);
    const r = await recordSales(h.app.ctx);
    expect(r.alerts.sort()).toEqual(["US-FL:80", "US-GA:60"]);
    const read = Object.fromEntries((await nexusReadings(h.app.ctx)).map((x) => [x.region, x.progress]));
    expect(read["US-GA"]).toBeCloseTo(0.605, 3);                              // the 13-month-old row is outside the window
    expect(read["US-NY"]).toBeCloseTo(0.1, 3);
    const st = Object.fromEntries((await q("select state, threshold_state from tax_regions where state in ('US-GA','US-NY','US-FL')")).map((x) => [x.state, x.threshold_state]));
    expect(st).toEqual({ "US-GA": "watch_60", "US-NY": "below", "US-FL": "watch_80" });
    // Closing an alert does not bring it back on the next hourly run; crossing the next level does alert.
    await q("update alerts set state = 'closed' where kind = 'tax.nexus_threshold'");
    await q("insert into sales_ledger (state, period, gross_minor, txn_count) values ('US-GA',$1,0,40) on conflict (state, period) do update set txn_count = sales_ledger.txn_count + 40", [month(0)]);
    expect((await recordSales(h.app.ctx)).alerts).toEqual(["US-GA:80"]);
    expect((await q("select severity from alerts where kind = 'tax.nexus_threshold' and subject = 'US-GA:80'"))[0].severity).toBe("warn");
  });
});
