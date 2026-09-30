import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signHeader, verifySignature } from "../stripe/signature.ts";
import type { StripeEvent } from "../stripe/port.ts";
import { advance, machine } from "./machine.ts";
import { alerts, buyAndPay, deliver, deliverAll, drain, makeBuyer, makeHarness, orderRow, postOrder, WEBHOOK_SECRET, type Buyer, type OrdersHarness } from "./testkit.ts";

let h: OrdersHarness; let ada: Buyer;
beforeAll(async () => { h = await makeHarness(); ada = await makeBuyer(h, "ada@example.com"); }, 90_000);
afterAll(async () => { await h?.app.drop(); });
beforeEach(async () => { await h.app.db.owner.query("delete from rate_counters"); h.secrets.splice(0, h.secrets.length, WEBHOOK_SECRET); });

const jobs = async (kind = "order.fulfil") => Number((await h.app.db.owner.query("select count(*)::int as n from jobs where kind = $1", [kind])).rows[0].n);
const events = async () => Number((await h.app.db.owner.query("select count(*)::int as n from webhook_events")).rows[0].n);
const t0 = () => Math.floor(h.app.clock.now().getTime() / 1000);

describe("signature scheme (t=,v1=) with a timestamp tolerance and two secrets", () => {
  const body = '{"id":"evt_1"}';
  const now = new Date("2026-11-07T12:00:00Z"); const t = Math.floor(now.getTime() / 1000);
  it("accepts a valid header and rejects missing, malformed, wrong-secret, tampered and stale ones", () => {
    expect(verifySignature(body, signHeader(body, "s1", t), ["s1"], now).ok).toBe(true);
    expect(verifySignature(body, null, ["s1"], now)).toEqual({ ok: false, reason: "missing" });
    expect(verifySignature(body, "garbage", ["s1"], now)).toEqual({ ok: false, reason: "malformed" });
    expect(verifySignature(body, "t=abc,v1=00", ["s1"], now).ok).toBe(false);
    expect(verifySignature(body, signHeader(body, "other", t), ["s1"], now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature(body + " ", signHeader(body, "s1", t), ["s1"], now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature(body, signHeader(body, "s1", t), [], now)).toEqual({ ok: false, reason: "no_secret" });
    expect(verifySignature(body, signHeader(body, "s1", t - 301), ["s1"], now)).toEqual({ ok: false, reason: "stale" });
    expect(verifySignature(body, signHeader(body, "s1", t - 300), ["s1"], now).ok).toBe(true);
    expect(verifySignature(body, signHeader(body, "s1", t + 301), ["s1"], now)).toEqual({ ok: false, reason: "future" });
    // A header that keeps the signature but changes t is a different message.
    expect(verifySignature(body, signHeader(body, "s1", t).replace(`t=${t}`, `t=${t - 5}`), ["s1"], now).ok).toBe(false);
  });
  it("accepts either secret during a roll, and both signatures on one header", () => {
    expect(verifySignature(body, signHeader(body, "old", t), ["new", "old"], now)).toMatchObject({ ok: true, secretIndex: 1 });
    expect(verifySignature(body, signHeader(body, "new", t), ["new", "old"], now)).toMatchObject({ ok: true, secretIndex: 0 });
    expect(verifySignature(body, signHeader(body, ["new", "old"], t), ["new", "old"], now).ok).toBe(true);
    expect(verifySignature(body, signHeader(body, ["new", "old"], t), ["old"], now).ok).toBe(true);   // the overlap header still verifies against one secret
    expect(verifySignature(body, signHeader(body, "old", t), ["new"], now).ok).toBe(false);          // overlap over: the old secret is dead
  });
});

describe("ST-137: the Stripe webhook endpoint", () => {
  const ev = (): StripeEvent => ({ id: "evt_unrelated_1", type: "customer.created", livemode: false, created: t0(), data: { object: { id: "cus_1" } } });

  it("rejects a missing or invalid signature, a stale timestamp, a tampered body and a wrong method", async () => {
    const before = await events();
    expect((await deliver(h, ev(), { sign: false })).status).toBe(400);
    expect((await deliver(h, ev(), { headers: { "stripe-signature": "t=1,v1=deadbeef" }, sign: false })).status).toBe(400);
    expect((await deliver(h, ev(), { secrets: "whsec_wrong" })).status).toBe(400);
    expect((await deliver(h, ev(), { t: t0() - 301 })).status).toBe(400);
    expect((await deliver(h, ev(), { t: t0() + 301 })).status).toBe(400);
    const w = h.stripe.deliver(ev(), h.secrets);
    const tampered = await h.app.call("POST", "/api/v1/webhooks/stripe", { body: { ...JSON.parse(w.body), type: "checkout.session.completed" }, headers: w.headers, browser: false });
    expect(tampered.status).toBe(400);
    expect(tampered.json.error.code).toBe("bad_signature");
    for (const method of ["GET", "PUT", "PATCH", "DELETE"] as const) {
      const r = await h.app.call(method, "/api/v1/webhooks/stripe", { headers: w.headers, browser: false });
      expect([r.status, r.headers.get("allow")]).toEqual([405, "POST"]);
    }
    expect(await events()).toBe(before);
  });

  it("stores the raw event once and answers a replay without processing it again", async () => {
    const e = ev();
    const first = await deliver(h, e);
    expect([first.status, first.json]).toEqual([200, { received: true, duplicate: false }]);
    const again = await deliver(h, e);
    expect([again.status, again.json]).toEqual([200, { received: true, duplicate: true }]);
    const rows = (await h.app.db.owner.query("select * from webhook_events where event_id = 'evt_unrelated_1'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.id).toBe("evt_unrelated_1");
    expect(rows[0].processed_at).not.toBeNull();
    expect(rows[0].livemode).toBe(false);
  });

  it("a wrong cookie session or bearer does not stand in for a signature", async () => {
    const w = h.stripe.deliver(ev(), "whsec_wrong");
    expect((await h.app.call("POST", "/api/v1/webhooks/stripe", { body: JSON.parse(w.body), cookie: ada.cookie, headers: w.headers })).status).toBe(403);   // a session is not a webhook principal
  });
});

describe("ST-98: signature, replay and out-of-order delivery; state moves only on verified events", () => {
  it("an unsigned or forged 'payment succeeded' event moves nothing and queues nothing", async () => {
    const res = await postOrder(h, ada, { fqdn: "free-forge.com", years: 1 }, "st98-forge");
    const id = res.json.order_id as string;
    const sid = (await orderRow(h, id)).stripe_checkout_session_id;
    const jobsBefore = await jobs();
    const forged: StripeEvent = { id: "evt_forged", type: "checkout.session.completed", livemode: false, created: t0(), data: { object: { id: sid, metadata: { order_id: id }, payment_intent: "pi_forged", payment_status: "paid", status: "complete" } } };
    expect((await deliver(h, forged, { sign: false })).status).toBe(400);
    expect((await deliver(h, forged, { secrets: "whsec_attacker" })).status).toBe(400);
    expect((await orderRow(h, id)).state).toBe("checkout_open");
    expect(await jobs()).toBe(jobsBefore);
    // Even a correctly signed event that lies is only a nudge: the order state comes from Stripe's own record, where the Session is still open.
    expect((await deliver(h, { ...forged, id: "evt_liar" })).status).toBe(200);
    await advance(machine(h.app.ctx), id);
    expect((await orderRow(h, id)).state).toBe("checkout_open");
    expect(h.registrar.calls.register).toBe(0);
  });

  it("out-of-order events converge: the capturable update before the completed event, then a late 'expired'", async () => {
    const { id, events: evs } = await buyAndPay(h, ada, "free-order.com", { key: "st98-ooo" });
    const [completed, updated] = evs;
    expect([completed!.type, updated!.type]).toEqual(["checkout.session.completed", "payment_intent.amount_capturable_updated"]);
    expect((await deliver(h, updated!)).status).toBe(200);
    await drain(h);
    expect((await orderRow(h, id)).state).toBe("captured");
    // The earlier events arrive now, plus an 'expired' for the same Session that Stripe emitted before payment: all harmless.
    expect((await deliver(h, completed!)).status).toBe(200);
    const sess = (await orderRow(h, id)).stripe_checkout_session_id;
    expect((await deliver(h, { id: "evt_late_expired", type: "checkout.session.expired", livemode: false, created: t0(), data: { object: { id: sess, metadata: { order_id: id } } } })).status).toBe(200);
    await drain(h);
    const o = await orderRow(h, id);
    expect(o.state).toBe("captured");
    expect(h.registrar.calls.register).toBeGreaterThan(0);
    const regs = (await h.app.db.owner.query("select count(*)::int as n from order_operations where order_id = $1 and kind = 'register'", [id])).rows[0].n;
    expect(regs).toBe(1);
    expect(h.stripe.paymentIntents.get(o.stripe_payment_intent_id)!.status).toBe("succeeded");
  });

  it("the same events delivered many times, in any order, change nothing after the first pass", async () => {
    const { id, events: evs } = await buyAndPay(h, ada, "free-replay.com", { key: "st98-replay" });
    const other = [...evs, ...evs, ...[...evs].reverse()];
    const codes = [];
    for (const e of other) codes.push((await deliver(h, e)).json.duplicate);
    expect(codes.filter((d) => d === false)).toHaveLength(2);
    expect(await (async () => Number((await h.app.db.owner.query("select count(*)::int as n from webhook_events where event_id = any($1)", [evs.map((e) => e.id)])).rows[0].n))()).toBe(2);
    await drain(h);
    await drain(h);
    expect((await orderRow(h, id)).state).toBe("captured");
    expect(h.stripe.created.captures).toBeGreaterThan(0);
    const caps = (await h.app.db.owner.query("select count(*)::int as n from order_operations where order_id = $1 and kind = 'capture'", [id])).rows[0].n;
    expect(caps).toBe(1);
  });

  it("an event for an unknown order is stored and ignored", async () => {
    const r = await deliver(h, { id: "evt_nobody", type: "payment_intent.succeeded", livemode: false, created: t0(), data: { object: { id: "pi_nobody", metadata: { order_id: "01a0effc-72f0-7797-a58e-41958d9f59ae" } } } });
    expect(r.status).toBe(200);
  });
});

describe("ST-151: a Stripe event whose livemode differs from its order is rejected and alerted", () => {
  it("a live event reaching a test-mode process is rejected with an alert, and stays rejected on retry", async () => {
    const before = (await alerts(h, "livemode_mismatch")).length;
    const e: StripeEvent = { id: "evt_live_1", type: "checkout.session.completed", livemode: true, created: t0(), data: { object: { id: "cs_live_x", metadata: {} } } };
    const r = await deliver(h, e);
    expect([r.status, r.json.error.code]).toEqual([400, "livemode_mismatch"]);
    expect((await alerts(h, "livemode_mismatch")).length).toBe(before + 1);
    expect((await alerts(h, "livemode_mismatch")).at(-1).severity).toBe("page");
    const row = (await h.app.db.owner.query("select * from webhook_events where event_id = 'evt_live_1'")).rows[0];
    expect([row.livemode, row.error]).toEqual([true, "livemode_mismatch"]);
    const retry = await deliver(h, e);
    expect([retry.status, retry.json.error.code]).toEqual([400, "livemode_mismatch"]);
    expect((await alerts(h, "livemode_mismatch")).length).toBe(before + 1);      // one open alert, not a storm
  });

  it("an event that matches the process but not the order it names is rejected too, and moves nothing", async () => {
    const { id, events: evs } = await buyAndPay(h, ada, "free-mode.com", { key: "st151-b" });
    await h.app.db.owner.query("update orders set livemode = true where id = $1", [id]);          // the order was created in live mode
    const r = await deliver(h, evs[0]!);
    expect([r.status, r.json.error.code]).toEqual([400, "livemode_mismatch"]);
    const a = (await alerts(h, "livemode_mismatch")).find((x) => x.subject === id);
    expect(a?.severity).toBe("page");
    expect((await orderRow(h, id)).state).toBe("checkout_open");
    await h.app.db.owner.query("update orders set livemode = false where id = $1", [id]);
  });

  it("a test-mode event is fine in a test-mode process (the control)", async () => {
    const { evs } = { evs: h.stripe.takeEvents() };
    void evs;
    const { id, events } = await buyAndPay(h, ada, "free-modeok.com", { key: "st151-c" });
    expect((await deliver(h, events[0]!)).status).toBe(200);
    await drain(h);
    expect((await orderRow(h, id)).state).toBe("captured");
  });
});

describe("webhook secret roll with a 24-hour overlap (the drill)", () => {
  it("accepts events signed with the old, the new or both secrets during the overlap, and only the new one after", async () => {
    const OLD = WEBHOOK_SECRET, NEW = "whsec_test_rolled_fedcba9876543210";
    const mk = (n: number): StripeEvent => ({ id: `evt_roll_${n}`, type: "customer.updated", livemode: false, created: t0(), data: { object: { id: "cus_x" } } });
    h.secrets.splice(0, 2, NEW, OLD);                                            // endpoint now accepts both
    expect((await deliver(h, mk(1), { secrets: OLD })).status).toBe(200);        // Stripe still signing with the old secret
    expect((await deliver(h, mk(2), { secrets: NEW })).status).toBe(200);
    expect((await deliver(h, mk(3), { secrets: [NEW, OLD] })).status).toBe(200); // Stripe signs with both during the overlap
    expect((await deliver(h, mk(4), { secrets: "whsec_neither" })).status).toBe(400);
    h.app.clock.advance(24 * 3600_000);                                          // overlap ends; the old secret is removed
    h.secrets.splice(0, 2, NEW);
    expect((await deliver(h, mk(5), { secrets: NEW })).status).toBe(200);
    expect((await deliver(h, mk(6), { secrets: OLD })).status).toBe(400);
    expect((await deliver(h, mk(7), { secrets: [NEW, OLD] })).status).toBe(200);
    expect((await deliver(h, mk(1), { secrets: NEW })).json.duplicate).toBe(true);
    h.app.clock.advance(-24 * 3600_000);
  });
});

void deliverAll;
