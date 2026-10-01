import { tx } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { advance, machine, move, requestRefund, RefundRefused } from "../orders/machine.ts";
import { loadOrder } from "../orders/support.ts";
import { REFUND_CAP_PER_30_DAYS, type OrderRow } from "../orders/types.ts";
import { DAY_MS, loadDomain, registrarOf, svcOf, tableExists, type Q } from "./common.ts";
import { releaseDomain } from "./release.ts";
import { advanceRenewal, cancelDraftRenewals, startRefund } from "./renewals.ts";
import { rowToTerm, termForDomain, type TermRow } from "./terms.ts";

/**
 * Refund rules (C-29, ST-102).
 *  - A registration is refundable inside the lesser of 5 days from registry creation and the extension's window in `refund_policy`
 *    (`.io` and `.ai` are not refundable), only for a domain with no DNS records and no connections, and at most 3 refunds per account per 30 days
 *    (the machine's `requestRefund` counts them).
 *  - A renewal that is charged but not yet renewed upstream is refunded on request at any time (nothing was delivered).
 *  - A renewal refunded after the upstream renewal, within 5 days, deletes the name: the customer must confirm that (`confirm_delete`).
 *  - A charge with no valid mandate is refunded in full by an operator and the domain is kept; that path is not a customer route.
 * Refunding never touches the name at the registrar except through `deleteDomain` inside the add grace period; where the adapter cannot,
 * the machine's alert asks a person.
 */
export type RefundCode = "refund_cap" | "domain_in_use" | "not_refundable" | "window_closed" | "tld_non_refundable" | "confirm_delete_required";
export class RefundDenied extends Error {
  constructor(public code: RefundCode) { super(code); this.name = "RefundDenied"; }
}

/**
 * DNS records or connections exist for the domain: the zone at the registrar (read through the adapter, so a hosted zone with any record counts)
 * and the connections table of the connections module when it exists. A registrar that cannot answer is not guessed at: the error propagates.
 */
export async function domainInUse(ctx: AppContext, c: Q, d: { id: string; fqdn: string }): Promise<boolean> {
  const svc = svcOf(ctx);
  if (svc.domainInUse) return svc.domainInUse(ctx, c as never, d.id);
  const zone = await svc.registrar.getDns(d.fqdn);
  if (zone.hosted && zone.records.length > 0) return true;
  if (await tableExists(c, "connections") && (await c.query("select 1 from connections where domain_id = $1 and ended_at is null limit 1", [d.id])).rowCount) return true;
  return false;
}

export async function refundWindow(c: Q, registrar: string, tld: string): Promise<{ refundable: boolean; windowDays: number | null }> {
  const p = (await c.query("select refundable, window_days from refund_policy where registrar = $1 and tld = $2", [registrar, tld])).rows[0];
  return p ? { refundable: !!p.refundable, windowDays: p.window_days } : { refundable: false, windowDays: null };
}

/** The customer asks for a refund. Throws RefundDenied with a code the route turns into a plain message. */
export async function refundOrder(ctx: AppContext, userId: string, orderId: string, opts: { confirmDelete?: boolean } = {}): Promise<OrderRow> {
  const o = await loadOrder(ctx.cron, orderId);
  if (!o || o.userId !== userId) throw new RefundDenied("not_refundable");
  const svc = svcOf(ctx);
  const m = machine(ctx);
  const now = ctx.clock.now();
  const d = o.domainId ? await loadDomain(ctx.cron, o.domainId) : null;

  if (o.kind === "register" && o.state === "captured") {
    if (!d) throw new RefundDenied("not_refundable");
    const w = await refundWindow(ctx.cron, svc.registrarId, d.tld);
    if (!w.refundable) throw new RefundDenied("tld_non_refundable");
    const start = d.registryCreatedAt ?? o.registeredAt ?? o.createdAt;
    if (now.getTime() > start.getTime() + Math.min(5, w.windowDays ?? 5) * DAY_MS) throw new RefundDenied("window_closed");
    if (await domainInUse(ctx, ctx.cron, d)) throw new RefundDenied("domain_in_use");
    let out: OrderRow;
    try { out = await requestRefund(m, o.id, { reason: "requested_by_customer", hasDnsOrConnections: false, cause: "user" }); }
    catch (e) { throw translate(e); }
    await afterNameRefund(ctx, out, d.id, d.fqdn);
    return out;
  }

  if (o.kind === "renew" && o.state === "renewing_upstream" && d) {
    // Upstream drafts are cancelled and confirmed first. If one completed in the meantime the name is renewed and the renewed rules apply.
    const c0 = await cancelDraftRenewals(registrarOf(ctx), d.fqdn);
    if (!c0.completed) {
      const term = await termOfOrder(ctx, o.id) ?? await termForDomain(ctx.cron, d);
      await startRefund(m, o, term, "requested");
      return (await loadOrder(ctx.cron, o.id))!;
    }
    await advanceRenewal(m, o.id);
    return refundOrder(ctx, userId, orderId, opts);
  }

  if (o.kind === "renew" && o.state === "renewed" && d) {
    const w = await refundWindow(ctx.cron, svc.registrarId, d.tld);
    if (!w.refundable) throw new RefundDenied("tld_non_refundable");
    if (!o.registeredAt || now.getTime() > o.registeredAt.getTime() + Math.min(5, w.windowDays ?? 5) * DAY_MS) throw new RefundDenied("window_closed");
    if (!opts.confirmDelete) throw new RefundDenied("confirm_delete_required");
    if (!o.paymentIntentId) throw new RefundDenied("not_refundable");
    const piId = o.paymentIntentId;
    // The cap is checked and the refund_pending move made in one transaction under the same per-user lock as the orders module's
    // requestRefund, and a refund still in flight counts as much as a booked one: parallel requests cannot pass it.
    const moved = await tx(ctx.cron, async (c) => {
      await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`mh.refunds:${userId}`]);
      if (await refundsInWindow(c, userId, new Date(now.getTime() - 30 * DAY_MS)) >= REFUND_CAP_PER_30_DAYS) return "cap" as const;
      return (await move(m, c, o.id, "renewed", "refund_pending", { cancel_pi_id: piId }, { cause: "user", detail: { reason: "renewal_refund_deletes_name", renewal: true } })) ? "moved" as const : "lost" as const;
    });
    if (moved === "cap") throw new RefundDenied("refund_cap");
    if (moved !== "moved") throw new RefundDenied("not_refundable");
    await advance(m, o.id);
    const out = (await loadOrder(ctx.cron, o.id))!;
    await afterNameRefund(ctx, out, d.id, d.fqdn);
    return out;
  }
  throw new RefundDenied("not_refundable");
}

/** Refunds booked in the window plus refunds in flight (refund_pending with no refund row yet), counted the way the orders module counts them. */
async function refundsInWindow(c: Q, userId: string, since: Date): Promise<number> {
  const r = await c.query(
    `select (select count(*) from refunds where user_id = $1 and created_at >= $2)
          + (select count(*) from orders x where x.user_id = $1 and x.state = 'refund_pending' and not exists (select 1 from refunds r where r.order_id = x.id)) as n`,
    [userId, since]);
  return Number(r.rows[0].n);
}

async function termOfOrder(ctx: AppContext, orderId: string): Promise<TermRow | null> {
  const r = await ctx.cron.query("select * from renewal_terms where order_id = $1", [orderId]);
  return r.rows[0] ? rowToTerm(r.rows[0]) : null;
}

function translate(e: unknown): unknown {
  if (e instanceof RefundRefused) return new RefundDenied(e.code);
  return e;
}

/** The money is back: the name leaves the account (a refunded name is deleted inside the add grace period, or a person is asked to). */
async function afterNameRefund(ctx: AppContext, o: OrderRow, domainId: string, fqdn: string): Promise<void> {
  if (o.state !== "refunded" && o.state !== "partially_refunded") return;
  const svc = svcOf(ctx);
  let deleted = false;
  if (svc.deleteDomain) { try { await svc.deleteDomain(fqdn); deleted = true; } catch { deleted = false; } }
  await releaseDomain(ctx, domainId, "refunded");
  if (!deleted) await tx(ctx.cron, (c) => raiseAlert(ctx, c, { severity: "page", kind: "manual_domain_delete_required", subject: o.id, detail: { order_id: o.id, reason: "refund" } }));
}

/**
 * C-29: a renewal charged without a valid mandate is refunded in full and the domain is kept. Operator-only (no customer route): it refuses a
 * charge the person asked for with Renew now, and one a live mandate covered when it was made.
 */
export async function refundChargeWithoutMandate(ctx: AppContext, orderId: string, operator: string): Promise<"refunded" | "covered_by_mandate" | "asked_for" | "not_a_renewal_charge"> {
  const o = await loadOrder(ctx.cron, orderId);
  if (!o || o.kind !== "renew" || !o.domainId || !["renewing_upstream", "renewed"].includes(o.state)) return "not_a_renewal_charge";
  if ((await ctx.cron.query("select 1 from order_events where order_id = $1 and detail->>'manual_renew' = 'true' limit 1", [o.id])).rowCount) return "asked_for";
  const covered = (await ctx.cron.query(
    "select 1 from renewal_mandates where domain_id = $1 and accepted_at <= $2 and (revoked_at is null or revoked_at > $2) limit 1", [o.domainId, o.createdAt])).rowCount;
  if (covered) return "covered_by_mandate";
  const m = machine(ctx);
  if (o.state === "renewing_upstream") {
    const d = (await loadDomain(ctx.cron, o.domainId))!;
    const c0 = await cancelDraftRenewals(registrarOf(ctx), d.fqdn);
    if (c0.completed) { await advanceRenewal(m, o.id); return refundChargeWithoutMandate(ctx, orderId, operator); }
    await startRefund(m, o, await termOfOrder(ctx, o.id), "requested");
  } else {
    if (!o.paymentIntentId) return "not_a_renewal_charge";
    const moved = await tx(ctx.cron, (c) => move(m, c, o.id, "renewed", "refund_pending", { cancel_pi_id: o.paymentIntentId }, { cause: "system", detail: { reason: "no_valid_mandate", operator_ref: operator.slice(0, 40), renewal: true } }));
    if (!moved) return "not_a_renewal_charge";
    await advance(m, o.id);
  }
  return "refunded";
}
