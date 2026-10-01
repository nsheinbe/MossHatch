import { tx, withUser, type PoolClient } from "@mosshatch/db";
import { HttpError } from "../http/router.ts";
import type { AppContext } from "../ports.ts";
import { RegistrarError } from "@mosshatch/registrar/port";
import { hit } from "../ratelimit.ts";
import { appendAudit } from "../audit.ts";
import { base32, base62, hashOf, randomBytes } from "../util/bytes.ts";
import { PricingError, quoteToJson } from "../pricing/index.ts";
import { parseFqdn } from "../search/labels.ts";
import { StripeError, type CheckoutSession, type CreateSessionInput } from "../stripe/port.ts";
import { SELL_GATE_MIN_FUNDS_MINOR, SESSION_TTL_MS, type OrderRow, type OrdersServices } from "./types.ts";
import { loadOrder, ordersSvc, rowToOrder } from "./support.ts";
import { modeProblem } from "./wiring.ts";
import { reservedRenewalsMinor } from "../domains/gate.ts";
import { ModeError, refuseSampleAtLiveCheckout } from "../config/modeguard.ts";
import { operationForOrderKind } from "../stripe/catalog.ts";
import { preCheckoutRegionGate } from "./tax.ts";

export const RESERVING_STATES = ["review_hold", "authorized", "registering", "outcome_unknown", "registrar_unavailable", "paid_before_registration"];
export const PAUSED_MESSAGE = "Registration is paused for a short while. Nothing was charged.";
export const MAINTENANCE_MESSAGE = "Registrations are paused while our registrar is in maintenance. Nothing was charged.";

export interface CreateOrderInput {
  userId: string;
  fqdn: unknown;
  years: unknown;
  idempotencyKey: string;
  ipPrefix: string;
  uaFamily: string;
  /** Set when a passkey-approved agent purchase creates the order: the assertion is the acceptance. */
  assertionActionId?: string;
  agentRequestId?: string;
  /** The document hashes the person was shown and accepted: `{terms, registration_agreement}`. Required unless a passkey assertion carries the acceptance. */
  accept?: unknown;
  /**
   * The auto-renew box at checkout, unticked by default and separate from the terms box (C-31, D-024). `true` asks Stripe to save the
   * card (`setup_future_usage=off_session`) and needs `accept.auto_renew_authorisation` = the hash of the authorisation text shown.
   * The mandate itself is still signed with a passkey on the domain page (`mandate.sign`).
   */
  autoRenew?: unknown;
}

/** Extensions whose registry terms the buyer accepts as a separate addendum at checkout (C-59 .ai, C-60 .io). */
export const TLD_ADDENDA: Record<string, string> = { ai: "tld_addendum_ai", io: "tld_addendum_io" };
export interface CreateOrderResult { order: OrderRow; checkoutUrl: string | null; replay: boolean }

const REGISTER_ROW_UNIQUE = "orders_user_id_idempotency_key_key";
const RETAIN_CONSENT_MS = 7 * 365 * 24 * 3600_000;

/**
 * POST /orders. The client supplies a domain and a term and nothing else: the price comes from the frozen server quote,
 * so a client-supplied price is never read (ST-97). One order per (user, Idempotency-Key): the same parameters replay
 * the same order and the same Checkout Session, other parameters are a 409.
 */
export async function createOrder(ctx: AppContext, input: CreateOrderInput): Promise<CreateOrderResult> {
  const svc = ordersSvc(ctx);
  const problem = modeProblem(ctx, svc);
  if (problem) throw new HttpError(503, "mode_inconsistent");
  if (!/^[\x21-\x7e]{1,200}$/.test(input.idempotencyKey)) throw new HttpError(400, "idempotency_key_required");
  const parsed = typeof input.fqdn === "string" ? parseFqdn(input.fqdn) : null;
  if (!parsed) throw new HttpError(422, "invalid_fqdn");
  if (typeof input.years !== "number" || !Number.isInteger(input.years) || input.years < 1 || input.years > 10) throw new HttpError(422, "invalid_term");
  const fqdn = `${parsed.label}.${parsed.tld}`;
  const years = input.years;
  if (input.autoRenew !== undefined && typeof input.autoRenew !== "boolean") throw new HttpError(422, "invalid_request");
  const autoRenew = input.autoRenew === true;
  // The opt-in is part of the request: the same key with the box ticked differently is a different request.
  const requestHash = hashOf(autoRenew ? { fqdn, years, auto_renew: true } : { fqdn, years });

  const replayOf = async (): Promise<CreateOrderResult | null> => {
    const row = (await withUser(ctx.runtime, input.userId, (c) => c.query("select * from orders where user_id = $1 and idempotency_key = $2", [input.userId, input.idempotencyKey]))).rows[0];
    if (!row) return null;
    if (!Buffer.from(row.request_hash).equals(requestHash)) throw new HttpError(409, "idempotency_key_reuse");
    const order = rowToOrder(row);
    return { order, checkoutUrl: (await ensureSession(ctx, svc, order)).url, replay: true };
  };
  const early = await replayOf();
  if (early) return early;

  // Gates that need no order row. Nothing is created when one of them refuses.
  const now = ctx.clock.now();
  await withUser(ctx.runtime, input.userId, async (c) => {
    const u = (await c.query("select status, email_verified_at, frozen_at from users where id = $1", [input.userId])).rows[0];
    if (!u || u.status !== "active") throw new HttpError(403, "account_inactive");
    if (!u.email_verified_at) throw new HttpError(403, "email_unverified");
    if (u.frozen_at) throw new HttpError(403, "account_frozen");
    if ((await c.query("select value from flags where name = 'orders_paused'")).rows[0]?.value === true) throw new HttpError(503, "orders_paused", PAUSED_MESSAGE);
    const perUser = await hit(ctx, c, `orders:user:${input.userId}`, { bucket: "orders_create_user", max: 20, windowSeconds: 3600 });
    const perIp = await hit(ctx, c, `orders:ip:${input.ipPrefix}`, { bucket: "orders_create_ip", max: 60, windowSeconds: 3600 });
    if (!perUser.allowed || !perIp.allowed) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(Math.max(perUser.retryAfterSeconds, perIp.retryAfterSeconds)) });
    // C-42: the tax-region gate, before any Stripe call (the authoritative check on the Checkout address runs at authorization).
    await preCheckoutRegionGate(c, input.userId);
  });

  let priced;
  try { priced = await withUser(ctx.runtime, input.userId, (c) => svc.pricing.quote(ctx, c, { fqdn, years }, now)); }
  catch (e) {
    if (e instanceof PricingError) {
      if (e.code === "premium_refused" || e.code === "price_mismatch") throw new HttpError(422, "price_not_standard");
      if (e.code === "no_price") throw new HttpError(503, "orders_paused", PAUSED_MESSAGE);
      throw new HttpError(422, e.code === "invalid_term" ? "invalid_term" : e.code === "unsupported_tld" ? "unsupported_tld" : "invalid_fqdn");
    }
    throw e;
  }
  // Checkout refuses a sample amount when livemode is true (plan 4.3b Environments).
  if (ctx.config.livemode && svc.registrar.capabilities().mode !== "live") throw new HttpError(503, "mode_inconsistent");

  let avail, funds;
  try {
    avail = await svc.registrar.checkAvailability(fqdn, { noCache: true });
    funds = await svc.registrar.getFundingStatus();
  } catch (e) {
    // Maintenance or an outage: no order is taken, and nothing is charged.
    if (e instanceof RegistrarError && (e.kind === "maintenance" || e.kind === "unavailable" || e.kind === "rate_limited")) throw new HttpError(503, "registrar_unavailable", MAINTENANCE_MESSAGE);
    throw e;
  }
  if (avail.kind !== "available") throw new HttpError(409, "name_unavailable");
  // Checkout refuses a sample amount when livemode is true: the registrar's own money and availability carry their source.
  try { refuseSampleAtLiveCheckout(avail, ctx.config.livemode); } catch (e) { if (e instanceof ModeError) throw new HttpError(503, "sample_price_in_live"); throw e; }

  const created = await withUser(ctx.runtime, input.userId, async (c) => {
    const verdict = await svc.compliance.check(ctx, c, { userId: input.userId, fqdn, wholesaleMinor: priced.wholesaleMinor, subtotalMinor: priced.subtotalMinor });
    if (!verdict.ok) throw new HttpError(verdict.status, verdict.code, verdict.status === 503 ? PAUSED_MESSAGE : undefined);
    // Sell gate: available funds minus reserved wholesale (including this order) must stay above the floor.
    if (funds !== "unsupported") {
      const floor = BigInt(((await c.query("select value from flags where name = 'sell_gate.min_funds_minor'")).rows[0]?.value as number | undefined) ?? Number(SELL_GATE_MIN_FUNDS_MINOR));
      const reserved = BigInt((await ctx.cron.query("select coalesce(sum((quote->>'wholesale_minor')::bigint), 0)::text as s from orders where kind = 'register' and state = any($1)", [RESERVING_STATES])).rows[0].s);
      // Renewals rank ahead of new registrations (ST-109): what is already promised to renewals comes off first.
      const renewals = await reservedRenewalsMinor(ctx.cron, now);
      if (funds.minor - renewals - reserved - priced.wholesaleMinor < floor) throw new HttpError(503, "sell_gate", PAUSED_MESSAGE);
    }
    if (!(await svc.registrant(ctx, input.userId))) throw new HttpError(422, "contact_required");
    const addendumKind = TLD_ADDENDA[parsed.tld];
    const docs = (await c.query(
      `select distinct on (kind) kind, version_hash from document_versions where kind = any($1) and effective_at <= $2 and (retired_at is null or retired_at > $2) order by kind, effective_at desc`,
      [["terms", "registration_agreement", "auto_renew_authorisation", ...(addendumKind ? [addendumKind] : [])], now])).rows;
    const terms = docs.find((d) => d.kind === "terms"), agreement = docs.find((d) => d.kind === "registration_agreement");
    const addendum = addendumKind ? docs.find((d) => d.kind === addendumKind) : undefined;
    const authorisation = docs.find((d) => d.kind === "auto_renew_authorisation");
    if (!terms || !agreement) throw new HttpError(503, "documents_unavailable");
    // .ai and .io are sold only with their registry terms published and accepted (two-year .ai term, .io registry rules and sovereignty risk).
    if (addendumKind && !addendum) throw new HttpError(503, "documents_unavailable");
    if (autoRenew && !authorisation) throw new HttpError(503, "documents_unavailable");
    const a = (input.accept && typeof input.accept === "object" ? input.accept : {}) as Record<string, unknown>;
    if (!input.assertionActionId && !input.agentRequestId) {
      // C-12 and C-14: acceptance is an explicit act on the exact documents in force, recorded per registration.
      if (a.terms !== terms.version_hash || a.registration_agreement !== agreement.version_hash) throw new HttpError(422, "terms_not_accepted");
      if (addendum && a[addendumKind!] !== addendum.version_hash) throw new HttpError(422, "tld_terms_not_accepted");
    }
    // The auto-renew consent is its own act on its own text (C-31, C-38), never implied by the terms: an agent path cannot give it.
    if (autoRenew && (input.agentRequestId || a.auto_renew_authorisation !== authorisation!.version_hash)) throw new HttpError(422, "auto_renew_consent_required");

    const id = (await c.query("select uuidv7() as id")).rows[0].id as string;
    const regUsername = "mh" + base32(randomBytes(9)).toLowerCase().slice(0, 14);
    const regPassword = base62(18);
    const ipEnc = await ctx.pii.encrypt(input.ipPrefix, `order_ip:${id}`);
    const ins = await c.query(
      `insert into orders (id, user_id, kind, fqdn_ascii, years, state, idempotency_key, request_hash, quote, subtotal_minor, tax_ceiling_minor, total_minor, attempt, reg_username, checkout_ip_enc, livemode, agent_request_id, created_at, save_card, auto_renew_opt_in)
       values ($1,$2,'register',$3,$4,'checkout_open',$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14,$15,$16,$16)
       on conflict (user_id, idempotency_key) do nothing returning *`,
      [id, input.userId, fqdn, years, input.idempotencyKey, requestHash, quoteToJson(priced), priced.subtotalMinor, priced.taxCeilingMinor, priced.totalMinor, regUsername, ipEnc, ctx.config.livemode, input.agentRequestId ?? null, now, autoRenew]);
    if (ins.rowCount === 0) return null;                       // lost the race to a twin request: replay below
    // The upstream profile is generated and stored BEFORE any registrar call.
    await c.query("insert into registrar_profiles (order_id, username, password_enc) values ($1,$2,$3)", [id, regUsername, await ctx.pii.encrypt(regPassword, `registrar_profile:${id}`)]);
    const accepted: [string, { version_hash: string }][] = [["terms", terms], ["registration_agreement", agreement]];
    if (addendum) accepted.push(["tld_addendum", addendum]);
    if (autoRenew) accepted.push(["auto_renew_mandate", authorisation!]);
    for (const [kind, doc] of accepted) {
      await c.query(
        "insert into consents (user_id, kind, document_hash, version, accepted_at, ip_enc, ua_family, assertion_action_id, order_id, actor_kind, retain_until) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'user',$10)",
        [input.userId, kind, doc.version_hash, doc.version_hash.slice(0, 12), now, ipEnc, input.uaFamily, input.assertionActionId ?? null, id, new Date(now.getTime() + RETAIN_CONSENT_MS)]);
    }
    // Write-ahead record of the Checkout Session, holding the exact expiry so a replay sends identical parameters.
    const expiresAt = Math.floor((now.getTime() + SESSION_TTL_MS) / 1000);
    await c.query("insert into order_operations (order_id, kind, seq, request_hash, state, detail) values ($1,'checkout_session',1,$2,'intent',$3)", [id, hashOf({ order: id, attempt: 1 }), { expires_at: expiresAt }]);
    await c.query("insert into order_events (order_id, from_state, to_state, cause, detail, at) values ($1,null,'checkout_open',$2,$3,$4)", [id, input.agentRequestId ? "agent" : "user", { years }, now]);
    await appendAudit(ctx, c, { chainId: input.userId, actorKind: "user", actorId: input.userId, action: "order.created", resourceKind: "order", resourceId: id, detail: { years } });
    return rowToOrder(ins.rows[0]);
  });
  if (!created) {
    const again = await replayOf();
    if (again) return again;
    throw new HttpError(409, "request_in_progress");
  }
  return { order: created, checkoutUrl: (await ensureSession(ctx, svc, created)).url, replay: false };
}

/** The Stripe customer for a user, created once under the idempotency key `cust:{user}`. */
export async function ensureCustomer(ctx: AppContext, svc: OrdersServices, userId: string): Promise<string> {
  const have = (await ctx.cron.query("select stripe_customer_id from stripe_customers where user_id = $1 and livemode = $2 order by created_at limit 1", [userId, svc.stripe.livemode])).rows[0];
  if (have) return have.stripe_customer_id as string;
  const cust = await svc.stripe.createCustomer({ userId }, `cust:${userId}`);
  await ctx.cron.query("insert into stripe_customers (user_id, stripe_customer_id, livemode) values ($1,$2,$3) on conflict (stripe_customer_id) do nothing", [userId, cust.id, cust.livemode]);
  return cust.id;
}

/** The Session parameters are a pure function of the order and its stored expiry, so a replay under the same key is byte-identical. */
export function sessionInputFor(ctx: AppContext, o: OrderRow, customer: string, expiresAt: number, priorOrders: number): CreateSessionInput {
  return {
    customer,
    clientReferenceId: o.id,
    successUrl: `${ctx.config.origin}/checkout/return?order=${o.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${ctx.config.origin}/checkout/cancelled?order=${o.id}`,
    expiresAt,
    metadata: { order_id: o.id, attempt: String(o.attempt) },
    lineItem: { name: `${o.fqdn} for ${o.years} ${o.years === 1 ? "year" : "years"}`, unitAmount: Number(o.subtotalMinor), currency: "usd", operation: operationForOrderKind(o.kind) },
    captureMethod: "manual",
    // 3-D Secure for an account's first two orders and any order over USD 100 (own targets).
    requestThreeDSecure: priorOrders < 2 || o.totalMinor > 10_000n ? "any" : "automatic",
    ...(o.saveCard ? { setupFutureUsage: "off_session" as const } : {}),
  };
}

async function checkoutOp(q: Pick<PoolClient, "query">, orderId: string, attempt: number) {
  const r = await q.query("select * from order_operations where order_id = $1 and kind = 'checkout_session' and seq = $2", [orderId, attempt]);
  return r.rows[0] as { id: string; detail: { expires_at: number } | null } | undefined;
}

/** Create (or replay) the one hosted Checkout Session for the order's current attempt and return its URL. */
export async function ensureSession(ctx: AppContext, svc: OrdersServices, order: OrderRow, depth = 0): Promise<{ url: string | null; session: CheckoutSession | null }> {
  if (order.state !== "checkout_open") return { url: null, session: null };
  if (order.sessionId) {
    const s = await svc.stripe.retrieveSession(order.sessionId);
    return { url: s.status === "open" ? s.url : null, session: s };
  }
  const op = await checkoutOp(ctx.cron, order.id, order.attempt);
  const expiresAt = op?.detail?.expires_at;
  const nowSec = Math.floor(ctx.clock.now().getTime() / 1000);
  // Stripe wants at least 30 minutes; a stale intent means a new attempt (new key, fresh expiry).
  if (!op || !expiresAt || expiresAt - nowSec < 30 * 60 + 5) {
    if (depth > 0) throw new HttpError(503, "payment_unavailable");
    const next = await restartCheckout(ctx, svc, order.id);
    return next ? ensureSession(ctx, svc, next, depth + 1) : { url: null, session: null };
  }
  const prior = (await ctx.cron.query("select count(*)::int as n from orders where user_id = $1 and authorized_at is not null", [order.userId])).rows[0].n as number;
  let session: CheckoutSession;
  try {
    const customer = order.stripeCustomerId ?? await ensureCustomer(ctx, svc, order.userId);
    session = await svc.stripe.createCheckoutSession(sessionInputFor(ctx, order, customer, expiresAt, prior), `cs:${order.id}:${order.attempt}`);
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    if (e.kind === "idempotency_in_progress" && depth < 5) {
      // A twin request is creating the same Session right now: wait for it to store the id, then read it.
      await new Promise((r) => setTimeout(r, 40));
      const fresh = await loadOrder(ctx.cron, order.id);
      return fresh ? ensureSession(ctx, svc, fresh, depth + 1) : { url: null, session: null };
    }
    if (e.kind === "idempotency_error" && depth === 0) {
      const next = await restartCheckout(ctx, svc, order.id);
      return next ? ensureSession(ctx, svc, next, depth + 1) : { url: null, session: null };
    }
    throw new HttpError(503, "payment_unavailable");
  }
  const stored = await tx(ctx.cron, async (c) => {
    const r = await c.query("update orders set stripe_checkout_session_id = $2, stripe_customer_id = $3 where id = $1 and state = 'checkout_open' and attempt = $4 and stripe_checkout_session_id is null", [order.id, session.id, session.customer, order.attempt]);
    if (r.rowCount === 1) await c.query("update order_operations set state = 'resolved', response_code = 'created', sent_at = $2, detail = detail || $3::jsonb where order_id = $1 and kind = 'checkout_session' and seq = $4", [order.id, ctx.clock.now(), { session_id: session.id }, order.attempt]);
    return r.rowCount === 1;
  });
  if (!stored) {
    const fresh = await loadOrder(ctx.cron, order.id);
    if (fresh?.sessionId === session.id) return { url: session.url, session };
    // The order moved on (or a twin stored a different Session for this attempt): the caller reads the order's current state.
    return { url: null, session };
  }
  return { url: session.url, session };
}

/**
 * A new attempt: same order, new idempotency key `cs:{order}:{attempt}`. The previous Session is expired; if the customer just
 * paid it, expiry fails and the stray-attempt sweep later cancels whichever PaymentIntent is not the current attempt's.
 */
export async function restartCheckout(ctx: AppContext, svc: OrdersServices, orderId: string): Promise<OrderRow | null> {
  const before = await loadOrder(ctx.cron, orderId);
  if (!before || before.state !== "checkout_open") return before;
  const now = ctx.clock.now();
  const expiresAt = Math.floor((now.getTime() + SESSION_TTL_MS) / 1000);
  const next = await tx(ctx.cron, async (c) => {
    const r = await c.query("update orders set attempt = attempt + 1, stripe_checkout_session_id = null where id = $1 and state = 'checkout_open' and attempt = $2 returning *", [orderId, before.attempt]);
    if (!r.rows[0]) return null;
    const row = rowToOrder(r.rows[0]);
    // The old Session id stays on record in its attempt's operation row so the stray-attempt sweep can find it.
    if (before.sessionId) await c.query("update order_operations set detail = coalesce(detail,'{}'::jsonb) || $3::jsonb where order_id = $1 and kind = 'checkout_session' and seq = $2", [orderId, before.attempt, { session_id: before.sessionId }]);
    await c.query("insert into order_operations (order_id, kind, seq, request_hash, state, detail) values ($1,'checkout_session',$2,$3,'intent',$4)", [orderId, row.attempt, hashOf({ order: orderId, attempt: row.attempt }), { expires_at: expiresAt }]);
    await c.query("insert into order_events (order_id, from_state, to_state, cause, detail, at) values ($1,'checkout_open','checkout_open','system',$2,$3)", [orderId, { new_attempt: row.attempt }, now]);
    return row;
  });
  if (!next) return loadOrder(ctx.cron, orderId);
  if (before.sessionId) {
    try { await svc.stripe.expireSession(before.sessionId, `expire:${orderId}:${before.attempt}`); }
    catch (e) { if (!(e instanceof StripeError) || e.kind !== "invalid_request") throw e; }
  }
  return loadOrder(ctx.cron, orderId);
}
