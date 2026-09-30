import { tx } from "@mosshatch/db";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { enqueue } from "../jobs/registry.ts";
import { raiseAlert } from "../ops/alerts.ts";
import type { StripeEvent } from "../stripe/port.ts";
import { machine, markPaidViaLink, move } from "./machine.ts";
import { loadOrder, ordersSvc, rowToOrder } from "./support.ts";
import type { OrderRow } from "./types.ts";

/** Router `verify` for `POST /webhooks/stripe`: signature over the raw body, timestamp tolerance, any of the accepted secrets. */
export async function verifyStripeRequest(request: Request, rawBody: string, ctx: AppContext): Promise<{ ok: boolean; provider: string }> {
  try {
    const svc = ordersSvc(ctx);
    svc.stripe.constructEvent(rawBody, request.headers.get("stripe-signature"), svc.webhookSecrets(), ctx.clock.now());
    return { ok: true, provider: "stripe" };
  } catch {
    return { ok: false, provider: "stripe" };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULFIL_TYPES = new Set([
  "checkout.session.completed", "checkout.session.expired", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "payment_intent.succeeded", "payment_intent.canceled", "payment_intent.payment_failed", "payment_intent.amount_capturable_updated", "payment_intent.requires_action",
  "review.opened", "review.closed",
]);

async function findOrder(ctx: AppContext, ev: StripeEvent): Promise<OrderRow | null> {
  const o = ev.data.object ?? {};
  const type = ev.type;
  const piId: string | undefined = type.startsWith("payment_intent.") ? o.id : typeof o.payment_intent === "string" ? o.payment_intent : undefined;
  if (piId) {
    const r = (await ctx.cron.query("select * from orders where stripe_payment_intent_id = $1 or cancel_pi_id = $1 limit 1", [piId])).rows[0]
      ?? (await ctx.cron.query("select o.* from payments p join orders o on o.id = p.order_id where p.stripe_payment_intent_id = $1", [piId])).rows[0];
    if (r) return rowToOrder(r);
  }
  const meta = o.metadata?.order_id;
  if (typeof meta === "string" && UUID.test(meta)) return loadOrder(ctx.cron, meta);
  if (type.startsWith("checkout.session.") && typeof o.id === "string") {
    const r = (await ctx.cron.query("select * from orders where stripe_checkout_session_id = $1", [o.id])).rows[0];
    if (r) return rowToOrder(r);
  }
  return null;
}

async function rejectLivemode(ctx: AppContext, ev: StripeEvent, order: OrderRow | null): Promise<never> {
  await tx(ctx.cron, async (c) => {
    await c.query(
      `insert into webhook_events (provider, event_id, livemode, type, payload, processed_at, error) values ('stripe',$1,$2,$3,$4,$5,'livemode_mismatch')
       on conflict (provider, event_id) do update set error = 'livemode_mismatch', processed_at = coalesce(webhook_events.processed_at, $5)`,
      [ev.id, !!ev.livemode, String(ev.type).slice(0, 100), ev, ctx.clock.now()]);
    await raiseAlert(ctx, c, { severity: "page", kind: "livemode_mismatch", subject: order?.id ?? ev.id, detail: { event: ev.id, event_livemode: !!ev.livemode, order_id: order?.id ?? null } });
  });
  throw new HttpError(400, "livemode_mismatch");
}

/**
 * POST /webhooks/stripe (already signature-checked by the router). The event is stored raw, deduplicated by id, checked
 * against the mode, and turned into work: order state moves only through `order.fulfil`, which re-fetches Stripe, or
 * through the direct overlays below (dispute, early fraud warning, refund). Replays and out-of-order delivery are
 * harmless because every handler is a conditional update keyed on state.
 */
export async function stripeWebhook(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const ev = req.body as StripeEvent | null;
  if (!ev || typeof ev !== "object" || typeof ev.id !== "string" || typeof ev.type !== "string" || !ev.data || typeof ev.data !== "object") throw new HttpError(400, "bad_event");
  const svc = ordersSvc(ctx);
  const order = await findOrder(ctx, ev);

  // Mode consistency on every event: against this process, and against the order it names (ST-151).
  if (!!ev.livemode !== ctx.config.livemode) return rejectLivemode(ctx, ev, order);
  if (order && order.livemode !== !!ev.livemode) return rejectLivemode(ctx, ev, order);

  const first = await tx(ctx.cron, async (c) => {
    const ins = await c.query(
      "insert into webhook_events (provider, event_id, livemode, type, payload) values ('stripe',$1,$2,$3,$4) on conflict (provider, event_id) do nothing returning id",
      [ev.id, !!ev.livemode, ev.type.slice(0, 100), ev]);
    if (ins.rowCount === 1) return { fresh: true };
    const prior = (await c.query("select processed_at, error from webhook_events where provider = 'stripe' and event_id = $1", [ev.id])).rows[0];
    if (prior?.error === "livemode_mismatch") throw new HttpError(400, "livemode_mismatch");
    return { fresh: false, done: !!prior?.processed_at };
  });
  if (!first.fresh && first.done) return json({ received: true, duplicate: true });

  let woke = false;
  try {
    woke = await applyEvent(req, ev, order);
  } catch (e) {
    await ctx.cron.query("update webhook_events set error = $2 where provider = 'stripe' and event_id = $1 and processed_at is null", [ev.id, (e as Error)?.name ?? "error"]);
    throw e;
  }
  await ctx.cron.query("update webhook_events set processed_at = $2, error = null where provider = 'stripe' and event_id = $1", [ev.id, ctx.clock.now()]);
  if (woke) { try { svc.tick?.(ctx); } catch { /* the cron tick will pick the job up */ } }
  return json({ received: true, duplicate: false });
}

async function applyEvent(req: HandlerReq, ev: StripeEvent, order: OrderRow | null): Promise<boolean> {
  const { ctx } = req;
  const svc = ordersSvc(ctx);
  const o = ev.data.object as Record<string, any>;
  const m = machine(ctx);

  if (ev.type === "checkout.session.completed" && o.metadata?.purpose === "pay_link" && order) {
    if (o.payment_status !== "paid" || typeof o.payment_intent !== "string") return false;
    const pi = await svc.stripe.retrievePaymentIntent(o.payment_intent);
    const ok = await markPaidViaLink(m, order.id, pi);
    if (!ok) await tx(ctx.cron, (c) => raiseAlert(ctx, c, { severity: "warn", kind: "pay_link_unexpected", subject: order.id, detail: { order_id: order.id, state: order.state } }));
    return false;
  }

  if (FULFIL_TYPES.has(ev.type)) {
    if (!order) return false;
    await tx(ctx.cron, (c) => enqueue(c, { kind: "order.fulfil", payload: { order_id: order.id }, userId: order.userId, priority: 0 }));
    return true;
  }

  if (ev.type === "charge.dispute.created" || ev.type === "radar.early_fraud_warning.created") {
    if (!order) { await tx(ctx.cron, (c) => raiseAlert(ctx, c, { severity: "warn", kind: "dispute_unknown_order", subject: ev.id })); return false; }
    // Overlay, not a state change: the order stays captured; the account goes to review; a person looks at the evidence.
    await tx(ctx.cron, async (c) => {
      await c.query("update users set risk_state = 'review' where id = $1 and risk_state <> 'review'", [order.userId]);
      await c.query("update payments set dispute_state = 'open' where order_id = $1", [order.id]);
      await c.query("insert into order_events (order_id, from_state, to_state, cause, stripe_event_id, detail, at) values ($1,$2,$2,'webhook',$3,$4,$5)", [order.id, order.state, ev.id, { overlay: "dispute_open", source: ev.type }, ctx.clock.now()]);
      await appendAudit(ctx, c, { chainId: order.userId, actorKind: "system", action: "order.dispute_open", resourceKind: "order", resourceId: order.id, detail: { source: ev.type } });
      await raiseAlert(ctx, c, { severity: "warn", kind: "dispute_opened", subject: order.id, detail: { order_id: order.id } });
    });
    return false;
  }
  if (ev.type === "charge.dispute.closed" && order) {
    const won = o.status === "won";
    await tx(ctx.cron, async (c) => {
      await c.query("update payments set dispute_state = $2 where order_id = $1", [order.id, won ? "won" : "lost"]);
      await c.query("insert into order_events (order_id, from_state, to_state, cause, stripe_event_id, detail, at) values ($1,$2,$2,'webhook',$3,$4,$5)", [order.id, order.state, ev.id, { overlay: won ? "dispute_won" : "dispute_lost" }, ctx.clock.now()]);
    });
    return false;
  }

  if (ev.type === "charge.refunded" && order) {
    const refunded = BigInt(o.amount_refunded ?? 0);
    await tx(ctx.cron, async (c) => {
      const st = (await c.query("select state from orders where id = $1 for update", [order.id])).rows[0];
      if (st?.state !== "captured") return;         // our own refund flow keeps the ledger itself
      const p = (await c.query("select id, amount_minor, refunded_minor from payments where order_id = $1 for update", [order.id])).rows[0];
      if (!p || refunded <= BigInt(p.refunded_minor)) return;
      // A refund made outside our flow (Dashboard): mirror it. Our own refunds already updated the ledger before this event.
      const delta = refunded - BigInt(p.refunded_minor);
      await c.query("update payments set refunded_minor = $2 where id = $1", [p.id, refunded]);
      await c.query("insert into refunds (order_id, payment_id, user_id, amount_minor, reason) values ($1,$2,$3,$4,'dashboard')", [order.id, p.id, order.userId, delta]);
      await move(m, c, order.id, "captured", refunded >= BigInt(p.amount_minor) ? "refunded" : "partially_refunded", {}, { cause: "webhook", stripeEventId: ev.id, detail: { source: "dashboard" } });
    });
    return false;
  }
  return false;
}
