import { z } from "zod";
import { domainToUnicode } from "node:url";
import { tx, withUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { appendAudit } from "../audit.ts";
import { hashOf, safeEqual } from "../util/bytes.ts";
import { markExecuted, requireAction } from "../stepup/gate.ts";
import { registerActionSpec, type ActionSpec } from "../stepup/specs.ts";
import { createOrder, ensureSession } from "../orders/create.ts";
import { loadOrder, ordersSvc } from "../orders/support.ts";
import { TLD_ADDENDA } from "../orders/create.ts";
import { rowToDomain } from "../domains/common.ts";
import { ensureTerm } from "../domains/terms.ts";
import { ensureRenewalOrder, startRenewalCheckout } from "../domains/renewals.ts";
import { StripeError } from "../stripe/port.ts";
import { applyApprovedDns } from "./dns.ts";
import { confirmRule, expireIfDue, loadRequest, priceRegistration, priceRenewal, voidRequest, type RequestRow } from "./requests.ts";
import { assertAgentPurchasesOpen, liveBinding, lockUser, notFound, sessionUserOf, UUID } from "./common.ts";
import { approvedNotice } from "./notices.ts";
import { registerRoutedSpec } from "./specs.ts";

/**
 * Deciding with a passkey (PLAN 4.5 step-up table): `agent.purchase.approve` binds the request, the binding, the domain, the
 * years, the subtotal, the tax ceiling, the currency, the quote hash and the terms hash; `dns.sensitive.approve` binds the
 * request and the before and after zone hashes. One assertion approves one request (`request_id` is in the signed params
 * and `decided_by_action_id` is unique). Approval binds no payment method and charges nothing: the order is created in
 * `checkout_open` with one Stripe Checkout Session, and the Checkout URL goes only to the approving cookie session.
 */

const NO_STORE = { "Cache-Control": "no-store, private", Pragma: "no-cache" };
const usd = (minor: string) => { const s = minor.padStart(3, "0"); return `USD ${s.slice(0, -2)}.${s.slice(-2)}`; };

/** The documents an approval accepts on the person's behalf: the ones in force now (C-12, C-14). */
async function termsHash(c: PoolClient, now: Date, tld: string): Promise<string> {
  const addendum = TLD_ADDENDA[tld];
  const docs = (await c.query(
    "select distinct on (kind) kind, version_hash from document_versions where kind = any($1) and effective_at <= $2 and (retired_at is null or retired_at > $2) order by kind, effective_at desc",
    [["terms", "registration_agreement", ...(addendum ? [addendum] : [])], now])).rows;
  const byKind = Object.fromEntries(docs.map((d) => [d.kind, d.version_hash]));
  if (!byKind.terms || !byKind.registration_agreement || (addendum && !byKind[addendum])) throw new HttpError(503, "documents_unavailable");
  return hashOf(byKind).toString("hex");
}

const typedMatches = (typed: string | undefined, fqdn: string) => {
  if (!typed) return false;
  const t = typed.normalize("NFC").trim().toLowerCase().replace(/\.$/, "");
  let uni = fqdn; try { uni = domainToUnicode(fqdn) || fqdn; } catch { /* ascii only */ }
  return t === fqdn || t === uni.normalize("NFC").toLowerCase();
};

const purchaseInput = z.strictObject({ typed_domain: z.string().max(300).optional() });

export const purchaseApproveSpec: ActionSpec<z.infer<typeof purchaseInput>> = {
  type: "agent.purchase.approve", held: true, userInput: purchaseInput,
  async derive(ctx, c, userId, targetId, input) {
    const r = await loadRequest(c, userId, targetId);
    if (!r || (r.kind !== "register" && r.kind !== "renew")) throw notFound();
    if (r.state !== "pending") throw new HttpError(409, "request_unavailable");
    const now = ctx.clock.now();
    if (new Date(r.expires_at) <= now) { await expireIfDue(ctx, userId, r); throw new HttpError(409, "request_expired"); }
    const b = await liveBinding(c, userId, r.binding_id, now);
    if (!b) throw new HttpError(409, "binding_unavailable");
    await assertAgentPurchasesOpen(c);
    const pr = r.kind === "register" ? await priceRegistration(ctx, c, r.fqdn_ascii!, r.years!) : await priceRenewal(ctx, c, r.fqdn_ascii!, r.years!);
    if (!r.price_hash || !safeEqual(pr.priceHash, Buffer.from(r.price_hash))) { await voidRequest(ctx, userId, r.id, "price_changed"); throw new HttpError(409, "price_changed"); }
    const confirm = await confirmRule(c, userId, r);
    if (confirm.required && !typedMatches(input.typed_domain, pr.fqdn)) throw new HttpError(422, "typed_confirmation_required", undefined, undefined, { reasons: confirm.reasons });
    // A registration needs the registrant contact: asked for before the passkey, so an approval never fails on it afterwards.
    if (r.kind === "register") {
      const svc = (ctx.services as { orders?: { registrant(ctx: unknown, userId: string): Promise<unknown> } }).orders;
      if (svc && !(await svc.registrant(ctx, userId))) throw new HttpError(422, "contact_required");
    }
    return {
      params: {
        route: "agent_request", request_id: r.id, binding_id: r.binding_id, binding_name: b.name, kind: r.kind, domain: pr.fqdn, years: pr.years,
        subtotal_minor: pr.quote.subtotalMinor.toString(), tax_ceiling_minor: pr.quote.taxCeilingMinor.toString(), total_minor: pr.quote.totalMinor.toString(), currency: "usd",
        quote_hash: pr.priceHash.toString("hex"), terms_hash: await termsHash(c, now, pr.tld), typed: confirm.required,
      },
      resourceId: r.id,
    };
  },
  summary: (p) => `Approve your token "${String(p.binding_name)}" to ${p.kind === "renew" ? "renew" : "register"} ${String(p.domain)} for ${String(p.years)} ${p.years === 1 ? "year" : "years"}, up to ${usd(String(p.total_minor))} including tax. You pay on Stripe next. Nothing is charged until you do.`,
};

export const dnsApproveSpec: ActionSpec<Record<string, never>> = {
  type: "dns.sensitive.approve", held: true, userInput: z.strictObject({}),
  async derive(ctx, c, userId, targetId) {
    const id = targetId.slice(3);
    const r = await loadRequest(c, userId, id);
    if (!r || r.kind !== "dns_change") throw notFound();
    if (r.state !== "pending") throw new HttpError(409, "request_unavailable");
    const now = ctx.clock.now();
    if (new Date(r.expires_at) <= now) { await expireIfDue(ctx, userId, r); throw new HttpError(409, "request_expired"); }
    const b = await liveBinding(c, userId, r.binding_id, now);
    if (!b) throw new HttpError(409, "binding_unavailable");
    return {
      params: { route: "agent_request", request_id: r.id, binding_id: r.binding_id, binding_name: b.name, domain: r.params.fqdn, request_hash: Buffer.from(r.request_hash).toString("hex"), before_hash: r.params.before_hash, after_hash: r.params.after_hash, sensitive: (r.params.sensitive as unknown[]).length },
      resourceId: r.id,
    };
  },
  summary: (p) => `Apply the DNS change your token "${String(p.binding_name)}" asked for on ${String(p.domain)}. It touches ${String(p.sensitive)} sensitive record${p.sensitive === 1 ? "" : "s"} that control mail, certificates or where the domain points.`,
};

export function registerApprovalSpecs(): void {
  registerActionSpec(purchaseApproveSpec);
  registerRoutedSpec("dns.sensitive.approve", (t) => /^ar_[0-9a-f-]{36}$/i.test(t), "agent_request", dnsApproveSpec as ActionSpec);
}

// ---- the gated routes ----------------------------------------------------------------------------------------------------------

type Settled = { ok: RequestRow } | { refuse: string; status: number };

/** Common part of both approvals: consume the action, lock, re-check, and move `pending` to `approved` in one transaction. */
async function settle(ctx: AppContext, c: PoolClient, userId: string, action: { id: string; type: "agent.purchase.approve" | "dns.sensitive.approve" }, requestId: string, kinds: string[]): Promise<Settled> {
  await markExecuted(c, action);
  await lockUser(c, userId);
  const r = await loadRequest(c, userId, requestId, true);
  if (!r || !kinds.includes(r.kind)) throw notFound();
  if (r.state !== "pending") return { refuse: "request_unavailable", status: 409 };
  const now = ctx.clock.now();
  if (new Date(r.expires_at) <= now) {
    await c.query("update agent_requests set state = 'expired', decision_reason = 'expired', decided_at = $2 where id = $1 and state = 'pending'", [r.id, now]);
    return { refuse: "request_expired", status: 409 };
  }
  if (!(await liveBinding(c, userId, r.binding_id, now, true))) {
    // Revoked (or expired) is final: the request becomes void and its reservation is released. Paused waits for a resume.
    const b = (await c.query("select revoked_at, paused_at, expires_at, family_expires_at from bindings where id = $1", [r.binding_id])).rows[0];
    if (b && (b.revoked_at || new Date(b.family_expires_at ?? b.expires_at) <= now)) await c.query("update agent_requests set state = 'void', decision_reason = 'binding_revoked', decided_at = $2 where id = $1 and state = 'pending'", [r.id, now]);
    return { refuse: "binding_unavailable", status: 409 };
  }
  return { ok: r };
}

async function markApproved(ctx: AppContext, c: PoolClient, userId: string, r: RequestRow, actionId: string, to: "approved" | "completed"): Promise<void> {
  const u = await c.query("update agent_requests set state = $3, decided_at = $4, decided_by_action_id = $2, decision_reason = 'owner' where id = $1 and state = 'pending'", [r.id, actionId, to, ctx.clock.now()]);
  if (u.rowCount !== 1) throw new HttpError(409, "request_unavailable");
  await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "agent.request.approved", resourceKind: "agent_request", resourceId: r.id, detail: { kind: r.kind, action_id: actionId, binding_id: r.binding_id } });
}

/** POST /approvals/:id/decide (`agent.purchase.approve`). */
export async function decideHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = sessionUserOf(req);
  const action = requireAction(req, "agent.purchase.approve");
  const p = action.params as { request_id: string; quote_hash: string; kind: string };
  if (!UUID.test(req.params.id ?? "") || p.request_id !== req.params.id) throw notFound();
  const out = await withUser(ctx.runtime, userId, async (c): Promise<Settled> => {
    const s = await settle(ctx, c, userId, { id: action.id, type: "agent.purchase.approve" }, p.request_id, ["register", "renew"]);
    if (!("ok" in s)) return s;
    const r = s.ok;
    // Only if the quote is unchanged: a price change voids the request and the action is spent (ST-77, ST-61).
    const pr = r.kind === "register" ? await priceRegistration(ctx, c, r.fqdn_ascii!, r.years!) : await priceRenewal(ctx, c, r.fqdn_ascii!, r.years!);
    if (pr.priceHash.toString("hex") !== p.quote_hash || !r.price_hash || !safeEqual(pr.priceHash, Buffer.from(r.price_hash))) {
      await c.query("update agent_requests set state = 'void', decision_reason = 'price_changed', decided_at = $2 where id = $1 and state = 'pending'", [r.id, ctx.clock.now()]);
      return { refuse: "price_changed", status: 409 };
    }
    await markApproved(ctx, c, userId, r, action.id, "approved");
    const b = (await c.query("select name from bindings where id = $1", [r.binding_id])).rows[0];
    await approvedNotice(ctx, c, userId, r.id, { bindingName: b.name, kind: r.kind, fqdn: r.fqdn_ascii, years: r.years, totalMinor: BigInt(r.quoted_minor) });
    return s;
  });
  if (!("ok" in out)) throw new HttpError(out.status, out.refuse, undefined, NO_STORE);
  const pay = await checkoutFor(req, userId, out.ok, action.id);
  return json({ id: out.ok.id, state: "approved_awaiting_payment", ...pay }, 200, { headers: NO_STORE });
}

/** An order that would charge more than the passkey signed for (subtotal, tax ceiling or maximum total). */
const exceedsSigned = (o: { subtotalMinor: bigint; taxCeilingMinor: bigint; totalMinor: bigint }, r: RequestRow) =>
  o.subtotalMinor > BigInt(r.params.subtotal_minor ?? 0) || o.taxCeilingMinor > BigInt(r.params.tax_ceiling_minor ?? 0) || o.totalMinor > BigInt(r.quoted_minor);

/**
 * Before "Pay now" makes the order for an approval given earlier, the quote and the documents must still be the ones the
 * passkey signed (the approval binds the quote hash and the terms hash; C-12, C-14). A change is a 409 that fails the
 * request and releases its reservation; the agent can propose again. An order already made keeps the amounts it was made with.
 */
async function assertStillAsSigned(ctx: AppContext, userId: string, r: RequestRow, actionId: string): Promise<void> {
  const refusal = await withUser(ctx.runtime, userId, async (c) => {
    const made = r.kind === "register"
      ? (await c.query("select 1 from orders where user_id = $1 and idempotency_key = $2", [userId, `agent:${r.id}`])).rowCount
      : (r.order_id ? 1 : 0);
    if (made) return null;
    const signed = UUID.test(actionId ?? "")
      ? (await c.query("select params from actions where id = $1 and user_id = $2 and type = 'agent.purchase.approve'", [actionId, userId])).rows[0]?.params as Record<string, unknown> | undefined
      : undefined;
    if (!signed || signed.request_id !== r.id) return "price_changed";
    const pr = r.kind === "register" ? await priceRegistration(ctx, c, r.fqdn_ascii!, r.years!) : await priceRenewal(ctx, c, r.fqdn_ascii!, r.years!);
    if (!r.price_hash || !safeEqual(pr.priceHash, Buffer.from(r.price_hash)) || signed.quote_hash !== pr.priceHash.toString("hex")) return "price_changed";
    if (signed.terms_hash !== await termsHash(c, ctx.clock.now(), pr.tld)) return "terms_changed";
    return null;
  });
  if (refusal) throw new HttpError(409, refusal, undefined, NO_STORE);
}

/**
 * The order and its Checkout for an approved request. Idempotent (key `agent:<request>`), so a lost response, a second tab
 * or the "Pay now" button later all reach the same order and the same Session. A refusal from the order path (the name was
 * taken, a new-account limit, no registrant contact, a quote or terms that changed since the approval) fails the request,
 * which releases its reservation. The order never charges more than was signed: one priced higher gets no Checkout URL.
 */
async function checkoutFor(req: HandlerReq, userId: string, r: RequestRow, actionId: string, later = false): Promise<{ order_id: string | null; checkout_url: string | null }> {
  const { ctx } = req;
  try {
    await withUser(ctx.runtime, userId, (c) => assertAgentPurchasesOpen(c));
    if (later) await assertStillAsSigned(ctx, userId, r, actionId);
    if (r.kind === "register") {
      const res = await createOrder(ctx, { userId, fqdn: r.fqdn_ascii, years: r.years, idempotencyKey: `agent:${r.id}`, ipPrefix: req.ipPrefix, uaFamily: req.uaFamily, assertionActionId: actionId, agentRequestId: r.id });
      if (exceedsSigned(res.order, r)) throw new HttpError(409, "price_changed", undefined, NO_STORE);
      await withUser(ctx.runtime, userId, (c) => c.query("update agent_requests set order_id = $2 where id = $1 and order_id is null", [r.id, res.order.id]));
      return { order_id: res.order.id, checkout_url: res.checkoutUrl };
    }
    return await renewalCheckout(ctx, userId, r, req);
  } catch (e) {
    if (e instanceof HttpError && e.status < 500 && e.code !== "rate_limited") {
      // The release of the reservation happens in the database trigger on the move to `failed`.
      await withUser(ctx.runtime, userId, (c) => c.query("update agent_requests set state = 'failed', decision_reason = $2 where id = $1 and state = 'approved' and order_id is null",
        [r.id, `order_${e.code}`.slice(0, 40).replace(/[^a-z_]/g, "_")]));
    }
    throw e;
  }
}

/** Renewals approved for an agent are paid on Checkout too: off-session charging is never used for agent purchases in v1. */
async function renewalCheckout(ctx: AppContext, userId: string, r: RequestRow, req: HandlerReq): Promise<{ order_id: string | null; checkout_url: string | null }> {
  const row = await withUser(ctx.runtime, userId, async (c) => (await c.query("select * from domains where id = $1 and user_id = $2 and released_at is null", [r.domain_id, userId])).rows[0]);
  if (!row) throw notFound();
  const d = rowToDomain(row);
  const term = await tx(ctx.cron, (c) => ensureTerm(c, d, ctx.clock.now()));
  if (!term) throw new HttpError(503, "no_price");
  if (term.state === "renewed") throw new HttpError(409, "already_renewed");
  const order = await ensureRenewalOrder(ctx, term, d);
  if (!order) throw new HttpError(503, "no_price");
  if (exceedsSigned(order, r)) throw new HttpError(409, "price_changed", undefined, NO_STORE);
  const claimed = await ctx.cron.query("update orders set agent_request_id = $2 where id = $1 and (agent_request_id is null or agent_request_id = $2) returning id", [order.id, r.id]);
  if (!claimed.rowCount) throw new HttpError(409, "renewal_in_progress");
  await withUser(ctx.runtime, userId, (c) => c.query("update agent_requests set order_id = $2 where id = $1 and order_id is null", [r.id, order.id]));
  if (order.state !== "draft") return { order_id: order.id, checkout_url: null };
  let url: string | null = null;
  try { url = await startRenewalCheckout(ctx, order, { ipPrefix: req.ipPrefix, uaFamily: req.uaFamily }); }
  catch (e) { if (e instanceof StripeError) throw new HttpError(503, "payment_unavailable"); throw e; }
  return { order_id: order.id, checkout_url: url };
}

/** POST /approvals/:id/checkout (session): the Checkout for an approved request, again. Never reachable by a bearer. */
export async function checkoutHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = sessionUserOf(req);
  const r = await withUser(ctx.runtime, userId, (c) => loadRequest(c, userId, req.params.id ?? ""));
  if (!r || (r.kind !== "register" && r.kind !== "renew")) throw notFound();
  if (r.state !== "approved" || !r.params) throw new HttpError(409, "request_unavailable", undefined, NO_STORE);
  const actionId = (await withUser(ctx.runtime, userId, (c) => c.query("select decided_by_action_id from agent_requests where id = $1", [r.id]))).rows[0]?.decided_by_action_id as string;
  if (r.order_id) {
    const o = await loadOrder(ctx.cron, r.order_id);
    if (o && o.kind === "register") { const s = await ensureSession(ctx, ordersSvc(ctx), o); return json({ id: r.id, order_id: o.id, checkout_url: s.url }, 200, { headers: NO_STORE }); }
  }
  return json({ id: r.id, ...(await checkoutFor(req, userId, r, actionId, true)) }, 200, { headers: NO_STORE });
}

/** POST /approvals/:id/approve-dns (`dns.sensitive.approve`). Applies exactly the zone that was signed, or nothing. */
export async function approveDnsHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = sessionUserOf(req);
  const action = requireAction(req, "dns.sensitive.approve");
  const p = action.params as { route?: string; request_id: string; before_hash: string; after_hash: string };
  if (p.route !== "agent_request" || !UUID.test(req.params.id ?? "") || p.request_id !== req.params.id) throw notFound();
  const out = await withUser(ctx.runtime, userId, async (c): Promise<Settled | { done: Awaited<ReturnType<typeof applyApprovedDns>> }> => {
    const s = await settle(ctx, c, userId, { id: action.id, type: "dns.sensitive.approve" }, p.request_id, ["dns_change"]);
    if (!("ok" in s)) return s;
    const r = s.ok;
    if (r.params.before_hash !== p.before_hash || r.params.after_hash !== p.after_hash) return { refuse: "params_changed", status: 409 };
    await c.query("savepoint dns_apply");
    try {
      await markApproved(ctx, c, userId, r, action.id, "completed");
      return { done: await applyApprovedDns(ctx, c, userId, r, action.id) };
    } catch (e) {
      if (e instanceof HttpError && (e.code === "zone_changed" || e.code === "params_changed")) {
        // The zone moved since the request: nothing is written, the request is void and the assertion is spent.
        await c.query("rollback to savepoint dns_apply");
        await c.query("update agent_requests set state = 'void', decision_reason = 'zone_changed', decided_at = $2 where id = $1 and state = 'pending'", [r.id, ctx.clock.now()]);
        return { refuse: "zone_changed", status: 409 };
      }
      throw e;
    }
  });
  if ("refuse" in out) throw new HttpError(out.status, out.refuse);
  if (!("done" in out)) throw new HttpError(500, "internal");
  return json({ id: p.request_id, state: "applied", ...out.done });
}
