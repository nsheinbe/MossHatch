import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderMail, MailRenderError } from "../mail/templates.ts";
import { buyAndPay, deliver, deliverAll, orderRow, postOrder } from "../orders/testkit.ts";
import { cardDetachSweep } from "./cards.ts";
import { AUTH_TEXT_HASH, at, autoRenewOn, buyDomain, days, domainRow, harnessPerTest, mailOf, makeDomainsHarness, makeOwner, relogin, renewOrders, settle, signMandate, termRow, type DomainsHarness } from "./testkit.ts";

/**
 * Phase 3 finish: the saved card and the mandate (C-31, C-32, C-33, C-34, C-38) against FakeStripe at the pinned API version.
 * FakeStripe is not Stripe: these prove our side of the contract (parameters sent, events handled), not Stripe's behaviour.
 */
let h: DomainsHarness;
beforeAll(async () => { h = await makeDomainsHarness(); }, 120_000);
afterAll(async () => { await h?.app.drop(); });
const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });

const expiry = async (x: DomainsHarness, id: string) => new Date((await domainRow(x, id)).expires_at);
const renewPIs = (x: DomainsHarness) => [...x.stripe.paymentIntents.values()].filter((p) => p.metadata.purpose === "renewal");
const sessionOf = async (x: DomainsHarness, orderId: string) => (await orderRow(x, orderId)).stripe_checkout_session_id as string;

describe("C-31: the card is saved only when the auto-renew box is ticked, apart from the terms", () => {
  it("without the box: no setup_future_usage, the card is not reusable, and a mandate cannot be signed on it", async () => {
    const o = await makeOwner(h, "nobox@example.com");
    const dom = await buyDomain(h, o, "free-nobox.dev", { autoRenew: false });
    const order = await orderRow(h, dom.orderId);
    expect(h.stripe.sessionParams(order.stripe_checkout_session_id).stripe.payment_intent_data).not.toHaveProperty("setup_future_usage");
    expect([order.save_card, order.card_reusable]).toEqual([false, false]);
    expect(h.stripe.paymentMethods.get(order.payment_method_ref)!.customer).toBeNull();
    const prep = await signMandate(h, o, dom.id);
    expect(prep.prep.status).toBe(409); expect(prep.prep.json.error.code).toBe("no_saved_card");
    // The faithful fake refuses an off-session charge on a card that was never attached, as Stripe does.
    const off = await h.stripe.createOffSessionPaymentIntent({ customer: order.stripe_customer_id, paymentMethod: order.payment_method_ref, amount: 100, currency: "usd", metadata: {} }, "probe").catch((e) => e);
    expect(off.code).toBe("payment_method_not_attached");
  });

  it("the box needs its own consent to the authorisation text: missing or wrong hash is refused before anything is created", async () => {
    const o = await makeOwner(h, "boxnoconsent@example.com");
    const docs = { terms: "termshash0123456789abcdef", registration_agreement: "agreementhash0123456789" };
    const bad = await postOrder(h, o, { fqdn: "free-boxnc.dev", years: 1, auto_renew: true, accept: docs }, "k-bnc");
    expect(bad.status).toBe(422); expect(bad.json.error.code).toBe("auto_renew_consent_required");
    const wrong = await postOrder(h, o, { fqdn: "free-boxnc.dev", years: 1, auto_renew: true, accept: { ...docs, auto_renew_authorisation: "not-the-text" } }, "k-bnc2");
    expect(wrong.status).toBe(422);
    const notBool = await postOrder(h, o, { fqdn: "free-boxnc.dev", years: 1, auto_renew: "yes", accept: docs }, "k-bnc3");
    expect(notBool.status).toBe(422);
    expect((await h.app.db.owner.query("select count(*)::int n from orders where user_id = $1", [o.userId])).rows[0].n).toBe(0);
  });

  it("with the box: setup_future_usage=off_session, the consent row is stored apart from the terms, and the card is attached and reusable", async () => {
    const o = await makeOwner(h, "box@example.com");
    const dom = await buyDomain(h, o, "free-box.dev", { autoRenew: true });
    const order = await orderRow(h, dom.orderId);
    const params = h.stripe.sessionParams(order.stripe_checkout_session_id).stripe;
    expect(params.payment_intent_data).toMatchObject({ capture_method: "manual", setup_future_usage: "off_session" });
    expect([order.save_card, order.auto_renew_opt_in, order.card_reusable]).toEqual([true, true, true]);
    expect(h.stripe.paymentMethods.get(order.payment_method_ref)!.customer).toBe(order.stripe_customer_id);
    const consents = (await h.app.db.owner.query("select kind, document_hash from consents where order_id = $1 order by kind", [dom.orderId])).rows;
    expect(consents.map((c) => c.kind)).toEqual(["auto_renew_mandate", "registration_agreement", "terms"]);
    expect(consents[0].document_hash).toBe(AUTH_TEXT_HASH);
    // The opt-in is not a mandate: auto-renew stays off until the passkey signs (C-31).
    expect((await domainRow(h, dom.id)).auto_renew).toBe(false);
    await autoRenewOn(h, o, dom.id);
    expect((await domainRow(h, dom.id)).auto_renew).toBe(true);
  });

  it("an opt-in order that ends without a name has its card detached; a card a live mandate uses is kept", async () => {
    const x = await per.make();
    const o = await makeOwner(x, "detach@example.com");
    const r = await buyAndPay(x, o, "free-detach.dev", { autoRenew: true });
    x.registrar.registerAsOther("free-detach.dev");                       // someone else registers it first: the order is voided
    await deliverAll(x); await settle(x);
    const order = await orderRow(x, r.id);
    expect(["voided", "canceling", "registration_failed"]).toContain(order.state);
    // The hourly `card.detach_sweep` job ran inside settle: the card left the Stripe customer.
    await settle(x);
    expect(x.stripe.paymentMethods.get(order.payment_method_ref)!.customer).toBeNull();
    expect(x.stripe.calls.detachPaymentMethod).toBe(1);
    expect((await orderRow(x, r.id)).card_detached_at).toBeTruthy();
    expect((await cardDetachSweep(x.app.ctx)).detached).toBe(0);           // idempotent
    // A kept card: the same person's live domain with a mandate on the same saved card.
    const dom = await buyDomain(x, o, "free-kept.dev", { autoRenew: true });
    await autoRenewOn(x, o, dom.id);
    const kept = await orderRow(x, dom.orderId);
    await x.app.db.owner.query("update orders set state = 'voided', card_detached_at = null where id = $1", [r.id]);
    await x.app.db.owner.query("update orders set payment_method_ref = $2 where id = $1", [r.id, kept.payment_method_ref]);
    const again = await cardDetachSweep(x.app.ctx);
    expect(again).toMatchObject({ detached: 0, kept: 1 });
    expect(x.stripe.paymentMethods.get(kept.payment_method_ref)!.customer).toBe(kept.stripe_customer_id);
  });
});

describe("Renew now with no saved card pays on Checkout, and the registrar is called only after the payment (C-30)", () => {
  it("returns a Checkout URL, reuses it on a second click, renews once after payment, and never saves the card", async () => {
    const x = await per.make();
    const o = await makeOwner(x, "rncheckout@example.com");
    const dom = await buyDomain(x, o, "free-rncheckout.dev", { autoRenew: false });
    const first = await x.app.call("POST", `/api/v1/domains/${dom.id}/renew`, { cookie: o.cookie, body: {} });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.status).toBe("checkout");
    expect(first.json.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const second = await x.app.call("POST", `/api/v1/domains/${dom.id}/renew`, { cookie: o.cookie, body: {} });
    expect(second.json.checkout_url).toBe(first.json.checkout_url);
    expect(x.registrar.calls.renew ?? 0).toBe(0);                          // nothing upstream before the payment
    const sid = await sessionOf(x, first.json.order_id);
    const params = x.stripe.sessionParams(sid).stripe;
    expect(params.payment_intent_data).toMatchObject({ capture_method: "automatic" });
    expect(params.payment_intent_data).not.toHaveProperty("setup_future_usage");
    x.stripe.takeEvents();
    x.stripe.payCheckout(sid);
    const delivered = await deliverAll(x);
    expect(delivered.every((d) => d.status === 200)).toBe(true);
    await settle(x);
    const orders = await renewOrders(x, dom.id);
    expect(orders.map((r) => r.state)).toEqual(["renewed"]);
    expect(x.registrar.calls.renew).toBe(1);
    expect((await x.app.db.owner.query("select count(*)::int n from payments where order_id = $1", [orders[0].id])).rows[0].n).toBe(1);
    expect((await x.app.db.owner.query("select state from renewal_terms where order_id = $1", [orders[0].id])).rows[0].state).toBe("renewed");
    expect([...x.stripe.paymentIntents.values()].filter((p) => p.metadata.order_id === orders[0].id)).toHaveLength(1);   // one payment, on Checkout
    // A replayed webhook changes nothing.
    const ev = x.stripe.outbox.length ? x.stripe.takeEvents() : [];
    void ev;
    const view = await x.app.call("GET", `/api/v1/orders/${orders[0].id}`, { cookie: o.cookie });
    expect(view.json).toMatchObject({ kind: "renew", state: "renewed" });
    expect(mailOf(x, "renewal_receipt")).toHaveLength(1);
    expect(mailOf(x, "renewal_receipt")[0]!.text).not.toMatch(/email-actions/);   // no mandate, so no turn-off link to offer
  });

  it("a Checkout payment that lands after the term was renewed another way is refunded, never kept twice", async () => {
    const x = await per.make();
    const o = await makeOwner(x, "rnlate@example.com");
    const dom = await buyDomain(x, o, "free-rnlate.dev", { autoRenew: false });
    const first = await x.app.call("POST", `/api/v1/domains/${dom.id}/renew`, { cookie: o.cookie, body: {} });
    const sid = await sessionOf(x, first.json.order_id);
    // The order moves on before the payment lands (an operator voided it).
    await x.app.db.owner.query("update orders set state = 'voided' where id = $1", [first.json.order_id]);
    x.stripe.takeEvents();
    x.stripe.payCheckout(sid);
    await deliverAll(x);
    const pi = [...x.stripe.paymentIntents.values()].find((p) => p.metadata.order_id === first.json.order_id)!;
    expect([...x.stripe.refunds.values()].filter((r) => r.payment_intent === pi.id)).toHaveLength(1);
    expect(x.registrar.calls.renew ?? 0).toBe(0);
  });
});

describe("C-38: payment_method.automatically_updated brings the person back; a new brand needs a new agreement", () => {
  it("same brand: recorded, emailed with the one-click turn-off link, and the renewal still charges", async () => {
    const x = await per.make();
    const o = await makeOwner(x, "updater@example.com");
    const dom = await buyDomain(x, o, "free-updater.dev");
    await autoRenewOn(x, o, dom.id);
    const pm = (await orderRow(x, dom.orderId)).payment_method_ref as string;
    const res = await deliver(x, x.stripe.cardUpdater(pm, { expYear: 2031 }));
    expect(res.status).toBe(200);
    const m = (await x.app.db.owner.query("select card_updated_at, reconsent_required_at from renewal_mandates where domain_id = $1 and revoked_at is null", [dom.id])).rows[0];
    expect(m.card_updated_at).toBeTruthy(); expect(m.reconsent_required_at).toBeNull();
    const mail = mailOf(x, "card_updated").at(-1)!;
    expect(mail.text).toMatch(/Auto-renew stays on/);
    expect(mail.text).toMatch(/\/api\/v1\/email-actions\/[A-Za-z0-9_-]{43}/);
    at(x, new Date((await expiry(x, dom.id)).getTime() - days(10) + 60_000)); await settle(x);
    expect((await renewOrders(x, dom.id)).map((r) => r.state)).toEqual(["renewed"]);
  });

  it("new brand: the mandate waits for a fresh passkey signature; nothing is charged meanwhile; signing again lets the charge run", async () => {
    const x = await per.make();
    const o = await makeOwner(x, "brand@example.com");
    const dom = await buyDomain(x, o, "free-brand.dev");
    await autoRenewOn(x, o, dom.id);
    const pm = (await orderRow(x, dom.orderId)).payment_method_ref as string;
    await deliver(x, x.stripe.cardUpdater(pm, { brand: "mastercard" }));
    expect(mailOf(x, "card_updated").at(-1)!.text).toMatch(/will not charge it until you agree again/);
    const e = await expiry(x, dom.id);
    at(x, new Date(e.getTime() - days(10) + 60_000)); await settle(x);
    expect(renewPIs(x)).toHaveLength(0);
    expect((await termRow(x, dom.id)).held_reason).toBe("reconsent_required");
    // Renew now does not charge the changed card off-session either: it offers Checkout.
    const o2 = await relogin(x, o);
    const click = await x.app.call("POST", `/api/v1/domains/${dom.id}/renew`, { cookie: o2.cookie, body: {} });
    expect(click.json.status).toBe("checkout");
    expect(renewPIs(x)).toHaveLength(0);
    // A fresh signature replaces the mandate (not "already on"), and the next pass charges.
    const again = await signMandate(x, o2, dom.id);
    expect(again.res?.status, JSON.stringify(again.res?.json ?? again.prep.json)).toBe(200);
    expect((await x.app.db.owner.query("select count(*)::int n from renewal_mandates where domain_id = $1 and revoked_by = 'reconsent'", [dom.id])).rows[0].n).toBe(1);
    // The new agreement is new: its confirmation email is the pre-charge notice, so the charge waits 7 days after it (C-38), still before expiry.
    at(x, new Date(e.getTime() - days(10) + 20 * 60_000)); await settle(x);
    expect(renewPIs(x)).toHaveLength(0);
    expect((await termRow(x, dom.id)).held_reason).toBe("charge_notice_pending");
    at(x, new Date(e.getTime() - days(3) + 30 * 60_000)); await settle(x);
    expect(renewPIs(x)).toHaveLength(1);
    expect((await renewOrders(x, dom.id)).map((r) => r.state)).toEqual(["renewed"]);
  });
});

describe("C-32, C-38: the pre-charge notice reaches the person at least 7 days before an automatic charge", () => {
  it("a mandate signed two days before the charge day waits until 7 days after its confirmation email, then charges before expiry", async () => {
    const x = await per.make();
    const o = await makeOwner(x, "late@example.com");
    const dom = await buyDomain(x, o, "free-late.dev");
    const e = await expiry(x, dom.id);
    at(x, new Date(e.getTime() - days(12)));
    const o2 = await relogin(x, o);
    await autoRenewOn(x, o2, dom.id);
    at(x, new Date(e.getTime() - days(10) + 60_000)); await settle(x);
    expect(renewPIs(x)).toHaveLength(0);
    expect((await termRow(x, dom.id)).held_reason).toBe("charge_notice_pending");
    at(x, new Date(e.getTime() - days(5) + 60_000)); await settle(x);
    expect(renewPIs(x)).toHaveLength(1);
    expect((await renewOrders(x, dom.id)).map((r) => r.state)).toEqual(["renewed"]);
  });
});

describe("C-34: every email about an automatic charge carries the one-click turn-off link", () => {
  it("the templates refuse to render a renewal or price notice for an auto-renewing name without the link", () => {
    const base = { fqdn: "moonfern.com", expiresAt: "2026-12-01T00:00:00.000Z", chargeAt: "2026-11-21T00:00:00.000Z", priceMinor: "1850" };
    for (const stage of ["e43", "e32", "c8"] as const) expect(() => renderMail("renewal_notice", { ...base, stage, autoRenew: true })).toThrow(MailRenderError);
    expect(() => renderMail("renewal_notice", { ...base, stage: "e43", autoRenew: false })).not.toThrow();
    expect(() => renderMail("price_change_notice", { fqdn: "moonfern.com", kind: "known", oldMinor: "1850", newMinor: "1925", chargeAt: base.chargeAt, autoRenew: true, aboveCap: true })).toThrow(MailRenderError);
  });
});

describe("C-59, C-60: .ai and .io are sold only with their registry terms accepted", () => {
  it("an .io order without the addendum hash is refused; with it, the acceptance is stored as a tld_addendum consent", async () => {
    const o = await makeOwner(h, "iobuyer@example.com");
    const docs = { terms: "termshash0123456789abcdef", registration_agreement: "agreementhash0123456789" };
    const no = await postOrder(h, o, { fqdn: "free-ioterms.io", years: 1, accept: docs }, "k-io1");
    expect(no.status).toBe(422); expect(no.json.error.code).toBe("tld_terms_not_accepted");
    const ok = await postOrder(h, o, { fqdn: "free-ioterms.io", years: 1, accept: { ...docs, tld_addendum_io: "ioaddendumhash0123456789" } }, "k-io2");
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    const c = (await h.app.db.owner.query("select kind, document_hash from consents where order_id = $1 and kind = 'tld_addendum'", [ok.json.order_id])).rows;
    expect(c).toEqual([{ kind: "tld_addendum", document_hash: "ioaddendumhash0123456789" }]);
    const ai1 = await postOrder(h, o, { fqdn: "free-aiterms.ai", years: 1 }, "k-ai1");
    expect(ai1.status).toBe(422); expect(ai1.json.error.code).toBe("invalid_term");     // .ai: no one-year option (C-59)
  });
});

describe("C-16: a registration starts the registrant-verification clock", () => {
  it("the domain row and a pending 15-day verification are created together, and the status route shows it to the owner", async () => {
    const o = await makeOwner(h, "c16@example.com");
    const dom = await buyDomain(h, o, "free-c16.dev");
    const v = (await h.app.db.owner.query("select reason, state, started_at, deadline_at from registrant_verifications where domain_id = $1", [dom.id])).rows[0];
    expect(v).toMatchObject({ reason: "registration", state: "pending" });
    expect(new Date(v.deadline_at).getTime() - new Date(v.started_at).getTime()).toBe(days(15));
    const st = await h.app.call("GET", `/api/v1/domains/${dom.fqdn}/registrant-verification`, { cookie: o.cookie });
    expect(st.json.verification).toMatchObject({ state: "pending", reason: "registration", days_left: 15 });
  });
});

describe("C-38: a charge that needs the person present brings them back on-session", () => {
  it("authentication_required on Renew now answers with a Checkout URL instead of a dead end", async () => {
    const x = await per.make();
    const o = await makeOwner(x, "sca@example.com");
    const dom = await buyDomain(x, o, "free-sca.dev", { pay: { paymentMethod: "pm_auth_required_1" } });
    await autoRenewOn(x, o, dom.id);
    const click = await x.app.call("POST", `/api/v1/domains/${dom.id}/renew`, { cookie: o.cookie, body: {} });
    expect(click.status, JSON.stringify(click.json)).toBe(200);
    expect(click.json.status).toBe("checkout");
    expect(click.json.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
  });
});

describe("C-31: a person who did not tick the box at checkout can save the card when they pay a renewal, with the same separate consent", () => {
  it("Renew now with the authorisation hash saves the card; afterwards the mandate can be signed; a wrong hash saves nothing", async () => {
    const x = await per.make();
    const o = await makeOwner(x, "latesave@example.com");
    const dom = await buyDomain(x, o, "free-latesave.dev", { autoRenew: false });
    const wrong = await x.app.call("POST", `/api/v1/domains/${dom.id}/renew`, { cookie: o.cookie, body: { auto_renew_consent: "not-the-text-shown" } });
    expect(wrong.status).toBe(422); expect(wrong.json.error.code).toBe("auto_renew_consent_required");
    const click = await x.app.call("POST", `/api/v1/domains/${dom.id}/renew`, { cookie: o.cookie, body: { auto_renew_consent: AUTH_TEXT_HASH } });
    expect(click.json.status).toBe("checkout");
    const sid = await sessionOf(x, click.json.order_id);
    expect(x.stripe.sessionParams(sid).stripe.payment_intent_data).toMatchObject({ capture_method: "automatic", setup_future_usage: "off_session" });
    expect((await x.app.db.owner.query("select count(*)::int n from consents where order_id = $1 and kind = 'auto_renew_mandate'", [click.json.order_id])).rows[0].n).toBe(1);
    x.stripe.takeEvents(); x.stripe.payCheckout(sid); await deliverAll(x); await settle(x);
    const ord = await orderRow(x, click.json.order_id);
    expect([ord.state, ord.card_reusable]).toEqual(["renewed", true]);
    await autoRenewOn(x, await relogin(x, o), dom.id);
    expect((await domainRow(x, dom.id)).auto_renew).toBe(true);
  });
});

describe("Renew now on Checkout: the return page reconciles without waiting for the webhook", () => {
  it("GET /orders/:id/return reads the Session and PaymentIntent, charges the order once and renews it", async () => {
    const x = await per.make();
    const o = await makeOwner(x, "rnreturn@example.com");
    const dom = await buyDomain(x, o, "free-rnreturn.dev", { autoRenew: false });
    const click = await x.app.call("POST", `/api/v1/domains/${dom.id}/renew`, { cookie: o.cookie, body: {} });
    const sid = await sessionOf(x, click.json.order_id);
    x.stripe.takeEvents(); x.stripe.payCheckout(sid); x.stripe.takeEvents();          // the webhooks never arrive
    const back = await x.app.call("GET", `/api/v1/orders/${click.json.order_id}/return?session_id=${sid}`, { cookie: o.cookie });
    expect(back.status).toBe(200);
    expect(["renewed", "renewing_upstream"]).toContain(back.json.state);
    const again = await x.app.call("GET", `/api/v1/orders/${click.json.order_id}/return?session_id=${sid}`, { cookie: o.cookie });
    expect(again.json.state).toBe("renewed");
    expect((await x.app.db.owner.query("select count(*)::int n from payments where order_id = $1", [click.json.order_id])).rows[0].n).toBe(1);
    expect(x.registrar.calls.renew).toBe(1);
  });
});
