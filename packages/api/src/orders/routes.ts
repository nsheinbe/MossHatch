import { withUser } from "@mosshatch/db";
import { HttpError, json, type Router } from "../http/router.ts";
import type { HandlerReq } from "../http/types.ts";
import type { AppContext } from "../ports.ts";
import { StripeError } from "../stripe/port.ts";
import { createOrder, ensureCustomer } from "./create.ts";
import { advance, applyPayLinkSession, machine, openPayLink } from "./machine.ts";
import { loadOrder, ordersSvc, rowToOrder, voidMessage } from "./support.ts";
import { PAY_LINK_MS, type OrderRow } from "./types.ts";
import { stripeWebhook, verifyStripeRequest } from "./webhook.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the owner sees. Money is decimal strings; nothing here is a token, a URL or a payment detail. */
export function orderView(o: OrderRow, paid?: { amountMinor: bigint; taxMinor: bigint } | null) {
  return {
    id: o.id, kind: o.kind, state: o.state, fqdn: o.fqdn, years: o.years, currency: "usd",
    subtotal_minor: o.subtotalMinor.toString(), tax_ceiling_minor: o.taxCeilingMinor.toString(), total_minor: o.totalMinor.toString(),
    charged_minor: paid ? paid.amountMinor.toString() : null, tax_minor: paid ? paid.taxMinor.toString() : null,
    message: o.state === "voided" || o.state === "canceling" ? voidMessage(o.voidReason) : null,
    created_at: o.createdAt.toISOString(),
  };
}

/** The ownership join: an unowned order and a nonexistent one leave through the same 404. */
async function owned(ctx: AppContext, userId: string, id: string): Promise<OrderRow> {
  const found = UUID.test(id)
    ? (await withUser(ctx.runtime, userId, (c) => c.query("select * from orders where id = $1 and user_id = $2", [id, userId]))).rows[0]
    : undefined;
  if (!found) throw new HttpError(404, "not_found");
  return rowToOrder(found);
}
async function viewFor(ctx: AppContext, userId: string, o: OrderRow) {
  const p = (await withUser(ctx.runtime, userId, (c) => c.query("select amount_minor, tax_minor from payments where order_id = $1 and status = 'succeeded'", [o.id]))).rows[0];
  return orderView(o, p ? { amountMinor: BigInt(p.amount_minor), taxMinor: BigInt(p.tax_minor) } : null);
}
const uid = (r: HandlerReq) => { if (!r.principal.userId) throw new HttpError(401, "unauthorized"); return r.principal.userId; };

export function registerOrderRoutes(router: Router): Router {
  router.add(
    {
      // Session principal only: an agent binding can never place or accept an order (C-12, C-14).
      method: "POST", path: "/api/v1/orders", principals: ["session"], tag: "orders",
      async handler(r) {
        const key = r.request.headers.get("idempotency-key");
        if (!key) throw new HttpError(400, "idempotency_key_required");
        const b = (r.body && typeof r.body === "object" && !Array.isArray(r.body) ? r.body : {}) as Record<string, unknown>;
        // Only `fqdn`, `years`, the acceptance hashes and the auto-renew box are read. A price, total or currency in the body is ignored (ST-97).
        const res = await createOrder(r.ctx, { userId: uid(r), fqdn: b.fqdn, years: b.years, idempotencyKey: key, ipPrefix: r.ipPrefix, uaFamily: r.uaFamily, accept: b.accept, autoRenew: b.auto_renew });
        return json({ order_id: res.order.id, checkout_url: res.checkoutUrl }, res.replay ? 200 : 201);
      },
    },
    {
      method: "GET", path: "/api/v1/orders/:id", principals: ["session"], tag: "orders",
      async handler(r) {
        const o = await owned(r.ctx, uid(r), r.params.id ?? "");
        return json(await viewFor(r.ctx, uid(r), o));
      },
    },
    {
      // The success page's reconcile: the same idempotent advance the webhook path runs, after checking that the Session is this order's.
      method: "GET", path: "/api/v1/orders/:id/return", principals: ["session"], tag: "orders",
      async handler(r) {
        const userId = uid(r);
        const o = await owned(r.ctx, userId, r.params.id ?? "");
        const sid = r.url.searchParams.get("session_id") ?? "";
        const known = sid && (o.sessionId === sid || (await r.ctx.cron.query("select 1 from order_operations where order_id = $1 and kind = 'checkout_session' and detail->>'session_id' = $2", [o.id, sid])).rowCount);
        const payLink = !known && sid && (await r.ctx.cron.query("select 1 from order_operations where order_id = $1 and kind = 'pay_link' and detail->>'session_id' = $2", [o.id, sid])).rowCount;
        if (!known && !payLink) throw new HttpError(404, "not_found");
        try {
          // A pay link's success page reconciles exactly as its webhook would.
          if (payLink) await applyPayLinkSession(machine(r.ctx), o.id, sid);
          else if (o.kind === "renew" && o.state === "draft" && o.sessionId === sid) {
            // A renewal paid on Checkout: the return page reconciles exactly as the webhook would (read the Session, then the PaymentIntent).
            const sess = await ordersSvc(r.ctx).stripe.retrieveSession(sid);
            if (sess.status === "complete" && sess.payment_status === "paid" && sess.payment_intent) {
              const { renewalCheckoutPaid, advanceRenewal } = await import("../domains/renewals.ts");
              await renewalCheckoutPaid(r.ctx, o.id, sid, sess.payment_intent);
              await advanceRenewal(machine(r.ctx), o.id);
            }
          } else await advance(machine(r.ctx), o.id, { maxSteps: 8 });
        } catch { /* the job path retries; the page shows the state as it is */ }
        const now = (await loadOrder(r.ctx.cron, o.id)) ?? o;
        return json(await viewFor(r.ctx, userId, now));
      },
    },
    {
      // capture_failed only: the order's one payable pay-link Checkout while the emailed pay window is open (valid up to 7 days).
      // An open one is handed out again; the machine records each one as an operation and never leaves two payable.
      method: "POST", path: "/api/v1/orders/:id/pay-link", principals: ["session"], tag: "orders",
      async handler(r) {
        const userId = uid(r);
        const o = await owned(r.ctx, userId, r.params.id ?? "");
        const svc = ordersSvc(r.ctx);
        const now = r.ctx.clock.now();
        if (o.state !== "capture_failed" || !o.payLinkExpiresAt || o.payLinkExpiresAt <= now) throw new HttpError(409, "not_payable");
        const customer = o.stripeCustomerId ?? await ensureCustomer(r.ctx, svc, userId);
        let link;
        try { link = await openPayLink(machine(r.ctx), o.id, customer); }
        catch (e) { if (e instanceof StripeError) throw new HttpError(503, "payment_unavailable"); throw e; }
        if (!link) throw new HttpError(409, "not_payable");
        return json({ checkout_url: link.url });
      },
    },
    {
      // Webhook principal: the router verifies the signature (with the roll-overlap secrets) and the timestamp before this runs.
      method: "POST", path: "/api/v1/webhooks/stripe", principals: ["webhook"], tag: "orders",
      verify: verifyStripeRequest,
      handler: stripeWebhook,
    },
  );
  return router;
}
export { PAY_LINK_MS };
