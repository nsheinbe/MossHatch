import { withUser } from "@mosshatch/db";
import { RegistrarError } from "@mosshatch/registrar/port";
import { HttpError, json, type Router } from "../http/router.ts";
import type { HandlerReq, Route } from "../http/types.ts";
import type { AppContext } from "../ports.ts";
import { advance, machine, registerKindDriver } from "../orders/machine.ts";
import { loadOrder, ordersSvc } from "../orders/support.ts";
import type { OrderRow } from "../orders/types.ts";
import { fail, transferDriver } from "./driver.ts";
import { gateHandler } from "./gate.ts";
import { registerTransferJobs } from "./jobs.ts";
import { failureMessage, STATE_TEXT, timingFor } from "./policy.ts";
import { confirmTransfer, ownedTransfer, startTransfer } from "./start.ts";
import { logTransfer, type TransferRow } from "./store.ts";

const uid = (r: HandlerReq): string => { if (r.principal.kind !== "session" || !r.principal.userId) throw new HttpError(401, "unauthorized"); return r.principal.userId; };

/** What the owner sees. `completed` is true only in the state written after the adapter confirmed; money is decimal strings; no code. */
export function transferView(t: TransferRow, o: OrderRow | null, paid: { amountMinor: bigint } | null) {
  const refunded = o?.state === "refunded" || o?.state === "refund_pending" || o?.state === "partially_refunded";
  const live = ["pending_owner_approval", "pending_registry"].includes(t.state);
  return {
    id: t.id, order_id: t.orderId, fqdn: t.fqdn, years: t.years, state: t.state, message: STATE_TEXT[t.state],
    completed: t.state === "completed", completed_at: t.completedAt?.toISOString() ?? null, domain_id: t.state === "completed" ? t.domainId : null,
    failure: t.failure ? { code: t.failure, nack_reason: t.nackReason, message: failureMessage(t.failure, t.nackReason) } : null,
    owner_deadline_at: t.state === "pending_owner_approval" ? t.ownerDeadlineAt?.toISOString() ?? null : null,
    registry_deadline_at: t.state === "pending_registry" ? t.registryDeadlineAt?.toISOString() ?? null : null,
    payment: {
      order_state: o?.state ?? null, total_minor: o?.totalMinor.toString() ?? null, charged_minor: paid ? paid.amountMinor.toString() : null,
      charged_before_completion: !!t.earlyCaptureAt, refunded,
      note: t.earlyCaptureAt && t.state !== "completed" ? "Your card hold was about to end, so we took the payment. If the transfer fails we refund it in full." : null,
    },
    can_cancel: t.state === "awaiting_confirmation" || t.state === "awaiting_payment" || t.state === "submitting" || live,
    code_stored: t.hasAuthCode,
    timing: timingFor(t.tld),
    created_at: t.createdAt.toISOString(),
  };
}

async function viewOf(ctx: AppContext, userId: string, t: TransferRow) {
  const o = await loadOrder(ctx.cron, t.orderId);
  const p = (await withUser(ctx.runtime, userId, (c) => c.query("select amount_minor from payments where order_id = $1 and status = 'succeeded'", [t.orderId]))).rows[0];
  return transferView(t, o, p ? { amountMinor: BigInt(p.amount_minor) } : null);
}

/**
 * POST /transfers/:id/cancel. Before payment: the draft or checkout ends and nothing is charged. While the request waits to be sent,
 * the send is claimed away. Once pending upstream: `CANCEL_TRANSFER`, then the hold is released (or the payment refunded). While the
 * first status is unknown, or after completion, it refuses with a plain code.
 */
async function cancelHandler(r: HandlerReq) {
  const { ctx } = r; const userId = uid(r);
  const t = await withUser(ctx.runtime, userId, (c) => ownedTransfer(c, userId, r.params.id ?? ""));
  const m = machine(ctx);
  const o = await loadOrder(ctx.cron, t.orderId);
  if (!o) throw new HttpError(404, "not_found");
  if (t.state === "awaiting_confirmation") {
    await fail(m, o, t, ["draft"], "cancelled_by_us", { actor: "user" });
  } else if (t.state === "awaiting_payment" || t.state === "submitting") {
    // Claim the unsent operation away from the worker; if the worker already sent it, the transfer is in flight (409 below).
    const claimed = await ctx.cron.query("update order_operations set state = 'resolved', response_code = 'cancelled' where order_id = $1 and kind = 'transfer' and state = 'intent' returning id", [o.id]);
    const sent = (await ctx.cron.query("select 1 from order_operations where order_id = $1 and kind = 'transfer' and state <> 'resolved'", [o.id])).rowCount ?? 0;
    if (sent > 0 && claimed.rowCount === 0) throw new HttpError(409, "transfer_in_flight", "We are still confirming the request with our registrar. Try again in a few minutes.");
    await fail(m, o, t, ["draft", "checkout_open", "payment_failed", "review_hold", "authorized", "registrar_unavailable", "registering"], "cancelled_by_us", { actor: "user" });
    await advance(m, o.id);
  } else if (t.state === "submitted") {
    throw new HttpError(409, "transfer_in_flight", "We are still confirming the request with our registrar. Try again in a few minutes.");
  } else if (t.state === "pending_owner_approval" || t.state === "pending_registry") {
    let res;
    try { res = await ordersSvc(ctx).registrar.cancelTransferIn(t.fqdn); }
    catch (e) { if (e instanceof RegistrarError) throw new HttpError(503, "registrar_unavailable"); throw e; }
    if (!res.cancelled) {
      await advance(m, o.id);          // it may have just completed or ended: the next read shows which
      throw new HttpError(409, "not_cancellable", "The transfer can no longer be cancelled.");
    }
    // The registrar confirmed the cancel: it ends the transfer from whichever upstream stage a poll has recorded meanwhile.
    await fail(m, o, t, ["registering", "outcome_unknown", "paid_before_registration", "registrar_unavailable", "capturing", "capture_failed", "captured"], "cancelled_by_us", { actor: "user", transferFrom: ["submitted", "pending_owner_approval", "pending_registry"] });
    await advance(m, o.id);
  } else {
    throw new HttpError(409, "not_cancellable", "The transfer can no longer be cancelled.");
  }
  await withUser(ctx.runtime, userId, (c) => logTransfer(ctx, c, { userId, direction: "in", event: "cancel_requested", actor: "user", transferId: t.id }));
  const after = await withUser(ctx.runtime, userId, (c) => ownedTransfer(c, userId, t.id));
  return json(await viewOf(ctx, userId, after));
}

const base = { principals: ["session" as const], tag: "transfers" };
/**
 * Transfer routes. Session only: an agent binding has no path to start, confirm or cancel a transfer, or to read the Gate (C-02; the
 * agent `transfer_status` tool belongs to the MCP module). Unowned and nonexistent ids leave through one 404.
 */
export const transferRoutes: Route[] = [
  {
    ...base, method: "POST", path: "/api/v1/transfers", liveGate: true,
    async handler(r) {
      const key = r.request.headers.get("idempotency-key");
      if (!key) throw new HttpError(400, "idempotency_key_required");
      const b = (r.body && typeof r.body === "object" && !Array.isArray(r.body) ? r.body : {}) as Record<string, unknown>;
      const res = await startTransfer(r.ctx, { userId: uid(r), fqdn: b.fqdn, years: b.years, authCode: b.auth_code, idempotencyKey: key, ipPrefix: r.ipPrefix, uaFamily: r.uaFamily, accept: b.accept });
      return json({ transfer_id: res.transfer.id, order_id: res.transfer.orderId, state: res.transfer.state, message: STATE_TEXT[res.transfer.state], timing: timingFor(res.transfer.tld) }, res.replay ? 200 : 201);
    },
  },
  {
    ...base, method: "GET", path: "/api/v1/transfers/:id",
    async handler(r) {
      const userId = uid(r);
      const t = await withUser(r.ctx.runtime, userId, (c) => ownedTransfer(c, userId, r.params.id ?? ""));
      return json(await viewOf(r.ctx, userId, t));
    },
  },
  {
    ...base, method: "POST", path: "/api/v1/transfers/:id/confirm", liveGate: true,
    async handler(r) {
      const userId = uid(r);
      const res = await confirmTransfer(r.ctx, userId, r.params.id ?? "", r.body);
      return json({ ...(await viewOf(r.ctx, userId, res.transfer)), checkout_url: res.checkoutUrl });
    },
  },
  { ...base, method: "POST", path: "/api/v1/transfers/:id/cancel", handler: cancelHandler },
  { ...base, method: "GET", path: "/api/v1/domains/:id/gate", handler: gateHandler },
];

/** One registration line in `routes.ts`: the routes, the job and the order-machine driver for `transfer_in` orders. */
export function registerTransfers(router: Router): Router {
  registerKindDriver("transfer_in", transferDriver);
  registerTransferJobs();
  router.add(...transferRoutes);
  return router;
}
