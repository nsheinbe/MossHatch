import { afterEach, describe, expect, it } from "vitest";
import { deliver } from "../orders/testkit.ts";
import { loadOrder } from "../orders/support.ts";
import { clearAccountReview } from "./disputes.ts";
import { refundChargeWithoutMandate } from "./refunds.ts";
import { renewalChargeDeadLetter } from "./renewals.ts";
import { alertRows, at, autoRenewOn, buyDomain, days, domainRow, harnessPerTest, hygiene, makeOwner, relogin, renewOrders, settle, termRow, type DomainsHarness, type Owner } from "./testkit.ts";

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });

const piOf = (h: DomainsHarness, orderId: string) => [...h.stripe.paymentIntents.values()].find((p) => p.metadata.order_id === orderId)!;
const refund = (h: DomainsHarness, o: Owner, orderId: string, body: unknown = {}) => h.app.call("POST", `/api/v1/orders/${orderId}/refund`, { cookie: o.cookie, body });

describe("ST-102: a dispute flags the account and pauses renewals, and the refund cap applies", () => {
  it("a dispute test card flags the account, holds the renewal charge for a manual look, and the charge resumes when a person clears it", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "st102a@example.com");
    const dom = await buyDomain(h, o, "free-st102a.dev");
    await autoRenewOn(h, o, dom.id);
    const ev = h.stripe.openDispute(piOf(h, dom.orderId).id);
    expect((await deliver(h, ev)).status).toBe(200);
    expect((await h.app.db.owner.query("select risk_state from users where id = $1", [o.userId])).rows[0].risk_state).toBe("review");
    expect((await h.app.db.owner.query("select dispute_state from payments where order_id = $1", [dom.orderId])).rows[0].dispute_state).toBe("open");
    expect(await alertRows(h, "dispute_opened")).toHaveLength(1);

    const c = new Date((await termRow(h, dom.id)).charge_at);
    at(h, new Date(c.getTime() + 60_000)); await settle(h);
    expect(h.stripe.calls.createOffSessionPaymentIntent ?? 0).toBe(0);
    expect(await renewOrders(h, dom.id)).toHaveLength(0);
    const t = await termRow(h, dom.id);
    expect([t.state, t.held_reason]).toEqual(["held", "account_review"]);
    // The customer's own click waits too: renewal charges wait for a manual look.
    const click = await h.app.call("POST", `/api/v1/domains/${dom.id}/renew`, { cookie: (await relogin(h, o)).cookie, body: {} });
    expect(click.status).toBe(409); expect(click.json.error.code).toBe("renewal_paused");
    // Winning the dispute does not lift the flag by itself.
    await deliver(h, h.stripe.closeDispute(piOf(h, dom.orderId).id, true));
    expect((await h.app.db.owner.query("select dispute_state from payments where order_id = $1", [dom.orderId])).rows[0].dispute_state).toBe("won");
    at(h, new Date(c.getTime() + days(2))); await settle(h);
    expect(h.stripe.calls.createOffSessionPaymentIntent ?? 0).toBe(0);
    // A person looks and clears it; the next pass charges and renews.
    expect(await clearAccountReview(h.app.ctx, o.userId, "ops-1")).toBe(true);
    expect(await clearAccountReview(h.app.ctx, o.userId, "ops-1")).toBe(false);
    at(h, new Date(c.getTime() + days(2) + 10 * 60_000)); await settle(h);
    expect((await renewOrders(h, dom.id)).map((r) => r.state)).toEqual(["renewed"]);
    // A dispute lock never touches the payment dispute path: the name stayed locked and was never released.
    expect((await domainRow(h, dom.id)).released_at).toBeNull();
  });

  it("an early fraud warning does the same", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "st102b@example.com");
    const dom = await buyDomain(h, o, "free-st102b.dev");
    await deliver(h, h.stripe.openDispute(piOf(h, dom.orderId).id, "efw"));
    expect((await h.app.db.owner.query("select risk_state from users where id = $1", [o.userId])).rows[0].risk_state).toBe("review");
  });

  it("the refund cap: three refunds in 30 days, the fourth is refused, and each refunded name leaves the account", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "st102c@example.com");
    const doms = [];
    for (let i = 0; i < 4; i++) doms.push(await buyDomain(h, o, `free-st102c${i}.dev`));
    for (let i = 0; i < 3; i++) {
      const r = await refund(h, o, doms[i]!.orderId);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json.state).toBe("refunded");
      expect((await domainRow(h, doms[i]!.id)).release_reason).toBe("refunded");
    }
    const fourth = await refund(h, o, doms[3]!.orderId);
    expect(fourth.status).toBe(403); expect(fourth.json.error.code).toBe("refund_cap");
    expect((await domainRow(h, doms[3]!.id)).released_at).toBeNull();
    expect(h.stripe.created.refunds).toBe(3);
    expect((await h.app.db.owner.query("select count(*)::int n from refunds where user_id = $1", [o.userId])).rows[0].n).toBe(3);
    expect(await alertRows(h, "manual_domain_delete_required")).toHaveLength(3);      // no adapter can delete: a person is asked
    // The window rolls: 31 days later a refund is allowed again if the rest of the rules hold (here the 5-day window has closed).
    at(h, new Date(h.app.clock.now().getTime() + days(31)));
    const late = await refund(h, await relogin(h, o), doms[3]!.orderId);
    expect(late.status).toBe(409); expect(late.json.error.code).toBe("window_closed");
    // The ledger shows the three refunds against their orders.
    const led = await h.app.call("GET", "/api/v1/ledger", { cookie: (await relogin(h, o)).cookie });
    expect(led.json.refunds).toHaveLength(3);
  });
});

describe("refund rules (C-29)", () => {
  it(".io and .ai are not refundable; inside the window a domain with DNS records or connections is not refunded; another person's order is a 404", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "c29a@example.com");
    const io = await buyDomain(h, o, "free-c29a.io");
    const r1 = await refund(h, o, io.orderId);
    expect(r1.status).toBe(409); expect(r1.json.error.code).toBe("tld_non_refundable");
    const dev = await buyDomain(h, o, "free-c29b.dev");
    await h.registrar.replaceZone(dev.fqdn, [{ type: "A", name: "", value: "203.0.113.5" }]);
    const r2 = await refund(h, o, dev.orderId);
    expect(r2.status).toBe(409); expect(r2.json.error.code).toBe("domain_in_use");
    await h.registrar.replaceZone(dev.fqdn, []);
    const eve = await makeOwner(h, "c29eve@example.com");
    const stranger = await refund(h, eve, dev.orderId);
    const missing = await refund(h, eve, "018f0000-0000-7000-8000-000000000000");
    expect([stranger.status, JSON.stringify(stranger.json)]).toEqual([missing.status, JSON.stringify(missing.json)]);
    expect(stranger.status).toBe(404);
    // With the records gone the refund goes through, inside the 5-day window.
    const ok = await refund(h, o, dev.orderId);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });

  it("the window closes 5 days after registry creation", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "c29w@example.com");
    const d = await buyDomain(h, o, "free-c29w.dev");
    at(h, new Date(h.app.clock.now().getTime() + days(4)));
    // Inside the window it would be allowed; one hour after day 5 it is not.
    at(h, new Date(h.app.clock.now().getTime() + days(1) + 3600_000));
    const r = await refund(h, await relogin(h, o), d.orderId);
    expect(r.status).toBe(409); expect(r.json.error.code).toBe("window_closed");
  });

  it("a renewal refunded after it was delivered deletes the name, so the customer must confirm that first", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "c29r@example.com");
    const d = await buyDomain(h, o, "free-c29r.dev");
    const click = await h.app.call("POST", `/api/v1/domains/${d.id}/renew`, { cookie: o.cookie, body: {} });
    expect(click.status).toBe(200);
    const orderId = click.json.order_id as string;
    const noConfirm = await refund(h, o, orderId);
    expect(noConfirm.status).toBe(409); expect(noConfirm.json.error.code).toBe("confirm_delete_required");
    expect((await domainRow(h, d.id)).released_at).toBeNull();
    const yes = await refund(h, o, orderId, { confirm_delete: true });
    expect(yes.status, JSON.stringify(yes.json)).toBe(200);
    expect(yes.json.state).toBe("refunded");
    expect((await domainRow(h, d.id)).release_reason).toBe("refunded");
    expect(h.stripe.created.refunds).toBe(1);
  });
});

describe("a charge without a valid mandate (C-29) and a dead renewal job (PLAN jobs table)", () => {
  it("is refunded in full by an operator and the domain is kept; a charge the person asked for, or one a mandate covered, is not", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "c29m@example.com");
    const dom = await buyDomain(h, o, "free-c29m.dev");
    await autoRenewOn(h, o, dom.id);
    at(h, new Date(new Date((await termRow(h, dom.id)).charge_at).getTime() + 60_000)); await settle(h);
    const order = (await renewOrders(h, dom.id))[0];
    expect(order.state).toBe("renewed");
    expect(await refundChargeWithoutMandate(h.app.ctx, order.id, "ops-1")).toBe("covered_by_mandate");
    // The mandate is found not to have covered the charge (it was signed after it).
    await h.app.db.owner.query("update renewal_mandates set accepted_at = accepted_at + interval '400 days' where domain_id = $1", [dom.id]);
    expect(await refundChargeWithoutMandate(h.app.ctx, order.id, "ops-1")).toBe("refunded");
    expect((await loadOrder(h.app.ctx.cron, order.id))!.state).toBe("refunded");
    expect(h.stripe.created.refunds).toBe(1);
    expect((await domainRow(h, dom.id)).released_at).toBeNull();          // the domain is kept
    const p = (await h.app.db.owner.query("select amount_minor, refunded_minor from payments where order_id = $1", [order.id])).rows[0];
    expect(p.refunded_minor).toBe(p.amount_minor);
    // A click on Renew now is the person's own request, so it is never "without a mandate".
    const o2 = await makeOwner(h, "c29n@example.com");
    const d2 = await buyDomain(h, o2, "free-c29n.dev");
    await hygiene(h);
    const click = await h.app.call("POST", `/api/v1/domains/${d2.id}/renew`, { cookie: (await relogin(h, o2)).cookie, body: {} });
    expect(click.status).toBe(200);
    expect(await refundChargeWithoutMandate(h.app.ctx, click.json.order_id, "ops-1")).toBe("asked_for");
  });

  it("a renewal.charge job that dead-letters is queued again 15 minutes later instead of being abandoned", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "dead@example.com");
    const dom = await buyDomain(h, o, "free-dead.dev");
    await autoRenewOn(h, o, dom.id);
    const t0 = new Date(new Date((await termRow(h, dom.id)).charge_at).getTime() + 60_000);
    at(h, t0);
    h.registrar.faults.set("renewDraft", { fqdn: dom.fqdn });
    await settle(h);
    const order = (await renewOrders(h, dom.id))[0];
    const dead = (await h.app.db.owner.query("insert into jobs (kind, priority, state, payload, attempts, max_attempts) values ('renewal.charge', 0, 'dead', $1, 12, 12) returning id", [{ order_id: order.id }])).rows[0];
    await h.app.db.owner.query("delete from jobs where kind = 'renewal.charge' and state = 'queued'");
    await renewalChargeDeadLetter(h.app.ctx, { id: dead.id });
    const q = (await h.app.db.owner.query("select run_at, payload from jobs where kind = 'renewal.charge' and state = 'queued'")).rows;
    expect(q).toHaveLength(1);
    expect(q[0].payload.order_id).toBe(order.id);
    expect(new Date(q[0].run_at).getTime()).toBe(t0.getTime() + 15 * 60_000);
  });
});
