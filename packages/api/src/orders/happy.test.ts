import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advance, machine } from "./machine.ts";
import { alerts, buyAndPay, deliverAll, drain, getOrder, makeBuyer, makeHarness, orderRow, postOrder, states, work, type Buyer, type OrdersHarness } from "./testkit.ts";

let h: OrdersHarness; let ada: Buyer;
beforeAll(async () => { h = await makeHarness(); ada = await makeBuyer(h, "ada@example.com"); }, 90_000);
afterAll(async () => { await h?.app.drop(); });

describe("happy path and amount charged equals amount shown", () => {
  it("order -> authorize webhook -> register -> capture -> domain row and receipt", async () => {
    const res = await postOrder(h, ada, { fqdn: "free-happy.com", years: 1 }, "happy-1");
    expect(res.status, res.text).toBe(201);
    expect(res.json.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const id = res.json.order_id as string;
    expect((await orderRow(h, id)).state).toBe("checkout_open");

    // The customer pays on Stripe: the card is authorized, tax is added at Checkout.
    h.stripe.takeEvents();
    h.stripe.payCheckout((await orderRow(h, id)).stripe_checkout_session_id);
    const replies = await deliverAll(h);
    expect(replies.every((r) => r.status === 200)).toBe(true);
    // Verified events only enqueue work; the order does not move until the job runs.
    expect((await orderRow(h, id)).state).toBe("checkout_open");
    await drain(h);

    const o = await orderRow(h, id);
    const sub = h.subtotal("com"), tax = (sub * 800n) / 10000n;
    expect(o.state).toBe("captured");
    const pay = (await h.app.db.owner.query("select * from payments where order_id = $1", [id])).rows[0];
    // Shown: subtotal 19.25 (wholesale 15.25 + fee 4.00). Charged: subtotal plus the tax Checkout added, never more than the ceiling.
    expect(BigInt(o.subtotal_minor)).toBe(sub);
    expect(BigInt(pay.amount_minor)).toBe(sub + tax);
    expect(BigInt(pay.tax_minor)).toBe(tax);
    expect(BigInt(pay.amount_minor)).toBeLessThanOrEqual(BigInt(o.total_minor));
    expect(pay.status).toBe("succeeded");
    expect(h.stripe.created.captures).toBe(1);
    expect(h.registrar.calls.register).toBe(1);

    const dom = (await h.app.db.owner.query("select * from domains where fqdn_ascii = 'free-happy.com'")).rows[0];
    expect(dom.user_id).toBe(ada.userId);
    expect(dom.livemode).toBe(false);
    expect(dom.registrar_ref).toMatch(/^mock-ord-/);

    const view = await getOrder(h, ada, id);
    expect(view.status).toBe(200);
    expect(view.json.state).toBe("captured");
    expect(view.json.charged_minor).toBe((sub + tax).toString());

    const receipt = h.app.email.sent.find((m) => m.kind === "receipt");
    expect(receipt).toBeTruthy();
    expect(receipt!.text).toContain(`USD ${(Number(sub + tax) / 100).toFixed(2)}`);
    expect(receipt!.text).not.toMatch(/https?:\/\/(?!mosshatch\.test)/);
    expect(await states(h, id)).toEqual(["->checkout_open", "checkout_open>authorized", "authorized>registering", "registering>registered", "registered>capturing", "capturing>captured"]);
    expect(await alerts(h, "authorized_amount_guard")).toHaveLength(0);
  });
});
