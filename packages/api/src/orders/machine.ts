import crypto from "node:crypto";
import { tx, type PoolClient } from "@mosshatch/db";
import { RegistrarError } from "@mosshatch/registrar/port";
import { claimRegistration, registrantFingerprint } from "@mosshatch/registrar/mock-port";
import { PricingError } from "../pricing/index.ts";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { enqueue } from "../jobs/registry.ts";
import { LeaseLostError } from "../jobs/engine.ts";
import { hashOf } from "../util/bytes.ts";
import { StripeError, type PaymentIntent } from "../stripe/port.ts";
import {
  ADD_GRACE_DEADLINE_MS, CAPTURE_RETRY_WINDOW_MS, FALLBACK_AUTH_WINDOW_MS, LATE_WATCH_MS, MIN_AUTH_WINDOW_MS, PAY_LINK_MS, SWEEP_UNKNOWN_AFTER_MS,
  type OrderRow, type OrderState, type OrdersServices, type VoidReason,
} from "./types.ts";
import { alert, backoffMs, loadOrder, mailCustomer, mailReceipt, mailVoid, ordersSvc, rowToOrder } from "./support.ts";

/**
 * The order state machine (plan 4.3b "Order state machine"). Every transition is a conditional update inside a
 * transaction that also writes `order_events` (and an audit row); every network call happens OUTSIDE a transaction,
 * after the intent that authorizes it has committed. Registrar writes go through `order_operations`: the row moves
 * intent -> sent in one conditional update before the call, so exactly one worker ever sends, and a `sent` operation
 * is only ever reconciled, never re-sent.
 */
export interface M {
  ctx: AppContext; svc: OrdersServices; attemptId?: string;
  /** When a job drives the machine: every write transaction first takes a share lock on the job row, so a job that outlived its lease cannot commit. */
  lease?: { jobId: string; attemptId: string };
}
export const machine = (ctx: AppContext, opts: { attemptId?: string; jobId?: string } = {}): M => ({
  ctx, svc: ordersSvc(ctx), attemptId: opts.attemptId, lease: opts.jobId && opts.attemptId ? { jobId: opts.jobId, attemptId: opts.attemptId } : undefined,
});
/** A write transaction as the cron role, fenced by the job lease when there is one. */
const ltx = <T>(m: M, fn: (c: PoolClient) => Promise<T>): Promise<T> => tx(m.ctx.cron, async (c) => {
  if (m.lease) {
    const ok = (await c.query("select job_lease_lock($1, $2, $3) as ok", [m.lease.jobId, m.lease.attemptId, m.ctx.clock.now()])).rows[0].ok as boolean;
    if (!ok) throw new LeaseLostError();
  }
  return fn(c);
});

type Cause = "webhook" | "job" | "user" | "agent" | "system";
type Step = "progressed" | "wait" | "done";
const OPEN_STATES: OrderState[] = ["checkout_open", "payment_failed", "review_hold", "authorized", "registering", "registered", "capturing", "capture_failed", "registrar_unavailable", "outcome_unknown", "registration_failed", "canceling", "paid_before_registration", "refund_pending"];
export const OPEN_ORDER_STATES = OPEN_STATES;
const now = (m: M) => m.ctx.clock.now();
const cron = (m: M) => m.ctx.cron;

/**
 * Customer mail goes out AFTER the state change commits, in its own transaction, and a mail failure never undoes money that
 * already moved: it raises a warning and the dedupe key lets the next pass send it.
 */
async function notify(m: M, o: OrderRow, fn: (c: PoolClient) => Promise<unknown>): Promise<void> {
  try { await tx(m.ctx.cron, fn); }
  catch (e) {
    try { await tx(m.ctx.cron, (c) => alert(m.ctx, c, { orderId: o.id, severity: "warn", kind: "mail_failed" })); } catch { /* the order state is already safe */ }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Transition primitive
// ---------------------------------------------------------------------------------------------------------------

export async function move(
  m: M, c: PoolClient, id: string, from: OrderState | OrderState[], to: OrderState, patch: Record<string, unknown>,
  ev: { cause: Cause; detail?: Record<string, unknown>; stripeEventId?: string },
): Promise<OrderRow | null> {
  const froms = Array.isArray(from) ? from : [from];
  const prev = (await c.query("select state, user_id from orders where id = $1 for update", [id])).rows[0] as { state: OrderState; user_id: string } | undefined;
  if (!prev || !froms.includes(prev.state)) return null;
  const cols = Object.keys(patch);
  for (const k of cols) if (!/^[a-z_]+$/.test(k)) throw new Error("bad column");
  const sets = ["state = $2", ...cols.map((k, i) => `${k} = $${i + 4}`)];
  const r = await c.query(`update orders set ${sets.join(", ")} where id = $1 and state = any($3::text[]) returning *`, [id, to, froms, ...cols.map((k) => patch[k])]);
  const row = r.rows[0];
  if (!row) return null;
  await c.query("insert into order_events (order_id, from_state, to_state, cause, stripe_event_id, detail, at) values ($1,$2,$3,$4,$5,$6,$7)",
    [id, prev.state, to, ev.cause, ev.stripeEventId ?? null, ev.detail ?? null, now(m)]);
  await appendAudit(m.ctx, c, {
    chainId: prev.user_id, actorKind: ev.cause === "user" ? "user" : ev.cause === "agent" ? "agent" : "system", actorId: ev.cause === "user" ? prev.user_id : undefined,
    action: `order.${to}`, resourceKind: "order", resourceId: id, detail: { from: prev.state, to, cause: ev.cause, ...(ev.detail ?? {}) },
  });
  // Wake-ups written in the same transaction as the state change, so a crash after commit cannot lose them.
  const wake = to === "registered" || to === "capturing" || to === "capture_failed" ? "order.capture" : to === "canceling" ? "order.cancel" : null;
  if (wake) await enqueue(c, { kind: wake, payload: { order_id: id }, userId: prev.user_id, dedupeKey: `${wake}:${id}`, priority: 0 });
  return rowToOrder(row);
}

// ---------------------------------------------------------------------------------------------------------------
// Operations (write-ahead records)
// ---------------------------------------------------------------------------------------------------------------

interface Op { id: string; seq: number; kind: string; state: "intent" | "sent" | "resolved"; sentAt: Date | null; responseCode: string | null; registrarOrderId: string | null; detail: Record<string, any> | null }
const opOf = (r: Record<string, any>): Op => ({ id: r.id, seq: r.seq, kind: r.kind, state: r.state, sentAt: r.sent_at ? new Date(r.sent_at) : null, responseCode: r.response_code, registrarOrderId: r.registrar_order_id, detail: r.detail });
async function latestOp(q: Pick<PoolClient, "query">, orderId: string, kind: string): Promise<Op | null> {
  const r = await q.query("select * from order_operations where order_id = $1 and kind = $2 order by seq desc limit 1", [orderId, kind]);
  return r.rows[0] ? opOf(r.rows[0]) : null;
}
async function insertIntent(c: PoolClient, orderId: string, kind: string, seq: number, requestHash: Buffer, detail?: Record<string, unknown>): Promise<Op | null> {
  const r = await c.query("insert into order_operations (order_id, kind, seq, request_hash, state, detail) values ($1,$2,$3,$4,'intent',$5) on conflict (order_id, kind, seq) do nothing returning *", [orderId, kind, seq, requestHash, detail ?? null]);
  return r.rows[0] ? opOf(r.rows[0]) : null;
}
const resolveOp = (c: PoolClient, id: string, code: string, extra: { registrarOrderId?: string; detail?: Record<string, unknown> } = {}) =>
  c.query("update order_operations set state = 'resolved', response_code = $2, registrar_order_id = coalesce($3, registrar_order_id), detail = coalesce(detail, '{}'::jsonb) || $4::jsonb where id = $1", [id, code, extra.registrarOrderId ?? null, extra.detail ?? {}]);

const keyFor = (kind: "capture" | "cancel" | "refund", orderId: string, seq: number, suffix = ""): string =>
  kind === "capture" ? (seq === 1 ? `cap:${orderId}` : `cap:${orderId}:${seq}`)
  : kind === "cancel" ? (seq === 1 ? `cancel:${orderId}${suffix}` : `cancel:${orderId}${suffix}:${seq}`)
  : `refund:${orderId}:${seq}`;

type StripeOpResult<T> = { ok: true; value: T } | { ok: false; err: StripeError };
/**
 * One Stripe write with a write-ahead operation. A `sent` operation (the call timed out, so the answer is unknown) is
 * retried under the SAME idempotency key, which replays the real result. After a determined failure (a 5xx that
 * Stripe caches under the key, or a 4xx) the next attempt gets a NEW operation and therefore a NEW key.
 */
async function stripeOp<T>(m: M, o: OrderRow, kind: "capture" | "cancel" | "refund", opKind: string, opts: { suffix?: string; detail?: Record<string, unknown>; onlyInStates?: string[] }, call: (key: string) => Promise<T>): Promise<StripeOpResult<T>> {
  const claimed = await ltx(m, async (c) => {
    // A worker that read the PaymentIntent before another worker finished must not open a second operation: lock the order and
    // re-check that it is still in a state that needs this write.
    if (opts.onlyInStates) {
      const cur = (await c.query("select state from orders where id = $1 for update", [o.id])).rows[0]?.state as string | undefined;
      if (!cur || !opts.onlyInStates.includes(cur)) return null;
    }
    const last = await latestOp(c, o.id, opKind);
    // A capture that already succeeded is never repeated: the worker that did it is about to record the result.
    if (kind === "capture" && last && last.state === "resolved") {
      const ok = (await c.query("select 1 from order_operations where id = $1 and response_code = 'ok'", [last.id])).rowCount;
      if (ok) return null;
    }
    let op: Op | null;
    if (last && last.state === "sent") op = last;
    else {
      op = await insertIntent(c, o.id, opKind, (last?.seq ?? 0) + 1, hashOf({ order: o.id, kind: opKind, seq: (last?.seq ?? 0) + 1 }), opts.detail);
      if (!op) throw new Error("operation_conflict");
    }
    await c.query("update order_operations set state = 'sent', sent_at = coalesce(sent_at, $2), attempt_id = coalesce($3::uuid, attempt_id) where id = $1", [op.id, now(m), m.attemptId ?? null]);
    return op;
  });
  // Another worker already moved the order on: report "in progress" so the caller waits and the next look sees the result.
  if (!claimed) return { ok: false, err: new StripeError("idempotency_in_progress", null) };
  const key = keyFor(kind, o.id, claimed.seq, opts.suffix);
  try {
    const value = await call(key);
    await ltx(m, (c) => resolveOp(c, claimed.id, "ok"));
    return { ok: true, value };
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    if (e.isTimeout || e.kind === "idempotency_in_progress") return { ok: false, err: e };   // stays `sent`: same key next time
    await ltx(m, (c) => resolveOp(c, claimed.id, e.isServerError ? "api_error" : e.code ?? e.kind));
    return { ok: false, err: e };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Advance: drive one order as far as it can go right now
// ---------------------------------------------------------------------------------------------------------------

export async function advance(m: M, orderId: string, opts: { maxSteps?: number } = {}): Promise<OrderRow | null> {
  const max = opts.maxSteps ?? 30;
  for (let i = 0; i < max; i++) {
    const o = await loadOrder(cron(m), orderId);
    if (!o) return null;
    if (OPEN_STATES.includes(o.state)) await sweepStrayAttempts(m, o);
    const step = await stepOnce(m, o);
    const after = await loadOrder(cron(m), orderId);
    if (step === "done" || !after) return after;
    // Losing a race (zero rows updated) means another worker moved the order: carry on from the new state so this worker can
    // contend for whatever comes next (the operation claim), instead of quitting.
    if (step === "wait" && after.state === o.state) return after;
  }
  return loadOrder(cron(m), orderId);
}

const due = (m: M, o: OrderRow) => !o.nextCheckAt || o.nextCheckAt <= now(m);

async function stepOnce(m: M, o: OrderRow): Promise<Step> {
  switch (o.state) {
    case "checkout_open": case "payment_failed": return reconcilePayment(m, o);
    case "review_hold": return reviewHold(m, o);
    case "authorized": case "registrar_unavailable": return beginRegistration(m, o);
    case "registering": case "paid_before_registration": return driveRegistering(m, o);
    case "outcome_unknown": return resolveUnknown(m, o);
    case "registration_failed": {
      const r = await ltx(m, (c) => move(m, c, o.id, "registration_failed", "canceling", { cancel_pi_id: o.cancelPiId ?? o.paymentIntentId }, { cause: "system" }));
      return r ? "progressed" : "wait";
    }
    case "registered": {
      const r = await ltx(m, (c) => move(m, c, o.id, "registered", "capturing", {}, { cause: "system" }));
      return r ? "progressed" : "wait";
    }
    case "capturing": return doCapture(m, o);
    case "capture_failed": return ladder(m, o);
    case "canceling": return runCancel(m, o);
    case "refund_pending": return settleRefund(m, o);
    default: return "done";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// checkout_open -> authorized (the authorized-amount guard)
// ---------------------------------------------------------------------------------------------------------------

/** Plan 4.3b guard 7 and ST-100. Returns the reason to cancel, or null when the PaymentIntent may be authorized. */
export function authorizedAmountGuard(o: Pick<OrderRow, "id" | "livemode" | "subtotalMinor" | "taxCeilingMinor">, pi: PaymentIntent): VoidReason | null {
  if (pi.livemode !== o.livemode) return "guard_livemode";
  if (pi.metadata.order_id !== o.id) return "guard_wrong_order";
  if (pi.currency !== "usd") return "guard_currency";
  if (pi.status === "requires_capture" && pi.review_open) return "guard_open_review";
  const amount = BigInt(pi.status === "succeeded" ? pi.amount_received : pi.amount_capturable);
  if (amount < o.subtotalMinor) return "guard_low";
  if (amount > o.subtotalMinor + o.taxCeilingMinor) return "guard_high";
  return null;
}

async function reconcilePayment(m: M, o: OrderRow): Promise<Step> {
  if (!o.sessionId) return "wait";
  const s = await m.svc.stripe.retrieveSession(o.sessionId);
  if (s.livemode !== o.livemode) { await ltx(m, (c) => alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "livemode_mismatch" })); return "wait"; }
  if (s.status === "open") return "wait";
  if (s.status === "expired") {
    const r = await ltx(m, (c) => move(m, c, o.id, ["checkout_open", "payment_failed"], "checkout_expired", {}, { cause: "job" }));
    return r ? "progressed" : "wait";
  }
  if (!s.payment_intent) return "wait";
  const pi = await m.svc.stripe.retrievePaymentIntent(s.payment_intent);
  return evaluateAuthorization(m, o, pi);
}

async function evaluateAuthorization(m: M, o: OrderRow, pi: PaymentIntent): Promise<Step> {
  if (pi.status === "canceled") {
    const r = await ltx(m, (c) => move(m, c, o.id, "checkout_open", "payment_failed", { failure_code: "payment_canceled" }, { cause: "job" }));
    return r ? "progressed" : "wait";
  }
  if (pi.status !== "requires_capture" && pi.status !== "succeeded") return "wait";
  const bad = authorizedAmountGuard(o, pi);
  if (bad) {
    // Cancel the PaymentIntent (re-fetched in runCancel) and alert; a captured one is refunded there.
    await ltx(m, async (c) => {
      const r = await move(m, c, o.id, ["checkout_open", "payment_failed"], "canceling", { void_reason: bad, cancel_pi_id: pi.id }, { cause: "job", detail: { guard: bad } });
      if (r) await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "authorized_amount_guard", detail: { reason: bad, pi: pi.id } });
    });
    return "progressed";
  }
  const at = now(m);
  const captureBefore = pi.capture_before ? new Date(pi.capture_before * 1000) : new Date(at.getTime() + FALLBACK_AUTH_WINDOW_MS);
  const amount = BigInt(pi.status === "succeeded" ? pi.amount_received : pi.amount_capturable);
  const to: OrderState = pi.status === "succeeded" ? "paid_before_registration" : "authorized";
  const patch = {
    stripe_payment_intent_id: pi.id, authorized_at: at, capture_before: captureBefore, amount_capturable_minor: amount, tax_minor: amount - o.subtotalMinor,
    payment_method_ref: pi.payment_method, stripe_customer_id: pi.customer ?? o.stripeCustomerId, next_check_at: null, check_count: 0,
  };
  const result = await ltx(m, async (c) => {
    await c.query("savepoint authorize");
    let row: OrderRow | null;
    try { row = await move(m, c, o.id, ["checkout_open", "payment_failed"], to, patch, { cause: "job", detail: to === "paid_before_registration" ? { unexpected_capture: true } : undefined }); await c.query("release savepoint authorize"); }
    catch (e) {
      if ((e as { code?: string }).code === "23505" && /orders_one_live_register/.test(String((e as { constraint?: string }).constraint ?? (e as Error).message))) {
        // The other customer got there first: this one is voided at `authorized` with a plain message.
        await c.query("rollback to savepoint authorize");
        const lost = await move(m, c, o.id, ["checkout_open", "payment_failed"], "canceling", { void_reason: "name_taken", cancel_pi_id: pi.id }, { cause: "job", detail: { name_taken: true } });
        return lost ? "loser" as const : "gone" as const;
      }
      throw e;
    }
    if (!row) return "gone" as const;
    await c.query(
      `insert into payments (order_id, user_id, stripe_payment_intent_id, amount_minor, tax_minor, currency, status, livemode) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (stripe_payment_intent_id) do update set amount_minor = excluded.amount_minor, tax_minor = excluded.tax_minor, status = excluded.status`,
      [o.id, o.userId, pi.id, amount, amount - o.subtotalMinor, pi.currency, pi.status, o.livemode],
    );
    return "ok" as const;
  });
  return result === "gone" ? "wait" : "progressed";
}

/** Plan guard 2: expire every other Session of the order (expiry fails if the customer just paid) and cancel any extra PaymentIntent. */
async function sweepStrayAttempts(m: M, o: OrderRow): Promise<void> {
  const r = await cron(m).query("select * from order_operations where order_id = $1 and kind = 'checkout_session' and seq <> $2 and coalesce((detail->>'swept')::boolean, false) = false", [o.id, o.attempt]);
  for (const row of r.rows) {
    const op = opOf(row);
    const sid = op.detail?.session_id as string | undefined;
    if (!sid) continue;
    let s = await m.svc.stripe.retrieveSession(sid);
    if (s.status === "open") {
      try { s = await m.svc.stripe.expireSession(sid, `expire:${o.id}:${op.seq}`); }
      catch (e) { if (!(e instanceof StripeError) || e.kind !== "invalid_request") throw e; s = await m.svc.stripe.retrieveSession(sid); }
    }
    if (s.status === "complete" && s.payment_intent && s.payment_intent !== o.paymentIntentId) {
      const pi = await m.svc.stripe.retrievePaymentIntent(s.payment_intent);       // re-fetch before any cancel
      if (pi.status === "requires_capture") await m.svc.stripe.cancelPaymentIntent(pi.id, `cancel:${o.id}:${pi.id}`);
      else if (pi.status === "succeeded") await m.svc.stripe.createRefund({ paymentIntent: pi.id, reason: "duplicate" }, `refund:${o.id}:x:${pi.id}`);
      await ltx(m, (c) => alert(m.ctx, c, { orderId: o.id, severity: "warn", kind: "extra_payment_intent", detail: { pi: pi.id, final: pi.status } }));
    }
    if (s.status !== "open") await cron(m).query("update order_operations set detail = coalesce(detail,'{}'::jsonb) || '{\"swept\":true}'::jsonb where id = $1", [op.id]);
  }
}

async function reviewHold(m: M, o: OrderRow): Promise<Step> {
  if (!o.paymentIntentId) return "wait";
  const pi = await m.svc.stripe.retrievePaymentIntent(o.paymentIntentId);
  if (pi.status === "canceled") return toCanceling(m, o, ["review_hold"], "review_refused");
  if (pi.status === "requires_capture" && !pi.review_open) { const r = await ltx(m, (c) => move(m, c, o.id, "review_hold", "authorized", {}, { cause: "webhook", detail: { review: "closed" } })); return r ? "progressed" : "wait"; }
  return "wait";
}

/** Move to `canceling`; the cancel step re-fetches the PaymentIntent, cancels upstream orders first, and then voids. */
export async function toCanceling(m: M, o: OrderRow, from: OrderState[], reason: VoidReason, extra: Record<string, unknown> = {}): Promise<Step> {
  const r = await ltx(m, async (c) => {
    const row = await move(m, c, o.id, from, "canceling", { void_reason: reason, cancel_pi_id: o.cancelPiId ?? o.paymentIntentId, ...extra }, { cause: "job", detail: { reason } });
    if (row && (reason === "auth_window" || reason === "registrar_unavailable" || reason === "unknown_deadline")) await alert(m.ctx, c, { orderId: o.id, severity: "warn", kind: `void_${reason}` });
    return row;
  });
  return r ? "progressed" : "wait";
}

// ---------------------------------------------------------------------------------------------------------------
// authorized -> registering (window, quote and price checks) and the registrar write
// ---------------------------------------------------------------------------------------------------------------

async function flagValue(q: Pick<PoolClient, "query">, name: string): Promise<unknown> {
  const r = await q.query("select value from flags where name = $1", [name]);
  return r.rows[0]?.value;
}

function captureBeforeOf(o: OrderRow): Date {
  return o.captureBefore ?? new Date((o.authorizedAt ?? o.createdAt).getTime() + FALLBACK_AUTH_WINDOW_MS);
}

async function beginRegistration(m: M, o: OrderRow): Promise<Step> {
  const from = o.state as "authorized" | "registrar_unavailable";
  const at = now(m);
  const cb = captureBeforeOf(o);
  // From authorized: registering needs at least 24 hours left. From registrar_unavailable: retry only until capture_before minus 24 hours, then void.
  const left = cb.getTime() - at.getTime();
  if (from === "registrar_unavailable" ? left <= MIN_AUTH_WINDOW_MS : left < MIN_AUTH_WINDOW_MS) return toCanceling(m, o, [from], from === "registrar_unavailable" ? "registrar_unavailable" : "auth_window");
  if (from === "registrar_unavailable" && !due(m, o)) return "wait";
  if (!o.paymentIntentId) return "wait";
  const pi = await m.svc.stripe.retrievePaymentIntent(o.paymentIntentId);
  if (pi.status === "succeeded") { const r = await ltx(m, (c) => move(m, c, o.id, [from], "paid_before_registration", {}, { cause: "system", detail: { unexpected_capture: true } })); return r ? "progressed" : "wait"; }
  if (pi.status === "canceled") return toCanceling(m, o, [from], "auth_lost");
  if (pi.review_open) { const r = await ltx(m, (c) => move(m, c, o.id, [from], "review_hold", {}, { cause: "webhook", detail: { review: "opened" } })); return r ? "progressed" : "wait"; }

  const bump = async (why: string, to: OrderState = from): Promise<Step> => {
    const next = { next_check_at: new Date(at.getTime() + backoffMs(o.checkCount)), check_count: o.checkCount + 1 };
    if (to === from) { await cron(m).query("update orders set next_check_at = $2, check_count = $3 where id = $1 and state = $4", [o.id, next.next_check_at, next.check_count, from]); return "wait"; }
    const r = await ltx(m, (c) => move(m, c, o.id, [from], to, next, { cause: "system", detail: { why } }));
    return r ? "progressed" : "wait";
  };
  if ((await flagValue(cron(m), "registrar_writes_paused")) === true) return bump("registrar_writes_paused");
  const health = await m.svc.registrar.health();
  if (health.status === "maintenance") return bump("maintenance", "registrar_unavailable");

  // Quote re-check at fulfilment: any increase voids, and a premium or non-standard price is refused (D-031).
  let fresh;
  try { fresh = await ltx(m, (c) => m.svc.pricing.quote(m.ctx, c, { fqdn: o.fqdn, years: o.years }, at)); }
  catch (e) { if (e instanceof PricingError && (e.code === "premium_refused" || e.code === "price_mismatch")) return toCanceling(m, o, [from], "price_guard"); throw e; }
  if (fresh.subtotalMinor > o.subtotalMinor) return toCanceling(m, o, [from], "quote_increased");
  if (!(await m.svc.registrant(m.ctx, o.userId))) return toCanceling(m, o, [from], "no_contact");

  const moved = await ltx(m, async (c) => {
    const row = await move(m, c, o.id, [from], "registering", { next_check_at: null, check_count: 0 }, { cause: "job" });
    if (!row) return null;
    const last = await latestOp(c, o.id, "register");
    await insertIntent(c, o.id, "register", (last?.seq ?? 0) + 1, hashOf({ fqdn: o.fqdn, years: o.years, reg_username: o.regUsername }));
    return row;
  });
  return moved ? "progressed" : "wait";
}

async function driveRegistering(m: M, o: OrderRow): Promise<Step> {
  const op = await latestOp(cron(m), o.id, "register");
  if (!op) {
    await ltx(m, async (c) => { if (await lockedState(c, o.id, ["registering", "paid_before_registration"])) await insertIntent(c, o.id, "register", 1, hashOf({ fqdn: o.fqdn, years: o.years, reg_username: o.regUsername })); });
    return "progressed";
  }
  if (op.state === "resolved") {
    if (op.responseCode === "registered") return finishRegistered(m, o, { registrarOrderId: op.registrarOrderId ?? "", op });
    return "wait";
  }
  if (op.state === "sent") return pendingCheck(m, o, op);

  // op.state === 'intent': this worker may claim the send, if the world still allows it.
  if (!due(m, o)) return "wait";
  if (o.state === "paid_before_registration" && o.authorizedAt && now(m).getTime() - o.authorizedAt.getTime() > MIN_AUTH_WINDOW_MS) return toCanceling(m, o, ["paid_before_registration"], "registrar_unavailable");
  if (o.state === "registering") {
    const pi = o.paymentIntentId ? await m.svc.stripe.retrievePaymentIntent(o.paymentIntentId) : null;
    if (pi?.status === "succeeded") { const r = await ltx(m, (c) => move(m, c, o.id, "registering", "paid_before_registration", {}, { cause: "system", detail: { unexpected_capture: true } })); return r ? "progressed" : "wait"; }
    if (pi?.status === "canceled") return toCanceling(m, o, ["registering"], "auth_lost");
  }
  if ((await flagValue(cron(m), "registrar_writes_paused")) === true) return "wait";
  const registrant = await m.svc.registrant(m.ctx, o.userId);
  if (!registrant) return toCanceling(m, o, ["registering", "paid_before_registration"], "no_contact");
  const profile = (await cron(m).query("select password_enc from registrar_profiles where order_id = $1", [o.id])).rows[0];
  if (!profile || !o.regUsername) throw new Error("registrar_profile_missing");
  const regPassword = await m.ctx.pii.decrypt(profile.password_enc, `registrar_profile:${o.id}`);
  const fp = registrantFingerprint(registrant);

  const claimed = await ltx(m, (c) => c.query(
    `update order_operations op set state = 'sent', sent_at = $2, attempt_id = $3::uuid, detail = coalesce(op.detail,'{}'::jsonb) || $4::jsonb
     where op.id = $1 and op.state = 'intent' and exists (select 1 from orders o where o.id = op.order_id and o.state in ('registering','paid_before_registration')) returning *`,
    [op.id, now(m), m.attemptId ?? crypto.randomUUID(), { fp }],
  ));
  if (claimed.rowCount === 0) return "wait";           // another worker owns the send
  const sentOp = opOf(claimed.rows[0]);

  let res;
  try {
    res = await m.svc.registrar.register({ fqdn: o.fqdn, years: o.years, regUsername: o.regUsername, regPassword, registrant });
  } catch (e) {
    if (!(e instanceof RegistrarError)) throw e;           // the worker "died": the operation stays `sent` and the sweeper reconciles it
    return onRegisterError(m, o, sentOp, e);
  }
  if (res.status === "registered") return finishRegistered(m, o, { registrarOrderId: res.registrarOrderId, expiresAt: res.expiresAt, op: sentOp });
  await cron(m).query("update order_operations set registrar_order_id = $2, response_code = 'accepted_pending', detail = detail || $3::jsonb where id = $1", [sentOp.id, res.registrarOrderId, { accepted_pending: true, reason: res.reason }]);
  await cron(m).query("update orders set next_check_at = $2 where id = $1 and state in ('registering','paid_before_registration')", [o.id, new Date(now(m).getTime() + backoffMs(0))]);
  return "wait";
}

async function lockedState(c: PoolClient, id: string, states: OrderState[]): Promise<boolean> {
  const r = await c.query("select state from orders where id = $1 for update", [id]);
  return !!r.rows[0] && states.includes(r.rows[0].state);
}

async function onRegisterError(m: M, o: OrderRow, op: Op, e: RegistrarError): Promise<Step> {
  const from: OrderState[] = ["registering", "paid_before_registration"];
  if (e.outcomeUnknown || e.kind === "unknown") {
    const r = await ltx(m, (c) => move(m, c, o.id, "registering", "outcome_unknown", { next_check_at: new Date(now(m).getTime() + backoffMs(0)), check_count: 1 }, { cause: "job", detail: { code: e.code ?? e.kind } }));
    if (r) await ltx(m, (c) => alert(m.ctx, c, { orderId: o.id, severity: "warn", kind: "outcome_unknown" }));
    return r ? "progressed" : "wait";
  }
  if (e.kind === "maintenance" || e.kind === "unavailable" || e.kind === "rate_limited" || e.kind === "insufficient_funds") {
    // The request was refused before any effect: the operation is resolved, and a retry gets a new one.
    const next = { next_check_at: new Date(now(m).getTime() + backoffMs(o.checkCount)), check_count: o.checkCount + 1 };
    const r = await ltx(m, async (c) => {
      await resolveOp(c, op.id, e.kind);
      if (o.state === "paid_before_registration") {
        // Already captured by someone else: stay here, retry with a new operation, refund if it drags on.
        await c.query("update orders set next_check_at = $2, check_count = $3 where id = $1 and state = 'paid_before_registration'", [o.id, next.next_check_at, next.check_count]);
        await insertIntent(c, o.id, "register", op.seq + 1, hashOf({ fqdn: o.fqdn, years: o.years, reg_username: o.regUsername }));
        return null;
      }
      const row = await move(m, c, o.id, ["registering"], "registrar_unavailable", next, { cause: "job", detail: { kind: e.kind } });
      if (row && e.kind === "insufficient_funds") await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "registrar_funds" });
      return row;
    });
    return r ? "progressed" : "wait";
  }
  // rejected: the registry or reseller refused. If the domain now belongs to someone else, say so.
  let takenByOther = e.code === "domain_taken" || e.code === "order_exists";
  if (takenByOther) { const d = await m.svc.registrar.getDomain(o.fqdn); takenByOther = !!d && d.profileUsername !== o.regUsername; }
  await ltx(m, async (c) => {
    await resolveOp(c, op.id, "rejected", { detail: { code: e.code ?? null } });
    await failRegistration(m, c, o, from, takenByOther ? "taken_by_other" : "registration_rejected", takenByOther ? "taken_by_other" : e.code ?? "rejected");
  });
  return "progressed";
}

async function failRegistration(m: M, c: PoolClient, o: OrderRow, from: OrderState[], reason: VoidReason, failureCode: string): Promise<void> {
  const failed = await move(m, c, o.id, from, "registration_failed", { failure_code: failureCode, void_reason: reason }, { cause: "job", detail: { code: failureCode } });
  if (failed) await move(m, c, o.id, "registration_failed", "canceling", { cancel_pi_id: o.cancelPiId ?? o.paymentIntentId }, { cause: "system" });
}

async function finishRegistered(m: M, o: OrderRow, r: { registrarOrderId: string; expiresAt?: Date; op?: Op | null }): Promise<Step> {
  const dom = await m.svc.registrar.getDomain(o.fqdn);
  const at = now(m);
  const expires = r.expiresAt ?? dom?.expiresAt ?? null;
  const moved = await ltx(m, async (c) => {
    const row = await move(m, c, o.id, ["registering", "paid_before_registration", "outcome_unknown"], "registered", { registered_at: at, registrar_ref: r.registrarOrderId, registrar_expires_at: expires, next_check_at: null, check_count: 0 }, { cause: "job" });
    if (!row) return null;
    if (r.op) await resolveOp(c, r.op.id, "registered", { registrarOrderId: r.registrarOrderId });
    await createDomainRow(m, c, o, { registrarRef: r.registrarOrderId, at, dom });
    return row;
  });
  return moved ? "progressed" : "wait";
}

async function createDomainRow(m: M, c: PoolClient, o: OrderRow, i: { registrarRef: string; at: Date; dom: Awaited<ReturnType<OrdersServices["registrar"]["getDomain"]>> }): Promise<void> {
  const tld = o.fqdn.slice(o.fqdn.indexOf(".") + 1);
  const ins = await c.query(
    `insert into domains (user_id, fqdn_ascii, tld, registrar, registrar_ref, state, registered_at, registry_created_at, expires_at, locked, privacy_status, nameservers, registry_statuses, ds_present, livemode, synced_at)
     values ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,$12,$13,$14,$6) on conflict (fqdn_ascii) where released_at is null do nothing returning id`,
    [o.userId, o.fqdn, tld, m.svc.registrarId, i.registrarRef, i.at, i.dom?.createdAt ?? i.at, i.dom?.expiresAt ?? null, i.dom?.locked ?? true, i.dom?.privacyStatus ?? "redacted_default",
      i.dom?.nameservers ?? [], i.dom?.registryStatuses ?? [], i.dom?.dsPresent ?? false, o.livemode],
  );
  const id = ins.rows[0]?.id as string | undefined;
  if (!id) { await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "domain_row_conflict" }); return; }
  await c.query("update orders set domain_id = $2 where id = $1", [o.id, id]);
  await c.query("update registrar_profiles set domain_id = $2 where order_id = $1", [o.id, id]);
}

async function pendingCheck(m: M, o: OrderRow, op: Op): Promise<Step> {
  if (op.detail?.accepted_pending) return resolveUpstream(m, o, op);
  if (o.state === "registering" && op.sentAt && now(m).getTime() - op.sentAt.getTime() > SWEEP_UNKNOWN_AFTER_MS) return markUnknown(m, o);
  return "wait";
}

/** The sweeper's move (plan: an operation `sent` for over 90 seconds). Never re-sends. */
async function markUnknown(m: M, o: OrderRow): Promise<Step> {
  const r = await ltx(m, async (c) => {
    const row = await move(m, c, o.id, "registering", "outcome_unknown", { next_check_at: new Date(now(m).getTime() + backoffMs(0)), check_count: 1 }, { cause: "system", detail: { sweep: true } });
    if (row) await alert(m.ctx, c, { orderId: o.id, severity: "warn", kind: "outcome_unknown" });
    return row;
  });
  return r ? "progressed" : "wait";
}

// ---------------------------------------------------------------------------------------------------------------
// outcome_unknown (and accepted-but-pending): reconcile by polling under the claim rule, never by resending
// ---------------------------------------------------------------------------------------------------------------

async function resolveUnknown(m: M, o: OrderRow): Promise<Step> {
  const op = await latestOp(cron(m), o.id, "register");
  if (!op || !op.sentAt) return "wait";
  return resolveUpstream(m, o, op);
}

async function resolveUpstream(m: M, o: OrderRow, op: Op): Promise<Step> {
  const at = now(m);
  const deadline = new Date(captureBeforeOf(o).getTime() - MIN_AUTH_WINDOW_MS);
  if (!due(m, o) && at < deadline) return "wait";
  const from: OrderState[] = ["registering", "outcome_unknown", "paid_before_registration"];
  const claim = await claimRegistration(m.svc.registrar, { fqdn: o.fqdn, regUsername: o.regUsername ?? "", sentAt: op.sentAt ?? at, registrantFingerprint: String(op.detail?.fp ?? "") });
  if (claim.ours && claim.state === "registered") return finishRegistered(m, o, { registrarOrderId: claim.order.registrarOrderId, op });
  if (claim.ours && claim.state === "cancelled") {
    await ltx(m, async (c) => { await resolveOp(c, op.id, "cancelled_upstream"); await failRegistration(m, c, o, from, "registration_rejected", "upstream_cancelled"); });
    return "progressed";
  }
  if (!claim.ours && claim.reason === "other_profile") {
    await ltx(m, async (c) => { await resolveOp(c, op.id, "taken_by_other"); await failRegistration(m, c, o, from, "taken_by_other", "taken_by_other"); });
    return "progressed";
  }
  if (!claim.ours && (claim.reason === "registrant_mismatch" || claim.reason === "registrant_unverifiable")) {
    await ltx(m, (c) => alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "claim_needs_review", detail: { reason: claim.reason } }));
  }
  if (at >= deadline) {
    // Nothing found by capture_before minus 24 hours: cancel the authorization, tell the customer, keep watching the name for 14 days.
    return toCanceling(m, o, from, "unknown_deadline", { late_watch_until: new Date(at.getTime() + LATE_WATCH_MS), late_watch_state: "watching" });
  }
  await cron(m).query("update orders set next_check_at = $2, check_count = check_count + 1 where id = $1 and state = any($3::text[])", [o.id, new Date(at.getTime() + backoffMs(o.checkCount)), from]);
  return "wait";
}

/** `order.sweep_unknown`: registering orders whose register operation has been `sent` for over 90 seconds move to outcome_unknown. */
export async function sweepUnknown(m: M): Promise<{ moved: number; nudged: number }> {
  const cutoff = new Date(now(m).getTime() - SWEEP_UNKNOWN_AFTER_MS);
  const stuck = await cron(m).query(
    `select o.id from orders o join order_operations op on op.order_id = o.id and op.kind = 'register' and op.seq = (select max(seq) from order_operations x where x.order_id = o.id and x.kind = 'register')
     where o.state = 'registering' and op.state = 'sent' and op.sent_at < $1 and coalesce((op.detail->>'accepted_pending')::boolean, false) = false`, [cutoff]);
  let moved = 0;
  for (const row of stuck.rows) { const o = await loadOrder(cron(m), row.id); if (o && (await markUnknown(m, o)) === "progressed") moved++; }
  // A worker that died before it sent: the intent is still there. Wake a fulfil job; the claim rule keeps it to one send.
  const idle = await cron(m).query(
    `select o.id, o.user_id from orders o join order_operations op on op.order_id = o.id and op.kind = 'register' and op.seq = (select max(seq) from order_operations x where x.order_id = o.id and x.kind = 'register')
     where o.state = 'registering' and op.state = 'intent' and op.created_at < $1`, [new Date(now(m).getTime() - 5 * 60_000)]);
  let nudged = 0;
  for (const row of idle.rows) { await ltx(m, (c) => enqueue(c, { kind: "order.fulfil", payload: { order_id: row.id }, userId: row.user_id, dedupeKey: `order.fulfil:${row.id}`, priority: 0 })); nudged++; }
  // Alarm: any order within 36 hours of capture_before that is neither captured nor cancelled.
  const near = await cron(m).query(
    `select id from orders where state in ('authorized','registering','outcome_unknown','registered','capturing','capture_failed','registrar_unavailable','paid_before_registration','review_hold') and capture_before is not null and capture_before - $1::timestamptz < interval '36 hours'`, [now(m)]);
  for (const row of near.rows) await ltx(m, (c) => alert(m.ctx, c, { orderId: row.id, severity: "page", kind: "auth_window_36h" }));
  return { moved, nudged };
}

// ---------------------------------------------------------------------------------------------------------------
// registered -> captured, and the capture_failed ladder
// ---------------------------------------------------------------------------------------------------------------

async function markCaptured(m: M, o: OrderRow, pi: PaymentIntent, cause: Cause = "job"): Promise<Step> {
  const at = now(m);
  const amount = BigInt(pi.amount_received || pi.amount);
  const tax = amount > o.subtotalMinor ? amount - o.subtotalMinor : 0n;
  const row = await ltx(m, async (c) => {
    const r = await move(m, c, o.id, ["capturing", "capture_failed"], "captured", { stripe_payment_intent_id: pi.id, next_check_at: null, check_count: 0, failure_code: null }, { cause });
    if (!r) return null;
    await c.query(
      `insert into payments (order_id, user_id, stripe_payment_intent_id, amount_minor, tax_minor, currency, status, captured_at, livemode) values ($1,$2,$3,$4,$5,$6,'succeeded',$7,$8)
       on conflict (stripe_payment_intent_id) do update set amount_minor = excluded.amount_minor, tax_minor = excluded.tax_minor, status = 'succeeded', captured_at = excluded.captured_at`,
      [o.id, o.userId, pi.id, amount, tax, pi.currency, at, o.livemode]);
    return r;
  });
  if (row) await notify(m, o, (c) => mailReceipt(m.ctx, c, o, { totalMinor: amount, taxMinor: tax, paidAt: at }));
  return row ? "progressed" : "wait";
}

/** One capture attempt with the key rules of plan guard 4. */
async function captureOnce(m: M, o: OrderRow): Promise<"captured" | "canceled" | "failed" | "busy"> {
  if (!o.paymentIntentId) return "failed";
  for (let attempt = 0; attempt < 2; attempt++) {
    let pi: PaymentIntent;
    try { pi = await m.svc.stripe.retrievePaymentIntent(o.paymentIntentId); } catch (e) { if (e instanceof StripeError && e.retryable) return "failed"; throw e; }
    if (pi.status === "succeeded") { await markCaptured(m, o, pi); return "captured"; }
    if (pi.status === "canceled") return "canceled";
    if (pi.status !== "requires_capture") return "failed";
    const res = await stripeOp(m, o, "capture", "capture", { onlyInStates: ["capturing", "capture_failed"] }, (key) => m.svc.stripe.capturePaymentIntent(pi.id, key));
    if (res.ok) { await markCaptured(m, o, res.value); return "captured"; }
    if (res.err.kind === "idempotency_in_progress") return "busy";          // another worker holds this key right now
    // A 500 is cached under its key: GET the PaymentIntent again and, if it is still requires_capture, capture under a NEW key.
    if (!res.err.isServerError && !res.err.isTimeout) return "failed";     // after a timeout, GET again: the capture may have landed
  }
  return "failed";
}

async function doCapture(m: M, o: OrderRow): Promise<Step> {
  const r = await captureOnce(m, o);
  if (r === "captured") return "progressed";
  if (r === "busy") return "wait";
  const reason = r === "canceled" ? "pi_canceled" : "capture_error";
  const at = now(m);
  const moved = await ltx(m, async (c) => {
    const row = await move(m, c, o.id, "capturing", "capture_failed", {
      capture_failed_at: at, capture_deadline: new Date((o.registeredAt ?? at).getTime() + ADD_GRACE_DEADLINE_MS), failure_code: reason, next_check_at: new Date(at.getTime() + 15 * 60_000),
    }, { cause: "job", detail: { reason } });
    if (row) await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "capture_failed", detail: { reason } });
    return row;
  });
  return moved ? "progressed" : "wait";
}

async function ladder(m: M, o: OrderRow): Promise<Step> {
  const at = now(m);
  if (o.captureDeadline && at >= o.captureDeadline) return giveUp(m, o);
  if (!due(m, o)) return "wait";
  const r = await captureOnce(m, o);
  if (r === "captured") return "progressed";
  if (r === "busy") return "wait";
  if (r === "failed") {
    // Retry (same key on a timeout, a new key after a 500) every 15 minutes; page again if the first 6 hours pass.
    await cron(m).query("update orders set next_check_at = $2, check_count = check_count + 1 where id = $1 and state = 'capture_failed'", [o.id, new Date(at.getTime() + 15 * 60_000)]);
    if (o.captureFailedAt && at.getTime() - o.captureFailedAt.getTime() >= CAPTURE_RETRY_WINDOW_MS) await ltx(m, (c) => alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "capture_failed_6h" }));
    return "wait";
  }
  // The PaymentIntent is cancelled or expired. Charge a saved method off-session if there is one, else email a pay link.
  const mandate = (await cron(m).query("select stripe_payment_method_ref from renewal_mandates where user_id = $1 and revoked_at is null and stripe_payment_method_ref is not null order by accepted_at desc limit 1", [o.userId])).rows[0];
  if (mandate && o.stripeCustomerId) {
    try {
      const pi = await m.svc.stripe.createOffSessionPaymentIntent({ customer: o.stripeCustomerId, paymentMethod: mandate.stripe_payment_method_ref, amount: Number(o.amountCapturableMinor ?? o.subtotalMinor), currency: "usd", metadata: { order_id: o.id, purpose: "capture_failed" } }, `offsession:${o.id}`);
      if (pi.status === "succeeded") return markCaptured(m, o, pi);
    } catch (e) { if (!(e instanceof StripeError)) throw e; if (e.retryable) return "wait"; }
  }
  const expires = o.payLinkExpiresAt ?? new Date(Math.min(at.getTime() + PAY_LINK_MS, (o.captureDeadline ?? new Date(at.getTime() + PAY_LINK_MS)).getTime()));
  if (!o.payLinkExpiresAt) await ltx(m, (c) => c.query("update orders set pay_link_expires_at = $2 where id = $1 and state = 'capture_failed' and pay_link_expires_at is null", [o.id, expires]));
  // Sent once (dedupe key); tried again on later passes if the mail provider was down.
  await notify(m, o, (c) => mailCustomer(m.ctx, c, o, { kind: "order.pay_link", dedupeKey: `order.pay_link:${o.id}`, subject: `Finish paying for ${o.fqdn}`, body: `We registered ${o.fqdn} for you, but your card hold ended before we could collect payment. Sign in and pay before ${expires.toISOString().replace("T", " ").slice(0, 16)} UTC to keep the name. If we do not receive payment by then, we release the name.` }));
  await cron(m).query("update orders set next_check_at = $2 where id = $1 and state = 'capture_failed'", [o.id, new Date(at.getTime() + 60 * 60_000)]);
  return "wait";
}

/** Unpaid at the deadline: delete inside the add-grace period and book the loss. */
async function giveUp(m: M, o: OrderRow): Promise<Step> {
  if (m.svc.deleteDomain) await m.svc.deleteDomain(o.fqdn);
  const r = await ltx(m, async (c) => {
    const row = await move(m, c, o.id, "capture_failed", "voided", { void_reason: "unpaid", failure_code: m.svc.deleteDomain ? "unpaid_deleted" : "unpaid_manual_delete" }, { cause: "job", detail: { loss: true } });
    if (!row) return null;
    if (o.domainId) await c.query("update domains set released_at = $2, release_reason = 'unpaid' where id = $1 and released_at is null", [o.domainId, now(m)]);
    await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "loss_booked", detail: { reason: "capture_failed_unpaid", deleted: !!m.svc.deleteDomain } });
    if (!m.svc.deleteDomain) await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "manual_domain_delete_required" });
    return row;
  });
  if (r) await notify(m, o, (c) => mailVoid(m.ctx, c, o, "unpaid"));
  return r ? "progressed" : "wait";
}

/** A pay-link Checkout completed for a capture_failed order. The PaymentIntent is fetched by the caller. */
export async function markPaidViaLink(m: M, orderId: string, pi: PaymentIntent): Promise<boolean> {
  const o = await loadOrder(cron(m), orderId);
  if (!o || o.state !== "capture_failed" || pi.status !== "succeeded" || pi.metadata.order_id !== o.id || pi.currency !== "usd") return false;
  return (await markCaptured(m, o, pi, "webhook")) === "progressed";
}

// ---------------------------------------------------------------------------------------------------------------
// canceling -> voided (or refunded, if the money was already taken)
// ---------------------------------------------------------------------------------------------------------------

async function runCancel(m: M, o: OrderRow): Promise<Step> {
  // 0. The customer must not be able to pay a Session we have given up on.
  if (o.sessionId) {
    try {
      const s = await m.svc.stripe.retrieveSession(o.sessionId);
      if (s.status === "open") await m.svc.stripe.expireSession(s.id, `expire:${o.id}:${o.attempt}`);
    } catch (e) { if (!(e instanceof StripeError) || e.kind !== "invalid_request") throw e; }   // already paid or expired: the guards below decide
  }
  // 1. Every pending upstream order of ours for the domain is cancelled and confirmed BEFORE the PaymentIntent is cancelled.
  const regOps = (await cron(m).query("select state from order_operations where order_id = $1 and kind = 'register'", [o.id])).rows;
  if (regOps.some((r) => r.state !== "intent") && o.regUsername) {
    const ups = await m.svc.registrar.getOrdersByDomain(o.fqdn);
    const mine = ups.filter((u) => u.profileUsername === o.regUsername && (u.status === "pending" || u.status === "waiting"));
    for (const u of mine) await m.svc.registrar.cancelPendingOrder(u.registrarOrderId);
    if (mine.length) {
      const after = await m.svc.registrar.getOrdersByDomain(o.fqdn);
      for (const u of mine) {
        const now2 = after.find((x) => x.registrarOrderId === u.registrarOrderId);
        if (now2?.status === "completed") {
          // It completed while we cancelled: the name is ours and unpaid. Book the loss and keep watching for it.
          await ltx(m, async (c) => {
            await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "loss_booked", detail: { reason: "upstream_completed_after_cancel" } });
            await c.query("update orders set late_watch_state = coalesce(late_watch_state, 'watching'), late_watch_until = coalesce(late_watch_until, $2) where id = $1", [o.id, new Date(now(m).getTime() + LATE_WATCH_MS)]);
          });
        } else if (now2 && (now2.status === "pending" || now2.status === "waiting")) throw new Error("upstream_cancel_unconfirmed");
      }
    }
  }
  // 2. Re-fetch the PaymentIntent, then cancel it (or refund it if someone captured it).
  const piId = o.cancelPiId ?? o.paymentIntentId;
  if (piId) {
    const pi = await m.svc.stripe.retrievePaymentIntent(piId);
    if (pi.status === "succeeded") return startRefund(m, o, { from: ["canceling"], reason: "cancelled_after_capture", system: true, piId });
    if (pi.status !== "canceled") {
      const own = piId === o.paymentIntentId;
      const res = await stripeOp(m, o, "cancel", own ? "cancel_pi" : `cancel_pi:${piId}`, { suffix: own ? "" : `:${piId}` }, (key) => m.svc.stripe.cancelPaymentIntent(piId, key));
      if (!res.ok) { if (res.err.kind === "idempotency_in_progress") return "wait"; if (res.err.retryable) throw res.err; return "wait"; }
    }
  }
  const done = await ltx(m, async (c) => {
    const row = await move(m, c, o.id, "canceling", "voided", {}, { cause: "job", detail: { reason: o.voidReason } });
    if (!row) return null;
    await c.query("update payments set status = 'canceled' where order_id = $1 and status = 'requires_capture'", [o.id]);
    return row;
  });
  if (done) await notify(m, o, (c) => mailVoid(m.ctx, c, o, o.voidReason));
  return done ? "progressed" : "wait";
}

// ---------------------------------------------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------------------------------------------

export class RefundRefused extends Error {
  constructor(public code: "refund_cap" | "domain_in_use" | "not_refundable") { super(code); this.name = "RefundRefused"; }
}

/**
 * Customer- or support-initiated refund of a captured order. Capped at 3 per account per 30 days and allowed only for a
 * domain with no DNS records and no connections; the DNS tables arrive in Phase 3, so the caller passes that fact.
 */
export async function requestRefund(m: M, orderId: string, p: { reason: string; hasDnsOrConnections: boolean; cause?: Cause }): Promise<OrderRow> {
  const o = await loadOrder(cron(m), orderId);
  if (!o || o.state !== "captured") throw new RefundRefused("not_refundable");
  if (p.hasDnsOrConnections) throw new RefundRefused("domain_in_use");
  const since = new Date(now(m).getTime() - 30 * 24 * 3600_000);
  const n = (await cron(m).query("select count(*)::int as n from refunds where user_id = $1 and created_at >= $2", [o.userId, since])).rows[0].n as number;
  if (n >= 3) throw new RefundRefused("refund_cap");
  if (!o.paymentIntentId) throw new RefundRefused("not_refundable");
  await startRefund(m, o, { from: ["captured"], reason: p.reason, system: false, piId: o.paymentIntentId });
  return (await advance(m, orderId))!;
}

async function startRefund(m: M, o: OrderRow, p: { from: OrderState[]; reason: string; system: boolean; piId: string }): Promise<Step> {
  const r = await ltx(m, (c) => move(m, c, o.id, p.from, "refund_pending", { cancel_pi_id: p.piId }, { cause: p.system ? "system" : "user", detail: { reason: p.reason } }));
  if (!r) return "wait";
  return settleRefund(m, { ...o, state: "refund_pending", cancelPiId: p.piId }, p.reason);
}

async function settleRefund(m: M, o: OrderRow, reasonIn?: string): Promise<Step> {
  const piId = o.cancelPiId ?? o.paymentIntentId;
  if (!piId) return "wait";
  const reason = reasonIn ?? "requested_by_customer";
  const pay = (await cron(m).query("select id, amount_minor, refunded_minor from payments where stripe_payment_intent_id = $1", [piId])).rows[0];
  let paymentId: string | undefined = pay?.id;
  let amount: bigint;
  if (pay) amount = BigInt(pay.amount_minor) - BigInt(pay.refunded_minor);
  else { const pi = await m.svc.stripe.retrievePaymentIntent(piId); amount = BigInt(pi.amount_received); }
  if (amount <= 0n) { await finishRefund(m, o, null, 0n, paymentId, reason); return "progressed"; }
  const res = await stripeOp(m, o, "refund", "refund", { detail: { amount: amount.toString() } }, (key) => m.svc.stripe.createRefund({ paymentIntent: piId, amount: Number(amount), reason }, key));
  if (!res.ok) { if (res.err.kind === "idempotency_in_progress") return "wait"; if (res.err.retryable) throw res.err; await ltx(m, (c) => move(m, c, o.id, "refund_pending", "refund_failed", {}, { cause: "job", detail: { code: res.err.code ?? res.err.kind } })); await ltx(m, (c) => alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "refund_failed" })); return "progressed"; }
  const refund = res.value;
  if (refund.status === "failed" || refund.status === "canceled") { await ltx(m, async (c) => { await move(m, c, o.id, "refund_pending", "refund_failed", {}, { cause: "job" }); await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "refund_failed" }); }); return "progressed"; }
  if (refund.status === "pending") return "wait";
  await finishRefund(m, o, refund.id, BigInt(refund.amount), paymentId, reason);
  return "progressed";
}

async function finishRefund(m: M, o: OrderRow, stripeRefundId: string | null, amount: bigint, paymentId: string | undefined, reason: string): Promise<void> {
  await ltx(m, async (c) => {
    if (paymentId && stripeRefundId) {
      // The ledger row and the payment total move together, once: a second worker finishing the same refund inserts nothing and adds nothing.
      const ins = await c.query("insert into refunds (order_id, payment_id, user_id, stripe_refund_id, amount_minor, reason) values ($1,$2,$3,$4,$5,$6) on conflict (stripe_refund_id) do nothing returning id", [o.id, paymentId, o.userId, stripeRefundId, amount, reason]);
      if (ins.rowCount === 1) await c.query("update payments set refunded_minor = refunded_minor + $2 where id = $1", [paymentId, amount]);
    }
    const p = paymentId ? (await c.query("select amount_minor, refunded_minor from payments where id = $1", [paymentId])).rows[0] : null;
    const full = !p || BigInt(p.refunded_minor) >= BigInt(p.amount_minor);
    const row = await move(m, c, o.id, "refund_pending", full ? "refunded" : "partially_refunded", {}, { cause: "job", detail: { reason } });
    // A refunded name that is still registered to the customer needs releasing: a person confirms it (add-grace deletion is an upstream action).
    if (row && full && o.registeredAt && !o.voidReason) await alert(m.ctx, c, { orderId: o.id, severity: "warn", kind: "refunded_domain_release" });
    return row;
  });
  await notify(m, o, (c) => mailCustomer(m.ctx, c, o, { kind: "order.refunded", dedupeKey: `order.refunded:${o.id}`, subject: `Your payment for ${o.fqdn} was refunded`, body: "We refunded your payment in full. Your bank shows the refund in a few days." }));
}

// ---------------------------------------------------------------------------------------------------------------
// late_registration_watch
// ---------------------------------------------------------------------------------------------------------------

/** For 14 days after giving up on a name, check whether it appears as ours. If it does, the order enters capture_failed. */
export async function scanLateWatches(m: M): Promise<number> {
  const at = now(m);
  await cron(m).query("update orders set late_watch_state = 'expired' where late_watch_state = 'watching' and late_watch_until <= $1", [at]);
  const rows = (await cron(m).query("select id from orders where late_watch_state = 'watching'")).rows;
  let claimed = 0;
  for (const row of rows) {
    const o = await loadOrder(cron(m), row.id);
    const op = o ? await latestOp(cron(m), o.id, "register") : null;
    if (!o || !op || !op.sentAt || !o.regUsername) continue;
    const claim = await claimRegistration(m.svc.registrar, { fqdn: o.fqdn, regUsername: o.regUsername, sentAt: op.sentAt, registrantFingerprint: String(op.detail?.fp ?? "") });
    if (!(claim.ours && claim.state === "registered")) continue;
    const dom = await m.svc.registrar.getDomain(o.fqdn);
    const ok = await ltx(m, async (c) => {
      const r = await move(m, c, o.id, ["voided", "canceling"], "capture_failed", {
        registered_at: at, registrar_ref: claim.order.registrarOrderId, capture_failed_at: at, capture_deadline: new Date(claim.order.orderDate.getTime() + ADD_GRACE_DEADLINE_MS),
        late_watch_state: "claimed", failure_code: "late_registration", next_check_at: null,
      }, { cause: "system", detail: { late_registration: true } });
      if (!r) return false;
      await createDomainRow(m, c, o, { registrarRef: claim.order.registrarOrderId, at, dom });
      await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "late_registration" });
      return true;
    });
    if (ok) claimed++;
  }
  return claimed;
}

/** `order.reconcile`: open orders older than two minutes that are due get a fulfil job; late watches are scanned. */
export async function reconcileOpen(m: M): Promise<{ enqueued: number; lateClaimed: number }> {
  const at = now(m);
  const rows = (await cron(m).query(
    `select id, user_id from orders where state = any($1::text[]) and created_at < $2 and (next_check_at is null or next_check_at <= $3)`,
    [OPEN_STATES, new Date(at.getTime() - 2 * 60_000), at])).rows;
  for (const r of rows) await ltx(m, (c) => enqueue(c, { kind: "order.fulfil", payload: { order_id: r.id }, userId: r.user_id, dedupeKey: `order.fulfil:${r.id}`, priority: 0 }));
  const lateClaimed = await scanLateWatches(m);
  return { enqueued: rows.length, lateClaimed };
}
