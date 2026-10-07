import { readFundingLease, releaseFundingLease, reserveFunding } from "../orders/funding.ts";
import crypto from "node:crypto";
import { tx, type PoolClient } from "@mosshatch/db";
import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { LeaseLostError } from "../jobs/engine.ts";
import { enqueue } from "../jobs/registry.ts";
import { closeAlerts, raiseAlert } from "../ops/alerts.ts";
import { sendMail } from "../email.ts";
import { buildMail } from "../mail/templates.ts";
import { advance, machine, move, type M } from "../orders/machine.ts";
import { customerAddresses, loadOrder } from "../orders/support.ts";
import { mintEmailActionToken } from "../auth/email-actions.ts";
import type { OrderRow } from "../orders/types.ts";
import { StripeError, type CreateOffSessionInput } from "../stripe/port.ts";
import { quoteToJson } from "../pricing/index.ts";
import { hashOf } from "../util/bytes.ts";
import { DAY_MS, flagTrue, loadDomain, registrarOf, rowToDomain, svcOf, yearOf, type DomainRow } from "./common.ts";
import { sellGate } from "./gate.ts";
import { activeMandate, currentAuthorisationHash, savedCard, type MandateRow } from "./mandate.ts";
import { HttpError } from "../http/router.ts";
import { ensureTerm, renewalQuote, rowToTerm, type TermRow } from "./terms.ts";

/**
 * Renewals (PLAN 4.3b "Renewals", C-30, ST-101, ST-110). They reuse the order machine's tables and transitions but charge FIRST:
 *
 *   draft --(off-session PaymentIntent succeeds)--> captured --> renewing_upstream --(registrar renew)--> renewed
 *
 * `draft -> captured -> renewing_upstream` happens in one transaction, so `captured` is never a resting state (the unique index on open
 * renewals does not cover it). One renewal order exists per (domain, term), enforced by `orders.idempotency_key` and the partial unique
 * index, so the scheduled charge and a "Renew now" click meet at the same row; one PaymentIntent exists per order, enforced by a
 * write-ahead `order_operations` row per try and the Stripe idempotency key `renew:{domain}:{term_end}:{try}`, where `try` moves only after
 * a determined failure. The registrar is called only after the charge, at most once per operation, every 15 minutes for 24 hours and
 * hourly after that until E-1, with any draft renewal cancelled before each retry. A refund happens only on request or when the name is
 * still unrenewed at E-1.
 */

export const UPSTREAM_FAST_RETRY_MS = 15 * 60_000;
export const UPSTREAM_FAST_WINDOW_MS = 24 * 3600_000;
export const UPSTREAM_SLOW_RETRY_MS = 3600_000;
/** How soon a `sent` upstream operation is polled for its outcome (no registrar write). */
export const UPSTREAM_POLL_MS = 2 * 60_000;
/** Decline ladder: charge day C, C+3 and C+6 (C-38); the customer is told after each. */
export const DECLINE_LADDER_DAYS = [0, 3, 6] as const;
/** After a price-change notice the charge waits at least this long (California's 7 to 30 day window). */
export const PRICE_NOTICE_MIN_MS = 7 * DAY_MS;

const TERMINAL_ORDER = ["renewed", "refunded", "voided", "partially_refunded", "refund_failed"];

/** The retry time for the next upstream attempt, or null when E-1 has arrived (then the payment is refunded). Pure: ST-110 tests it directly. */
export function nextUpstreamTry(now: Date, firstFailureAt: Date, termEnd: Date): Date | null {
  const cutoff = termEnd.getTime() - DAY_MS;
  if (now.getTime() >= cutoff) return null;
  const step = now.getTime() - firstFailureAt.getTime() < UPSTREAM_FAST_WINDOW_MS ? UPSTREAM_FAST_RETRY_MS : UPSTREAM_SLOW_RETRY_MS;
  return new Date(Math.min(now.getTime() + step, cutoff));
}

const ltx = <T>(m: M, fn: (c: PoolClient) => Promise<T>): Promise<T> => tx(m.ctx.cron, async (c) => {
  if (m.lease) {
    const ok = (await c.query("select job_lease_lock($1, $2, $3) as ok", [m.lease.jobId, m.lease.attemptId, m.ctx.clock.now()])).rows[0].ok as boolean;
    if (!ok) throw new LeaseLostError();
  }
  return fn(c);
});

interface Op { id: string; seq: number; kind: string; state: "intent" | "sent" | "resolved"; sentAt: Date | null; responseCode: string | null; registrarOrderId: string | null; detail: Record<string, any> | null; createdAt: Date }
const opOf = (r: Record<string, any>): Op => ({ id: r.id, seq: r.seq, kind: r.kind, state: r.state, sentAt: r.sent_at ? new Date(r.sent_at) : null, responseCode: r.response_code, registrarOrderId: r.registrar_order_id, detail: r.detail, createdAt: new Date(r.created_at) });
async function latestOp(q: Pick<PoolClient, "query">, orderId: string, kind: string): Promise<Op | null> {
  const r = await q.query("select * from order_operations where order_id = $1 and kind = $2 order by seq desc limit 1", [orderId, kind]);
  return r.rows[0] ? opOf(r.rows[0]) : null;
}
const resolveOp = (c: PoolClient, id: string, code: string, extra: { registrarOrderId?: string; detail?: Record<string, unknown> } = {}) =>
  c.query("update order_operations set state = 'resolved', response_code = $2, registrar_order_id = coalesce($3, registrar_order_id), detail = coalesce(detail, '{}'::jsonb) || $4::jsonb where id = $1", [id, code, extra.registrarOrderId ?? null, extra.detail ?? {}]);

/** The card an off-session try charged, stored on its operation so a replay under the same key sends the same body. */
interface ChargeReq { customer: string; paymentMethod: string }
function reqOf(op: Op): ChargeReq | null {
  const r = op.detail?.req as { customer?: unknown; payment_method?: unknown } | undefined;
  return r && typeof r.customer === "string" && typeof r.payment_method === "string" ? { customer: r.customer, paymentMethod: r.payment_method } : null;
}
const chargeKey = (domainId: string, termEnd: Date, seq: number) => `renew:${domainId}:${termEnd.toISOString().slice(0, 10)}:${seq}`;
const offSessionInput = (o: OrderRow, term: TermRow, req: ChargeReq): CreateOffSessionInput =>
  ({ customer: req.customer, paymentMethod: req.paymentMethod, amount: Number(o.subtotalMinor), currency: "usd", metadata: { order_id: o.id, renewal_id: term.id, purpose: "renewal" } });
/** An unresolved `renew_charge` operation opened by a renewal Checkout (as opposed to an off-session try). */
const isCheckoutOp = (op: Op) => op.detail?.via === "checkout";

/** A renewal payment the order did not keep is refunded once, and an operator is told. Returns what happened to it. */
async function refundUnkept(ctx: AppContext, o: OrderRow, piId: string, alertKind: string): Promise<"kept" | "refunded" | "failed"> {
  const kept = (await ctx.cron.query("select 1 from payments where stripe_payment_intent_id = $1 union all select 1 from orders where id = $2 and stripe_payment_intent_id = $1", [piId, o.id])).rowCount;
  if (kept) return "kept";
  try { await svcOf(ctx).stripe.createRefund({ paymentIntent: piId, reason: "duplicate_renewal" }, `renew-dup-refund:${piId}`); }
  catch (e) {
    if (!(e instanceof StripeError)) throw e;
    await tx(ctx.cron, (c) => raiseAlert(ctx, c, { severity: "page", kind: "renewal_duplicate_refund_failed", subject: o.id, detail: { order_id: o.id, code: e.code ?? e.kind } }));
    return "failed";
  }
  await tx(ctx.cron, (c) => raiseAlert(ctx, c, { severity: "warn", kind: alertKind, subject: o.id, detail: { order_id: o.id } }));
  return "refunded";
}

/** Raised while an off-session try for the order is still in flight: the Checkout webhook fails and is delivered again later. */
export class RenewalChargeInFlight extends Error { constructor() { super("renewal_charge_in_flight"); this.name = "RenewalChargeInFlight"; } }

/** Claim (or reuse) the write-ahead operation for one side effect. A `sent` operation is reused with the same key and never re-sent as a new try. */
async function claimOp(c: PoolClient, m: M, orderId: string, kind: string, detail?: Record<string, unknown>): Promise<{ op: Op; fresh: boolean }> {
  const last = await latestOp(c, orderId, kind);
  let op: Op;
  let fresh = false;
  if (last && last.state !== "resolved") op = last;
  else {
    const seq = (last?.seq ?? 0) + 1;
    const ins = await c.query("insert into order_operations (order_id, kind, seq, request_hash, state, detail) values ($1,$2,$3,$4,'intent',$5) returning *", [orderId, kind, seq, hashOf({ order: orderId, kind, seq }), detail ?? null]);
    op = opOf(ins.rows[0]); fresh = true;
  }
  if (op.state === "intent") {
    await c.query("update order_operations set state = 'sent', sent_at = $2, attempt_id = $3::uuid where id = $1", [op.id, m.ctx.clock.now(), m.attemptId ?? null]);
    fresh = true;                                            // this worker moved intent to sent, so this worker sends
  }
  return { op, fresh };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The order for a term
// ---------------------------------------------------------------------------------------------------------------------------------------

/** The renewal order for a term, created once. The scheduler and a "Renew now" click both land on this row. */
export async function ensureRenewalOrder(ctx: AppContext, term: TermRow, d: DomainRow): Promise<OrderRow | null> {
  return tx(ctx.cron, async (c) => {
    const key = `renew:${d.id}:${term.termEnd.toISOString()}`;
    const existing = (await c.query("select * from orders where user_id = $1 and idempotency_key = $2", [d.userId, key])).rows[0]
      ?? (term.orderId ? (await c.query("select * from orders where id = $1", [term.orderId])).rows[0] : undefined);
    if (existing) {
      await c.query("update renewal_terms set order_id = $2 where id = $1 and order_id is null", [term.id, existing.id]);
      return loadOrder(c, existing.id);
    }
    const now = ctx.clock.now();
    const q = await renewalQuote(c, d.fqdn, now);
    if (!q) return null;
    const mandate = await activeMandate(c, d.id);
    const card = mandate?.paymentMethodRef && mandate.customerRef ? { customer: mandate.customerRef, paymentMethod: mandate.paymentMethodRef } : await savedCard(c, d.userId);
    const id = (await c.query("select uuidv7() as id")).rows[0].id as string;
    let ins;
    try {
      await c.query("savepoint mk");
      ins = await c.query(
        `insert into orders (id, user_id, kind, fqdn_ascii, domain_id, years, state, idempotency_key, request_hash, quote, subtotal_minor, tax_ceiling_minor, total_minor, target_expiry_year,
                             livemode, stripe_customer_id, payment_method_ref, created_at)
         values ($1,$2,'renew',$3,$4,$5,'draft',$6,$7,$8,$9,0,$9,$10,$11,$12,$13,$14) on conflict (user_id, idempotency_key) do nothing returning id`,
        [id, d.userId, d.fqdn, d.id, q.years, key, hashOf({ d: d.id, e: term.termEnd.toISOString() }), quoteToJson(q), q.subtotalMinor, term.targetExpiryYear, d.livemode, card?.customer ?? null, card?.paymentMethod ?? null, now]);
      await c.query("release savepoint mk");
    } catch (e) {
      if ((e as { code?: string }).code !== "23505") throw e;
      await c.query("rollback to savepoint mk");
      const open = (await c.query("select id from orders where domain_id = $1 and kind = 'renew' and target_expiry_year = $2 and state <> all($3::text[]) order by created_at limit 1", [d.id, term.targetExpiryYear, ["checkout_expired", "payment_failed", "voided", "refunded", "registration_failed", "renewed", "captured"]])).rows[0];
      if (!open) throw e;
      await c.query("update renewal_terms set order_id = $2 where id = $1 and order_id is null", [term.id, open.id]);
      return loadOrder(c, open.id);
    }
    if (ins.rowCount === 0) {
      // The other worker (the scheduler or a Renew now click) inserted first: this one takes its order.
      const won = (await c.query("select id from orders where user_id = $1 and idempotency_key = $2", [d.userId, key])).rows[0];
      if (!won) return null;
      await c.query("update renewal_terms set order_id = $2 where id = $1 and order_id is null", [term.id, won.id]);
      return loadOrder(c, won.id);
    }
    const oid = id;
    await c.query("insert into order_events (order_id, from_state, to_state, cause, detail, at) values ($1,null,'draft','system',$2,$3)", [oid, { renewal: true }, now]);
    await c.query("update renewal_terms set order_id = $2, state = case when state in ('scheduled','held') then 'charging' else state end where id = $1", [term.id, oid]);
    return loadOrder(c, oid);
  });
}

async function termOfOrder(q: Pick<PoolClient, "query">, orderId: string): Promise<TermRow | null> {
  const r = await q.query("select * from renewal_terms where order_id = $1", [orderId]);
  return r.rows[0] ? rowToTerm(r.rows[0]) : null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Holds: reasons the automatic charge waits (C-33, ST-102, ST-109)
// ---------------------------------------------------------------------------------------------------------------------------------------

export type HoldReason = "paused" | "account_review" | "no_price" | "above_cap" | "price_notice_pending" | "funds_gate" | "no_saved_card" | "registrar_unavailable" | "reconsent_required" | "charge_notice_pending" | "price_check";

/**
 * The registrar's live renewal price against the table row the customer is charged from. A renewal is charged first and renewed
 * upstream second, so a registrar increase nobody entered would be charged at the old price and could sell below cost (docs/AUDIT-2026-10-07.md
 * P3). Higher than the table, or premium: hold (`price_check`) until a dated row is added, which also starts the price-change notices.
 * Lower or equal: proceed at the table price the customer was told. An unreachable registrar holds like the sell gate does.
 */
export async function liveRenewalCheck(ctx: AppContext, fqdn: string, years: number, tableWholesaleMinor: bigint): Promise<{ reason: HoldReason } | null> {
  let live;
  try { live = await svcOf(ctx).registrar.quote(fqdn, years, "renew"); }
  catch (e) { if (e instanceof RegistrarError) return { reason: e.code === "premium_refused" ? "price_check" : "registrar_unavailable" }; throw e; }
  if (live.isRegistryPremium || live.wholesale.minor > tableWholesaleMinor) return { reason: "price_check" };
  return null;
}

/** The pre-charge notice must reach the person at least this long before an automatic charge (Visa 7 days, C-38; the C-8 notice gives 8). */
export const PRE_CHARGE_NOTICE_MS = 7 * DAY_MS;

/**
 * Whether the person was told about THIS charge at least 7 days ago: a renewal notice for this term with auto-renew on (E-43, E-32 or C-8),
 * or the auto-renew confirmation email, which names the charge date, when the mandate was signed during this term. A mandate signed a
 * year ago does not count for this year's charge; the notices do.
 */
export async function preChargeNoticeGiven(ctx: AppContext, term: TermRow, mandate: MandateRow): Promise<boolean> {
  const cutoff = new Date(ctx.clock.now().getTime() - PRE_CHARGE_NOTICE_MS);
  const n = await ctx.cron.query(
    "select 1 from notices where domain_id = $1 and term_key = $2 and kind in ('renewal.e43','renewal.e32','renewal.c8') and sent_at <= $3 limit 1",
    [term.domainId, term.termEnd.toISOString().slice(0, 10), cutoff]);
  if ((n.rowCount ?? 0) > 0) return true;
  if (mandate.acceptedAt > cutoff) return false;
  const prev = (await ctx.cron.query("select max(term_end) as t from renewal_terms where domain_id = $1 and term_end < $2", [term.domainId, term.termEnd])).rows[0]?.t;
  return !prev || mandate.acceptedAt >= new Date(prev);
}

/** Why a charge must wait right now, or null. `manual` (the person pressed Renew now) skips the cap and notice waits: the click is the consent. */
export async function chargeHold(ctx: AppContext, term: TermRow, d: DomainRow, mandate: MandateRow | null, manual: boolean): Promise<{ reason: HoldReason; price?: bigint } | null> {
  if (await flagTrue(ctx.cron, "renewals_paused")) return { reason: "paused" };
  const u = (await ctx.cron.query("select risk_state from users where id = $1", [d.userId])).rows[0];
  if (u?.risk_state === "review") return { reason: "account_review" };
  const q = await tx(ctx.cron, (c) => renewalQuote(c, d.fqdn, ctx.clock.now()));
  if (!q) return { reason: "no_price" };
  if (!manual) {
    if (!mandate) return { reason: "no_saved_card" };
    if (mandate.reconsentRequiredAt) return { reason: "reconsent_required" };
    if (q.subtotalMinor > mandate.priceCeilingMinor) return { reason: "above_cap", price: q.subtotalMinor };
    if (!(await preChargeNoticeGiven(ctx, term, mandate))) return { reason: "charge_notice_pending" };
    if (q.subtotalMinor > term.notifiedPriceMinor) return { reason: "price_notice_pending", price: q.subtotalMinor };
    // A price change the person was told about less than 7 days ago waits, unless the name is about to expire.
    if (term.priceNoticeAt && q.subtotalMinor !== term.baselinePriceMinor && ctx.clock.now().getTime() - term.priceNoticeAt.getTime() < PRICE_NOTICE_MIN_MS && ctx.clock.now().getTime() < term.termEnd.getTime() - 3 * DAY_MS) return { reason: "price_notice_pending", price: q.subtotalMinor };
  }
  const gate = await sellGate(ctx, "renew", q.wholesaleMinor, { excludeTermId: term.id });
  if (!gate.ok) return { reason: gate.reason === "registrar_unavailable" ? "registrar_unavailable" : "funds_gate" };
  // Last, so a renewal that would wait anyway costs no registrar call; a Renew now click is checked too (the click consents to the table price).
  return liveRenewalCheck(ctx, d.fqdn, q.years, q.wholesaleMinor);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Step 1: the charge
// ---------------------------------------------------------------------------------------------------------------------------------------

type Step = "progressed" | "wait" | "done";

async function chargeStep(m: M, o: OrderRow, manual: boolean): Promise<Step> {
  const ctx = m.ctx;
  const term = await termOfOrder(ctx.cron, o.id);
  const d = o.domainId ? await loadDomain(ctx.cron, o.domainId) : null;
  if (!term || !d || d.releasedAt) return "done";
  const now = ctx.clock.now();
  if (now >= term.termEnd) return lapseDraft(m, o, term);
  const mandate = await activeMandate(ctx.cron, d.id);
  if (!manual && !mandate) {
    await setHeld(ctx, term, "auto_renew_off");
    return "wait";
  }
  // The decline ladder: C, C+3, C+6. A manual charge is not bound to it.
  if (!manual && (term.state === "payment_failed" || (o.nextCheckAt && o.nextCheckAt > now))) return "wait";
  const hold = await chargeHold(ctx, term, d, mandate, manual);
  if (hold) {
    await setHeld(ctx, term, hold.reason);
    if (hold.reason === "funds_gate" || hold.reason === "registrar_unavailable") await tx(ctx.cron, (c) => raiseAlert(ctx, c, { severity: "page", kind: "renewal_sell_gate", subject: o.id, detail: { order_id: o.id, reason: hold.reason } }));
    if (hold.reason === "price_check") await tx(ctx.cron, (c) => raiseAlert(ctx, c, { severity: "page", kind: "renewal_price_check", subject: d.tld, detail: { tld: d.tld } }));
    return "wait";
  }
  const card = mandate?.paymentMethodRef && mandate.customerRef ? { customer: mandate.customerRef, paymentMethod: mandate.paymentMethodRef } : (o.stripeCustomerId && o.paymentMethodRef ? { customer: o.stripeCustomerId, paymentMethod: o.paymentMethodRef } : await savedCard(ctx.cron, d.userId));
  if (!card) { await setHeld(ctx, term, "no_saved_card"); return "wait"; }
  // A card the network replaced with another brand is a new card: even a Renew now click pays on Checkout until the mandate is signed again.
  if (mandate?.reconsentRequiredAt) { await setHeld(ctx, term, "reconsent_required"); return "wait"; }

  const fundingLease = await readFundingLease(ctx, svcOf(ctx).registrar);
  let claimed;
  try { claimed = await ltx(m, async (c) => {
    const cur = (await c.query("select state from orders where id = $1 for update", [o.id])).rows[0]?.state as string | undefined;
    if (cur !== "draft") return null;
    // A Checkout payment for this order is being recorded: no off-session charge is sent beside it.
    const last = await latestOp(c, o.id, "renew_charge");
    if (last && last.state !== "resolved" && isCheckoutOp(last)) return "checkout" as const;
    if (!(await reserveFunding(ctx, c, o, fundingLease, { excludeTermId: term.id }))) return "funds" as const;
    await c.query("update renewal_terms set state = 'charging', held_reason = null where id = $1 and state in ('scheduled','held','charging','payment_failed')", [term.id]);
    return claimOp(c, m, o.id, "renew_charge", { term: term.id, req: { customer: card.customer, payment_method: card.paymentMethod } });
  });
  } finally { await releaseFundingLease(svcOf(ctx).registrar, fundingLease); }
  if (claimed === "funds") { await setHeld(ctx, term, "funds_gate"); return "wait"; }
  if (!claimed) return "progressed";                        // another worker moved the order
  if (claimed === "checkout") {
    await cron(m).query("update orders set next_check_at = $2 where id = $1 and state = 'draft'", [o.id, new Date(now.getTime() + 60_000)]);
    return "wait";
  }
  const key = chargeKey(d.id, term.termEnd, claimed.op.seq);
  // A reused `sent` operation replays the body it was first sent with, so the same key never carries a different request.
  const req = reqOf(claimed.op) ?? card;
  const svc = svcOf(ctx);
  try {
    const pi = await svc.stripe.createOffSessionPaymentIntent(offSessionInput(o, term, req), key);
    if (pi.status !== "succeeded") {
      // A processing or otherwise incomplete response is not proof that money cannot move.
      if (!["requires_payment_method", "requires_action", "canceled"].includes(pi.status)) {
        await cron(m).query("update orders set next_check_at = $2 where id = $1 and state = 'draft'", [o.id, new Date(now.getTime() + 60_000)]);
        return "wait";
      }
      return failedCharge(m, o, term, "authentication_required", claimed.op.id, { status: pi.status });
    }
    return charged(m, o, term, pi.id, BigInt(pi.amount_received || pi.amount), pi.currency, claimed.op.id);
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    // No answer, or the same key is being processed by the other worker: the operation stays `sent` and the next look reuses the key.
    if (e.isTimeout || e.kind === "idempotency_in_progress") {
      await cron(m).query("update orders set next_check_at = $2 where id = $1 and state = 'draft'", [o.id, new Date(now.getTime() + 60_000)]);
      return "wait";
    }
    if (e.retryable) {
      await ltx(m, async (c) => {
        const current = (await c.query("select state from orders where id = $1 for update", [o.id])).rows[0]?.state;
        const last = await latestOp(c, o.id, "renew_charge");
        if (current !== "draft" || last?.id !== claimed.op.id || last.state === "resolved") return;
        await resolveOp(c, claimed.op.id, "api_error", { detail: { code: e.code ?? e.kind } });
        await c.query("update orders set next_check_at = $2 where id = $1 and state = 'draft'", [o.id, new Date(now.getTime() + 5 * 60_000)]);
      });
      return "wait";
    }
    return failedCharge(m, o, term, e.code === "authentication_required" ? "authentication_required" : "declined", claimed.op.id, { code: e.code ?? e.kind });
  }
}
const cron = (m: M) => m.ctx.cron;

async function setHeld(ctx: AppContext, term: TermRow, reason: string): Promise<void> {
  await ctx.cron.query("update renewal_terms set state = case when state in ('renewing','renewed','refunded','lapsed','skipped') then state else 'held' end, held_reason = $2 where id = $1", [term.id, reason]);
}

/** Money moved. `draft -> captured -> renewing_upstream` in one transaction; the payment row and the wake-up commit with it. */
async function charged(m: M, o: OrderRow, term: TermRow, piId: string, amount: bigint, currency: string, opId: string): Promise<Step> {
  const at = m.ctx.clock.now();
  const done = await ltx(m, async (c) => {
    const a = await move(m, c, o.id, "draft", "captured", { stripe_payment_intent_id: piId, next_check_at: null, check_count: 0, failure_code: null }, { cause: "job", detail: { renewal: true } });
    if (!a) return null;
    // The operation resolves in the same transaction that moves the order, so no worker can see a settled charge on a draft order.
    await resolveOp(c, opId, "ok", { detail: { pi: piId } });
    await c.query(
      `insert into payments (order_id, user_id, stripe_payment_intent_id, amount_minor, tax_minor, currency, status, captured_at, livemode) values ($1,$2,$3,$4,0,$5,'succeeded',$6,$7)
       on conflict (stripe_payment_intent_id) do nothing`, [o.id, o.userId, piId, amount, currency, at, o.livemode]);
    const b = await move(m, c, o.id, "captured", "renewing_upstream", { next_check_at: at, check_count: 0 }, { cause: "job", detail: { renewal: true } });
    await c.query("update renewal_terms set state = 'renewing', held_reason = null, next_try_at = null where id = $1", [term.id]);
    await enqueue(c, { kind: "renewal.charge", payload: { order_id: o.id }, userId: o.userId, dedupeKey: `renewal.charge:${o.id}:up`, priority: 0 });
    return b;
  });
  if (!done) {
    // Another payment moved the order first (a Checkout and an off-session try crossed, or the order ended): this one is refunded, never dropped.
    await refundUnkept(m.ctx, o, piId, "renewal_duplicate_charge");
    return "progressed";
  }
  try { await tx(m.ctx.cron, (c) => mailRenewalReceipt(m.ctx, c, o, term, { totalMinor: amount, taxMinor: 0n, paidAt: at })); }
  catch { await tx(m.ctx.cron, (c) => raiseAlert(m.ctx, c, { severity: "warn", kind: "mail_failed", subject: o.id })).catch(() => undefined); }
  return "progressed";
}

/**
 * The renewal receipt (C-33): the amount, and while a mandate is live, the terms of the authorisation (ceiling, when we charge) and the
 * one-click turn-off link, so the person keeps an acknowledgement of the terms and how to cancel with every charge.
 */
async function mailRenewalReceipt(ctx: AppContext, c: PoolClient, o: OrderRow, term: TermRow, p: { totalMinor: bigint; taxMinor: bigint; paidAt: Date }): Promise<void> {
  const to = await customerAddresses(c, o.userId);
  if (to.length === 0) return;
  const live = await activeMandate(c, term.domainId);
  const off = live ? (await mintEmailActionToken(ctx, c, { userId: o.userId, purpose: "auto_renew_off", eventId: term.domainId, ttlMs: 400 * DAY_MS })).token : undefined;
  await sendMail(c, ctx.email, buildMail("renewal_receipt", {
    orderId: o.id, fqdn: o.fqdn, years: o.years, totalMinor: p.totalMinor.toString(), taxMinor: p.taxMinor.toString(), paidAt: p.paidAt.toISOString(),
    ...(live ? { ceilingMinor: live.priceCeilingMinor.toString() } : {}), ...(off ? { offToken: off } : {}),
  }, { to, dedupeKey: `receipt:${o.id}`, userId: o.userId, origin: ctx.config.origin }));
}

/** Resolve a determined decline and release only that attempt's funding in the same locked transaction. */
async function failedCharge(m: M, o: OrderRow, term: TermRow, kind: "declined" | "authentication_required", opId: string, detail: Record<string, unknown>): Promise<Step> {
  const ctx = m.ctx;
  const now = ctx.clock.now();
  await ltx(m, async (c) => {
    const current = (await c.query("select state from orders where id = $1 for update", [o.id])).rows[0]?.state;
    const last = await latestOp(c, o.id, "renew_charge");
    // A delayed answer cannot release the reservation of a newer try or rewrite a paid term.
    if (current !== "draft" || last?.id !== opId || last.state === "resolved") return;
    await resolveOp(c, opId, "declined", { detail });
    // The rung is the number of determined declines so far: 1 = the charge day, 2 = C+3, 3 = C+6.
    const rung = (await c.query("select count(*)::int as n from order_operations where order_id = $1 and kind = 'renew_charge' and response_code = 'declined'", [o.id])).rows[0].n as number;
    const seq = rung;
    const nextDay = DECLINE_LADDER_DAYS[rung];
    const nextAt = kind === "declined" && nextDay !== undefined ? new Date(Math.max(term.chargeAt.getTime() + nextDay * DAY_MS, now.getTime() + 60_000)) : null;
    await c.query("update orders set funding_reserved_minor = 0, failure_code = $2, next_check_at = $3, check_count = check_count + 1 where id = $1 and state = 'draft'", [o.id, kind === "declined" ? "card_declined" : "authentication_required", nextAt]);
    await c.query("update renewal_terms set state = $2, held_reason = $3, try = $4, next_try_at = $5 where id = $1", [term.id, nextAt ? "charging" : "payment_failed", nextAt ? null : kind, rung, nextAt]);
    if (!nextAt) await raiseAlert(ctx, c, { severity: "warn", kind: "renewal_payment_failed", subject: o.id, detail: { order_id: o.id, kind } });
    const to = await customerAddresses(c, o.userId);
    if (to.length) {
      const live = await activeMandate(c, term.domainId);
      const off = live ? (await mintEmailActionToken(ctx, c, { userId: o.userId, purpose: "auto_renew_off", eventId: term.domainId, ttlMs: 60 * DAY_MS })).token : undefined;
      await sendMail(c, ctx.email, buildMail("renewal_failed", {
        fqdn: o.fqdn, priceMinor: o.subtotalMinor.toString(), ...(nextAt ? { nextTryAt: nextAt.toISOString() } : {}), deadline: term.termEnd.toISOString(), expiresAt: term.termEnd.toISOString(),
        ...(off ? { offToken: off } : {}),
      }, { to, dedupeKey: `renewal.failed:${o.id}:${seq}`, userId: o.userId, origin: ctx.config.origin }));
    }
  });
  return "wait";
}

/** The name expired with the charge still unpaid: the draft ends. */
async function lapseDraft(m: M, o: OrderRow, term: TermRow): Promise<Step> {
  await ltx(m, async (c) => {
    await move(m, c, o.id, "draft", "voided", { void_reason: "unpaid", next_check_at: null }, { cause: "job", detail: { renewal: true, lapsed: true } });
    await c.query("update renewal_terms set state = 'lapsed' where id = $1 and state in ('scheduled','held','charging','payment_failed')", [term.id]);
  });
  return "done";
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Step 2: the registrar
// ---------------------------------------------------------------------------------------------------------------------------------------

/** A renewal completed upstream (the expiry moved past the year we asked to extend), seen through the adapter. */
async function renewedUpstream(reg: RegistrarPort, fqdn: string, targetYear: number): Promise<Date | null> {
  const st = await reg.getDomain(fqdn);
  return st?.expiresAt && yearOf(st.expiresAt) > targetYear ? st.expiresAt : null;
}

/**
 * Cancel every pending or waiting upstream renewal for the name and confirm it (`PROCESS_PENDING` cancel). Returns a renewal that
 * completed in the meantime, when there is one: the name is renewed and nothing else must be sent.
 */
export async function cancelDraftRenewals(reg: RegistrarPort, fqdn: string): Promise<{ completed: boolean }> {
  const ups = await reg.getOrdersByDomain(fqdn);
  const drafts = ups.filter((u) => u.type === "renew" && (u.status === "pending" || u.status === "waiting"));
  for (const u of drafts) await reg.cancelPendingOrder(u.registrarOrderId);
  if (drafts.length === 0) return { completed: false };
  const after = await reg.getOrdersByDomain(fqdn);
  let completed = false;
  for (const u of drafts) {
    const now2 = after.find((x) => x.registrarOrderId === u.registrarOrderId);
    if (now2?.status === "completed") completed = true;
    else if (now2 && (now2.status === "pending" || now2.status === "waiting")) throw new Error("upstream_cancel_unconfirmed");
  }
  return { completed };
}

async function finishRenewed(m: M, o: OrderRow, term: TermRow | null, op: Op | null, expires: Date | null): Promise<Step> {
  const ctx = m.ctx;
  const done = await ltx(m, async (c) => {
    const r = await move(m, c, o.id, "renewing_upstream", "renewed", { funding_reserved_minor: 0, registrar_expires_at: expires, registered_at: ctx.clock.now(), next_check_at: null, check_count: 0, failure_code: null }, { cause: "job", detail: { renewal: true } });
    if (!r) return null;
    if (op) await resolveOp(c, op.id, "renewed", { registrarOrderId: op.registrarOrderId ?? undefined });
    if (term) await c.query("update renewal_terms set state = 'renewed', held_reason = null where id = $1", [term.id]);
    if (o.domainId && expires) await c.query("update domains set expires_at = $2 where id = $1 and released_at is null and (expires_at is null or expires_at < $2)", [o.domainId, expires]);
    await closeAlerts(c, "renewal_upstream_failed", o.id);
    await closeAlerts(c, "renewal_sell_gate", o.id);
    return r;
  });
  return done ? "progressed" : "wait";
}

async function upstreamStep(m: M, o: OrderRow): Promise<Step> {
  const ctx = m.ctx;
  const reg = registrarOf(ctx);
  const term = await termOfOrder(ctx.cron, o.id);
  const d = o.domainId ? await loadDomain(ctx.cron, o.domainId) : null;
  const termEnd = term?.termEnd ?? d?.expiresAt;
  if (!d || !termEnd) return "done";
  const targetYear = term?.targetExpiryYear ?? yearOf(termEnd);
  const now = ctx.clock.now();
  const op = await latestOp(ctx.cron, o.id, "renew_upstream");

  // Reconcile a `sent` operation by polling, never by resending (rule 1 of the adapter contract).
  if (op && op.state === "sent") {
    const expires = await renewedUpstream(reg, d.fqdn, targetYear);
    if (expires) return finishRenewed(m, o, term, op, expires);
    const ups = await reg.getOrdersByDomain(d.fqdn);
    const done = ups.find((u) => u.type === "renew" && u.status === "completed" && op.sentAt && u.orderDate.getTime() >= op.sentAt.getTime() - 5000);
    if (done) return finishRenewed(m, o, term, op, (await reg.getDomain(d.fqdn))?.expiresAt ?? null);
    if (op.sentAt && now.getTime() - op.sentAt.getTime() < UPSTREAM_FAST_RETRY_MS) {
      await cron(m).query("update orders set next_check_at = $2 where id = $1 and state = 'renewing_upstream'", [o.id, new Date(Math.min(now.getTime() + UPSTREAM_POLL_MS, op.sentAt.getTime() + UPSTREAM_FAST_RETRY_MS))]);
      return "wait";
    }
    // Sent 15 minutes ago and nothing landed: the operation ends, any waiting upstream order is cancelled, and the next attempt gets a new operation.
    await ltx(m, (c) => resolveOp(c, op.id, "not_applied"));
  }

  // E-1 with the name still unrenewed: refund (ST-110).
  if (now.getTime() >= termEnd.getTime() - DAY_MS) return refundUnrenewed(m, o, term);

  if (await flagTrue(cron(m), "registrar_writes_paused")) {
    await cron(m).query("update orders set next_check_at = $2 where id = $1 and state = 'renewing_upstream'", [o.id, new Date(now.getTime() + UPSTREAM_FAST_RETRY_MS)]);
    return "wait";
  }

  // Before each retry any draft renewal upstream is cancelled and confirmed.
  try {
    const c0 = await cancelDraftRenewals(reg, d.fqdn);
    if (c0.completed) { const e = await renewedUpstream(reg, d.fqdn, targetYear); return finishRenewed(m, o, term, null, e); }
  } catch (e) {
    if (e instanceof RegistrarError) return upstreamFailed(m, o, term, termEnd, null, e);
    throw e;
  }

  const claimed = await ltx(m, async (c) => {
    const cur = (await c.query("select state from orders where id = $1 for update", [o.id])).rows[0]?.state as string | undefined;
    if (cur !== "renewing_upstream") return null;
    return claimOp(c, m, o.id, "renew_upstream", { term: term?.id ?? null });
  });
  // Only the worker that moved the operation from intent to sent may send; anyone else finds it `sent` and waits for the poll (adapter rule 1).
  if (!claimed) return "progressed";
  if (!claimed.fresh) return "wait";
  try {
    const res = await reg.renew(d.fqdn, o.years, targetYear);
    if (res.status === "renewed") return finishRenewed(m, o, term, { ...claimed.op, registrarOrderId: res.registrarOrderId }, res.expiresAt ?? null);
    await cron(m).query("update order_operations set registrar_order_id = $2, response_code = 'accepted_pending', detail = coalesce(detail,'{}'::jsonb) || '{\"accepted_pending\":true}'::jsonb where id = $1", [claimed.op.id, res.registrarOrderId]);
    await cron(m).query("update orders set next_check_at = $2, check_count = check_count + 1 where id = $1 and state = 'renewing_upstream'", [o.id, new Date(now.getTime() + UPSTREAM_POLL_MS)]);
    await noteFirstFailure(m, o, "accepted_pending", true);
    return "wait";
  } catch (e) {
    if (!(e instanceof RegistrarError)) throw e;                 // a worker that "died" leaves the operation `sent`; the poll above reconciles it
    return upstreamFailed(m, o, term, termEnd, claimed.op, e);
  }
}

async function firstFailedAt(q: Pick<PoolClient, "query">, orderId: string): Promise<Date | null> {
  const v = (await q.query("select upstream_first_failed_at from orders where id = $1", [orderId])).rows[0]?.upstream_first_failed_at;
  return v ? new Date(v) : null;
}

async function noteFirstFailure(m: M, o: OrderRow, code: string, quiet = false): Promise<void> {
  await ltx(m, async (c) => {
    const r = await c.query("update orders set upstream_first_failed_at = coalesce(upstream_first_failed_at, $2), failure_code = $3 where id = $1 and state = 'renewing_upstream' returning upstream_first_failed_at", [o.id, m.ctx.clock.now(), code]);
    // Page on the first failure (C-30): one open alert per order.
    if (r.rowCount === 1 && !quiet) await raiseAlert(m.ctx, c, { severity: "page", kind: "renewal_upstream_failed", subject: o.id, detail: { order_id: o.id, code } });
  });
}

async function upstreamFailed(m: M, o: OrderRow, term: TermRow | null, termEnd: Date, op: Op | null, e: RegistrarError): Promise<Step> {
  const now = m.ctx.clock.now();
  if (e.outcomeUnknown || e.kind === "unknown") {
    // Sent and unanswered: stays `sent`; the next look polls (no write).
    await cron(m).query("update orders set next_check_at = $2 where id = $1 and state = 'renewing_upstream'", [o.id, new Date(now.getTime() + UPSTREAM_POLL_MS)]);
    await noteFirstFailure(m, o, "outcome_unknown");
    return "wait";
  }
  if (op) await ltx(m, (c) => resolveOp(c, op.id, e.kind, { detail: { code: e.code ?? null } }));
  await noteFirstFailure(m, o, e.code ?? e.kind);
  const next = nextUpstreamTry(now, (await firstFailedAt(cron(m), o.id)) ?? now, termEnd);
  if (e.kind === "rejected" && e.code !== "draft_exists") await tx(m.ctx.cron, (c) => raiseAlert(m.ctx, c, { severity: "page", kind: "renewal_rejected", subject: o.id, detail: { order_id: o.id, code: e.code ?? "rejected" } }));
  if (e.kind === "insufficient_funds") await tx(m.ctx.cron, (c) => raiseAlert(m.ctx, c, { severity: "page", kind: "registrar_funds", subject: o.id, detail: { order_id: o.id } }));
  void term;
  await cron(m).query("update orders set next_check_at = $2, check_count = check_count + 1 where id = $1 and state = 'renewing_upstream'", [o.id, next ?? now]);
  return "wait";
}

/** Unrenewed at E-1: cancel the upstream draft, then refund the payment in full through the machine's refund step. */
async function refundUnrenewed(m: M, o: OrderRow, term: TermRow | null): Promise<Step> {
  const reg = registrarOf(m.ctx);
  const dom = o.domainId ? await loadDomain(cron(m), o.domainId) : null;
  if (dom) {
    try {
      const c0 = await cancelDraftRenewals(reg, dom.fqdn);
      if (c0.completed) return finishRenewed(m, o, term, null, await renewedUpstream(reg, dom.fqdn, term?.targetExpiryYear ?? yearOf(term?.termEnd ?? new Date())));
      const e = await renewedUpstream(reg, dom.fqdn, term?.targetExpiryYear ?? 0);
      if (e) return finishRenewed(m, o, term, null, e);
    } catch (e) { if (!(e instanceof RegistrarError)) throw e; }
  }
  return startRefund(m, o, term, "unrenewed_at_e1");
}

/** Move a charged, unrenewed renewal to `refund_pending` and let the machine's refund step finish it. */
export async function startRefund(m: M, o: OrderRow, term: TermRow | null, reason: "unrenewed_at_e1" | "requested"): Promise<Step> {
  const moved = await ltx(m, async (c) => {
    const r = await move(m, c, o.id, "renewing_upstream", "refund_pending", { cancel_pi_id: o.paymentIntentId, next_check_at: null }, { cause: reason === "requested" ? "user" : "job", detail: { reason, renewal: true } });
    if (!r) return null;
    if (term) await c.query("update renewal_terms set state = 'refunded', held_reason = $2 where id = $1", [term.id, reason]);
    await raiseAlert(m.ctx, c, { severity: "page", kind: reason === "requested" ? "renewal_refund_requested" : "renewal_unrenewed_e1", subject: o.id, detail: { order_id: o.id } });
    return r;
  });
  if (!moved) return "progressed";
  await advance(m, o.id);                                   // refund_pending -> refunded (or refund_failed, which pages)
  if (term) {
    const dom = o.domainId ? await loadDomain(cron(m), o.domainId) : null;
    const to = await tx(m.ctx.cron, (c) => customerAddresses(c, o.userId));
    if (dom && to.length) {
      await tx(m.ctx.cron, (c) => sendMail(c, m.ctx.email, buildMail("renewal_refunded", { fqdn: o.fqdn, totalMinor: o.subtotalMinor.toString(), expiresAt: term.termEnd.toISOString() }, { to, dedupeKey: `renewal.refunded:${o.id}`, userId: o.userId, origin: m.ctx.config.origin }))).catch(() => undefined);
    }
  }
  return "done";
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Driving one order
// ---------------------------------------------------------------------------------------------------------------------------------------

/** The person pressed Renew now: the click is on the order's record, so a later "charged without a mandate" review can tell it from a scheduled charge. */
export async function markManualRenewal(ctx: AppContext, orderId: string, userId: string): Promise<void> {
  await ctx.cron.query(
    `insert into order_events (order_id, from_state, to_state, cause, detail, at)
     select o.id, o.state, o.state, 'user', '{"manual_renew":true}'::jsonb, $2 from orders o
      where o.id = $1 and o.user_id = $3 and not exists (select 1 from order_events e where e.order_id = o.id and e.detail->>'manual_renew' = 'true')`,
    [orderId, ctx.clock.now(), userId]);
}

export async function advanceRenewal(m: M, orderId: string, opts: { manual?: boolean; maxSteps?: number } = {}): Promise<OrderRow | null> {
  let force = false;                                        // just charged in this pass: the registrar call follows at once
  for (let i = 0; i < (opts.maxSteps ?? 8); i++) {
    const o = await loadOrder(cron(m), orderId);
    if (!o || o.kind !== "renew") return o;
    let step: Step;
    if (o.state === "draft") { step = await chargeStep(m, o, !!opts.manual); if (step === "progressed") force = true; }
    else if (o.state === "renewing_upstream") {
      if (!force && o.nextCheckAt && o.nextCheckAt > m.ctx.clock.now()) return o;
      step = await upstreamStep(m, o);
    } else if (o.state === "refund_pending") { await advance(m, orderId); step = "done"; }
    else return o;
    if (step === "done" || step === "wait") return loadOrder(cron(m), orderId);
  }
  return loadOrder(cron(m), orderId);
}

/** The job body: drive the order, then schedule the next look at its own `next_check_at` (a fresh dedupe key each time). */
export async function renewalChargeJob(ctx: AppContext, job: { id: string; attempt_id: string; payload: Record<string, unknown> }): Promise<void> {
  const id = job.payload?.order_id;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return;
  const m = machine(ctx, { attemptId: job.attempt_id, jobId: job.id });
  const o = await advanceRenewal(m, id);
  if (!o || TERMINAL_ORDER.includes(o.state) || !["draft", "renewing_upstream", "refund_pending"].includes(o.state)) return;
  const at = o.nextCheckAt ?? new Date(ctx.clock.now().getTime() + UPSTREAM_FAST_RETRY_MS);
  if (o.state === "draft" && !o.nextCheckAt) return;                   // held: the scheduler wakes it when the hold lifts
  await tx(ctx.cron, (c) => enqueue(c, { kind: "renewal.charge", payload: { order_id: id }, userId: o.userId, runAt: at, dedupeKey: `renewal.charge:${id}:${at.getTime()}`, priority: 0 }));
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface SchedulerResult { started: number; held: number; nudged: number; lapsed: number }

/** `renewal.scheduler`: charge at C = E-10 for every mandated domain, wake work that is due, close what expired. */
export async function runRenewalScheduler(ctx: AppContext): Promise<SchedulerResult> {
  const now = ctx.clock.now();
  const res: SchedulerResult = { started: 0, held: 0, nudged: 0, lapsed: 0 };
  // A term for every live domain that has none yet (the sync makes them too; this keeps a domain from waiting for its next sync).
  const bare = (await ctx.cron.query("select * from domains d where d.released_at is null and d.expires_at is not null and d.state <> 'pending' and not exists (select 1 from renewal_terms t where t.domain_id = d.id and t.term_end = d.expires_at)")).rows;
  for (const r of bare) await tx(ctx.cron, (c) => ensureTerm(c, rowToDomain(r), now));

  const due = (await ctx.cron.query(
    `select t.* from renewal_terms t join domains d on d.id = t.domain_id and d.expires_at = t.term_end and d.released_at is null
      where t.state in ('scheduled','held') and t.charge_at <= $1 order by t.charge_at, t.id`, [now])).rows.map(rowToTerm);
  for (const t of due) {
    const d = (await loadDomain(ctx.cron, t.domainId))!;
    const mandate = await activeMandate(ctx.cron, d.id);
    if (now >= t.termEnd) { await ctx.cron.query("update renewal_terms set state = 'lapsed' where id = $1 and state in ('scheduled','held')", [t.id]); res.lapsed++; continue; }
    if (!mandate) continue;                                         // reminder mode: no card, no charge
    const hold = await chargeHold(ctx, t, d, mandate, false);
    if (hold) {
      await setHeld(ctx, t, hold.reason); res.held++;
      if (hold.reason === "funds_gate" || hold.reason === "registrar_unavailable") await tx(ctx.cron, (c) => raiseAlert(ctx, c, { severity: "page", kind: "renewal_sell_gate", subject: t.id, detail: { term_id: t.id, reason: hold.reason } }));
      // One page per extension: the price table needs a dated row for the registrar's new renewal price (scripts/live-preflight.mjs reads it).
      if (hold.reason === "price_check") await tx(ctx.cron, (c) => raiseAlert(ctx, c, { severity: "page", kind: "renewal_price_check", subject: d.tld, detail: { tld: d.tld } }));
      continue;
    }
    const order = await ensureRenewalOrder(ctx, t, d);
    if (!order) continue;
    await tx(ctx.cron, (c) => enqueue(c, { kind: "renewal.charge", payload: { order_id: order.id }, userId: d.userId, dedupeKey: `renewal.charge:${order.id}`, priority: 0 }));
    res.started++;
  }
  // Work that is due: ladder retries and upstream retries. The job reschedules itself; this is the safety net if a job row was lost.
  const wake = (await ctx.cron.query(
    `select id, user_id from orders where kind = 'renew' and state in ('draft','renewing_upstream','refund_pending') and (next_check_at is null or next_check_at <= $1)
        and not exists (select 1 from jobs j where j.kind = 'renewal.charge' and j.state in ('queued','running') and j.payload->>'order_id' = orders.id::text)`, [now])).rows;
  for (const w of wake) {
    const o = await loadOrder(ctx.cron, w.id);
    if (o?.state === "draft" && !o.nextCheckAt) {
      // A held draft is woken only when a term is due and its hold lifted (handled above).
      continue;
    }
    await tx(ctx.cron, (c) => enqueue(c, { kind: "renewal.charge", payload: { order_id: w.id }, userId: w.user_id, dedupeKey: `renewal.charge:${w.id}:wake`, priority: 0 }));
    res.nudged++;
  }
  return res;
}

/** Dead-letter default for `renewal.charge`: keep retrying until E-1 (PLAN jobs table). */
export async function renewalChargeDeadLetter(ctx: AppContext, dead: { id: string }): Promise<void> {
  const row = (await ctx.cron.query("select payload from jobs where id = $1", [dead.id])).rows[0];
  const id = row?.payload?.order_id;
  if (typeof id !== "string") return;
  const o = await loadOrder(ctx.cron, id);
  if (!o || !["draft", "renewing_upstream"].includes(o.state)) return;
  await tx(ctx.cron, (c) => enqueue(c, { kind: "renewal.charge", payload: { order_id: id }, userId: o.userId, runAt: new Date(ctx.clock.now().getTime() + UPSTREAM_FAST_RETRY_MS), dedupeKey: `renewal.charge:${id}:dl:${crypto.randomUUID()}`, priority: 0 }));
}


// ---------------------------------------------------------------------------------------------------------------------------------------
// Renew now without a saved card: a hosted Checkout for the same renewal order (C-30: the charge still comes before the registrar)
// ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * The person pressed Renew now and no card is saved for off-session use (they never ticked auto-renew, or the card was detached). The
 * same renewal order gets a hosted Checkout with automatic capture: the registrar is called only after Stripe says the payment
 * succeeded. The Session is reused while it is open, so repeated clicks do not open a second payment page for the same term.
 * The card is saved only when the person also ticked the auto-renew authorisation (`consentHash`, its own consent row, C-31).
 */
export async function startRenewalCheckout(ctx: AppContext, o: OrderRow, opts: { consentHash?: string; ipPrefix?: string; uaFamily?: string } = {}): Promise<string | null> {
  if (o.kind !== "renew" || o.state !== "draft") return null;
  const svc = svcOf(ctx);
  const now0 = ctx.clock.now();
  // The authorisation text in force; a consent to anything else saves nothing (and is refused, so the page cannot pretend it saved the card).
  let save = o.saveCard;
  if (opts.consentHash !== undefined && !o.saveCard) {
    const hash = await currentAuthorisationHash(ctx.cron, now0);
    if (!hash || opts.consentHash !== hash) throw new HttpError(422, "auto_renew_consent_required");
    await tx(ctx.cron, async (c) => {
      const upd = await c.query("update orders set save_card = true, auto_renew_opt_in = true, stripe_checkout_session_id = null where id = $1 and state = 'draft' and not save_card", [o.id]);
      if (upd.rowCount !== 1) return;
      const ip = await ctx.pii.encrypt(opts.ipPrefix ?? "", `order_ip:${o.id}`);
      await c.query(
        "insert into consents (user_id, kind, document_hash, version, accepted_at, ip_enc, ua_family, order_id, domain_id, actor_kind, retain_until) values ($1,'auto_renew_mandate',$2,$3,$4,$5,$6,$7,$8,'user',$9)",
        [o.userId, hash, hash.slice(0, 12), now0, ip, opts.uaFamily ?? null, o.id, o.domainId, new Date(now0.getTime() + 3 * 365 * DAY_MS)]);
    });
    save = true;
    o = { ...o, saveCard: true, sessionId: null };
  }
  if (o.sessionId) {
    try { const s = await svc.stripe.retrieveSession(o.sessionId); if (s.status === "open" && s.url) return s.url; }
    catch (e) { if (!(e instanceof StripeError)) throw e; }
  }
  const now = ctx.clock.now();
  const { ensureCustomer } = await import("../orders/create.ts");
  const customer = o.stripeCustomerId ?? await ensureCustomer(ctx, svc, o.userId);
  // One Session per order per hour-bucket: a retried click inside the hour replays the same Session under the same key.
  const key = `renewcs:${o.id}:${save ? "save:" : ""}${Math.floor(now.getTime() / 3600_000)}`;
  const s = await svc.stripe.createCheckoutSession({
    customer, clientReferenceId: o.id,
    successUrl: `${ctx.config.origin}/checkout/return?order=${o.id}&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${ctx.config.origin}/checkout/cancelled?order=${o.id}`,
    expiresAt: Math.floor(now.getTime() / 1000) + 60 * 60, metadata: { order_id: o.id, purpose: "renewal", renewal: "checkout" },
    lineItem: { name: `${o.fqdn} renewal for ${o.years} ${o.years === 1 ? "year" : "years"}`, unitAmount: Number(o.subtotalMinor), currency: "usd" },
    captureMethod: "automatic", requestThreeDSecure: "automatic",
    ...(save ? { setupFutureUsage: "off_session" as const } : {}),
  }, key);
  await ctx.cron.query("update orders set stripe_checkout_session_id = $2, stripe_customer_id = coalesce(stripe_customer_id, $3) where id = $1 and state = 'draft'", [o.id, s.id, s.customer]);
  return s.url;
}

/**
 * `checkout.session.completed` for a renewal Checkout: re-fetch the PaymentIntent, and when it succeeded for this order's amount,
 * move `draft -> captured -> renewing_upstream` exactly as an off-session charge would. A payment that arrives after the order moved on
 * (the name was renewed another way, or it lapsed) is refunded in full and an operator is told; nothing is charged twice for one term.
 */
export async function renewalCheckoutPaid(ctx: AppContext, orderId: string, sessionId: string, piId: string): Promise<"charged" | "refunded" | "ignored"> {
  let o = await loadOrder(ctx.cron, orderId);
  if (!o || o.kind !== "renew") return "ignored";
  const svc = svcOf(ctx);
  const pi = await svc.stripe.retrievePaymentIntent(piId);
  if (pi.status !== "succeeded" || pi.metadata.order_id !== o.id || pi.livemode !== o.livemode) return "ignored";
  const m = machine(ctx);
  const term = await termOfOrder(ctx.cron, o.id);
  const mine = () => !!o && o.state === "draft" && !!term && o.sessionId === sessionId;
  if (mine() && term) {
    // An off-session try for this order that is in flight or unanswered is settled first, under its own key and body (a replay, never a
    // second charge). When it went through, it pays the term and this Checkout's payment is refunded below.
    const pending = await latestOp(ctx.cron, o.id, "renew_charge");
    if (pending && pending.state !== "resolved" && !isCheckoutOp(pending)) {
      if ((await settleOffSessionTry(m, o, term, pending)) === "in_flight") throw new RenewalChargeInFlight();
      o = (await loadOrder(ctx.cron, o.id)) ?? o;
    }
  }
  const cur0 = o;
  const fundingLease = mine() && term ? await readFundingLease(ctx, svc.registrar) : null;
  let claimed;
  try { claimed = mine() && term ? await ltx(m, async (c) => {
    const cur = (await c.query("select state from orders where id = $1 for update", [cur0.id])).rows[0]?.state as string | undefined;
    if (cur !== "draft") return null;
    const last = await latestOp(c, cur0.id, "renew_charge");
    if (last && last.state !== "resolved" && !isCheckoutOp(last)) return "busy" as const;   // an off-session try started meanwhile
    if (!(await reserveFunding(ctx, c, cur0, fundingLease, { excludeTermId: term.id }))) return null;
    return claimOp(c, m, cur0.id, "renew_charge", { term: term.id, via: "checkout" });
  }) : null; } finally { await releaseFundingLease(svc.registrar, fundingLease); }
  if (claimed === "busy") throw new RenewalChargeInFlight();
  if (claimed && term) {
    await charged(m, o, term, pi.id, BigInt(pi.amount_received || pi.amount), pi.currency, claimed.op.id);
    const kept = (await ctx.cron.query("select 1 from payments where stripe_payment_intent_id = $1", [pi.id])).rowCount;
    // The card used on Checkout, kept for off-session renewals only when this Checkout carried the auto-renew consent.
    if (kept) {
      await ctx.cron.query("update orders set payment_method_ref = coalesce(payment_method_ref, $2), stripe_customer_id = coalesce(stripe_customer_id, $3), card_reusable = save_card and $2::text is not null where id = $1",
        [o.id, pi.payment_method, pi.customer]);
      return "charged";
    }
  }
  // Already paid another way for this term (or the order ended): give the money back, once.
  const r = await refundUnkept(ctx, o, pi.id, "renewal_checkout_after_close");
  if (r === "kept") return "charged";
  if (r === "failed") throw new Error("renewal_refund_failed");          // the webhook is delivered again
  return "refunded";
}

/**
 * Settle an off-session try whose answer this process has not seen, by sending the same request under the same key: Stripe replays the
 * first result (or reports that it is still in flight). A payment that went through moves the order; a determined failure closes the try.
 */
async function settleOffSessionTry(m: M, o: OrderRow, term: TermRow, op: Op): Promise<"settled" | "in_flight"> {
  const req = reqOf(op);
  if (!req || !o.domainId) return "in_flight";              // the exact request is not known here: the charge step's next look replays it
  try {
    const pi = await svcOf(m.ctx).stripe.createOffSessionPaymentIntent(offSessionInput(o, term, req), chargeKey(o.domainId, term.termEnd, op.seq));
    if (pi.status === "succeeded") { await charged(m, o, term, pi.id, BigInt(pi.amount_received || pi.amount), pi.currency, op.id); return "settled"; }
    if (!["requires_payment_method", "requires_action", "canceled"].includes(pi.status)) return "in_flight";
    await ltx(m, (c) => resolveOp(c, op.id, "declined", { detail: { status: pi.status, settled_by: "checkout" } }));
    return "settled";
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    if (e.isTimeout || e.kind === "idempotency_in_progress") return "in_flight";
    await ltx(m, (c) => resolveOp(c, op.id, e.retryable ? "api_error" : "declined", { detail: { code: e.code ?? e.kind, settled_by: "checkout" } }));
    return "settled";
  }
}
