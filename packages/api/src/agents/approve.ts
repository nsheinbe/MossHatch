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
import type { OrderRow } from "../orders/types.ts";
import { approvedZonePlan } from "./dns.ts";
import { mapRegistrarError, notifyDomainEvent } from "../domain-mgmt/common.ts";
import { writeZoneLocked, type ZoneWriter } from "../domain-mgmt/dns.ts";
import { approvalExpired, confirmRule, expireIfDue, loadRequest, priceRegistration, priceRenewal, voidRequest, type RequestRow } from "./requests.ts";
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

type Pay = { order_id: string | null; checkout_url: string | null };

/**
 * The order and its Checkout for an approved request. Idempotent (key `agent:<request>`), so a lost response, a second tab
 * or the "Pay now" button later all reach the same order and the same Session. A refusal from the order path (the name was
 * taken, a new-account limit, no registrant contact, a quote or terms that changed since the approval) fails the request,
 * which releases its reservation. The order never charges more than was signed: one priced higher gets no Checkout URL.
 * Pay now and the sweeper's expiry of an approval nobody paid for (ST-74) meet on the request row: see `withApproval`.
 */
async function checkoutFor(req: HandlerReq, userId: string, r: RequestRow, actionId: string, later = false): Promise<Pay> {
  const { ctx } = req;
  try {
    await withUser(ctx.runtime, userId, (c) => assertAgentPurchasesOpen(c));
    if (later) await assertStillAsSigned(ctx, userId, r, actionId);
    if (r.kind === "register") {
      const res = await withApproval(ctx, userId, r, () => createOrder(ctx, { userId, fqdn: r.fqdn_ascii, years: r.years, idempotencyKey: `agent:${r.id}`, ipPrefix: req.ipPrefix, uaFamily: req.uaFamily, assertionActionId: actionId, agentRequestId: r.id }));
      if (exceedsSigned(res.order, r)) throw new HttpError(409, "price_changed", undefined, NO_STORE);
      await linkOrder(ctx, userId, r.id, res.order.id);
      return { order_id: res.order.id, checkout_url: res.checkoutUrl };
    }
    const order = await withApproval(ctx, userId, r, () => renewalOrder(ctx, userId, r));
    await linkOrder(ctx, userId, r.id, order.id);
    return await renewalCheckout(ctx, order, req);
  } catch (e) {
    if (e instanceof HttpError && e.status < 500 && !KEEPS_APPROVAL.has(e.code)) await failApproval(ctx, userId, r.id, e.code);
    throw e;
  }
}

/** Refusals that leave the approval as it is: a limit to wait out, a request no longer approved, an approval the sweeper expires. */
const KEEPS_APPROVAL = new Set(["rate_limited", "request_unavailable", "request_expired"]);

/**
 * Make the order for an approved request while holding the request row (`for update`), after checking under that lock that the
 * request is still approved and its approval not past its time. The sweeper expires an approval only under the same lock, and only
 * when no order points at the request (`expireDue`). Whichever comes second sees what the first did, with no margin of time involved:
 * an expired approval never yields an order, and an approval with an order is never expired (the order settles or releases the
 * reservation). When an order already exists for the request, nothing new is made, so `make` replays it after the lock is released: a
 * replay may update that order, and a change of the order's state locks this row (the settle trigger), so it never runs under the lock.
 */
async function withApproval<T>(ctx: AppContext, userId: string, r: RequestRow, make: () => Promise<T>): Promise<T> {
  const held = await withUser(ctx.runtime, userId, async (g): Promise<{ made: true } | { made: false; out: T }> => {
    const cur = await loadRequest(g, userId, r.id, true);
    if (!cur || cur.state !== "approved") throw new HttpError(409, cur?.state === "expired" ? "request_expired" : "request_unavailable", undefined, NO_STORE);
    // A statement after the lock, so an order that a racing Pay now committed is seen.
    const made = !!cur.order_id || !!(await g.query("select 1 from orders where user_id = $1 and (agent_request_id = $2 or idempotency_key = $3) limit 1", [userId, r.id, `agent:${r.id}`])).rowCount;
    if (made) return { made: true };
    if (approvalExpired(cur, ctx.clock.now())) throw new HttpError(409, "request_expired", undefined, NO_STORE);
    return { made: false, out: await make() };
  });
  return held.made ? make() : held.out;
}

const linkOrder = (ctx: AppContext, userId: string, requestId: string, orderId: string) =>
  withUser(ctx.runtime, userId, (c) => c.query("update agent_requests set order_id = $2 where id = $1 and order_id is null", [requestId, orderId]));

/**
 * A refusal from the order path fails the request; the trigger releases its reservation on the move to `failed`. Under the request row
 * lock, then a fresh statement, and only while no order points at the request: an order that exists settles or releases it itself.
 */
async function failApproval(ctx: AppContext, userId: string, requestId: string, code: string): Promise<void> {
  await withUser(ctx.runtime, userId, async (c) => {
    await c.query("select 1 from agent_requests where id = $1 and user_id = $2 for update", [requestId, userId]);
    await c.query(
      "update agent_requests r set state = 'failed', decision_reason = $2 where r.id = $1 and r.state = 'approved' and r.order_id is null and not exists (select 1 from orders o where o.agent_request_id = r.id)",
      [requestId, `order_${code}`.slice(0, 40).replace(/[^a-z_]/g, "_")]);
  });
}

/** The renewal order for an approved renewal, claimed for the request (made under the request row lock by `withApproval`). */
async function renewalOrder(ctx: AppContext, userId: string, r: RequestRow): Promise<OrderRow> {
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
  return order;
}

/** Renewals approved for an agent are paid on Checkout too: off-session charging is never used for agent purchases in v1. */
async function renewalCheckout(ctx: AppContext, order: OrderRow, req: HandlerReq): Promise<Pay> {
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
  // An approval that waited too long for its order makes none now (ST-74): the sweeper expires it and releases the reservation.
  // An order already made for it (even one not yet linked) is still reached, below.
  if (approvalExpired(r, ctx.clock.now()) && !(await withUser(ctx.runtime, userId, (c) => c.query("select 1 from orders where user_id = $1 and agent_request_id = $2", [userId, r.id]))).rowCount) {
    throw new HttpError(409, "request_expired", undefined, NO_STORE);
  }
  const actionId = (await withUser(ctx.runtime, userId, (c) => c.query("select decided_by_action_id from agent_requests where id = $1", [r.id]))).rows[0]?.decided_by_action_id as string;
  if (r.order_id) {
    const o = await loadOrder(ctx.cron, r.order_id);
    if (o && o.kind === "register") { const s = await ensureSession(ctx, ordersSvc(ctx), o); return json({ id: r.id, order_id: o.id, checkout_url: s.url }, 200, { headers: NO_STORE }); }
  }
  return json({ id: r.id, ...(await checkoutFor(req, userId, r, actionId, true)) }, 200, { headers: NO_STORE });
}

/**
 * The approval's claim on a DNS request, in the transaction that commits the pre-write snapshot (so before the registrar is called and
 * before any audit row of that transaction), in the one lock order: the user's agent lock, the request, the binding. The request must
 * still be pending, unexpired and its binding live; it becomes `approved` by this assertion. `decline` locks the same row first, so
 * whichever of the two commits second sees the other's result.
 */
async function claimDnsRequest(ctx: AppContext, c: PoolClient, userId: string, requestId: string, actionId: string): Promise<void> {
  await lockUser(c, userId);
  const r = await loadRequest(c, userId, requestId, true);
  if (!r || r.kind !== "dns_change") throw notFound();
  if (r.state !== "pending") throw new HttpError(409, "request_unavailable");
  const now = ctx.clock.now();
  if (new Date(r.expires_at) <= now) throw new HttpError(409, "request_expired");
  if (!(await liveBinding(c, userId, r.binding_id, now, true))) throw new HttpError(409, "binding_unavailable");
  await markApproved(ctx, c, userId, r, actionId, "approved");
}

/**
 * The person approving an agent's sensitive DNS change: the snapshot and the audit name the person; the notice for an applied change is
 * sent from `after` with the approval (null here), and the one for a write whose outcome is unknown says it may have landed.
 */
const approvalWriter = (userId: string): ZoneWriter => ({
  snapshotKind: "user", actorKind: "user", actorId: userId,
  notice: ({ fqdn, sensitive, maybe }) => maybe
    ? { subject: "A sensitive DNS record on your Mosshatch domain may have changed", text: `You approved a change from one of your tokens to ${sensitive.length} sensitive DNS record${sensitive.length === 1 ? "" : "s"} on ${fqdn}. It may have been applied: our registrar did not confirm it. You can roll it back from the DNS tab, under History.` }
    : null,
});

/**
 * POST /approvals/:id/approve-dns (`dns.sensitive.approve`). Applies exactly the zone that was signed, or nothing.
 * 1. `settle` consumes the assertion and re-checks the request, and commits: one assertion is spent on one write, whatever happens next.
 * 2. `writeZoneLocked` (the DNS tab's write safety): under the zone lock, a fresh read must still hash to the signed before-hash and the
 *    zone written is the signed after-zone. In the transaction that commits the pre-write snapshot, before the registrar is called, the
 *    approval claims the request (`claimDnsRequest`: pending to approved under the request row lock), so approve and decline serialise
 *    on that row and exactly one wins: a decline that came first leaves nothing to claim and nothing is written; one that comes later
 *    finds the request approved and gets 409, and the write goes on. A write whose outcome is unknown keeps its snapshot (`unknown`) for
 *    rollback and the request stays approved; a refused write changed nothing and fails the request; an applied one marks the snapshot
 *    applied and the request completed, audited and announced, in one transaction (`after`).
 */
export async function approveDnsHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = sessionUserOf(req);
  const action = requireAction(req, "dns.sensitive.approve");
  const p = action.params as { route?: string; request_id: string; before_hash: string; after_hash: string };
  if (p.route !== "agent_request" || !UUID.test(req.params.id ?? "") || p.request_id !== req.params.id) throw notFound();
  const s = await withUser(ctx.runtime, userId, async (c): Promise<Settled> => {
    const st = await settle(ctx, c, userId, { id: action.id, type: "dns.sensitive.approve" }, p.request_id, ["dns_change"]);
    if (!("ok" in st)) return st;
    if (st.ok.params.before_hash !== p.before_hash || st.ok.params.after_hash !== p.after_hash) return { refuse: "params_changed", status: 409 };
    return st;
  });
  if (!("ok" in s)) throw new HttpError(s.status, s.refuse);
  const r = s.ok;
  if (!r.domain_id) throw notFound();
  let w;
  try {
    w = await writeZoneLocked(ctx, userId, r.domain_id, approvalWriter(userId), (live, d) => approvedZonePlan(d.fqdn_ascii, { before_hash: p.before_hash, after_hash: p.after_hash, desired: r.params.desired })(live), {
      detail: { actor: "user" },
      claim: (c) => claimDnsRequest(ctx, c, userId, r.id, action.id),
      // Refused: nothing changed, so the approval ends here (the agent can propose again). Unknown: it stays approved, with its snapshot.
      failed: async (c, outcome) => {
        if (outcome === "refused") await c.query("update agent_requests set state = 'failed', decision_reason = 'write_refused' where id = $1 and state = 'approved' and decided_by_action_id = $2", [r.id, action.id]);
      },
      after: async (c, done) => {
        // Never a refusal here: the zone is written, so the snapshot must reach `applied` whatever this finds.
        await c.query("update agent_requests set state = 'completed' where id = $1 and state = 'approved' and decided_by_action_id = $2", [r.id, action.id]);
        await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "dns.sensitive_approved", resourceKind: "agent_request", resourceId: r.id, detail: { action_id: action.id, snapshot: done.snapshotId } });
        const n = done.change?.sensitive.length ?? 0;
        await notifyDomainEvent(ctx, c, userId, {
          kind: "dns.sensitive_changed", domainId: done.domain.id, subject: "A sensitive DNS record on your Mosshatch domain changed",
          text: `You approved a change from one of your tokens that touched ${n} sensitive DNS record${n === 1 ? "" : "s"} on ${done.domain.fqdn_ascii}. You can roll it back from the DNS tab, under History.`,
        });
      },
    });
  } catch (e) {
    if (e instanceof HttpError && (e.code === "zone_changed" || e.code === "params_changed")) {
      // The zone moved since the request: nothing is written, the request is void and the assertion is spent.
      await voidRequest(ctx, userId, r.id, "zone_changed");
      throw new HttpError(409, "zone_changed");
    }
    throw mapRegistrarError(e);
  }
  return json({ id: p.request_id, state: "applied", zone_hash: w.zoneHash, snapshot_id: w.snapshotId });
}
