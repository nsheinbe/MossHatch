import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { sendMail } from "../email.ts";
import { raiseAlert, type AlertInput } from "../ops/alerts.ts";
import { assertMailSafe, buildMail } from "../mail/templates.ts";
import type { FrozenQuote, OrderRow, OrdersServices, VoidReason } from "./types.ts";

export function ordersSvc(ctx: Pick<AppContext, "services">): OrdersServices {
  const s = (ctx.services as { orders?: OrdersServices }).orders;
  if (!s) throw new Error("orders services are not installed");
  return s;
}

const big = (v: unknown) => (v === null || v === undefined ? null : BigInt(v as string | number | bigint));
const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date));

export function rowToOrder(r: Record<string, any>): OrderRow {
  return {
    id: r.id, userId: r.user_id, kind: r.kind, fqdn: r.fqdn_ascii, domainId: r.domain_id, years: r.years, state: r.state, idempotencyKey: r.idempotency_key,
    quote: r.quote as FrozenQuote, subtotalMinor: BigInt(r.subtotal_minor), taxCeilingMinor: BigInt(r.tax_ceiling_minor), totalMinor: BigInt(r.total_minor),
    sessionId: r.stripe_checkout_session_id, paymentIntentId: r.stripe_payment_intent_id, attempt: r.attempt, captureBefore: date(r.capture_before), regUsername: r.reg_username,
    livemode: r.livemode, failureCode: r.failure_code, voidReason: r.void_reason, authorizedAt: date(r.authorized_at), amountCapturableMinor: big(r.amount_capturable_minor),
    registeredAt: date(r.registered_at), nextCheckAt: date(r.next_check_at), checkCount: r.check_count, cancelPiId: r.cancel_pi_id, captureFailedAt: date(r.capture_failed_at),
    captureDeadline: date(r.capture_deadline), payLinkExpiresAt: date(r.pay_link_expires_at), stripeCustomerId: r.stripe_customer_id, paymentMethodRef: r.payment_method_ref,
    lateWatchUntil: date(r.late_watch_until), lateWatchState: r.late_watch_state, createdAt: new Date(r.created_at),
  };
}

type Q = Pick<PoolClient, "query">;
export async function loadOrder(q: Q, id: string): Promise<OrderRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await q.query("select * from orders where id = $1", [id]);
  return r.rows[0] ? rowToOrder(r.rows[0]) : null;
}

/** Poll backoff: 60 s, 2 min, 4 min ... capped at 30 minutes. */
export function backoffMs(checkCount: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, checkCount));
}

export const usdText = (minor: bigint | number) => { const n = BigInt(minor).toString().padStart(3, "0"); return `USD ${n.slice(0, -2)}.${n.slice(-2)}`; };

export async function alert(ctx: AppContext, q: Q, a: AlertInput & { orderId: string }) {
  // The subject is the order id, an opaque value; one open alert per (kind, order).
  return raiseAlert(ctx, q as PoolClient, { severity: a.severity, kind: a.kind, subject: a.orderId, detail: { order_id: a.orderId, ...(a.detail ?? {}) } });
}

/** Where customer mail goes: every verified, live notification address. */
export async function customerAddresses(q: Q, userId: string): Promise<string[]> {
  const r = await q.query("select address::text as a from notification_addresses where user_id = $1 and removed_at is null and verified_at is not null order by created_at", [userId]);
  return r.rows.map((x) => x.a as string);
}

const VOID_TEXT: Record<VoidReason, string> = {
  name_taken: "Someone else just bought this name. Nothing was charged.",
  taken_by_other: "Someone else just bought this name. Nothing was charged.",
  auth_window: "We could not finish the registration inside the payment hold. Nothing was charged.",
  auth_lost: "Your card hold ended before we could register the name. Nothing was charged.",
  quote_increased: "The price rose while you paid, so we stopped. Nothing was charged. You can start again at the new price.",
  price_guard: "This name is not sold at our standard price, so we stopped. Nothing was charged.",
  registrar_unavailable: "Registrations are paused while our registrar is in maintenance. Nothing was charged.",
  unknown_deadline: "We could not confirm the registration in time, so we cancelled the hold. Nothing was charged.",
  registration_rejected: "The registry rejected this registration. Nothing was charged.",
  no_contact: "We need a registrant contact before we can register a name. Nothing was charged.",
  review_refused: "Your card issuer or our fraud checks did not clear this payment. Nothing was charged.",
  unpaid: "We could not collect payment, so we released the name.",
  customer_cancel: "You cancelled this order. Nothing was charged.",
  guard_low: "The payment did not match the price we showed, so we cancelled it. Nothing was charged.",
  guard_high: "The payment did not match the price we showed, so we cancelled it. Nothing was charged.",
  guard_currency: "The payment did not match the price we showed, so we cancelled it. Nothing was charged.",
  guard_wrong_order: "The payment did not match this order, so we cancelled it. Nothing was charged.",
  guard_open_review: "This payment is under review, so we cancelled it. Nothing was charged.",
  guard_livemode: "The payment did not match this order, so we cancelled it. Nothing was charged.",
};
export const voidMessage = (r: VoidReason | null) => (r ? VOID_TEXT[r] : "This order was cancelled. Nothing was charged.");

/** Plain-text customer mail. The body carries the site origin at most: no tokens, no links to actions. */
export async function mailCustomer(ctx: AppContext, c: PoolClient, o: OrderRow, m: { kind: string; dedupeKey: string; subject: string; body: string }) {
  const to = await customerAddresses(c, o.userId);
  if (to.length === 0) return { sent: false };
  const text = `${m.body}\n\nOrder: ${o.id}\nDomain: ${o.fqdn}\n\nSign in at ${ctx.config.origin} to see your orders.\n`;
  assertMailSafe({ subject: m.subject, text }, ctx.config.origin, null);
  return sendMail(c, ctx.email, { dedupeKey: m.dedupeKey, kind: m.kind, userId: o.userId, to, subject: m.subject, text, klass: "C" });
}

export async function mailVoid(ctx: AppContext, c: PoolClient, o: OrderRow, reason: VoidReason | null) {
  const to = await customerAddresses(c, o.userId);
  if (to.length === 0) return;
  // Specific, plain message first; the standard notice is sent for reasons that need nothing more said.
  await mailCustomer(ctx, c, o, { kind: "order.voided", dedupeKey: `order.voided:${o.id}`, subject: `Your order for ${o.fqdn} was cancelled`, body: voidMessage(reason) });
}

export async function mailReceipt(ctx: AppContext, c: PoolClient, o: OrderRow, p: { totalMinor: bigint; taxMinor: bigint; paidAt: Date }) {
  const to = await customerAddresses(c, o.userId);
  if (to.length === 0) return;
  const msg = buildMail("receipt", { orderId: o.id, fqdn: o.fqdn, years: o.years, totalMinor: p.totalMinor.toString(), taxMinor: p.taxMinor.toString(), paidAt: p.paidAt.toISOString() }, { to, dedupeKey: `receipt:${o.id}`, userId: o.userId, origin: ctx.config.origin });
  await sendMail(c, ctx.email, msg);
}
