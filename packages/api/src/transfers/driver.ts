import crypto from "node:crypto";
import { tx, type PoolClient } from "@mosshatch/db";
import { RegistrarError, type TransferDenialReason, type TransferInState } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { LeaseLostError } from "../jobs/engine.ts";
import { hashOf } from "../util/bytes.ts";
import { buildQuote, PricingError } from "../pricing/index.ts";
import { StripeError } from "../stripe/port.ts";
import { advance, closeOrderSession, closePayLinks, machine, move, type M, type OrderStep } from "../orders/machine.ts";
import { alert, backoffMs, loadOrder } from "../orders/support.ts";
import { FALLBACK_AUTH_WINDOW_MS, MIN_AUTH_WINDOW_MS, type OrderRow, type OrderState } from "../orders/types.ts";
import {
  EARLY_CAPTURE_BEFORE_HOLD_END_MS, LATE_WATCH_MS, LIVE_STATES, POLL_EVERY_MS, TIMING_REGISTRY, UNKNOWN_AFTER_MS, timingFor, transferPolicy, type TransferFailure,
} from "./policy.ts";
import { logTransfer, mailUser, transferOfOrder, type TransferRow } from "./store.ts";

/**
 * The transfer-in state machine, driven through the order machine (plan 4.3b, "Order state machine ... transfer-in"). The order machine
 * owns payment (checkout -> authorized) and capture (registered -> captured) and refunds; this driver owns every state in between.
 *
 *   order:    authorized -> registering ............................................ -> registered -> capturing -> captured
 *   transfer: awaiting_payment -> submitting -> submitted -> pending_owner_approval -> pending_registry -> completed
 *                                              \-> failed | nacked | cancelled  (order -> canceling -> voided, or refund_pending if captured)
 *
 * Money: authorize at checkout; capture only when the adapter reports `completed` AND the name reads back as ours. A card hold lasts
 * about seven days and a transfer can take about two weeks, so if the hold is about to end while the transfer is still pending the
 * charge is taken then (the transfer is still shown as pending, never as complete) and refunded in full if the transfer fails.
 *
 * The code: an order operation `transfer` moves intent -> sent in the same transaction that wipes the stored code; the code exists only
 * in memory for the one call. A refusal with no effect (maintenance, rate limit, funds) puts it back for the retry; any other outcome
 * leaves it gone. A `sent` operation is never re-sent, only reconciled by polling.
 */

const now = (m: M) => m.ctx.clock.now();
const cron = (m: M) => m.ctx.cron;

/** A write transaction as the cron role, fenced by the job lease when a job drives the machine. */
const ltx = <T>(m: M, fn: (c: PoolClient) => Promise<T>): Promise<T> => tx(m.ctx.cron, async (c) => {
  if (m.lease) {
    const ok = (await c.query("select job_lease_lock($1, $2, $3) as ok", [m.lease.jobId, m.lease.attemptId, now(m)])).rows[0].ok as boolean;
    if (!ok) throw new LeaseLostError();
  }
  return fn(c);
});

interface Op { id: string; seq: number; state: "intent" | "sent" | "resolved"; sentAt: Date | null; responseCode: string | null; registrarOrderId: string | null }
async function latestOp(q: Pick<PoolClient, "query">, orderId: string): Promise<Op | null> {
  const r = (await q.query("select * from order_operations where order_id = $1 and kind = 'transfer' order by seq desc limit 1", [orderId])).rows[0];
  return r ? { id: r.id, seq: r.seq, state: r.state, sentAt: r.sent_at ? new Date(r.sent_at) : null, responseCode: r.response_code, registrarOrderId: r.registrar_order_id } : null;
}
const insertIntent = (c: PoolClient, o: OrderRow, seq: number) => c.query(
  "insert into order_operations (order_id, kind, seq, request_hash, state) values ($1,'transfer',$2,$3,'intent') on conflict (order_id, kind, seq) do nothing",
  [o.id, seq, hashOf({ fqdn: o.fqdn, years: o.years, reg_username: o.regUsername, kind: "transfer" })]);
const resolveOp = (c: PoolClient, id: string, code: string, registrarOrderId?: string | null) =>
  c.query("update order_operations set state = 'resolved', response_code = $2, registrar_order_id = coalesce($3, registrar_order_id) where id = $1 and state <> 'resolved'", [id, code, registrarOrderId ?? null]);

const flagOn = async (m: M, name: string) => (await cron(m).query("select value from flags where name = $1", [name])).rows[0]?.value === true;
const captureBeforeOf = (o: OrderRow) => o.captureBefore ?? new Date((o.authorizedAt ?? o.createdAt).getTime() + FALLBACK_AUTH_WINDOW_MS);

/** Order states in which the transfer request may still be sent or is out with the registrar (not yet paid in full). */
const PRE_CAPTURE: OrderState[] = ["authorized", "registrar_unavailable", "registering", "outcome_unknown", "paid_before_registration", "review_hold"];
/** Transfer states in which the request is out with the registrar and only its status can move it. */
const UPSTREAM_STATES = ["submitted", "pending_owner_approval", "pending_registry"] as const;

// -------------------------------------------------------------------------------------------------------------------------------
// The order-machine hook
// -------------------------------------------------------------------------------------------------------------------------------

export async function transferDriver(m: M, o: OrderRow): Promise<OrderStep | null> {
  switch (o.state) {
    case "authorized": case "registrar_unavailable": return beginTransfer(m, o);
    case "registering": case "outcome_unknown": case "paid_before_registration": return driveTransfer(m, o);
    case "canceling": return cancelOrder(m, o);
    case "capture_failed": {
      // The capture failed while the transfer may still be pending upstream: keep reading it, so a NACK ends the transfer (and the
      // demand for payment) and a completion writes the domain row, lock and mail, whatever the payment does.
      const t = await transferOfOrder(cron(m), o.id);
      if (t && t.sentAt && (UPSTREAM_STATES as readonly string[]).includes(t.state)) {
        await pollTransfer(m, o, t, await latestOp(cron(m), o.id));
        const after = await loadOrder(cron(m), o.id);
        if (!after || after.state !== "capture_failed") return "progressed";
        o = after;
      }
      // Never delete a name the customer brought with them (the register ladder deletes in the add-grace period): page and wait.
      if (o.captureDeadline && now(m) >= o.captureDeadline) {
        await ltx(m, async (c) => {
          await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "transfer_unpaid" });
          await c.query("update orders set next_check_at = $2 where id = $1 and state = 'capture_failed'", [o.id, new Date(now(m).getTime() + 24 * 3_600_000)]);
        });
        return "wait";
      }
      return null;
    }
    default: return null;
  }
}

// -------------------------------------------------------------------------------------------------------------------------------
// authorized -> registering: re-check the world, then write the intent
// -------------------------------------------------------------------------------------------------------------------------------

async function beginTransfer(m: M, o: OrderRow): Promise<OrderStep> {
  const t = await transferOfOrder(cron(m), o.id);
  if (!t) return "wait";
  const from = o.state as "authorized" | "registrar_unavailable";
  const at = now(m);
  if (t.state !== "awaiting_payment" && t.state !== "submitting") return reconcileMismatch(m, o, t);
  const left = captureBeforeOf(o).getTime() - at.getTime();
  if (from === "registrar_unavailable" ? left <= MIN_AUTH_WINDOW_MS : left < MIN_AUTH_WINDOW_MS) return fail(m, o, t, [from], "auth_window");
  if (from === "registrar_unavailable" && o.nextCheckAt && o.nextCheckAt > at) return "wait";
  if (!o.paymentIntentId) return "wait";
  const svc = m.svc;
  const pi = await svc.stripe.retrievePaymentIntent(o.paymentIntentId);
  if (pi.status === "canceled") return fail(m, o, t, [from], "auth_lost");
  if (pi.review_open) { const r = await ltx(m, (c) => move(m, c, o.id, [from], "review_hold", {}, { cause: "webhook", detail: { review: "opened" } })); return r ? "progressed" : "wait"; }
  if (pi.status === "succeeded") await ltx(m, (c) => alert(m.ctx, c, { orderId: o.id, severity: "warn", kind: "unexpected_capture" }));

  const bump = async (why: string, to: OrderState = from): Promise<OrderStep> => {
    const next = { next_check_at: new Date(at.getTime() + backoffMs(o.checkCount)), check_count: o.checkCount + 1 };
    if (to === from) { await cron(m).query("update orders set next_check_at = $2, check_count = $3 where id = $1 and state = $4", [o.id, next.next_check_at, next.check_count, from]); return "wait"; }
    const r = await ltx(m, (c) => move(m, c, o.id, [from], to, next, { cause: "system", detail: { why } }));
    return r ? "progressed" : "wait";
  };
  if (await flagOn(m, "registrar_writes_paused")) return bump("registrar_writes_paused");
  const health = await svc.registrar.health();
  if (health.status === "maintenance") return bump("maintenance", "registrar_unavailable");

  // The price at fulfilment: any increase stops (no one pays more than the total shown); a premium or non-standard price is refused.
  try {
    const fresh = await ltx(m, (c) => buildQuote(c, { fqdn: o.fqdn, years: o.years, kind: "transfer" }, at));
    if (fresh.subtotalMinor > o.subtotalMinor) return fail(m, o, t, [from], "quote_increased");
    const rq = await svc.registrar.quote(o.fqdn, o.years, "transfer");
    if (rq.isRegistryPremium || rq.wholesale.minor !== fresh.wholesaleMinor) return fail(m, o, t, [from], "price_guard");
  } catch (e) {
    if (e instanceof PricingError) return fail(m, o, t, [from], "price_guard");
    if (e instanceof RegistrarError && e.code === "premium_refused") return fail(m, o, t, [from], "price_guard");
    if (e instanceof RegistrarError) return bump("quote_unavailable", "registrar_unavailable");
    throw e;
  }
  if (!(await svc.registrant(m.ctx, o.userId))) return fail(m, o, t, [from], "no_contact");
  if (!t.hasAuthCode) return fail(m, o, t, [from], "unknown");
  // The pre-transfer check again, right before sending: a name locked or moved since checkout never gets a request.
  try {
    const chk = await svc.registrar.checkTransferIn(o.fqdn);
    if (!chk.transferable) {
      await cron(m).query("update transfers_in set eligibility = eligibility || $2::jsonb where id = $1", [t.id, { recheck: chk.reason ?? "other" }]);
      return fail(m, o, t, [from], "not_transferable");
    }
  } catch (e) {
    if (e instanceof RegistrarError) return bump("check_unavailable", "registrar_unavailable");
    throw e;
  }

  const moved = await ltx(m, async (c) => {
    const row = await move(m, c, o.id, [from], "registering", { next_check_at: null, check_count: 0 }, { cause: "job", detail: { transfer: true } });
    if (!row) return null;
    const last = await latestOp(c, o.id);
    if (!last || last.state === "resolved") await insertIntent(c, o, (last?.seq ?? 0) + 1);
    await c.query("update transfers_in set state = 'submitting' where id = $1 and state in ('awaiting_payment','submitting')", [t.id]);
    return row;
  });
  return moved ? "progressed" : "wait";
}

// -------------------------------------------------------------------------------------------------------------------------------
// registering / outcome_unknown: send once, then reconcile by polling
// -------------------------------------------------------------------------------------------------------------------------------

async function driveTransfer(m: M, o: OrderRow): Promise<OrderStep> {
  const t = await transferOfOrder(cron(m), o.id);
  if (!t) return "wait";
  const op = await latestOp(cron(m), o.id);
  if (!op) {
    await ltx(m, async (c) => { const s = (await c.query("select state from orders where id = $1 for update", [o.id])).rows[0]?.state; if (s === "registering" || s === "paid_before_registration") await insertIntent(c, o, 1); });
    return "progressed";
  }
  if (op.state === "intent") return sendTransfer(m, o, t, op);
  return pollTransfer(m, o, t, op);
}

async function sendTransfer(m: M, o: OrderRow, t: TransferRow, op: Op): Promise<OrderStep> {
  if (o.nextCheckAt && o.nextCheckAt > now(m)) return "wait";
  if (await flagOn(m, "registrar_writes_paused")) return "wait";
  const svc = m.svc;
  const registrant = await svc.registrant(m.ctx, o.userId);
  if (!registrant) return fail(m, o, t, ["registering", "paid_before_registration"], "no_contact");
  const profile = (await cron(m).query("select password_enc from registrar_profiles where order_id = $1", [o.id])).rows[0];
  if (!profile || !o.regUsername) throw new Error("registrar_profile_missing");
  const regPassword = await m.ctx.pii.decrypt(profile.password_enc, `registrar_profile:${o.id}`);
  const at = now(m);

  // Claim the one send and take the code out of storage in the same transaction.
  const claimed = await ltx(m, async (c) => {
    const r = await c.query(
      `update order_operations op set state = 'sent', sent_at = $2, attempt_id = $3::uuid
        where op.id = $1 and op.state = 'intent' and exists (select 1 from orders x where x.id = op.order_id and x.state in ('registering','paid_before_registration')) returning id`,
      [op.id, at, m.attemptId ?? crypto.randomUUID()]);
    if (r.rowCount !== 1) return null;
    const row = (await c.query("select auth_code_enc from transfers_in where id = $1 for update", [t.id])).rows[0];
    if (!row?.auth_code_enc) return { code: null as string | null };
    const code = await m.ctx.pii.decrypt(row.auth_code_enc, `transfer_auth:${t.id}`);
    await c.query("update transfers_in set auth_code_enc = null, auth_code_wiped_at = $2, state = 'submitted', sent_at = $2, next_check_at = $3 where id = $1", [t.id, at, new Date(at.getTime() + POLL_EVERY_MS)]);
    return { code };
  });
  if (!claimed) return "wait";
  if (claimed.code === null) {
    await ltx(m, (c) => resolveOp(c, op.id, "no_code"));
    return fail(m, o, t, ["registering", "paid_before_registration"], "unknown");
  }
  let authCode: string = claimed.code;
  let res;
  try {
    res = await svc.registrar.startTransferIn({ fqdn: o.fqdn, years: o.years, authCode, regUsername: o.regUsername, regPassword, registrant });
  } catch (e) {
    // A worker that "died" after sending: the operation stays `sent`, the code is already gone, and the poll reconciles.
    if (!(e instanceof RegistrarError)) throw e;
    const code = authCode; authCode = "";
    return onSendError(m, o, t, op, e, code);
  } finally { authCode = ""; }

  const stage = res.status === "pending_owner" ? "pending_owner_approval" : "pending_registry";
  await ltx(m, async (c) => {
    await resolveOp(c, op.id, "accepted", res.registrarOrderId);
    await c.query("update transfers_in set registrar_order_id = $2, upstream_status = $3, state = $4, owner_deadline_at = $5 where id = $1 and state = 'submitted'",
      [t.id, res.registrarOrderId, res.status, stage, stage === "pending_owner_approval" ? new Date(at.getTime() + 5 * 86_400_000) : null]);
    await appendAudit(m.ctx, c, { chainId: o.userId, actorKind: "system", action: "transfer_in.submitted", resourceKind: "transfer", resourceId: t.id, detail: { order: o.id, status: res.status } });
    await logTransfer(m.ctx, c, { userId: o.userId, direction: "in", event: "submitted", actor: "system", transferId: t.id, detail: { status: res.status } });
  });
  // Read the status once more now, so the stage mail carries the deadline the provider set.
  const fresh = await loadOrder(cron(m), o.id);
  if (fresh) await pollTransfer(m, fresh, { ...t, state: stage, registrarOrderId: res.registrarOrderId, sentAt: at, nextCheckAt: null }, { ...op, state: "resolved", sentAt: at }, { force: true });
  return "progressed";
}

async function onSendError(m: M, o: OrderRow, t: TransferRow, op: Op, e: RegistrarError, code: string): Promise<OrderStep> {
  const at = now(m);
  if (e.outcomeUnknown || e.kind === "unknown") {
    const r = await ltx(m, async (c) => {
      const row = await move(m, c, o.id, "registering", "outcome_unknown", { next_check_at: new Date(at.getTime() + 60_000), check_count: 1 }, { cause: "job", detail: { code: e.code ?? e.kind } });
      if (row) await alert(m.ctx, c, { orderId: o.id, severity: "warn", kind: "transfer_outcome_unknown" });
      await c.query("update transfers_in set next_check_at = $2 where id = $1", [t.id, new Date(at.getTime() + 60_000)]);
      return row;
    });
    return r ? "progressed" : "wait";
  }
  if (e.kind === "maintenance" || e.kind === "unavailable" || e.kind === "rate_limited" || e.kind === "insufficient_funds") {
    // Refused before any effect: nothing was submitted, so the code goes back into storage for the retry (encrypted, as before).
    const env = await m.ctx.pii.encrypt(code, `transfer_auth:${t.id}`);
    const next = { next_check_at: new Date(at.getTime() + backoffMs(o.checkCount)), check_count: o.checkCount + 1 };
    const r = await ltx(m, async (c) => {
      await resolveOp(c, op.id, e.kind);
      await c.query("update transfers_in set auth_code_enc = $2, auth_code_wiped_at = null, state = 'submitting', sent_at = null where id = $1 and state = 'submitted'", [t.id, env]);
      await insertIntent(c, o, op.seq + 1);
      if (e.kind === "insufficient_funds") await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "registrar_funds" });
      if (o.state === "paid_before_registration") { await c.query("update orders set next_check_at = $2, check_count = $3 where id = $1", [o.id, next.next_check_at, next.check_count]); return null; }
      return move(m, c, o.id, ["registering"], "registrar_unavailable", next, { cause: "job", detail: { kind: e.kind } });
    });
    return r ? "progressed" : "wait";
  }
  // Rejected by the registrar: the request had no effect upstream, and the code is not kept.
  const failure: TransferFailure = e.code === "premium_refused" ? "price_guard"
    : e.code === "552" || e.code?.startsWith("not_transferable") || e.code === "order_exists" ? "not_transferable" : "registrar_rejected";
  await ltx(m, (c) => resolveOp(c, op.id, "rejected"));
  return fail(m, o, t, ["registering", "paid_before_registration"], failure);
}

// -------------------------------------------------------------------------------------------------------------------------------
// Polling: the adapter's status is the only thing that moves a transfer
// -------------------------------------------------------------------------------------------------------------------------------

/** Only a transfer our order started counts: the provider can remember older transfers of the same name. */
function ours(t: TransferRow, st: TransferInState | null): TransferInState | null {
  if (!st) return null;
  if (t.registrarOrderId && st.registrarOrderId && st.registrarOrderId !== t.registrarOrderId) return null;
  if (!t.registrarOrderId && st.requestedAt && t.sentAt && st.requestedAt.getTime() < t.sentAt.getTime() - 5_000) return null;
  return st;
}

export async function pollTransfer(m: M, o: OrderRow, t: TransferRow, op: Op | null, opts: { force?: boolean } = {}): Promise<OrderStep> {
  const at = now(m);
  if (!opts.force && t.nextCheckAt && t.nextCheckAt > at && o.state !== "outcome_unknown") return "wait";
  if (!opts.force && o.state === "outcome_unknown" && o.nextCheckAt && o.nextCheckAt > at) return "wait";
  let st: TransferInState | null;
  try { st = ours(t, await m.svc.registrar.getTransferInStatus(o.fqdn)); }
  catch (e) {
    if (!(e instanceof RegistrarError)) throw e;
    await cron(m).query("update transfers_in set next_check_at = $2, check_count = check_count + 1 where id = $1", [t.id, new Date(at.getTime() + POLL_EVERY_MS)]);
    return "wait";
  }

  if (!st) {
    if (o.state === "registering" && op?.state === "sent" && op.sentAt && at.getTime() - op.sentAt.getTime() > UNKNOWN_AFTER_MS) {
      const r = await ltx(m, async (c) => {
        const row = await move(m, c, o.id, "registering", "outcome_unknown", { next_check_at: new Date(at.getTime() + 60_000), check_count: 1 }, { cause: "system", detail: { sweep: true } });
        if (row) await alert(m.ctx, c, { orderId: o.id, severity: "warn", kind: "transfer_outcome_unknown" });
        return row;
      });
      return r ? "progressed" : "wait";
    }
    if (o.state === "outcome_unknown") {
      const deadline = new Date(captureBeforeOf(o).getTime() - MIN_AUTH_WINDOW_MS);
      if (at >= deadline) return fail(m, o, t, ["outcome_unknown"], "unknown_deadline", { lateWatch: true });
      await cron(m).query("update orders set next_check_at = $2, check_count = check_count + 1 where id = $1 and state = 'outcome_unknown'", [o.id, new Date(at.getTime() + backoffMs(o.checkCount))]);
    }
    await cron(m).query("update transfers_in set next_check_at = $2 where id = $1", [t.id, new Date(at.getTime() + POLL_EVERY_MS)]);
    return "wait";
  }

  // The unknown submit turned out to have landed: back to registering, and the operation is resolved.
  if (o.state === "outcome_unknown") {
    await ltx(m, async (c) => {
      if (op) await resolveOp(c, op.id, "accepted", st!.registrarOrderId ?? null);
      await c.query("update transfers_in set registrar_order_id = coalesce(registrar_order_id, $2) where id = $1", [t.id, st!.registrarOrderId ?? null]);
      await move(m, c, o.id, "outcome_unknown", "registering", { next_check_at: null, check_count: 0 }, { cause: "job", detail: { found: st!.status } });
    });
    o = (await loadOrder(cron(m), o.id)) ?? o;
  }

  if (st.status === "completed") return completeTransfer(m, o, t, st);
  if (st.status === "cancelled") return failUpstream(m, o, t, st.failure ?? "unknown", st.nackReason ?? null);

  const stage = st.status === "pending_owner" ? "pending_owner_approval" : "pending_registry";
  await ltx(m, async (c) => {
    const u = await c.query(
      `update transfers_in set state = $2, upstream_status = $3, registrar_order_id = coalesce(registrar_order_id, $4),
              owner_deadline_at = coalesce($5, owner_deadline_at), registry_deadline_at = coalesce($6, registry_deadline_at), next_check_at = $7
        where id = $1 and state = any($8) returning state, owner_deadline_at, registry_deadline_at`,
      [t.id, stage, st!.status, st!.registrarOrderId ?? null, st!.ownerDeadlineAt ?? null, st!.registryDeadlineAt ?? null, new Date(at.getTime() + POLL_EVERY_MS), ["submitted", "pending_owner_approval", "pending_registry"]]);
    const row = u.rows[0];
    if (!row) return;
    if (t.state !== stage) await logTransfer(m.ctx, c, { userId: o.userId, direction: "in", event: stage, actor: "system", transferId: t.id });
    const deadline = stage === "pending_owner_approval" ? row.owner_deadline_at : row.registry_deadline_at;
    // One mail per stage. A pending_registry mail waits until the provider has named the registry deadline.
    if (deadline) {
      await mailUser(m.ctx, c, o.userId, "transfer_submitted", {
        fqdn: o.fqdn, orderId: o.id, stage: stage === "pending_owner_approval" ? "pending_owner" : "pending_registry", deadline: new Date(deadline).toISOString(),
        timing: timingFor(t.tld) === TIMING_REGISTRY ? "registry" : "standard",
      }, `transfer.stage:${t.id}:${stage}`);
    }
  });
  await cron(m).query("update orders set next_check_at = $2 where id = $1 and state = any($3)", [o.id, new Date(at.getTime() + POLL_EVERY_MS), ["registering", "paid_before_registration"]]);

  // The card hold is about to end and the transfer is still pending: take the payment now (the transfer stays pending, never "complete").
  if (o.state === "registering" && at.getTime() >= captureBeforeOf(o).getTime() - EARLY_CAPTURE_BEFORE_HOLD_END_MS) {
    const r = await ltx(m, async (c) => {
      const row = await move(m, c, o.id, "registering", "capturing", {}, { cause: "system", detail: { early_capture: "hold_ending", transfer_state: stage } });
      if (row) {
        await c.query("update transfers_in set early_capture_at = $2 where id = $1", [t.id, at]);
        await logTransfer(m.ctx, c, { userId: o.userId, direction: "in", event: "charged_before_completion", actor: "system", transferId: t.id });
      }
      return row;
    });
    return r ? "progressed" : "wait";
  }
  return "wait";
}

// -------------------------------------------------------------------------------------------------------------------------------
// Completion and failure
// -------------------------------------------------------------------------------------------------------------------------------

async function completeTransfer(m: M, o: OrderRow, t: TransferRow, st: TransferInState): Promise<OrderStep> {
  const at = now(m);
  // "Completed" is believed only when the name reads back as ours under this order's profile (exit criterion: never shown complete early).
  let dom;
  try { dom = await m.svc.registrar.getDomain(o.fqdn); } catch (e) { if (e instanceof RegistrarError) return "wait"; throw e; }
  if (!dom || (dom.profileUsername && o.regUsername && dom.profileUsername !== o.regUsername)) {
    await ltx(m, (c) => alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "transfer_complete_unconfirmed" }));
    await cron(m).query("update transfers_in set next_check_at = $2 where id = $1", [t.id, new Date(at.getTime() + POLL_EVERY_MS)]);
    return "wait";
  }
  const policy = await transferPolicy(cron(m), t.tld);
  const lockUntil = new Date(at.getTime() + (policy?.lockDays ?? 60) * 86_400_000);
  const expires = st.expiresAt ?? dom.expiresAt ?? null;
  const done = await ltx(m, async (c) => {
    const u = await c.query(
      // The registry's word wins over ours: a transfer we had written off (late watch, or a cancel that lost the race) is still the customer's name.
      "update transfers_in set state = 'completed', upstream_status = 'completed', completed_at = $2, next_check_at = null, auth_code_enc = null where id = $1 and state <> 'completed' returning id",
      [t.id, at]);
    if (u.rowCount !== 1) return null;
    const ins = await c.query(
      `insert into domains (user_id, fqdn_ascii, tld, registrar, registrar_ref, state, registered_at, registry_created_at, expires_at, locked, privacy_status, nameservers, registry_statuses, ds_present, dns_hosted_here, livemode, synced_at)
       values ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$6) on conflict (fqdn_ascii) where released_at is null do nothing returning id`,
      [o.userId, o.fqdn, t.tld, m.svc.registrarId, st.registrarOrderId ?? t.registrarOrderId, at, dom.createdAt ?? null, expires, dom.locked, dom.privacyStatus, dom.nameservers, dom.registryStatuses, dom.dsPresent,
        dom.nameservers.length > 0 && dom.nameservers.every((n) => n.endsWith(".systemdns.com")), o.livemode]);
    const domainId = ins.rows[0]?.id as string | undefined;
    if (!domainId) { await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "domain_row_conflict" }); return null; }
    await c.query("update transfers_in set domain_id = $2 where id = $1", [t.id, domainId]);
    await c.query("update orders set domain_id = $2, registrar_ref = coalesce(registrar_ref, $3), registrar_expires_at = $4 where id = $1", [o.id, domainId, st.registrarOrderId ?? t.registrarOrderId, expires]);
    await c.query("update registrar_profiles set domain_id = $2 where order_id = $1", [o.id, domainId]);
    // C-06: 60 days after a transfer the name cannot move again; the Gate shows the date and unlock refuses until then.
    await c.query(
      `insert into domain_security (domain_id, user_id, transfer_lock_until, transfer_lock_reason) values ($1,$2,$3,'transfer_in')
       on conflict (domain_id) do update set transfer_lock_until = greatest(coalesce(domain_security.transfer_lock_until, excluded.transfer_lock_until), excluded.transfer_lock_until),
         transfer_lock_reason = case when domain_security.transfer_lock_until is null or domain_security.transfer_lock_until < excluded.transfer_lock_until then 'transfer_in' else domain_security.transfer_lock_reason end`,
      [domainId, o.userId, lockUntil]);
    const pending = await c.query("select id from order_operations where order_id = $1 and kind = 'transfer' and state = 'sent'", [o.id]);
    for (const p of pending.rows) await resolveOp(c, p.id, "accepted", st.registrarOrderId ?? null);
    if ((["registering", "outcome_unknown", "paid_before_registration", "registrar_unavailable", "canceling"] as OrderState[]).includes(o.state)) {
      await move(m, c, o.id, [o.state], "registered", { registered_at: at, next_check_at: null, check_count: 0 }, { cause: "job", detail: { transfer: "completed" } });
    } else if (o.state === "captured" || o.state === "capturing" || o.state === "capture_failed") {
      await c.query("update orders set registered_at = coalesce(registered_at, $2) where id = $1", [o.id, at]);
    } else {
      // Completed after we gave up on it (late): the name is the customer's; the money is a person's decision.
      await alert(m.ctx, c, { orderId: o.id, severity: "page", kind: "late_transfer_unpaid" });
    }
    await appendAudit(m.ctx, c, { chainId: o.userId, actorKind: "system", action: "transfer_in.completed", resourceKind: "transfer", resourceId: t.id, detail: { domain: domainId } });
    await logTransfer(m.ctx, c, { userId: o.userId, direction: "in", event: "completed", actor: "system", transferId: t.id, domainId });
    await mailUser(m.ctx, c, o.userId, "transfer_completed", { fqdn: o.fqdn, expiresAt: (expires ?? lockUntil).toISOString(), transferableFrom: lockUntil.toISOString() }, `transfer.completed:${t.id}`);
    return domainId;
  });
  return done ? "progressed" : "wait";
}

const stateFor = (f: TransferFailure) => (f === "nack" ? "nacked" : f === "cancelled_by_us" ? "cancelled" : "failed");

/** The registrar reported the transfer over without completing. */
async function failUpstream(m: M, o: OrderRow, t: TransferRow, failure: TransferFailure, nack: TransferDenialReason | null): Promise<OrderStep> {
  return fail(m, o, t, [...PRE_CAPTURE, "capturing", "capture_failed", "captured"], failure, { nack });
}

/**
 * End a transfer: the transfer row reaches its terminal state and the order moves to canceling (the hold is released) or, when the
 * payment was already taken, to refund_pending. `lateWatch` keeps polling the name for 14 days after an unknown submit.
 */
export async function fail(m: M, o: OrderRow, t: TransferRow, from: OrderState[], failure: TransferFailure, opts: { nack?: TransferDenialReason | null; lateWatch?: boolean; actor?: "user" | "system" } = {}): Promise<OrderStep> {
  const at = now(m);
  const r = await ltx(m, async (c) => {
    const now0 = (await c.query("select state, failure, nack_reason from transfers_in where id = $1 for update", [t.id])).rows[0];
    if (!now0 || now0.state === "completed") return null;
    const u = await c.query(
      `update transfers_in set state = $2, failure = $3, nack_reason = $4, ended_at = $5, next_check_at = $6, late_watch_until = $7,
              auth_code_enc = null, auth_code_wiped_at = coalesce(auth_code_wiped_at, $5), confirm_code_hash = null
        where id = $1 and state = any($8) returning id`,
      [t.id, stateFor(failure), failure, opts.nack ?? null, at, opts.lateWatch ? new Date(at.getTime() + POLL_EVERY_MS) : null, opts.lateWatch ? new Date(at.getTime() + LATE_WATCH_MS) : null,
        ["awaiting_confirmation", "awaiting_payment", "submitting", "submitted", "pending_owner_approval", "pending_registry"]]);
    // Already ended (by a cancel that got there first, say): the order still follows, with the reason already recorded.
    if (u.rowCount !== 1) { failure = (now0.failure as TransferFailure) ?? failure; opts = { ...opts, nack: now0.nack_reason ?? opts.nack }; }
    else await appendAudit(m.ctx, c, { chainId: o.userId, actorKind: opts.actor ?? "system", actorId: opts.actor === "user" ? o.userId : undefined, action: `transfer_in.${stateFor(failure)}`, resourceKind: "transfer", resourceId: t.id, detail: { failure, ...(opts.nack ? { nack: opts.nack } : {}) } });
    if (u.rowCount === 1) await logTransfer(m.ctx, c, { userId: o.userId, direction: "in", event: stateFor(failure), actor: opts.actor ?? "system", transferId: t.id, detail: { failure, ...(opts.nack ? { nack: opts.nack } : {}) } });
    const cur = (await c.query("select state, stripe_payment_intent_id, cancel_pi_id from orders where id = $1 for update", [o.id])).rows[0];
    if (!cur || !from.includes(cur.state)) return "ended";
    if (cur.state === "captured") {
      await move(m, c, o.id, "captured", "refund_pending", { cancel_pi_id: cur.stripe_payment_intent_id }, { cause: "system", detail: { reason: "transfer_failed", failure } });
      await mailUser(m.ctx, c, o.userId, "transfer_failed", { fqdn: o.fqdn, reason: failure, ...(opts.nack ? { nackReason: opts.nack } : {}), money: "refunding" }, `transfer.failed:${t.id}`);
      return "refund";
    }
    if (cur.state === "draft") {
      await move(m, c, o.id, "draft", "voided", { void_reason: "transfer_failed", failure_code: failure }, { cause: "system", detail: { failure } });
      return "voided";
    }
    await move(m, c, o.id, [cur.state], "canceling", { void_reason: "transfer_failed", failure_code: failure, cancel_pi_id: cur.cancel_pi_id ?? cur.stripe_payment_intent_id }, { cause: "job", detail: { failure } });
    return "canceling";
  });
  if (r === "refund") await advance(m, o.id);   // the machine settles the refund
  return r ? "progressed" : "wait";
}

// -------------------------------------------------------------------------------------------------------------------------------
// canceling -> voided (or refund_pending): the transfer is stopped upstream first, then the hold is released
// -------------------------------------------------------------------------------------------------------------------------------

async function cancelOrder(m: M, o: OrderRow): Promise<OrderStep> {
  const svc = m.svc;
  const t = await transferOfOrder(cron(m), o.id);
  // The Checkout is closed; a PaymentIntent the customer authorized on it just before the cancel (never recorded on the order) is
  // released below like the order's own. Pay links of a transfer whose capture failed are expired, and one already paid is refunded.
  const sessionPi = await closeOrderSession(m, o);
  await closePayLinks(m, o);
  // 1. A request that is out with the registrar is cancelled and confirmed before the money moves.
  if (t && t.sentAt) {
    let st = ours(t, await svc.registrar.getTransferInStatus(o.fqdn));
    if (st && (st.status === "pending_owner" || st.status === "pending_registry")) {
      await svc.registrar.cancelTransferIn(o.fqdn);
      st = ours(t, await svc.registrar.getTransferInStatus(o.fqdn));
      if (st && (st.status === "pending_owner" || st.status === "pending_registry")) throw new Error("upstream_cancel_unconfirmed");
    }
    // It completed while we were stopping it: the name is the customer's and the hold is still there, so capture instead.
    if (st?.status === "completed") return completeTransfer(m, o, { ...t, state: t.state === "completed" ? "completed" : "pending_registry" }, st);
  }
  // 2. Re-fetch the PaymentIntent, then cancel it (or refund it if it was captured).
  const piId = o.cancelPiId ?? o.paymentIntentId ?? sessionPi;
  if (piId) {
    const pi = await svc.stripe.retrievePaymentIntent(piId);
    if (pi.status === "succeeded") {
      const r = await ltx(m, async (c) => {
        const row = await move(m, c, o.id, "canceling", "refund_pending", { cancel_pi_id: piId }, { cause: "system", detail: { reason: "cancelled_after_capture" } });
        if (row && t) await mailUser(m.ctx, c, o.userId, "transfer_failed", { fqdn: o.fqdn, reason: failureOf(o, t), ...(t.nackReason ? { nackReason: t.nackReason as TransferDenialReason } : {}), money: "refunding" }, `transfer.failed:${t.id}`);
        return row;
      });
      if (r) await advance(m, o.id);
      return r ? "progressed" : "wait";
    }
    if (pi.status !== "canceled") {
      try { await svc.stripe.cancelPaymentIntent(piId, `cancel:${o.id}`); }
      catch (e) { if (!(e instanceof StripeError)) throw e; if (e.retryable) throw e; return "wait"; }
    }
  }
  const done = await ltx(m, async (c) => {
    const row = await move(m, c, o.id, "canceling", "voided", {}, { cause: "job", detail: { reason: o.voidReason } });
    if (!row) return null;
    await c.query("update payments set status = 'canceled' where order_id = $1 and status = 'requires_capture'", [o.id]);
    if (t) {
      const f = failureOf(o, t);
      const u = await c.query(
        `update transfers_in set state = $2, failure = coalesce(failure, $3), ended_at = coalesce(ended_at, $4), auth_code_enc = null, auth_code_wiped_at = coalesce(auth_code_wiped_at, $4), next_check_at = null
          where id = $1 and state = any($5) returning id`, [t.id, stateFor(f), f, now(m), ["awaiting_confirmation", "awaiting_payment", "submitting", "submitted", "pending_owner_approval", "pending_registry"]]);
      if (u.rowCount === 1) await logTransfer(m.ctx, c, { userId: o.userId, direction: "in", event: stateFor(f), actor: "system", transferId: t.id, detail: { failure: f } });
      await mailUser(m.ctx, c, o.userId, "transfer_failed", { fqdn: o.fqdn, reason: f, ...(t.nackReason ? { nackReason: t.nackReason as TransferDenialReason } : {}), money: "nothing_charged" }, `transfer.failed:${t.id}`);
    }
    return row;
  });
  return done ? "progressed" : "wait";
}

const VOID_TO_FAILURE: Record<string, TransferFailure> = {
  customer_cancel: "cancelled_by_us", auth_window: "auth_window", auth_lost: "auth_lost", quote_increased: "quote_increased", price_guard: "price_guard",
  review_refused: "review_refused", no_contact: "no_contact", unknown_deadline: "unknown_deadline", guard_low: "payment_failed", guard_high: "payment_failed",
  guard_currency: "payment_failed", guard_wrong_order: "payment_failed", guard_open_review: "review_refused", guard_livemode: "payment_failed", registrar_unavailable: "registrar_rejected",
};
function failureOf(o: OrderRow, t: TransferRow): TransferFailure {
  if (t.failure) return t.failure as TransferFailure;
  return VOID_TO_FAILURE[o.voidReason ?? ""] ?? "unknown";
}

// -------------------------------------------------------------------------------------------------------------------------------
// Things that belong to no single order step
// -------------------------------------------------------------------------------------------------------------------------------

/** Transfer row and order disagree (a crash between two commits, or a machine path that moved the order): bring them together. */
async function reconcileMismatch(m: M, o: OrderRow, t: TransferRow): Promise<OrderStep> {
  if (t.state === "completed") return "wait";
  if (["failed", "nacked", "cancelled", "expired"].includes(t.state)) {
    const r = await ltx(m, (c) => move(m, c, o.id, [o.state], "canceling", { void_reason: "transfer_failed", cancel_pi_id: o.cancelPiId ?? o.paymentIntentId }, { cause: "system", detail: { reconcile: true } }));
    return r ? "progressed" : "wait";
  }
  return "wait";
}

/**
 * One pass for a transfer outside the order machine's reach: a live transfer whose payment was already taken (early capture), a
 * terminal transfer whose captured payment still needs refunding, and a late watch after an unknown submit.
 */
export async function pollOutsideMachine(ctx: AppContext, t: TransferRow, lease?: { jobId: string; attemptId: string }): Promise<void> {
  const m = machine(ctx, lease ? { jobId: lease.jobId, attemptId: lease.attemptId } : {});
  const o = await loadOrder(ctx.cron, t.orderId);
  if (!o) return;
  if ((LIVE_STATES as readonly string[]).includes(t.state)) {
    if (o.state === "captured") { await pollTransfer(m, o, t, await latestOp(ctx.cron, o.id)); return; }
    // Everything else goes through the order machine, which calls this module's driver.
    if (!["checkout_open", "payment_failed", "checkout_expired", "voided", "draft"].includes(o.state)) { await advance(m, o.id); return; }
    // The payment never completed: the Checkout expired or the order was voided without the transfer row hearing of it.
    if (o.state === "checkout_expired" || o.state === "voided") await fail(m, o, t, [o.state], o.state === "checkout_expired" ? "payment_failed" : failureOf(o, t));
    return;
  }
  if (["failed", "nacked", "cancelled"].includes(t.state)) {
    if (o.state === "captured") await fail(m, o, t, ["captured"], (t.failure as TransferFailure) ?? "unknown");
    if (t.lateWatchUntil && t.lateWatchUntil > ctx.clock.now() && t.failure === "unknown_deadline") {
      let st: TransferInState | null = null;
      try { st = ours(t, await m.svc.registrar.getTransferInStatus(o.fqdn)); } catch { st = null; }
      if (st?.status === "completed") await completeTransfer(m, o, t, st);
    }
  }
}
