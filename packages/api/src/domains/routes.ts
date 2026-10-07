import { z } from "zod";
import { RegistrarError } from "@mosshatch/registrar/port";
import { tx, withUser } from "@mosshatch/db";
import { HttpError, json, type Router } from "../http/router.ts";
import type { HandlerReq, Route } from "../http/types.ts";
import { hit } from "../ratelimit.ts";
import { markExecuted } from "../stepup/gate.ts";
import { machine } from "../orders/machine.ts";
import { orderView } from "../orders/routes.ts";
import { UUID_RE, rowToDomain } from "./common.ts";
import { disableAutoRenew, enableAutoRenew, registerMandateSpec } from "./mandate.ts";
import { RefundDenied, refundOrder } from "./refunds.ts";
import { advanceRenewal, ensureRenewalOrder, markManualRenewal, startRenewalCheckout } from "./renewals.ts";
import { StripeError } from "../stripe/port.ts";
import { ensureTerm } from "./terms.ts";
import { domainExport, domainOverview, ledger, listGrove } from "./views.ts";
import { registerDomainJobs } from "./jobs.ts";

const uid = (r: HandlerReq) => { if (!r.principal.userId) throw new HttpError(401, "unauthorized"); return r.principal.userId; };
const idOf = (r: HandlerReq) => { const id = r.params.id ?? ""; if (!UUID_RE.test(id)) throw new HttpError(404, "not_found"); return id; };

/** A binding may switch auto-renew off when it holds `mandate.off` (or `*`) for the domain (C-34: agent tokens may turn it off, never on). */
function bindingMayTurnOff(scopes: unknown, domainId: string): boolean {
  const list = Array.isArray(scopes) ? scopes : [];
  return list.some((s) => {
    if (typeof s === "string") return s === "mandate.off" || s === `mandate.off:${domainId}`;
    if (!s || typeof s !== "object") return false;
    const o = s as { capability?: unknown; domain_id?: unknown };
    return (o.capability === "mandate.off" || o.capability === "*") && (o.domain_id === domainId || o.domain_id === "*");
  });
}

const AutoRenewBody = z.strictObject({ consent_hash: z.string().min(8).max(128) });
const RenewBody = z.strictObject({ auto_renew_consent: z.string().min(8).max(128).optional() }).optional();
const RefundBody = z.strictObject({ confirm_delete: z.boolean().optional() }).optional();

const REFUND_STATUS: Record<string, [number, string]> = {
  refund_cap: [403, "refund_cap"], domain_in_use: [409, "domain_in_use"], not_refundable: [409, "not_refundable"], window_closed: [409, "window_closed"],
  tld_non_refundable: [409, "tld_non_refundable"], confirm_delete_required: [409, "confirm_delete_required"],
};

export const domainRoutes: Route[] = [
  {
    // The Grove: every live domain with its derived state, traits inputs, expiry, auto-renew and renewal price, plus an egg per registration in flight.
    method: "GET", path: "/api/v1/domains", principals: ["session"], tag: "domains",
    async handler(r) { return json(await listGrove(r.ctx, uid(r))); },
  },
  {
    method: "GET", path: "/api/v1/domains/:id", principals: ["session"], tag: "domains",
    async handler(r) { return json(await domainOverview(r.ctx, uid(r), idOf(r))); },
  },
  {
    // Works for a released domain during its hold (30 days); after that the id answers 404 like any unknown id.
    method: "GET", path: "/api/v1/domains/:id/export", principals: ["session"], tag: "domains",
    async handler(r) { return json(await domainExport(r.ctx, uid(r), idOf(r))); },
  },
  {
    // Renew now. The scheduled charge and this click meet at one order per term and one PaymentIntent per order (ST-101).
    method: "POST", path: "/api/v1/domains/:id/renew", principals: ["session"], tag: "domains", liveGate: true,
    async handler(r) {
      const userId = uid(r), domainId = idOf(r), ctx = r.ctx;
      // Optional: the person ticked the auto-renew authorisation, so a Checkout for this renewal also saves the card (C-31).
      const rb = RenewBody.safeParse(r.body && Object.keys(r.body as object).length ? r.body : undefined);
      if (!rb.success) throw new HttpError(422, "invalid_request");
      const saveConsent = rb.data?.auto_renew_consent;
      const rl = await withUser(ctx.runtime, userId, (c) => hit(ctx, c, `renew:${userId}`, { bucket: "domain_renew", max: 20, windowSeconds: 3600 }));
      if (!rl.allowed) throw new HttpError(429, "rate_limited", undefined, { "Retry-After": String(rl.retryAfterSeconds) });
      const row = await withUser(ctx.runtime, userId, async (c) => (await c.query("select * from domains where id = $1 and user_id = $2 and released_at is null", [domainId, userId])).rows[0]);
      if (!row) throw new HttpError(404, "not_found");
      const d = rowToDomain(row);
      if (["pending", "redemption", "pending_delete"].includes(d.state)) throw new HttpError(409, "not_renewable");
      // A click within a week of a renewal that is running or done replays that renewal instead of charging for another year.
      const recent = (await ctx.cron.query(
        "select id, state from orders where domain_id = $1 and kind = 'renew' and state in ('draft','renewing_upstream','renewed','refund_pending') and created_at > $2 order by created_at desc limit 1",
        [d.id, new Date(ctx.clock.now().getTime() - 7 * 86_400_000)])).rows[0];
      if (recent && recent.state !== "draft") return json({ status: recent.state === "renewed" ? "renewed" : "renewing", order_id: recent.id }, recent.state === "renewed" ? 200 : 202);
      const term = await tx(ctx.cron, (c) => ensureTerm(c, d, ctx.clock.now()));
      if (!term) throw new HttpError(503, "no_price");
      if (term.state === "renewed") return json({ status: "renewed", order_id: term.orderId });
      const order = await ensureRenewalOrder(ctx, term, d);
      if (!order) throw new HttpError(503, "no_price");
      // The decline ladder gave up on the saved card (C, C+3, C+6): it is not charged again. Renew now opens Stripe Checkout, where any
      // card can pay (C-38; docs/AUDIT-2026-10-07.md O7). The registrar is still called only after Stripe says the payment succeeded.
      if (term.state === "payment_failed" && order.state === "draft") {
        try { const url = await startRenewalCheckout(ctx, order, { consentHash: saveConsent, ipPrefix: r.ipPrefix, uaFamily: r.uaFamily }); if (url) return json({ status: "checkout", order_id: order.id, checkout_url: url }, 200); }
        catch (e) { if (e instanceof StripeError) throw new HttpError(503, "payment_unavailable"); throw e; }
      }
      await markManualRenewal(ctx, order.id, userId);
      const after = await advanceRenewal(machine(ctx), order.id, { manual: true });
      if (!after) throw new HttpError(503, "renewal_unavailable");
      if (after.state === "renewed") return json({ status: "renewed", order_id: after.id });
      if (after.state === "renewing_upstream" || after.state === "captured") return json({ status: "renewing", order_id: after.id }, 202);
      if (after.state === "refund_pending" || after.state === "refunded") return json({ status: "refunded", order_id: after.id }, 409);
      const t = (await ctx.cron.query("select state, held_reason from renewal_terms where order_id = $1", [after.id])).rows[0];
      // The bank wants the person present (3-D Secure), or declined the saved card: bring them back on-session through Checkout, where they
      // can confirm or use another card (C-38; O7).
      if (after.failureCode === "authentication_required" || after.failureCode === "card_declined") {
        try { const url = await startRenewalCheckout(ctx, after, { consentHash: saveConsent, ipPrefix: r.ipPrefix, uaFamily: r.uaFamily }); if (url) return json({ status: "checkout", order_id: after.id, checkout_url: url }, 200); }
        catch (e) { if (!(e instanceof StripeError)) throw e; }
      }
      if (after.failureCode === "card_declined" || after.failureCode === "authentication_required") throw new HttpError(402, "payment_declined");
      if (t?.held_reason === "no_saved_card" || t?.held_reason === "reconsent_required") {
        // No card saved for off-session use (or one that needs a new agreement): pay this renewal on Stripe's hosted Checkout instead.
        // The registrar is still called only after Stripe says the payment succeeded (C-30).
        try {
          const url = await startRenewalCheckout(ctx, after, { consentHash: saveConsent, ipPrefix: r.ipPrefix, uaFamily: r.uaFamily });
          if (url) return json({ status: "checkout", order_id: after.id, checkout_url: url }, 200);
        } catch (e) { if (e instanceof StripeError) throw new HttpError(503, "payment_unavailable"); throw e; }
        throw new HttpError(409, "payment_method_required");
      }
      if (t?.held_reason === "account_review" || t?.held_reason === "paused") throw new HttpError(409, "renewal_paused");
      if (t?.held_reason === "funds_gate" || t?.held_reason === "registrar_unavailable") throw new HttpError(503, "sell_gate", "Renewals are paused for a short while. Nothing was charged.");
      return json({ status: "pending", order_id: after.id }, 202);
    },
  },
  {
    // Turn on: a passkey signs the mandate (`mandate.sign`) and the person's separate consent to the authorisation text is recorded with its hash.
    method: "POST", path: "/api/v1/domains/:id/auto-renew", principals: ["session"], stepUp: "mandate.sign", tag: "domains",
    async handler(r) {
      const userId = uid(r), domainId = idOf(r);
      const body = AutoRenewBody.safeParse(r.body);
      if (!body.success) throw new HttpError(422, "consent_required");
      const action = r.action!;
      const res = await withUser(r.ctx.runtime, userId, async (c) => {
        const out = await enableAutoRenew(r.ctx, c, { userId, domainId, params: action.params as Record<string, unknown>, actionId: action.id, consentHash: body.data.consent_hash, ipPrefix: r.ipPrefix, uaFamily: r.uaFamily });
        if (!out.ok) return out;
        await markExecuted(c, action);
        return out;
      });
      if (!res.ok) {
        const map = { not_found: [404, "not_found"], already_on: [409, "already_on"], terms_not_accepted: [422, "terms_not_accepted"], params_mismatch: [409, "params_changed"] } as const;
        const [status, code] = map[res.code];
        throw new HttpError(status, code);
      }
      return json({ auto_renew: true, price_ceiling_minor: res.mandate.priceCeilingMinor.toString(), term_years: res.mandate.termYears });
    },
  },
  {
    // Turn off: one request, no passkey, no retention step (C-34). A binding may do it when it holds the `mandate.off` capability.
    method: "DELETE", path: "/api/v1/domains/:id/auto-renew", principals: ["session", "binding"], capability: "mandate.off", tag: "domains",
    async handler(r) {
      const userId = uid(r), domainId = idOf(r);
      if (r.principal.kind === "binding" && !bindingMayTurnOff(r.principal.scopes, domainId)) {
        // Same answer as an unowned id when the token is not scoped to it, so a token cannot probe which ids exist.
        throw new HttpError(404, "not_found");
      }
      const res = await withUser(r.ctx.runtime, userId, (c) => disableAutoRenew(r.ctx, c, { userId, domainId, by: r.principal.kind === "binding" ? "agent" : "user" }));
      if (!res.found) throw new HttpError(404, "not_found");
      return json({ auto_renew: false, changed: res.changed });
    },
  },
  {
    // Refund (C-29). The order is found through the owner join like every other order route.
    method: "POST", path: "/api/v1/orders/:id/refund", principals: ["session"], tag: "domains",
    async handler(r) {
      const userId = uid(r), id = idOf(r);
      const found = await withUser(r.ctx.runtime, userId, async (c) => (await c.query("select * from orders where id = $1 and user_id = $2", [id, userId])).rows[0]);
      if (!found) throw new HttpError(404, "not_found");
      const body = RefundBody.safeParse(r.body && Object.keys(r.body as object).length ? r.body : undefined);
      if (!body.success) throw new HttpError(422, "invalid_request");
      try {
        const o = await refundOrder(r.ctx, userId, id, { confirmDelete: body.data?.confirm_delete });
        return json(orderView(o));
      } catch (e) {
        if (e instanceof RefundDenied) { const [s, c] = REFUND_STATUS[e.code] ?? [409, "not_refundable"]; throw new HttpError(s, c); }
        if (e instanceof RegistrarError) throw new HttpError(503, "registrar_unavailable");       // the zone could not be read: no guess about whether the name is in use
        throw e;
      }
    },
  },
  {
    method: "GET", path: "/api/v1/ledger", principals: ["session"], tag: "domains",
    async handler(r) { return json(await ledger(r.ctx, uid(r))); },
  },
];

/** The one line `routes.ts` calls. Also registers the jobs and the `mandate.sign` spec, as `registerOps` does for its jobs. */
export function registerDomainRoutes(router: Router): Router {
  registerDomainJobs();
  registerMandateSpec();
  router.add(...domainRoutes);
  return router;
}
