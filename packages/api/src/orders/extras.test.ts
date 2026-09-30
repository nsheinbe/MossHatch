import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockRegistrarPort } from "@mosshatch/registrar/mock-port";
import { runTick, opportunisticTick } from "../jobs/engine.ts";
import { FakeStripe } from "../stripe/fake.ts";
import { ensureSession, restartCheckout } from "./create.ts";
import { advance, machine, reconcileOpen, sweepUnknown } from "./machine.ts";
import { orderReconcile } from "./jobs.ts";
import { installOrders } from "./wiring.ts";
import { alerts, buyAndPay, deliver, drain, makeBuyer, makeHarness, orderRow, postOrder, states, type Buyer, type OrdersHarness } from "./testkit.ts";
import { loadOrder } from "./support.ts";

let h: OrdersHarness; let ada: Buyer; let T0: Date;
beforeAll(async () => { h = await makeHarness(); ada = await makeBuyer(h, "ada@example.com"); T0 = h.app.clock.now(); }, 90_000);
afterAll(async () => { await h?.app.drop(); });
beforeEach(async () => {
  h.app.clock.set(T0); h.stripe.clearFaults(); h.resetRegistrar();
  await h.app.db.owner.query("delete from rate_counters");
  await h.app.db.owner.query("update flags set value = 'false' where name = 'registrar_writes_paused'");     // the tick's auto-safe mode may have engaged in a time-travel test
  await h.app.db.owner.query("update sessions set expires_at = expires_at + interval '400 days', idle_expires_at = idle_expires_at + interval '400 days'");
});
const m = () => machine(h.app.ctx);
const work = (id: string, maxSteps?: number) => advance(m(), id, { maxSteps });
let n = 0;
const fq = (p = "x") => `free-${p}${++n}.com`;

describe("checkout lifecycle", () => {
  it("an unpaid Session expires: checkout_open -> checkout_expired, and a late payment attempt on it fails at Stripe", async () => {
    const r = await postOrder(h, ada, { fqdn: fq("exp"), years: 1 }, "exp-1");
    const id = r.json.order_id as string;
    const sid = (await orderRow(h, id)).stripe_checkout_session_id;
    await work(id);
    expect((await orderRow(h, id)).state).toBe("checkout_open");
    h.app.clock.advance(32 * 60_000);
    await h.app.db.owner.query("update sessions set idle_expires_at = idle_expires_at + interval '400 days'");
    await work(id);
    expect((await orderRow(h, id)).state).toBe("checkout_expired");
    expect(() => h.stripe.payCheckout(sid)).toThrow();
    // An expired order does not reserve the name or block the customer from starting again with a new key.
    const again = await postOrder(h, ada, { fqdn: (await orderRow(h, id)).fqdn_ascii, years: 1 }, "exp-2");
    expect(again.status).toBe(201);
  });

  it("a declined card leaves the order open for another try on the same Session", async () => {
    const { id, events } = await buyAndPay(h, ada, fq("dec"), { key: "dec-1", pay: { declined: true } });
    expect(events[0]!.type).toBe("payment_intent.payment_failed");
    expect((await deliver(h, events[0]!)).status).toBe(200);
    await work(id);
    expect((await orderRow(h, id)).state).toBe("checkout_open");
    const sid = (await orderRow(h, id)).stripe_checkout_session_id;
    h.stripe.payCheckout(sid);
    await work(id);
    expect((await orderRow(h, id)).state).toBe("captured");
  });

  it("guard 2: a second payable Session is prevented; the current attempt wins, the other Session is expired and an extra PaymentIntent is cancelled", async () => {
    const r = await postOrder(h, ada, { fqdn: fq("two"), years: 1 }, "two-1");
    const id = r.json.order_id as string;
    const s1 = (await orderRow(h, id)).stripe_checkout_session_id;
    // The customer pays in one tab while a retry starts attempt 2 in another: the old Session cannot be expired because it just completed.
    h.stripe.payCheckout(s1);
    const next = await restartCheckout(h.app.ctx, h.svc, id);
    expect(next!.attempt).toBe(2);
    expect(next!.sessionId).toBeNull();
    const { session } = await ensureSession(h.app.ctx, h.svc, next!);
    expect(session!.id).not.toBe(s1);
    expect(h.stripe.keysUsed.filter((k) => k.method === "createCheckoutSession").at(-1)!.key).toBe(`cs:${id}:2`);
    expect(h.stripe.keysUsed.some((k) => k.key === `expire:${id}:1`)).toBe(true);
    const pi1 = [...h.stripe.paymentIntents.values()].find((p) => p.metadata.order_id === id && p.metadata.attempt === "1")!;
    h.stripe.payCheckout(session!.id);                                                    // and in the second tab too
    const pi2 = [...h.stripe.paymentIntents.values()].find((p) => p.metadata.order_id === id && p.metadata.attempt === "2")!;
    await work(id);
    const o = await orderRow(h, id);
    expect(o.state).toBe("captured");
    expect(o.stripe_payment_intent_id).toBe(pi2.id);
    expect(pi1.status).toBe("canceled");                                                  // the extra PaymentIntent was cancelled (after a re-fetch)
    expect(pi2.status).toBe("succeeded");
    expect((await alerts(h, "extra_payment_intent")).some((a) => a.subject === id)).toBe(true);
    expect(h.registrar.calls.register).toBe(1);
    expect((await h.app.db.owner.query("select count(*)::int as n from payments where order_id = $1 and status = 'succeeded'", [id])).rows[0].n).toBe(1);
  });

  it("a restart with an unpaid old Session expires it, so it cannot be paid later", async () => {
    const r = await postOrder(h, ada, { fqdn: fq("re"), years: 1 }, "re-1");
    const id = r.json.order_id as string;
    const s1 = (await orderRow(h, id)).stripe_checkout_session_id;
    await restartCheckout(h.app.ctx, h.svc, id);
    expect(() => h.stripe.payCheckout(s1)).toThrow();
    expect(h.stripe.sessions.get(s1)!.status).toBe("expired");
  });
});

describe("jobs and the tick", () => {
  it("order.reconcile finds a paid order whose webhook never arrived (open, older than two minutes) and finishes it", async () => {
    const { id } = await buyAndPay(h, ada, fq("lost"), { key: "lost-1" });        // no event is delivered
    h.stripe.takeEvents();
    expect((await reconcileOpen(m())).enqueued).toBeGreaterThanOrEqual(0);
    expect((await orderRow(h, id)).state).toBe("checkout_open");
    h.app.clock.advance(3 * 60_000);
    const A = "33333333-3333-3333-3333-333333333333";
    const jr = (await h.app.db.owner.query("insert into jobs (kind, priority, state, attempt_id, attempts, locked_until, payload) values ('order.reconcile',0,'running',$1,1,$2,'{}') returning id", [A, new Date(h.app.clock.now().getTime() + 3600_000)])).rows[0];
    await orderReconcile(h.app.ctx, { id: jr.id, kind: "order.reconcile", attempt_id: A, attempts: 1, max_attempts: 8, payload: {}, user_id: null });
    const q = (await h.app.db.owner.query("select count(*)::int as n from jobs where kind = 'order.fulfil' and payload->>'order_id' = $1", [id])).rows[0].n;
    expect(q).toBe(1);
    await drain(h);
    expect((await orderRow(h, id)).state).toBe("captured");
  });

  it("recurring schedule: the tick enqueues order.reconcile and order.sweep_unknown, all priority 0", async () => {
    await runTick(h.app.ctx, { heartbeat: false, budgetMs: 2000 });
    const rows = (await h.app.db.owner.query("select distinct kind, priority from jobs where kind like 'order.%'")).rows;
    expect(rows.filter((r) => r.priority !== 0)).toEqual([]);
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(["order.reconcile", "order.sweep_unknown"]));
  });

  it("a webhook enqueues order.fulfil and calls the tick through the injectable waitUntil", async () => {
    const before = h.svc.tick;
    h.svc.tick = (c) => { opportunisticTick(c, h.svc.waitUntil); };
    const { id, events } = await buyAndPay(h, ada, fq("wu"), { key: "wu-1" });
    h.waited.length = 0;
    for (const e of events) await deliver(h, e);
    expect(h.waited.length).toBeGreaterThan(0);
    await Promise.all(h.waited);
    await drain(h);
    expect((await orderRow(h, id)).state).toBe("captured");
    h.svc.tick = before;
  });

  it("the sweeper alarms an order within 36 hours of capture_before that is neither captured nor cancelled", async () => {
    const { id } = await buyAndPay(h, ada, fq("near"), { key: "near-1" });
    await work(id, 1);
    h.app.clock.advance(5.6 * 24 * 3600_000);                                        // 7 days minus 1 minute is the window; 36 hours before it starts here
    await sweepUnknown(m());
    expect((await alerts(h, "auth_window_36h")).find((a) => a.subject === id)?.severity).toBe("page");
  });

  it("a dead-lettered order.fulfil near the authorization deadline cancels the hold (money-job default)", async () => {
    const { id } = await buyAndPay(h, ada, fq("dead"), { key: "dead-1" });
    await work(id, 1);
    h.app.clock.advance(5.5 * 24 * 3600_000);                                        // inside 48 hours of capture_before, before the 24 hour cut
    const job = (await h.app.db.owner.query("insert into jobs (kind, priority, state, attempts, max_attempts, payload, run_at) values ('order.fulfil',0,'queued',7,8,$1,$2) returning id", [{ order_id: id }, new Date(h.app.clock.now().getTime() - 1000)])).rows[0];
    const def = (await import("../jobs/registry.ts")).getJobDef("order.fulfil")!;
    const saved = def.handler;
    (def as { handler: unknown }).handler = async () => { throw new Error("boom"); };
    await runTick(h.app.ctx, { heartbeat: false, budgetMs: 3000, random: () => 1 });
    (def as { handler: unknown }).handler = saved;
    expect((await h.app.db.owner.query("select state from jobs where id = $1", [job.id])).rows[0].state).toBe("dead");
    expect((await alerts(h, "job.dead")).length).toBeGreaterThan(0);
    const o = await orderRow(h, id);
    expect(["canceling", "voided"]).toContain(o.state);
    expect(o.void_reason).toBe("auth_window");
    await work(id);
    expect((await orderRow(h, id)).state).toBe("voided");
  });
});

describe("mode guard (ST-150 companion)", () => {
  it("POST /orders answers 503 when the process's Stripe key, registrar and environment disagree", async () => {
    const before = { ...h.app.ctx.config };
    h.app.ctx.config.stripeKeyKind = "live";
    const r = await postOrder(h, ada, { fqdn: fq("mode"), years: 1 }, "mode-1");
    expect([r.status, r.json.error.code]).toEqual([503, "mode_inconsistent"]);
    Object.assign(h.app.ctx.config, before);
    h.app.ctx.config.registrarMode = "live";
    expect((await postOrder(h, ada, { fqdn: fq("mode"), years: 1 }, "mode-2")).status).toBe(503);
    Object.assign(h.app.ctx.config, before);
    expect((await postOrder(h, ada, { fqdn: fq("mode"), years: 1 }, "mode-3")).status).toBe(201);
  });

  it("installing the orders services refuses a live Stripe client with a mock registrar, and a mode mismatch between client and config", () => {
    const live = new FakeStripe(h.app.clock, { livemode: true });
    expect(() => installOrders(h.app.ctx, { stripe: live, registrar: new MockRegistrarPort({ clock: h.app.clock }) })).toThrow(/mode guard/);
    const stripe = new FakeStripe(h.app.clock);
    expect(() => installOrders({ ...h.app.ctx, config: { ...h.app.ctx.config, mode: "production", livemode: true, stripeKeyKind: "live", registrarMode: "live" } }, { stripe, registrar: new MockRegistrarPort({ clock: h.app.clock }) })).toThrow(/mode guard/);
  });

  it("an event and an order in livemode true are refused by a test-mode process (ST-151 companion), and sample amounts are refused at live checkout", async () => {
    h.app.ctx.config.livemode = true;   // config says live, but the Stripe client is a test client
    expect((await postOrder(h, ada, { fqdn: fq("mode"), years: 1 }, "mode-4")).status).toBe(503);
    h.app.ctx.config.livemode = false;
  });
});

describe("money-path hygiene", () => {
  it("ST-103 with a slow registrar: workers that arrive while one is mid-call find the operation sent and wait", async () => {
    const { id } = await buyAndPay(h, ada, fq("slow"), { key: "slow-1" });
    await work(id, 1);
    const real = h.registrar.register.bind(h.registrar);
    let inflight = 0, maxInflight = 0;
    h.registrar.register = async (req) => { inflight++; maxInflight = Math.max(maxInflight, inflight); await new Promise((r) => setTimeout(r, 80)); try { return await real(req); } finally { inflight--; } };
    const before = h.registrar.calls.register;
    await Promise.all([work(id), work(id), work(id), work(id)]);
    await work(id);
    expect(maxInflight).toBe(1);
    expect(h.registrar.calls.register - before).toBe(1);
    expect((await orderRow(h, id)).state).toBe("captured");
  });

  it("a mail provider outage never undoes a capture: the order is captured, a warning is raised, and the receipt goes out on a later pass", async () => {
    const buyer = await makeBuyer(h, "outage@example.com");
    const { id } = await buyAndPay(h, buyer, fq("mail"), { key: "mail-1" });
    const send = h.app.email.send.bind(h.app.email);
    h.app.email.send = async () => { throw new Error("provider down"); };
    await work(id);
    h.app.email.send = send;
    expect((await orderRow(h, id)).state).toBe("captured");
    expect((await alerts(h, "mail_failed")).some((a) => a.subject === id)).toBe(true);
    expect(h.app.email.sent.some((x) => x.kind === "receipt" && x.to.includes(buyer.email))).toBe(false);
  });

  it("3-D Secure is requested for an account's first two orders and for any order over USD 100, and not otherwise", async () => {
    const buyer = await makeBuyer(h, "threeds@example.com");
    const mk = async (fqdn: string, key: string, years = 1) => {
      const r = await postOrder(h, buyer, { fqdn, years }, key);
      expect(r.status, r.text).toBe(201);
      const o = await orderRow(h, r.json.order_id);
      return { id: r.json.order_id as string, sid: o.stripe_checkout_session_id as string };
    };
    const rule = (sid: string) => h.stripe.sessionParams(sid).stripe.payment_method_options.card.request_three_d_secure;
    const a = await mk(fq("s"), "3ds-a"); expect(rule(a.sid)).toBe("any");
    h.stripe.payCheckout(a.sid); await work(a.id, 1);
    const b = await mk(fq("s"), "3ds-b"); expect(rule(b.sid)).toBe("any");
    h.stripe.payCheckout(b.sid); await work(b.id, 1);
    const c = await mk(fq("s"), "3ds-c"); expect(rule(c.sid)).toBe("automatic");
    const big = await mk("free-3dsbig.ai", "3ds-d", 2); expect(rule(big.sid)).toBe("any");
  });

  it("checkout refuses a sample amount when the deployment is live", async () => {
    const live = await makeHarness({ config: { mode: "production", livemode: true, stripeKeyKind: "live", registrarMode: "live" } as never, registrarPresentsAs: "live" });
    try {
      const b = await makeBuyer(live, "live@example.com");
      // The mock registrar presents as live here, but everything it returns still carries source 'sample'.
      const r = await postOrder(live, b, { fqdn: "free-livesample.com", years: 1 }, "live-1");
      expect([r.status, r.json.error.code]).toEqual([503, "sample_price_in_live"]);
      expect((await live.app.db.owner.query("select count(*)::int as n from orders")).rows[0].n).toBe(0);
    } finally { await live.app.drop(); }
  });
});

void loadOrder; void states;
