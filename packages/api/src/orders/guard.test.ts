import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { advance, machine } from "./machine.ts";
import { alerts, buyAndPay, makeBuyer, makeHarness, orderRow, states, type Buyer, type OrdersHarness } from "./testkit.ts";

let h: OrdersHarness; let ada: Buyer;
beforeAll(async () => { h = await makeHarness(); ada = await makeBuyer(h, "ada@example.com"); }, 90_000);
afterAll(async () => { await h?.app.drop(); });
beforeEach(async () => { await h.app.db.owner.query("delete from rate_counters"); });

const work = (id: string, maxSteps?: number) => advance(machine(h.app.ctx), id, { maxSteps });
let n = 0;
const fq = () => `free-guard${++n}.com`;

describe("ST-100: the authorized-amount guard", () => {
  it("accepts exactly the subtotal and exactly the subtotal plus the tax ceiling (the control)", async () => {
    const sub = Number(h.subtotal("com"));
    const ceiling = Math.ceil((sub * 1000) / 10000);
    for (const amount of [sub, sub + ceiling]) {
      const { id } = await buyAndPay(h, ada, fq(), { key: `ok-${amount}`, pay: { amountCapturable: amount } });
      await work(id);
      const o = await orderRow(h, id);
      expect(o.state).toBe("captured");
      expect(Number((await h.app.db.owner.query("select amount_minor from payments where order_id = $1", [id])).rows[0].amount_minor)).toBe(amount);
    }
  });

  const cases: [string, () => Parameters<typeof buyAndPay>[3], string][] = [
    ["low: one cent under the subtotal", () => ({ pay: { amountCapturable: Number(h.subtotal("com")) - 1 } }), "guard_low"],
    ["high: one cent over the subtotal plus the tax ceiling", () => ({ pay: { amountCapturable: Number(h.subtotal("com")) + Math.ceil(Number(h.subtotal("com")) / 10) + 1 } }), "guard_high"],
    ["wrong currency", () => ({ pay: { currency: "eur" } }), "guard_currency"],
    ["wrong order in the PaymentIntent metadata", () => ({ pay: { metadataOrderId: "01a0effc-72f0-7797-a58e-41958d9f59ae" } }), "guard_wrong_order"],
    ["an open Radar review", () => ({ pay: { reviewOpen: true } }), "guard_open_review"],
  ];
  for (const [name, mk, reason] of cases) {
    it(`${name}: the PaymentIntent is cancelled, the order is voided, an alert pages, and nothing is registered`, async () => {
      const registers = h.registrar.calls.register;
      const { id } = await buyAndPay(h, ada, fq(), { key: `bad-${reason}`, ...mk() });
      await work(id);
      const o = await orderRow(h, id);
      expect([o.state, o.void_reason]).toEqual(["voided", reason]);
      const pis = [...h.stripe.paymentIntents.values()].filter((p) => p.metadata.order_id === id || (reason === "guard_wrong_order" && p.customer && p.amount > 0));
      const pi = [...h.stripe.paymentIntents.values()].at(-1)!;
      expect(pi.status).toBe("canceled");
      expect(pis.length).toBeGreaterThan(0);
      expect(h.registrar.calls.register).toBe(registers);
      const a = (await alerts(h, "authorized_amount_guard")).find((x) => x.subject === id);
      expect([a?.severity, a?.detail.reason]).toEqual(["page", reason]);
      // Nothing was ever charged and the domain was not created.
      expect((await h.app.db.owner.query("select count(*)::int as n from domains where fqdn_ascii = $1", [o.fqdn_ascii])).rows[0].n).toBe(0);
      expect(await states(h, id)).toEqual(["->checkout_open", "checkout_open>canceling", "canceling>voided"]);
      expect(h.app.email.sent.some((m) => m.kind === "order.voided" && m.text.includes(o.fqdn_ascii) && m.text.includes("Nothing was charged"))).toBe(true);
      // The order keeps no link to a PaymentIntent it did not accept.
      expect(o.stripe_payment_intent_id).toBeNull();
    });
  }

  it("a PaymentIntent that Stripe already captured with the wrong amount is refunded, not cancelled", async () => {
    const { id } = await buyAndPay(h, ada, fq(), { key: "bad-captured", pay: { autoCapture: true, amountCapturable: 5 } });
    await work(id);
    const o = await orderRow(h, id);
    expect(o.state).toBe("refunded");
    expect([...h.stripe.refunds.values()].at(-1)).toMatchObject({ amount: 5, status: "succeeded" });
    expect((await alerts(h, "authorized_amount_guard")).some((x) => x.subject === id)).toBe(true);
  });

  it("livemode of the PaymentIntent must match the order", async () => {
    const { id } = await buyAndPay(h, ada, fq(), { key: "bad-mode" });
    const pi = [...h.stripe.paymentIntents.values()].at(-1)!;
    pi.livemode = true;
    await work(id);
    expect((await orderRow(h, id)).void_reason).toBe("guard_livemode");
  });
});
