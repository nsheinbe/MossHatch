import { afterEach, describe, expect, it } from "vitest";
import { deliver, deliverAll } from "../orders/testkit.ts";
import { recordSales } from "../orders/sales-ledger.ts";
import { alertRows, buyDomain, harnessPerTest, makeOwner, termRow } from "./testkit.ts";

/**
 * C-43 review: a refund made in the Stripe Dashboard of a renewal that already completed (`renewed`) is mirrored like one of a
 * `captured` order: the payment's refunded total, a `refunds` row and so the sales ledger. The domain was renewed at the registry and
 * stays renewed, so neither the order nor the renewal term changes state; an operator is told, because the money left outside our flow.
 */

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });

describe("C-43 review: a Dashboard refund of a renewed order", () => {
  it("C-43: mirrors the money into the payment, the refunds and the sales ledger, leaves the order and the term renewed, and raises one ops alert", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "dash-renewed@example.com");
    const d = await buyDomain(h, o, "free-dashrenew.dev");
    const click = await h.app.call("POST", `/api/v1/domains/${d.id}/renew`, { cookie: o.cookie, body: {} });
    expect(click.status, JSON.stringify(click.json)).toBe(200);
    const orderId = click.json.order_id as string;
    const order = async () => (await h.app.db.owner.query("select state from orders where id = $1", [orderId])).rows[0].state as string;
    expect(await order()).toBe("renewed");
    const termBefore = await termRow(h, d.id);
    expect(termBefore.state).toBe("renewed");
    const pay = (await h.app.db.owner.query("select id, stripe_payment_intent_id as pi, amount_minor::int as amount from payments where order_id = $1 and status = 'succeeded'", [orderId])).rows[0];
    expect(pay).toBeTruthy();
    await recordSales(h.app.ctx);                                               // the renewal charge is in the ledger

    // An operator refunds part of the renewal in the Dashboard.
    h.stripe.takeEvents();
    await h.stripe.createRefund({ paymentIntent: pay.pi, amount: 400 }, "dash-renewed-a");
    await deliverAll(h);
    const paid = async () => Number((await h.app.db.owner.query("select refunded_minor from payments where id = $1", [pay.id])).rows[0].refunded_minor);
    const refunds = async () => (await h.app.db.owner.query("select amount_minor::int as a, reason from refunds where payment_id = $1 order by created_at, id", [pay.id])).rows;
    expect(await paid()).toBe(400);
    expect(await refunds()).toEqual([{ a: 400, reason: "dashboard" }]);
    expect(await order()).toBe("renewed");
    expect((await termRow(h, d.id)).state).toBe("renewed");
    const alerts = await alertRows(h, "order.refund_outside_flow");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "warn", subject: orderId });

    // Then the rest, delivered twice: counted once, cumulative, and the order still does not move.
    await h.stripe.createRefund({ paymentIntent: pay.pi }, "dash-renewed-b");
    const rest = h.stripe.takeEvents();
    for (const ev of [...rest, ...rest]) expect((await deliver(h, ev)).status).toBe(200);
    expect(await paid()).toBe(pay.amount);
    expect((await refunds()).map((r) => r.a)).toEqual([400, pay.amount - 400]);
    expect(await order()).toBe("renewed");
    expect((await termRow(h, d.id)).state).toBe("renewed");
    expect(await alertRows(h, "order.refund_outside_flow")).toHaveLength(1);

    // The sales ledger nets the renewal charge out.
    await recordSales(h.app.ctx);
    const net = (await h.app.db.owner.query(
      `select coalesce(sum(e.gross_minor + e.tax_minor), 0)::int as net, count(*) filter (where e.source_kind = 'refund')::int as refunds from sales_ledger_entries e
        where (e.source_kind = 'payment' and e.source_id = $1) or (e.source_kind = 'refund' and e.source_id in (select id from refunds where payment_id = $1))`, [pay.id])).rows[0];
    expect(net).toEqual({ net: 0, refunds: 2 });
  });
});
