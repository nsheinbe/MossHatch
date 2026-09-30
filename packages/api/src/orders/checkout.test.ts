import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mintToken } from "../util/token.ts";
import { buyAndPay, deliverAll, drain, getOrder, makeBuyer, makeHarness, orderRow, postOrder, REGISTRANT, type Buyer, type OrdersHarness } from "./testkit.ts";
import { storeRegistrant } from "./registrant.ts";
import { withUser } from "@mosshatch/db";

let h: OrdersHarness; let W = 0n; let ada: Buyer; let bo: Buyer;
beforeAll(async () => {
  h = await makeHarness();
  W = h.subtotal("com") - 400n;             // wholesale of a .com year
  ada = await makeBuyer(h, "ada@example.com");
  bo = await makeBuyer(h, "bo@example.com");
}, 90_000);
afterAll(async () => { await h?.app.drop(); });
beforeEach(async () => { await h.app.db.owner.query("delete from rate_counters"); });

const count = async (where = "true", args: unknown[] = []) => Number((await h.app.db.owner.query(`select count(*)::int as n from orders where ${where}`, args)).rows[0].n);

describe("ST-97: a client-supplied price is ignored, and the amount charged equals the amount shown", () => {
  it("prices from the frozen server quote whatever the body says, and pins the Checkout parameters", async () => {
    const res = await postOrder(h, ada, { fqdn: "free-price.com", years: 1, price: 1, price_minor: 1, total_minor: 1, amount: 1, unit_amount: 1, currency: "eur", subtotal_minor: 1, price_id: "price_free" }, "st97-a");
    expect(res.status, res.text).toBe(201);
    const o = await orderRow(h, res.json.order_id);
    expect(BigInt(o.subtotal_minor)).toBe(h.subtotal("com"));
    expect(BigInt(o.tax_ceiling_minor)).toBe((h.subtotal("com") * 1000n + 9999n) / 10000n);
    expect(BigInt(o.total_minor)).toBe(h.subtotal("com") + BigInt(o.tax_ceiling_minor));
    expect(o.quote.subtotal_minor).toBe(h.subtotal("com").toString());
    expect(o.currency).toBe("usd");

    const p = h.stripe.sessionParams(o.stripe_checkout_session_id);
    expect(p.stripe.line_items).toHaveLength(1);
    expect(p.stripe.line_items[0]!.price_data.unit_amount).toBe(Number(h.subtotal("com")));
    expect(p.stripe.line_items[0]!.price_data.currency).toBe("usd");
    expect(JSON.stringify(p.stripe)).not.toContain("price_free");
    // D-002 and plan guards 6 and 7: manual capture, card only, 3-D Secure for a first order, tax added at Checkout.
    expect(p.stripe.payment_intent_data.capture_method).toBe("manual");
    expect(p.stripe.payment_method_types).toEqual(["card"]);
    expect(p.stripe.payment_method_options.card.request_three_d_secure).toBe("any");
    expect(p.stripe.automatic_tax.enabled).toBe(true);
    expect(p.stripe.metadata.order_id).toBe(o.id);
    expect(p.stripe.expires_at - Math.floor(h.app.clock.now().getTime() / 1000)).toBeGreaterThanOrEqual(30 * 60);
  });

  it("charges exactly what was shown: subtotal plus the tax Checkout added, never above the ceiling", async () => {
    const { id } = await buyAndPay(h, ada, "free-charged.com", { key: "st97-b" });
    await deliverAll(h); await drain(h);
    const o = await orderRow(h, id);
    const pay = (await h.app.db.owner.query("select * from payments where order_id = $1", [id])).rows[0];
    expect(o.state).toBe("captured");
    expect(BigInt(pay.amount_minor)).toBe(BigInt(o.subtotal_minor) + BigInt(pay.tax_minor));
    expect(BigInt(pay.amount_minor)).toBeLessThanOrEqual(BigInt(o.total_minor));
    expect([...h.stripe.paymentIntents.values()].find((p) => p.metadata.order_id === id)!.amount_received).toBe(Number(pay.amount_minor));
    const view = await getOrder(h, ada, id);
    expect(view.json.subtotal_minor).toBe(h.subtotal("com").toString());
    expect(view.json.charged_minor).toBe(pay.amount_minor);
  });

  it("refuses non-standard input plainly and creates nothing", async () => {
    const before = await count();
    expect((await postOrder(h, ada, { fqdn: "no spaces.com", years: 1 }, "bad-1")).status).toBe(422);
    expect((await postOrder(h, ada, { fqdn: "free-x.com", years: 0 }, "bad-2")).status).toBe(422);
    expect((await postOrder(h, ada, { fqdn: "free-x.com", years: 1.5 }, "bad-3")).status).toBe(422);
    expect((await postOrder(h, ada, { fqdn: "free-x.com", years: "1" }, "bad-4")).status).toBe(422);
    expect((await postOrder(h, ada, { fqdn: "free-x.zzz", years: 1 }, "bad-5")).json.error.code).toBe("unsupported_tld");
    h.registrar.setKind("premium-gem.com", "premium");
    const prem = await postOrder(h, ada, { fqdn: "premium-gem.com", years: 1 }, "bad-6");
    expect([prem.status, prem.json.error.code]).toEqual([422, "price_not_standard"]);
    expect((await postOrder(h, ada, { fqdn: "taken-name.com", years: 1 }, "bad-7")).json.error.code).toBe("name_unavailable");
    expect(await count()).toBe(before);
  });
});

describe("ST-99: a double submit creates one order, and the same key with different parameters returns 409", () => {
  it("the same key and parameters replay one order and one Checkout Session", async () => {
    const sessions = h.stripe.created.sessions, orders = await count();
    const a = await postOrder(h, ada, { fqdn: "free-dbl.com", years: 1 }, "st99-a");
    const b = await postOrder(h, ada, { fqdn: "free-dbl.com", years: 1 }, "st99-a");
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.json.order_id).toBe(a.json.order_id);
    expect(b.json.checkout_url).toBe(a.json.checkout_url);
    expect(await count()).toBe(orders + 1);
    expect(h.stripe.created.sessions).toBe(sessions + 1);
    // Key spelling in the body does not matter: only fqdn and years are parameters.
    const c = await postOrder(h, ada, { fqdn: "FREE-DBL.com", years: 1, price: 5 }, "st99-a");
    expect(c.json.order_id).toBe(a.json.order_id);
  });

  it("concurrent submits with one key still create exactly one order and one Session", async () => {
    for (let round = 0; round < 4; round++) {
      const sessions = h.stripe.created.sessions, orders = await count();
      await h.app.db.owner.query("delete from rate_counters");
      const key = `st99-race-${round}`;
      const rs = await Promise.all(Array.from({ length: 6 }, () => postOrder(h, ada, { fqdn: `free-race${round}.com`, years: 1 }, key)));
      const ok = rs.filter((r) => r.status === 200 || r.status === 201);
      expect(ok.length, JSON.stringify(rs.map((r) => r.status))).toBeGreaterThanOrEqual(1);
      expect(new Set(ok.map((r) => r.json.order_id)).size).toBe(1);
      expect(rs.every((r) => [200, 201, 409].includes(r.status)), JSON.stringify(rs.map((r) => [r.status, r.text]))).toBe(true);
      expect(await count()).toBe(orders + 1);
      expect(h.stripe.created.sessions).toBe(sessions + 1);
    }
  });

  it("the same key with different parameters is 409 and creates nothing", async () => {
    const first = await postOrder(h, ada, { fqdn: "free-conf.com", years: 1 }, "st99-c");
    expect(first.status).toBe(201);
    const orders = await count(), sessions = h.stripe.created.sessions;
    for (const body of [{ fqdn: "free-conf.com", years: 2 }, { fqdn: "free-other.com", years: 1 }, { fqdn: "free-conf.dev", years: 1 }]) {
      const r = await postOrder(h, ada, body, "st99-c");
      expect([r.status, r.json.error.code]).toEqual([409, "idempotency_key_reuse"]);
    }
    expect(await count()).toBe(orders);
    expect(h.stripe.created.sessions).toBe(sessions);
  });

  it("the key is required, and one user's key does not collide with another's", async () => {
    expect((await postOrder(h, ada, { fqdn: "free-k.com", years: 1 }, null)).json.error.code).toBe("idempotency_key_required");
    const x = await postOrder(h, ada, { fqdn: "free-shared.com", years: 1 }, "same-key");
    const y = await postOrder(h, bo, { fqdn: "free-shared.dev", years: 1 }, "same-key");
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(y.json.order_id).not.toBe(x.json.order_id);
  });
});

describe("order creation gates and tenancy", () => {
  it("writes the acceptance rows, the frozen quote and the upstream profile username before any registrar call", async () => {
    const registers = h.registrar.calls.register;
    const r = await postOrder(h, ada, { fqdn: "free-consent.com", years: 1 }, "gate-1");
    const o = await orderRow(h, r.json.order_id);
    expect(o.reg_username).toMatch(/^mh[a-z2-7]{14}$/);
    expect(h.registrar.calls.register).toBe(registers);
    const prof = (await h.app.db.owner.query("select * from registrar_profiles where order_id = $1", [o.id])).rows[0];
    expect(prof.username).toBe(o.reg_username);
    expect(JSON.stringify(prof.password_enc)).not.toMatch(/[A-Za-z0-9]{18}[^=]*"pw"/);
    const consents = (await h.app.db.owner.query("select kind, document_hash, actor_kind from consents where order_id = $1 order by kind", [o.id])).rows;
    expect(consents.map((c) => c.kind)).toEqual(["registration_agreement", "terms"]);
    expect(consents.map((c) => c.document_hash).sort()).toEqual(["agreementhash0123456789", "termshash0123456789abcdef"]);
    expect(consents.every((c) => c.actor_kind === "user")).toBe(true);
    expect(o.checkout_ip_enc.alg).toBe("A256GCM");
  });

  it("an agent token can never place an order", async () => {
    const m = mintToken("live");
    await h.app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, expires_at) values ($1,'agent','t',$2,$3,$4)", [ada.userId, m.prefix, m.hash, new Date(h.app.clock.now().getTime() + 86400_000)]);
    const before = await count();
    const r = await h.app.call("POST", "/api/v1/orders", { authorization: `Bearer ${m.token}`, body: { fqdn: "free-agent.com", years: 1 }, headers: { "idempotency-key": "agent-1" } });
    expect(r.status).toBe(403);
    expect((await h.app.call("POST", "/api/v1/orders", { body: { fqdn: "free-agent.com", years: 1 }, headers: { "idempotency-key": "agent-2" } })).status).toBe(401);
    expect(await count()).toBe(before);
  });

  it("orders_paused, the sell gate, a missing contact and an unverified account each refuse without creating an order", async () => {
    const before = await count();
    await h.app.db.owner.query("update flags set value = 'true' where name = 'orders_paused'");
    const p = await postOrder(h, ada, { fqdn: "free-paused.com", years: 1 }, "gate-p");
    expect([p.status, p.json.error.code, p.json.error.message]).toEqual([503, "orders_paused", "Registration is paused for a short while. Nothing was charged."]);
    await h.app.db.owner.query("update flags set value = 'false' where name = 'orders_paused'");

    // Funds minus reserved wholesale must stay above USD 250.
    h.registrar.setBalance(25_000n + W - 1n);
    const low = await postOrder(h, ada, { fqdn: "free-low.com", years: 1 }, "gate-f");
    expect([low.status, low.json.error.code]).toEqual([503, "sell_gate"]);
    h.registrar.setBalance(25_000n + W);
    expect((await postOrder(h, ada, { fqdn: "free-low.com", years: 1 }, "gate-f2")).status).toBe(201);
    // The order just placed does not reserve until it is authorized; an authorized one does.
    h.registrar.setBalance(1_000_000n);

    const nc = await makeBuyer(h, "nocontact@example.com", { contact: false });
    expect((await postOrder(h, nc, { fqdn: "free-nc.com", years: 1 }, "gate-c")).json.error.code).toBe("contact_required");
    const un = await makeBuyer(h, "unv@example.com");
    await h.app.db.owner.query("update users set email_verified_at = null where id = $1", [un.userId]);
    expect((await postOrder(h, un, { fqdn: "free-unv.com", years: 1 }, "gate-u")).json.error.code).toBe("email_unverified");
    await h.app.db.owner.query("update users set frozen_at = now() where id = $1", [bo.userId]);
    expect((await postOrder(h, bo, { fqdn: "free-fz.com", years: 1 }, "gate-z")).json.error.code).toBe("account_frozen");
    await h.app.db.owner.query("update users set frozen_at = null where id = $1", [bo.userId]);
    expect(await count("fqdn_ascii in ('free-paused.com','free-nc.com','free-unv.com','free-fz.com')")).toBe(0);
    void before;
  });

  it("reserved wholesale counts against the sell gate", async () => {
    const buyer = await makeBuyer(h, "reserve@example.com");
    const { id } = await buyAndPay(h, buyer, "free-reserve1.com", { key: "res-1" });
    await deliverAll(h);
    const { advance, machine } = await import("./machine.ts");
    await advance(machine(h.app.ctx), id, { maxSteps: 1 });           // authorized, holding 15.25 of wholesale
    expect((await orderRow(h, id)).state).toBe("authorized");
    h.registrar.setBalance(25_000n + W + W - 1n);
    expect((await postOrder(h, buyer, { fqdn: "free-reserve2.com", years: 1 }, "res-2")).json.error.code).toBe("sell_gate");
    h.registrar.setBalance(25_000n + W + W);
    expect((await postOrder(h, buyer, { fqdn: "free-reserve2.com", years: 1 }, "res-3")).status).toBe(201);
    h.registrar.setBalance(1_000_000n);
  });

  it("new-account limits and sanctions come from the compliance module", async () => {
    const fresh = await makeBuyer(h, "fresh@example.com");
    await h.app.db.owner.query("update users set created_at = $2 where id = $1", [fresh.userId, h.app.clock.now()]);
    for (let i = 0; i < 5; i++) await h.app.db.owner.query("insert into orders (user_id, kind, fqdn_ascii, years, state, idempotency_key, request_hash, quote, subtotal_minor, total_minor, livemode, created_at) values ($1,'register',$2,1,'authorized',$3,'\\x00','{}',1,1,false,$4)", [fresh.userId, `seed${i}.com`, `seed-${i}`, h.app.clock.now()]);
    const r = await postOrder(h, fresh, { fqdn: "free-fresh.com", years: 1 }, "vel-1");
    expect(r.status).toBe(429);
    const bad = await makeBuyer(h, "sanction@example.com", { contact: false });
    await withUser(h.app.ctx.runtime, bad.userId, (c) => storeRegistrant(h.app.ctx, c, bad.userId, { ...REGISTRANT, name: "Test Sanctioned Person", email: "sanction@example.com" }));
    const s = await postOrder(h, bad, { fqdn: "free-sanc.com", years: 1 }, "san-1");
    expect([s.status, s.json.error.code]).toEqual([403, "screening_hold"]);
  });

  it("GET /orders/:id: an unowned order and a nonexistent one leave through the same 404", async () => {
    const mine = await postOrder(h, ada, { fqdn: "free-own.com", years: 1 }, "own-1");
    const id = mine.json.order_id as string;
    expect((await getOrder(h, ada, id)).status).toBe(200);
    const other = await getOrder(h, bo, id);
    const missing = await getOrder(h, bo, "00000000-0000-7000-8000-000000000000");
    const junk = await getOrder(h, bo, "not-a-uuid");
    for (const r of [other, missing, junk]) expect([r.status, r.text]).toEqual([404, missing.text]);
    expect([...other.headers.keys()].sort()).toEqual([...missing.headers.keys()].sort());
    expect((await h.app.call("GET", `/api/v1/orders/${id}`, {})).status).toBe(401);
  });

  it("GET /orders/:id/return reconciles only a Session that belongs to the signed-in user's order", async () => {
    const buyer = await makeBuyer(h, "return@example.com");
    const { id, sessionId } = await buyAndPay(h, buyer, "free-return.com", { key: "ret-1" });
    const stranger = await makeBuyer(h, "stranger@example.com");
    expect((await h.app.call("GET", `/api/v1/orders/${id}/return?session_id=${sessionId}`, { cookie: stranger.cookie })).status).toBe(404);
    expect((await h.app.call("GET", `/api/v1/orders/${id}/return?session_id=cs_test_other`, { cookie: buyer.cookie })).status).toBe(404);
    expect((await h.app.call("GET", `/api/v1/orders/${id}/return`, { cookie: buyer.cookie })).status).toBe(404);
    expect((await orderRow(h, id)).state).toBe("checkout_open");
    const ok = await h.app.call("GET", `/api/v1/orders/${id}/return?session_id=${sessionId}`, { cookie: buyer.cookie });
    expect(ok.status).toBe(200);
    expect(ok.json.state).toBe("captured");                                        // the success page ran the same idempotent reconcile
    const again = await h.app.call("GET", `/api/v1/orders/${id}/return?session_id=${sessionId}`, { cookie: buyer.cookie });
    expect(again.json.state).toBe("captured");
    expect(h.registrar.calls.register).toBeGreaterThan(0);
    expect(h.stripe.created.captures).toBeGreaterThan(0);
    void deliverAll;
  });
});
