import { afterEach, describe, expect, it } from "vitest";
import { TRANSFER_REVIEW_MS } from "@mosshatch/registrar/mock-port";
import { harnessPerTest, mailOf } from "../domains/testkit.ts";
import { orderRow } from "../orders/testkit.ts";
import { CODE, cancel, confirm, confirmCodeOf, makeOwner, pass, rescueAndPay, startRescue, transferRow, type TH } from "./testkit.ts";

/** Reproductions of the independent review's findings against the transfer-in driver. */
const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });
const HOUR = 3_600_000, DAY = 24 * HOUR;
const make = async () => per.make() as Promise<TH>;

/** The transfer is pending upstream when the card hold is lost (cancelled outside our flow); the early capture then fails. */
async function holdLostBeforeEarlyCapture(h: TH, orderId: string) {
  await pass(h, TRANSFER_REVIEW_MS);
  for (let i = 0; i < 3; i++) await pass(h, DAY);
  expect((await orderRow(h, orderId)).state).toBe("registering");
  await h.stripe.cancelPaymentIntent((await orderRow(h, orderId)).stripe_payment_intent_id, `test-cancel-${orderId}`);
  for (let i = 0; i < 12 && (await orderRow(h, orderId)).state === "registering"; i++) await pass(h, 4 * HOUR);
  expect((await orderRow(h, orderId)).state).toBe("capture_failed");
}

describe("review: transfer-in and the capture_failed ladder", () => {
  it("review: a transfer whose capture failed is still polled: a NACK ends it and the order, and the pay-link mail never claims a registration", async () => {
    const h = await make();
    const o = await makeOwner(h, "rv-cf-transfer@example.org");
    const f = "held-too-long.com";
    h.registrar.transferIn.seedForeign(f, { authCode: CODE });
    const { id, orderId } = await rescueAndPay(h, o, f);
    await holdLostBeforeEarlyCapture(h, orderId);
    await pass(h, 20 * 60_000);
    const payMail = mailOf(h, "order.pay_link");
    expect(payMail).toHaveLength(1);
    expect(payMail[0]!.text).not.toMatch(/registered/i);
    expect((await transferRow(h, id)).state).toBe("pending_registry");
    // The losing registrar refuses: the transfer ends, and so does the demand for payment.
    h.registrar.transferIn.losingNack(f, "fraud");
    await pass(h);
    await pass(h);
    expect(await transferRow(h, id)).toMatchObject({ state: "nacked", failure: "nack" });
    expect((await orderRow(h, orderId)).state).toBe("voided");
    expect(h.stripe.created.captures).toBe(0);
    expect(mailOf(h, "transfer_failed")).toHaveLength(1);
  });

  it("review: a transfer that completes while its capture has failed gets its domain row and completion mail at once", async () => {
    const h = await make();
    const o = await makeOwner(h, "rv-cf-complete@example.org");
    const f = "finishes-unpaid.com";
    h.registrar.transferIn.seedForeign(f, { authCode: CODE });
    const { id, orderId } = await rescueAndPay(h, o, f);
    await holdLostBeforeEarlyCapture(h, orderId);
    h.registrar.transferIn.losingAck(f);
    await pass(h);
    await pass(h);
    expect((await transferRow(h, id)).state).toBe("completed");
    expect((await h.app.db.owner.query("select count(*)::int n from domains where fqdn_ascii = $1 and released_at is null", [f])).rows[0].n).toBe(1);
    expect(mailOf(h, "transfer_completed")).toHaveLength(1);
    expect((await orderRow(h, orderId)).state).toBe("capture_failed");             // still unpaid: the pay link stands
  });
});

describe("review: transfer cancel during checkout", () => {
  it("review: cancelling right after paying on Checkout, before the payment is recorded, releases that card hold", async () => {
    const h = await make();
    const o = await makeOwner(h, "rv-cancel-paid@example.org");
    const f = "paid-then-cancel.com";
    h.registrar.transferIn.seedForeign(f, { authCode: CODE });
    const s = await startRescue(h, o, f);
    expect(s.status, s.text).toBe(201);
    const id = s.json.transfer_id as string, orderId = s.json.order_id as string;
    expect((await confirm(h, o, id, confirmCodeOf(h, f))).status).toBe(200);
    const row = await orderRow(h, orderId);
    h.stripe.takeEvents();
    h.stripe.payCheckout(row.stripe_checkout_session_id);                          // authorized on Stripe; no webhook or reconcile has run
    const piId = h.stripe.sessions.get(row.stripe_checkout_session_id)!.payment_intent!;
    expect(h.stripe.paymentIntents.get(piId)!.status).toBe("requires_capture");
    const c = await cancel(h, o, id);
    expect(c.status, c.text).toBe(200);
    expect((await orderRow(h, orderId)).state).toBe("voided");
    expect(h.stripe.paymentIntents.get(piId)!.status).toBe("canceled");
    expect(h.stripe.created.captures).toBe(0);
  });
});
