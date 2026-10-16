import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { mintToken } from "../util/token.ts";
import { deliver } from "../orders/testkit.ts";
import { sha256 } from "../util/bytes.ts";
import { runRenewalScheduler, nextUpstreamTry } from "./renewals.ts";
import { AUTH_TEXT_HASH, alertRows, at, autoRenewOn, buyDomain, days, domainRow, harnessPerTest, mailOf, makeDomainsHarness, makeOwner, relogin, renewOrders, settle, signMandate, termRow, type DomainsHarness, type Owner } from "./testkit.ts";

let h: DomainsHarness;
beforeAll(async () => { h = await makeDomainsHarness(); }, 120_000);
afterAll(async () => { await h?.app.drop(); });

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); });
const expiry = async (h: DomainsHarness, id: string) => new Date((await domainRow(h, id)).expires_at);
const chargeDay = async (h: DomainsHarness, id: string) => new Date((await expiry(h, id)).getTime() - days(10));
const renewPIs = (h: DomainsHarness) => [...h.stripe.paymentIntents.values()].filter((p) => p.metadata.purpose === "renewal");
const postRenew = (h: DomainsHarness, o: Owner, id: string) => h.app.call("POST", `/api/v1/domains/${id}/renew`, { cookie: o.cookie, body: {} });

describe("auto-renew consent (C-31, C-33, C-34, C-38)", () => {
  let o: Owner; let dom: Awaited<ReturnType<typeof buyDomain>>;
  beforeAll(async () => { o = await makeOwner(h, "consent@example.com"); dom = await buyDomain(h, o, "free-consent.dev"); });

  it("auto-renew is off until the person signs: no mandate, no charge, and an agent token cannot turn it on", async () => {
    expect((await domainRow(h, dom.id)).auto_renew).toBe(false);
    const noStepUp = await h.app.call("POST", `/api/v1/domains/${dom.id}/auto-renew`, { cookie: o.cookie, body: { consent_hash: AUTH_TEXT_HASH } });
    expect(noStepUp.status).toBe(403); expect(noStepUp.json.error.code).toBe("step_up_required");
    const m = mintToken("live");
    await h.app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, expires_at) values ($1,'agent','agent',$2,$3,$4, now() + interval '30 days')", [o.userId, m.prefix, m.hash, JSON.stringify([{ capability: "*", domain_id: dom.id }])]);
    const viaAgent = await h.app.call("POST", `/api/v1/domains/${dom.id}/auto-renew`, { authorization: `Bearer ${m.token}`, body: { consent_hash: AUTH_TEXT_HASH }, browser: false });
    expect([401, 403]).toContain(viaAgent.status);
    expect((await h.app.db.owner.query("select count(*)::int n from renewal_mandates where domain_id = $1", [dom.id])).rows[0].n).toBe(0);
  });

  it("the passkey signs the mandate; the consent to the authorisation text is stored apart from the terms with its hash; a wrong or missing hash is refused", async () => {
    const wrong = await signMandate(h, o, dom.id, "not-the-text-that-was-shown");
    expect(wrong.res?.status).toBe(422); expect(wrong.res?.json.error.code).toBe("terms_not_accepted");
    const missing = await h.app.call("POST", `/api/v1/domains/${dom.id}/auto-renew`, { cookie: o.cookie, body: {}, headers: { [ACTION_HEADER]: wrong.prep.json.action_id } });
    expect(missing.status).toBe(422);
    expect((await domainRow(h, dom.id)).auto_renew).toBe(false);
    // The failed attempt rolled back with the action still unused, so the same signature can complete once the consent is right.
    const ok = await h.app.call("POST", `/api/v1/domains/${dom.id}/auto-renew`, { cookie: o.cookie, body: { consent_hash: AUTH_TEXT_HASH }, headers: { [ACTION_HEADER]: wrong.prep.json.action_id } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ auto_renew: true, term_years: 1 });
    const mandate = (await h.app.db.owner.query("select * from renewal_mandates where domain_id = $1", [dom.id])).rows[0];
    const consent = (await h.app.db.owner.query("select * from consents where id = $1", [mandate.consent_id])).rows[0];
    expect(consent).toMatchObject({ kind: "auto_renew_mandate", document_hash: AUTH_TEXT_HASH, actor_kind: "user", domain_id: dom.id });
    expect(consent.assertion_action_id).toBe(wrong.prep.json.action_id);
    expect(consent.ip_enc).toBeTruthy();
    expect(mandate).toMatchObject({ text_hash: AUTH_TEXT_HASH, signed_action_id: wrong.prep.json.action_id, term_years: 1, charge_days_before_expiry: 10, revoked_at: null });
    expect(BigInt(mandate.price_ceiling_minor)).toBe(BigInt((await termRow(h, dom.id)).current_price_minor));
    expect(new Date(mandate.retain_until).getTime()).toBeGreaterThan(h.app.clock.now().getTime() + days(3 * 365 - 1));
    expect((await domainRow(h, dom.id)).auto_renew).toBe(true);
    // The action is single use.
    const again = await h.app.call("POST", `/api/v1/domains/${dom.id}/auto-renew`, { cookie: o.cookie, body: { consent_hash: AUTH_TEXT_HASH }, headers: { [ACTION_HEADER]: wrong.prep.json.action_id } });
    expect(again.status).toBeGreaterThanOrEqual(400);
    // The confirmation mail carries a one-click turn-off link.
    const mail = mailOf(h, "auto_renew_on").at(-1)!;
    expect(mail.text).toMatch(/\/api\/v1\/email-actions\/[A-Za-z0-9_-]{43}/);
  });

  it("C-34: switching off needs no passkey, is one request, is idempotent, and an agent token may do it only with the capability", async () => {
    const m = mintToken("live");
    await h.app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, expires_at) values ($1,'agent','plain',$2,$3,'[]', now() + interval '30 days')", [o.userId, m.prefix, m.hash]);
    const denied = await h.app.call("DELETE", `/api/v1/domains/${dom.id}/auto-renew`, { authorization: `Bearer ${m.token}`, browser: false });
    expect(denied.status).toBe(404);                         // a token without the capability learns nothing
    expect((await domainRow(h, dom.id)).auto_renew).toBe(true);
    const scoped = mintToken("live");
    await h.app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, expires_at) values ($1,'agent','off',$2,$3,$4, now() + interval '30 days')", [o.userId, scoped.prefix, scoped.hash, JSON.stringify([{ capability: "mandate.off", domain_id: dom.id }])]);
    const viaAgent = await h.app.call("DELETE", `/api/v1/domains/${dom.id}/auto-renew`, { authorization: `Bearer ${scoped.token}`, browser: false });
    expect(viaAgent.status, JSON.stringify(viaAgent.json)).toBe(200);
    expect(viaAgent.json).toEqual({ auto_renew: false, changed: true });
    expect((await domainRow(h, dom.id)).auto_renew).toBe(false);
    const row = (await h.app.db.owner.query("select revoked_at, revoked_by from renewal_mandates where domain_id = $1", [dom.id])).rows[0];
    expect(row.revoked_at).toBeTruthy(); expect(row.revoked_by).toBe("agent");
    const twice = await h.app.call("DELETE", `/api/v1/domains/${dom.id}/auto-renew`, { cookie: o.cookie, body: {} });
    expect(twice.status).toBe(200); expect(twice.json.changed).toBe(false);
  });

  it("turning it on again, then off by the emailed link (single use, no sign-in)", async () => {
    await autoRenewOn(h, o, dom.id);
    const mail = mailOf(h, "auto_renew_on").at(-1)!;
    const token = /email-actions\/([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
    const page = await h.app.call("GET", `/api/v1/email-actions/${token}`);
    expect(page.status).toBe(200);
    expect((await domainRow(h, dom.id)).auto_renew).toBe(true);        // a GET never acts
    const done = await h.app.call("POST", `/api/v1/email-actions/${token}`, { body: { confirm: true } });
    expect(done.status, done.text).toBe(200);
    expect((await domainRow(h, dom.id)).auto_renew).toBe(false);
    expect((await h.app.call("POST", `/api/v1/email-actions/${token}`, { body: { confirm: true } })).status).toBe(404);
  });

  it("another person's domain cannot be switched off or on: same 404 as a name that does not exist", async () => {
    const eve = await makeOwner(h, "eve@example.com");
    const a = await h.app.call("DELETE", `/api/v1/domains/${dom.id}/auto-renew`, { cookie: eve.cookie, body: {} });
    const b = await h.app.call("DELETE", "/api/v1/domains/018f0000-0000-7000-8000-000000000000/auto-renew", { cookie: eve.cookie, body: {} });
    expect([a.status, JSON.stringify(a.json)]).toEqual([b.status, JSON.stringify(b.json)]);
    expect(a.status).toBe(404);
  });
});

/** A fresh harness, one owner, one bought domain with auto-renew on. */
async function mandated(tag: string, tld = "dev", pay?: Parameters<typeof buyDomain>[3]) {
  const h = await per.make();
  const o = await makeOwner(h, `${tag}@example.com`);
  const dom = await buyDomain(h, o, `free-${tag}.${tld}`, pay);
  await autoRenewOn(h, o, dom.id);
  return { h, o, dom };
}

describe("ST-101: a scheduled renewal and a Renew now click produce one PaymentIntent", () => {
  it("the scheduler charges at E-10 and a later click finds the same order and the same PaymentIntent", async () => {
    const { h, o, dom } = await mandated("st101a");
    at(h, new Date((await chargeDay(h, dom.id)).getTime() + 60_000));
    await settle(h);
    const oid = (await renewOrders(h, dom.id))[0].id;
    expect(renewPIs(h).filter((p) => p.metadata.order_id === oid)).toHaveLength(1);
    const click = await postRenew(h, await relogin(h, o), dom.id);
    expect(click.status, JSON.stringify(click.json)).toBe(200);
    expect(click.json.status).toBe("renewed");
    expect(await renewOrders(h, dom.id)).toHaveLength(1);
    expect(renewPIs(h).filter((p) => p.metadata.order_id === oid)).toHaveLength(1);
    expect((await h.app.db.owner.query("select count(*)::int n from payments where order_id = $1", [oid])).rows[0].n).toBe(1);
    expect(h.registrar.calls.renew).toBe(1);
    expect((await h.app.db.owner.query("select state from renewal_terms where order_id = $1", [oid])).rows[0].state).toBe("renewed");
  });

  it("the scheduler and the click at the same moment, several clicks at once: one order, one PaymentIntent under one idempotency key, one registrar renewal", async () => {
    const { h, o, dom } = await mandated("st101b");
    at(h, new Date((await chargeDay(h, dom.id)).getTime() + 60_000));
    const o2 = await relogin(h, o);
    const results = await Promise.all([
      (async () => { await runRenewalScheduler(h.app.ctx); await settle(h); return null; })(),
      postRenew(h, o2, dom.id), postRenew(h, o2, dom.id), postRenew(h, o2, dom.id),
    ]);
    await settle(h);
    const orders = await renewOrders(h, dom.id);
    expect(orders).toHaveLength(1);
    const mine = renewPIs(h);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.metadata).toMatchObject({ order_id: orders[0].id, purpose: "renewal" });
    expect((await h.app.db.owner.query("select count(*)::int n from payments where order_id = $1", [orders[0].id])).rows[0].n).toBe(1);
    // Every call that reached Stripe carried the same key: a replay, never a second charge.
    const keys = h.stripe.keysUsed.filter((k) => k.method === "createOffSessionPaymentIntent");
    expect(new Set(keys.map((k) => k.key)).size).toBe(1);
    expect(keys[0]!.key).toMatch(/^renew:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}:1$/);
    expect(h.registrar.calls.renew).toBe(1);
    for (const r of results.slice(1)) expect([200, 202]).toContain((r as { status: number }).status);
    expect(orders[0].state).toBe("renewed");
  });

  it("Renew now without a mandate charges the saved card once (the click is the consent) and is refused when the account is under review", async () => {
    const h = await per.make();
    const o = await makeOwner(h, "st101c@example.com");
    const dom = await buyDomain(h, o, "free-st101c.dev");
    const res = await postRenew(h, o, dom.id);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(renewPIs(h)).toHaveLength(1);
    const o2 = await makeOwner(h, "st101d@example.com");
    const dom2 = await buyDomain(h, o2, "free-st101d.dev");
    await h.app.db.owner.query("update users set risk_state = 'review' where id = $1", [o2.userId]);
    const held = await postRenew(h, o2, dom2.id);
    expect(held.status).toBe(409); expect(held.json.error.code).toBe("renewal_paused");
    expect(renewPIs(h)).toHaveLength(1);
  });
});

describe("ST-110: a renewal charged but failing upstream", () => {
  it("nextUpstreamTry: 15 minutes for 24 hours from the first failure, then hourly, never past E-1", () => {
    const first = new Date("2027-01-01T00:00:00Z"), end = new Date("2027-03-01T00:00:00Z");
    const t = (s: string) => new Date(s);
    expect(nextUpstreamTry(first, first, end)).toEqual(t("2027-01-01T00:15:00Z"));
    expect(nextUpstreamTry(t("2027-01-01T23:45:00Z"), first, end)).toEqual(t("2027-01-02T00:00:00Z"));
    expect(nextUpstreamTry(t("2027-01-02T00:00:00Z"), first, end)).toEqual(t("2027-01-02T01:00:00Z"));
    expect(nextUpstreamTry(t("2027-02-27T23:30:00Z"), first, end)).toEqual(t("2027-02-28T00:00:00Z"));      // clamped to E-1
    expect(nextUpstreamTry(t("2027-02-28T00:00:00Z"), first, end)).toBeNull();
  });

  it("retries every 15 minutes for 24 hours, then hourly, cancelling the draft before each retry; pages once; refunds only at E-1", async () => {
    const { h, dom } = await mandated("st110");
    const term = await termRow(h, dom.id);
    const t0 = new Date(new Date(term.charge_at).getTime() + 60_000);
    at(h, t0);
    // Every renewal attempt leaves a draft order upstream and fails.
    h.registrar.faults.set("renewDraft", { fqdn: dom.fqdn });
    await settle(h);
    const order = (await renewOrders(h, dom.id))[0];
    expect(order.state).toBe("renewing_upstream");
    expect(h.registrar.calls.renew).toBe(1);
    expect(h.stripe.created.refunds).toBe(0);
    expect(await alertRows(h, "renewal_upstream_failed")).toHaveLength(1);
    for (let k = 1; k <= 96; k++) {
      at(h, new Date(t0.getTime() + k * 15 * 60_000));
      await settle(h);
      expect(h.registrar.calls.renew, `attempt at +${k * 15} minutes`).toBe(1 + k);
    }
    // 24 hours in: 97 attempts, one payment, no refund, one page.
    expect(h.registrar.calls.renew).toBe(97);
    expect(h.stripe.created.refunds).toBe(0);
    expect(await alertRows(h, "renewal_upstream_failed")).toHaveLength(1);
    // The draft renewal is cancelled before each retry.
    expect(h.registrar.calls.cancelPendingOrder).toBeGreaterThanOrEqual(96);
    // Then hourly.
    at(h, new Date(t0.getTime() + 24 * 3600_000 + 15 * 60_000)); await settle(h);
    expect(h.registrar.calls.renew).toBe(97);
    at(h, new Date(t0.getTime() + 25 * 3600_000)); await settle(h);
    expect(h.registrar.calls.renew).toBe(98);
    at(h, new Date(t0.getTime() + 26 * 3600_000 - 60_000)); await settle(h);
    expect(h.registrar.calls.renew).toBe(98);
    at(h, new Date(t0.getTime() + 26 * 3600_000)); await settle(h);
    expect(h.registrar.calls.renew).toBe(99);
    expect((await renewOrders(h, dom.id))[0].state).toBe("renewing_upstream");
    expect(h.stripe.created.refunds).toBe(0);
    // Two days before expiry it still tries; nothing is refunded before E-1.
    const e = new Date(term.term_end);
    at(h, new Date(e.getTime() - 2 * 24 * 3600_000)); await settle(h);
    expect((await renewOrders(h, dom.id))[0].state).toBe("renewing_upstream");
    expect(h.stripe.created.refunds).toBe(0);
    const attemptsBeforeE1 = h.registrar.calls.renew;
    // E-1 with the name still unrenewed: full refund, no more attempts.
    at(h, new Date(e.getTime() - 24 * 3600_000 + 60_000)); await settle(h);
    const after = (await renewOrders(h, dom.id))[0];
    expect(after.state).toBe("refunded");
    expect(h.stripe.created.refunds).toBe(1);
    const pay = (await h.app.db.owner.query("select * from payments where order_id = $1", [after.id])).rows[0];
    expect(BigInt(pay.refunded_minor)).toBe(BigInt(pay.amount_minor));
    expect((await termRow(h, dom.id)).state).toBe("refunded");
    expect(h.registrar.calls.renew).toBe(attemptsBeforeE1);
    const pending = (await h.registrar.getOrdersByDomain(dom.fqdn)).filter((u) => u.type === "renew" && (u.status === "pending" || u.status === "waiting"));
    expect(pending).toHaveLength(0);
    expect(mailOf(h, "renewal_refunded")).toHaveLength(1);
    at(h, new Date(e.getTime() + 3600_000)); await settle(h);
    expect(h.registrar.calls.renew).toBe(attemptsBeforeE1);
    expect(h.stripe.created.refunds).toBe(1);
  }, 180_000);

  it("recovers on its own: when the registrar answers again the renewal completes, the page closes and nothing is refunded", async () => {
    const { h, dom } = await mandated("st110b");
    const term = await termRow(h, dom.id);
    const t0 = new Date(new Date(term.charge_at).getTime() + 60_000);
    at(h, t0);
    h.registrar.faults.set("renewDraft", { fqdn: dom.fqdn, times: 2 });
    await settle(h);
    expect((await renewOrders(h, dom.id))[0].state).toBe("renewing_upstream");
    at(h, new Date(t0.getTime() + 15 * 60_000)); await settle(h);
    expect((await renewOrders(h, dom.id))[0].state).toBe("renewing_upstream");
    at(h, new Date(t0.getTime() + 30 * 60_000)); await settle(h);
    expect((await renewOrders(h, dom.id))[0].state).toBe("renewed");
    expect(h.stripe.created.refunds).toBe(0);
    expect(await alertRows(h, "renewal_upstream_failed")).toHaveLength(0);
    // The renewed term, not the newest one: a sync after the renewal correctly schedules next year's term.
    expect((await h.app.db.owner.query("select state from renewal_terms where id = $1", [term.id])).rows[0].state).toBe("renewed");
  });

  it("refunds on request while unrenewed, at once, and cancels the upstream draft first", async () => {
    const { h, o, dom } = await mandated("st110c");
    const t0 = new Date(new Date((await termRow(h, dom.id)).charge_at).getTime() + 60_000);
    at(h, t0);
    h.registrar.faults.set("insufficientFunds", { fqdn: dom.fqdn });   // accepted upstream but waiting on funds (forced pending)
    await settle(h);
    const order = (await renewOrders(h, dom.id))[0];
    expect(order.state).toBe("renewing_upstream");
    expect((await h.registrar.getOrdersByDomain(dom.fqdn)).filter((u) => u.type === "renew" && u.status === "pending")).toHaveLength(1);
    const res = await h.app.call("POST", `/api/v1/orders/${order.id}/refund`, { cookie: (await relogin(h, o)).cookie, body: {} });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.state).toBe("refunded");
    expect((await h.registrar.getOrdersByDomain(dom.fqdn)).filter((u) => u.type === "renew" && (u.status === "pending" || u.status === "waiting"))).toHaveLength(0);
    // Late funds cannot complete a cancelled renewal.
    const before = (await h.registrar.getDomain(dom.fqdn))!.expiresAt!.getTime();
    h.registrar.topUp(1_000_000n);
    at(h, new Date(t0.getTime() + 3600_000)); await settle(h);
    expect((await h.registrar.getDomain(dom.fqdn))!.expiresAt!.getTime()).toBe(before);
  });
});

describe("the decline ladder (C-38) and the price cap (C-33)", () => {
  it("a declined card is tried on the charge day, C+3 and C+6, the person is told each time, and nothing renews", async () => {
    const { h, o, dom } = await mandated("ladder", "dev", { pay: { paymentMethod: "pm_declined_ladder" } });
    const c = new Date((await termRow(h, dom.id)).charge_at);
    const calls = () => h.stripe.calls.createOffSessionPaymentIntent ?? 0;
    at(h, new Date(c.getTime() + 60_000)); await settle(h);
    expect(calls()).toBe(1);
    expect(mailOf(h, "renewal_failed")).toHaveLength(1);
    expect(mailOf(h, "renewal_failed")[0]!.text).toContain(new Date(c.getTime() + days(3)).toISOString().slice(0, 10));
    at(h, new Date(c.getTime() + days(1))); await settle(h);
    expect(calls()).toBe(1);
    at(h, new Date(c.getTime() + days(3) + 60_000)); await settle(h);
    expect(calls()).toBe(2);
    at(h, new Date(c.getTime() + days(6) + 60_000)); await settle(h);
    expect(calls()).toBe(3);
    expect(mailOf(h, "renewal_failed")).toHaveLength(3);
    expect(mailOf(h, "renewal_failed")[2]!.text).toContain("will not try the card again");
    expect((await termRow(h, dom.id)).state).toBe("payment_failed");
    at(h, new Date(c.getTime() + days(8))); await settle(h);
    expect(calls()).toBe(3);
    expect(h.registrar.calls.renew).toBe(0);
    // Three tries, three keys: a new key only after a determined failure.
    const keys = h.stripe.keysUsed.filter((k) => k.method === "createOffSessionPaymentIntent").map((k) => k.key);
    expect(new Set(keys).size).toBe(3);
    // The name shows as needing attention, and Renew now does not charge the declined card again: it opens Stripe Checkout, where any
    // card can pay (docs/AUDIT-2026-10-07.md O7).
    const o2 = await relogin(h, o);
    const view = await h.app.call("GET", `/api/v1/domains/${dom.id}`, { cookie: o2.cookie });
    expect(view.json.state).toBe("attention");
    const click = await postRenew(h, o2, dom.id);
    expect(click.status, JSON.stringify(click.json)).toBe(200);
    expect(click.json.status).toBe("checkout"); expect(click.json.checkout_url).toMatch(/^https:\/\//);
    expect(calls()).toBe(3);
  });

  it("a price above the mandate's ceiling is held until the person signs again; the change is emailed when first seen and 21 days before the charge", async () => {
    // .com wholesale rises from 14.50 to 15.25 on 2026-11-01 (price table): a name bought now renews at the higher price.
    const { h, o, dom } = await mandated("cap", "com");
    const mandate = (await h.app.db.owner.query("select price_ceiling_minor from renewal_mandates where domain_id = $1 and revoked_at is null", [dom.id])).rows[0];
    expect(BigInt(mandate.price_ceiling_minor)).toBe(1750n);
    const e = await expiry(h, dom.id);
    at(h, new Date(e.getTime() - days(44))); await settle(h);
    at(h, new Date(e.getTime() - days(44) + 3600_000 * 2)); await settle(h);
    const known = mailOf(h, "price_change_notice").filter((m) => m.text.includes("changes from USD 17.50 to USD 18.25"));
    expect(known.length).toBeGreaterThanOrEqual(1);
    expect(known[0]!.text).toContain("above the limit you set");
    expect(known[0]!.text).toMatch(/\/api\/v1\/email-actions\/[A-Za-z0-9_-]{43}/);
    // Twenty-one days before the charge the reminder repeats it.
    at(h, new Date(e.getTime() - days(31) + 3600_000)); await settle(h);
    at(h, new Date(e.getTime() - days(31) + 3 * 3600_000)); await settle(h);
    expect(mailOf(h, "price_change_notice").some((m) => m.text.startsWith("In 21 days"))).toBe(true);
    // The charge day: held, nothing charged.
    at(h, new Date(e.getTime() - days(10) + 60_000)); await settle(h);
    expect(h.stripe.calls.createOffSessionPaymentIntent ?? 0).toBe(0);
    expect(await renewOrders(h, dom.id)).toHaveLength(0);
    const t = await termRow(h, dom.id);
    expect(t.state).toBe("held"); expect(t.held_reason).toBe("above_cap");
    // The person turns it off and signs again at the new price; the next pass charges the new price.
    const o2 = await relogin(h, o);
    expect((await h.app.call("DELETE", `/api/v1/domains/${dom.id}/auto-renew`, { cookie: o2.cookie, body: {} })).status).toBe(200);
    await autoRenewOn(h, o2, dom.id);
    at(h, new Date(e.getTime() - days(10) + 20 * 60_000)); await settle(h);
    const orders = await renewOrders(h, dom.id);
    expect(orders.map((r) => r.state)).toEqual(["renewed"]);
    expect(renewPIs(h).at(-1)!.amount).toBe(1825);
  });
});

describe("review: a renewal paid on Checkout while an off-session charge for the same order is in flight is charged once", () => {
  /** Every succeeded PaymentIntent for the order, with what is still kept after refunds. */
  const kept = (h: DomainsHarness, orderId: string) => [...h.stripe.paymentIntents.values()]
    .filter((p) => p.metadata.order_id === orderId && p.status === "succeeded")
    .map((p) => ({ id: p.id, kept: p.amount_received - [...h.stripe.refunds.values()].filter((r) => r.payment_intent === p.id).reduce((a, r) => a + r.amount, 0) }));

  /**
   * A name with no card saved for off-session use: Renew now opens a Checkout (tab A). The person then buys another name with the
   * auto-renew box ticked, which saves a card, and presses Renew now again (tab B), which charges that card off-session.
   */
  async function checkoutThenCard(tag: string) {
    const h = await per.make();
    const o = await makeOwner(h, `${tag}@example.com`);
    const dom = await buyDomain(h, o, `free-${tag}.dev`, { autoRenew: false });
    const a = await postRenew(h, o, dom.id);
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.status).toBe("checkout");
    const orderId = a.json.order_id as string;
    await buyDomain(h, o, `free-${tag}-b.dev`);                 // auto-renew ticked: the card is saved
    const sessionId = (await h.app.db.owner.query("select stripe_checkout_session_id from orders where id = $1", [orderId])).rows[0].stripe_checkout_session_id as string;
    return { h, o, dom, orderId, sessionId };
  }

  it("the Checkout webhook lands while the off-session request is in flight: one charge is kept, the other is refunded and an operator is told", async () => {
    const { h, o, orderId, sessionId, dom } = await checkoutThenCard("race1");
    const paid = h.stripe.payCheckout(sessionId);                   // tab A pays; the webhook is on its way
    const orig = h.stripe.createOffSessionPaymentIntent.bind(h.stripe);
    let delivered = false;
    h.stripe.createOffSessionPaymentIntent = async (input, key) => {
      const pi = await orig(input, key);
      if (!delivered && input.metadata.order_id === orderId) { delivered = true; for (const ev of paid) await deliver(h, ev); }
      return pi;
    };
    const b = await postRenew(h, await relogin(h, o), dom.id);   // tab B
    expect([200, 202, 409]).toContain(b.status);
    expect(delivered).toBe(true);
    await settle(h);
    const pis = kept(h, orderId);
    expect(pis).toHaveLength(2);                                     // Stripe took two payments for one term...
    expect(pis.filter((p) => p.kept > 0)).toHaveLength(1);          // ...and exactly one is kept
    const keptPi = pis.find((p) => p.kept > 0)!;
    const pays = (await h.app.db.owner.query("select stripe_payment_intent_id from payments where order_id = $1", [orderId])).rows;
    expect(pays.map((r) => r.stripe_payment_intent_id)).toEqual([keptPi.id]);
    expect((await h.app.db.owner.query("select state from orders where id = $1", [orderId])).rows[0].state).toBe("renewed");
    expect((await h.app.db.owner.query("select count(*)::int n from alerts where subject = $1 and kind in ('renewal_duplicate_charge','renewal_checkout_after_close')", [orderId])).rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("the off-session request timed out but was applied, then the Checkout is paid: the unanswered charge is settled first and only one payment is kept", async () => {
    const { h, o, orderId, sessionId, dom } = await checkoutThenCard("race2");
    h.stripe.fail("createOffSessionPaymentIntent", { kind: "timeout" });   // applied at Stripe, the answer never arrives
    const b = await postRenew(h, await relogin(h, o), dom.id);
    expect(b.status, JSON.stringify(b.json)).toBe(202);
    expect(kept(h, orderId)).toHaveLength(1);
    for (const ev of h.stripe.payCheckout(sessionId)) await deliver(h, ev);
    at(h, new Date(h.app.clock.now().getTime() + 5 * 60_000));
    await settle(h);
    for (const ev of h.stripe.takeEvents()) await deliver(h, ev);   // a redelivered webhook changes nothing
    await settle(h);
    const pis = kept(h, orderId);
    expect(pis).toHaveLength(2);
    expect(pis.filter((p) => p.kept > 0)).toHaveLength(1);
    const pays = (await h.app.db.owner.query("select stripe_payment_intent_id from payments where order_id = $1", [orderId])).rows;
    expect(pays.map((r) => r.stripe_payment_intent_id)).toEqual([pis.find((p) => p.kept > 0)!.id]);
    expect((await h.app.db.owner.query("select state from orders where id = $1", [orderId])).rows[0].state).toBe("renewed");
    expect(h.registrar.calls.renew).toBe(1);
  });
});

void sha256; void makeDomainsHarness; void signMandate; void AUTH_TEXT_HASH;

describe("AUD-P3: a renewal is never charged below the registrar's live renewal price (docs/AUDIT-2026-10-07.md)", () => {
  it("the registrar now charges more than the table: held with price_check, nothing charged, one page per extension; a table row matching the registrar releases it", async () => {
    const { h, dom } = await mandated("pricecheck");
    const table = BigInt((await termRow(h, dom.id)).current_wholesale_minor);
    h.registrar.overrideQuote(dom.fqdn, table + 100n);              // an upstream rise nobody has entered yet
    at(h, new Date((await chargeDay(h, dom.id)).getTime() + 60_000));
    await settle(h);
    expect(renewPIs(h)).toHaveLength(0);
    expect(h.registrar.calls.renew).toBe(0);
    const t = await termRow(h, dom.id);
    expect([t.state, t.held_reason]).toEqual(["held", "price_check"]);
    expect((await alertRows(h, "renewal_price_check")).map((a) => a.subject)).toEqual(["dev"]);
    // The registrar's price falls back to the table (or the operator adds the matching dated row): the next pass charges.
    h.registrar.overrideQuote(dom.fqdn, table);
    at(h, new Date((await chargeDay(h, dom.id)).getTime() + 2 * 3600_000));
    await settle(h);
    expect((await renewOrders(h, dom.id)).map((r) => r.state)).toEqual(["renewed"]);
  });

  it("a registrar price below the table does not hold: the customer pays the announced table price", async () => {
    const { h, dom } = await mandated("pricebelow");
    const table = BigInt((await termRow(h, dom.id)).current_wholesale_minor);
    h.registrar.overrideQuote(dom.fqdn, table - 50n);
    at(h, new Date((await chargeDay(h, dom.id)).getTime() + 60_000));
    await settle(h);
    expect((await renewOrders(h, dom.id)).map((r) => r.state)).toEqual(["renewed"]);
  });
});
