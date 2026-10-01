import { z } from "zod";
import { tx, withUser, type PoolClient } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { HttpError, json } from "../http/router.ts";
import { clearCookie, SESSION_COOKIE } from "../http/session.ts";
import { appendAudit } from "../audit.ts";
import { sendMail } from "../email.ts";
import { buildMail } from "../mail/templates.ts";
import { enqueue } from "../jobs/registry.ts";
import { markExecuted, requireAction } from "../stepup/gate.ts";
import type { ActionSpec } from "../stepup/specs.ts";
import { hashOf, safeEqual } from "../util/bytes.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { optSvc } from "../ops/services.ts";
import { purgeFromLedger } from "../ops/erasure.ts";
import { releaseDomain } from "../domains/release.ts";
import { revokeAllBindings } from "../bindings/tokens.ts";
import type { OrdersServices } from "../orders/types.ts";
import { closureSvc } from "./services.ts";
import { deleteStripeCustomers, eraseAccount, residueSweep } from "./purge.ts";
import { COOLING_OFF_MS, DAY_MS, blockersOf, iso, legalHoldOf, liveDomains, notFound, sessionUser, verifiedAddresses, type Blocker } from "./common.ts";

/**
 * Account closure (PLAN 4.3b, design section 1, C-28, C-70). States of `account_closures` and what each step does:
 *
 *   active --POST /account/close (step-up account.close)--> cooling_off   users.status = closing. In the same transaction: every session,
 *       token, connected app (OAuth grant and consent), device grant and pending agent request is revoked; mandates are revoked and
 *       auto-renew is off; cards are unpublished and the site rebuilt (CDN purge); open recovery requests are cancelled. Every verified
 *       address is told. Refused while money or a registration is in flight, and while names remain unless the person agrees that
 *       they are deleted (C-28: transfer-out is offered first, deletion follows within 45 days).
 *   cooling_off --passkey sign-in before cooling_off_until--> cancelled   (auth/login.ts calls cancelClosureOnSignIn)
 *   cooling_off --account.closure sweep at cooling_off_until--> winding_down   names still here are deleted at the registry and
 *       released (`account_closed`); a name mid transfer-out is left to finish.
 *   winding_down --no open order, refund, dispute, transfer or name--> closed   users.status = closed, export files deleted, the last
 *       email sent, the Stripe customer deleted.
 *   closed --no legal hold--> purged   erasure ledger first, then ops eraseUser, then the residue (purge.ts).
 *   purged --every released name's vault ciphertext destroyed after its 30-day hold--> sealed   `chain.closed` becomes the last row of
 *       the person's audit chain and is anchored by the next `audit.anchor`.
 */

export const OPEN_CLOSURE_STATES = ["cooling_off", "winding_down", "closed"] as const;

// ---- the step-up spec -----------------------------------------------------------------------------------------------------------

const closeInput = z.strictObject({ delete_domains: z.boolean().optional() });
type CloseInput = z.infer<typeof closeInput>;

async function deriveClose(c: PoolClient, userId: string, targetId: string, input: CloseInput) {
  if (targetId !== userId) throw notFound();
  const u = (await c.query("select status from users where id = $1", [userId])).rows[0];
  if (!u) throw notFound();
  if (u.status !== "active") throw new HttpError(409, "account_not_active");
  const blockers = await blockersOf(c, userId, "request");
  if (blockers.length) throw new HttpError(409, "closure_blocked", undefined, undefined, { blockers });
  const domains = await liveDomains(c, userId);
  // C-28: names are offered transfer-out first. Deleting them is a separate, explicit choice the passkey signs.
  if (domains.length && input.delete_domains !== true) throw new HttpError(409, "domains_remain", undefined, undefined, { domains: domains.map((d) => ({ id: d.id, fqdn: d.fqdn })) });
  return {
    params: { user_id: userId, cooling_off_days: COOLING_OFF_MS / DAY_MS, delete_domains: domains.length > 0, domains: domains.map((d) => ({ id: d.id, fqdn: d.fqdn })) },
    resourceId: userId,
  };
}

export const accountCloseSpec: ActionSpec<CloseInput> = {
  type: "account.close", held: true, userInput: closeInput,
  derive: (_ctx, c, userId, targetId, input) => deriveClose(c, userId, targetId, input),
  summary(p) {
    const days = Number(p.cooling_off_days);
    const ds = (p.domains as { fqdn: string }[]) ?? [];
    const names = ds.length === 0 ? "" : ` After ${days} days we ask the registry to delete the ${ds.length === 1 ? "name" : `${ds.length} names`} still here: ${ds.slice(0, 5).map((d) => d.fqdn).join(", ")}${ds.length > 5 ? ` and ${ds.length - 5} more` : ""}. Deletion is final: transfer out any name you want to keep first.`;
    return `Close your account. We sign out every session, revoke your tokens and connected apps, turn off auto-renew and take down your cards now. Signing in with your passkey in the next ${days} days cancels the closure.${names} Then we erase your personal data; receipts and payment records stay as the law requires.`;
  },
};

// ---- routes ----------------------------------------------------------------------------------------------------------------------

/** GET /account/closure: where a closure stands, and what closing would do now (names still here, what blocks it). */
export async function closureStatus(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const out = await withUser(req.ctx.runtime, userId, async (c) => {
    const domains = await liveDomains(c, userId);
    const blockers = await blockersOf(c, userId, "request");
    const last = (await c.query("select id, state, requested_at, cooling_off_until, cancelled_at from account_closures where user_id = $1 order by requested_at desc limit 1", [userId])).rows[0];
    return { domains, blockers, last };
  });
  return json({
    cooling_off_days: COOLING_OFF_MS / DAY_MS,
    domains: out.domains.map((d) => ({ id: d.id, fqdn: d.fqdn, transfer_out_in_progress: d.transferAway })),
    blockers: out.blockers,
    last_closure: out.last ? { id: out.last.id, state: out.last.state, requested_at: iso(out.last.requested_at), cooling_off_until: iso(out.last.cooling_off_until), cancelled_at: iso(out.last.cancelled_at) } : null,
  });
}

/** POST /account/close (step-up `account.close`). */
export async function requestClosure(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const action = requireAction(req, "account.close");
  const { ctx } = req;
  const now = ctx.clock.now();
  const until = new Date(now.getTime() + COOLING_OFF_MS);
  const out = await withUser(ctx.runtime, userId, async (c) => {
    await c.query("select id from users where id = $1 for update", [userId]);
    // Re-derive now: a name that arrived, or money that started moving, since the passkey signed makes the signature stale.
    const params = action.params as { delete_domains?: boolean };
    const d = await deriveClose(c, userId, userId, params.delete_domains ? { delete_domains: true } : {});
    if (!safeEqual(hashOf(d.params), hashOf(action.params))) throw new HttpError(409, "action_stale");
    await markExecuted(c, action);
    const ins = await c.query(
      `insert into account_closures (user_id, state, action_id, requested_at, cooling_off_until, delete_domains, domain_count, created_at)
       values ($1,'cooling_off',$2,$3,$4,$5,$6,$3) on conflict do nothing returning id`,
      [userId, action.id, now, until, d.params.delete_domains, d.params.domains.length]);
    if (ins.rowCount !== 1) throw new HttpError(409, "closure_open");
    const closureId = ins.rows[0].id as string;
    const u = await c.query("update users set status = 'closing' where id = $1 and status = 'active'", [userId]);
    if (u.rowCount !== 1) throw new HttpError(409, "account_not_active");
    const counts = await closingEffects(ctx, c, userId);
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "account.closing", resourceKind: "account_closure", resourceId: closureId, detail: { action_id: action.id, domains: d.params.domains.length, ...counts } });
    for (const a of await verifiedAddresses(c, userId)) {
      await sendMail(c, ctx.email, buildMail("account_closing", { requestedAt: now.toISOString(), coolingOffUntil: until.toISOString(), domainCount: d.params.domains.length },
        { to: [a.address], dedupeKey: `account.closing:${closureId}:${a.id}`, userId, origin: ctx.config.origin }));
    }
    return { closureId };
  });
  // This session was revoked with the others: the browser forgets it too.
  return json({ closure: { id: out.closureId, state: "cooling_off", requested_at: now.toISOString(), cooling_off_until: until.toISOString() } }, 202,
    { cookies: [clearCookie(SESSION_COOKIE)], headers: { "Clear-Site-Data": "\"cookies\"" } });
}

/** Revoke and switch off everything that acts for the person. Runs in the request transaction (runtime role, RLS). */
async function closingEffects(ctx: AppContext, c: PoolClient, userId: string): Promise<Record<string, number>> {
  const now = ctx.clock.now();
  const sessions = await c.query("update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null", [userId, now]);
  // Grants approved but not yet claimed first, then the bindings (the lock order the claim paths use, as recovery does).
  const consents = await c.query("update oauth_authorizations set status = 'denied', decided_at = $2 where user_id = $1 and status in ('pending','approved')", [userId, now]);
  const tokens = await revokeAllBindings(ctx, c, userId, "account_closing");
  const oauthRefresh = await c.query("update oauth_refresh_tokens set revoked_at = $2 where user_id = $1 and revoked_at is null", [userId, now]);
  const mandates = await c.query("update renewal_mandates set revoked_at = $2, revoked_by = 'system' where user_id = $1 and revoked_at is null", [userId, now]);
  await c.query("update domains set auto_renew = false where user_id = $1 and auto_renew", [userId]);
  await c.query("update renewal_terms set state = 'held', held_reason = 'account_closing' where user_id = $1 and state in ('scheduled','payment_failed')", [userId]);
  const cards = await c.query("update cards set unpublished_at = $2, unpublish_reason = 'account_closed' where user_id = $1 and unpublished_at is null returning id", [userId, now]);
  if ((cards.rowCount ?? 0) > 0) {
    // C-70: the portrait is purged from storage and the public site rebuilt without the card (the CDN cache goes with the rebuild).
    await enqueue(c, { kind: "card.purge", payload: {}, dedupeKey: `card.purge:closure:${userId}` });
    await enqueue(c, { kind: "cards.rebuild", payload: {}, dedupeKey: `cards.rebuild:${Math.floor(now.getTime() / 60_000)}` });
  }
  const recovery = await c.query("update recovery_requests set status = 'cancelled', cancelled_by = 'closure', updated_at = $2 where user_id = $1 and status in ('pending','cooling_off')", [userId, now]);
  await c.query("update account_export_tickets set used_at = coalesce(used_at, $2) where user_id = $1 and used_at is null", [userId, now]);
  return {
    sessions: sessions.rowCount ?? 0, tokens: tokens.bindings, device_grants: tokens.devices, agent_requests: tokens.requests, consents: consents.rowCount ?? 0,
    oauth_refresh: oauthRefresh.rowCount ?? 0, mandates: mandates.rowCount ?? 0, cards: cards.rowCount ?? 0, recovery: recovery.rowCount ?? 0,
  };
}

// ---- sign-in cancels (called by auth/login.ts) ----------------------------------------------------------------------------------

/** Whether a sign-in may go ahead for a `closing` account: only inside the cooling-off. */
export async function closureCancellable(ctx: AppContext, userId: string): Promise<boolean> {
  const r = await withUser(ctx.runtime, userId, (c) => c.query("select 1 from account_closures where user_id = $1 and state = 'cooling_off' and cooling_off_until > $2", [userId, ctx.clock.now()]));
  return (r.rowCount ?? 0) > 0;
}

/**
 * Inside the sign-in transaction, after the assertion verified: cancel a closure still in its cooling-off and reopen the account.
 * Losing the race with the sweep (the cooling-off just ended) refuses the sign-in: the caller's transaction rolls back.
 */
export async function cancelClosureOnSignIn(ctx: AppContext, c: PoolClient, userId: string): Promise<boolean> {
  const u = (await c.query("select status from users where id = $1 for update", [userId])).rows[0];
  if (!u || u.status !== "closing") return false;
  const now = ctx.clock.now();
  const r = await c.query("update account_closures set state = 'cancelled', cancelled_at = $2, cancelled_by = 'sign_in' where user_id = $1 and state = 'cooling_off' and cooling_off_until > $2 returning id", [userId, now]);
  if (r.rowCount !== 1) throw new HttpError(401, "login_failed");
  await c.query("update users set status = 'active' where id = $1 and status = 'closing'", [userId]);
  await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "account.closure_cancelled", resourceKind: "account_closure", resourceId: r.rows[0].id, detail: { by: "sign_in" } });
  for (const a of await verifiedAddresses(c, userId)) {
    await sendMail(c, ctx.email, buildMail("account_closure_cancelled", { at: now.toISOString() }, { to: [a.address], dedupeKey: `account.closure_cancelled:${r.rows[0].id}:${a.id}`, userId, origin: ctx.config.origin }));
  }
  return true;
}

// ---- the sweep (job account.closure) ---------------------------------------------------------------------------------------------

export interface SweepResult { windingDown: number; closed: number; purged: number; sealed: number; residue: number; blocked: number }

export async function closureSweep(ctx: AppContext): Promise<SweepResult> {
  const out: SweepResult = { windingDown: 0, closed: 0, purged: 0, sealed: 0, residue: 0, blocked: 0 };
  const now = ctx.clock.now();
  // Restore safety first: whatever a restore rewound, the ledger outside the database says who is erased.
  const ledger = optSvc(ctx, "erasureLedger");
  if (ledger) await purgeFromLedger(ctx, ledger);
  const due = (state: string, extra = "") => ctx.cron.query(`select * from account_closures where state = $1 ${extra} order by requested_at limit 200`, state === "cooling_off" ? [state, now] : [state]).then((r) => r.rows);
  for (const r of await due("cooling_off", "and cooling_off_until <= $2")) if (await startWindDown(ctx, r)) out.windingDown++;
  for (const r of await due("winding_down")) { const x = await tryClose(ctx, r); if (x === "closed") out.closed++; else out.blocked++; }
  for (const r of await due("closed")) { const x = await tryPurge(ctx, r); if (x) out.purged++; else out.blocked++; }
  for (const r of await due("purged")) if (await trySeal(ctx, r)) out.sealed++;
  out.residue = await residueSweep(ctx);
  // Stripe deletions that failed at closure are retried while the account waits for its purge.
  const retry = (await ctx.cron.query("select distinct s.user_id from stripe_customers s join users u on u.id = s.user_id where s.deleted_at is null and u.status = 'closed' limit 100")).rows;
  for (const r of retry) await deleteStripeCustomers(ctx, r.user_id);
  return out;
}

type ClosureRow = { id: string; user_id: string; state: string; delete_domains: boolean };

/** The cooling-off is over: nothing cancels the closure any more. Names still here are deleted at the registry (C-28). */
async function startWindDown(ctx: AppContext, r: ClosureRow): Promise<boolean> {
  const now = ctx.clock.now();
  const claimed = await tx(ctx.cron, async (c) => {
    const u = await c.query("update account_closures set state = 'winding_down', winding_down_at = $2 where id = $1 and state = 'cooling_off' and cooling_off_until <= $2 returning id", [r.id, now]);
    if (u.rowCount !== 1) return false;
    await appendAudit(ctx, c, { chainId: r.user_id, actorKind: "system", action: "account.winding_down", resourceKind: "account_closure", resourceId: r.id });
    return true;
  });
  if (!claimed) return false;
  for (const d of await liveDomains(ctx.cron, r.user_id)) {
    const away = await ctx.cron.query("select 1 from domain_transfers_away where domain_id = $1 and state in ('open','stopped') limit 1", [d.id]);
    if (d.transferAway || (away.rowCount ?? 0) > 0) continue;                   // it leaves on its own; `transfer_out` blocks until it does
    await deleteName(ctx, d);
  }
  return true;
}

/** Ask the registry to delete the name, then release it. Where the adapter cannot delete, a person is paged to do it inside C-28's 45 days. */
async function deleteName(ctx: AppContext, d: { id: string; fqdn: string }): Promise<void> {
  const svc = (ctx.services as { orders?: OrdersServices }).orders;
  let deleted = false;
  if (svc?.deleteDomain) { try { await svc.deleteDomain(d.fqdn); deleted = true; } catch { deleted = false; } }
  await releaseDomain(ctx, d.id, "account_closed");
  if (!deleted) await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "manual_domain_delete_required", subject: d.id, detail: { domain_id: d.id, reason: "account_closed" } });
}

async function tryClose(ctx: AppContext, r: ClosureRow): Promise<"closed" | "blocked"> {
  const blockers: Blocker[] = await blockersOf(ctx.cron, r.user_id, "close");
  if (blockers.length) {
    await ctx.cron.query("update account_closures set blocked_by = $2 where id = $1 and state = 'winding_down'", [r.id, blockers]);
    return "blocked";
  }
  const now = ctx.clock.now();
  const files = await tx(ctx.cron, async (c) => {
    const u = await c.query("update account_closures set state = 'closed', closed_at = $2, blocked_by = '{}' where id = $1 and state = 'winding_down' returning id", [r.id, now]);
    if (u.rowCount !== 1) return null;
    await c.query("update users set status = 'closed', closed_at = coalesce(closed_at, $2) where id = $1 and status = 'closing'", [r.user_id, now]);
    // The last email, while the addresses still exist.
    for (const a of await verifiedAddresses(c, r.user_id)) {
      await sendMail(c, ctx.email, buildMail("account_closed", { closedAt: now.toISOString() }, { to: [a.address], dedupeKey: `account.closed:${r.id}:${a.id}`, userId: r.user_id, origin: ctx.config.origin }));
    }
    // Nothing can be downloaded after closure: the files go now, the rows at erasure.
    const f = (await c.query("select id, storage_ref from account_exports where user_id = $1 and storage_ref is not null", [r.user_id])).rows;
    await c.query(
      `update account_exports set storage_ref = null, file_deleted_at = coalesce(file_deleted_at, $2),
         state = case when state in ('requested','building') then 'cancelled' when state = 'ready' then 'expired' else state end
       where user_id = $1 and (storage_ref is not null or state in ('requested','building','ready'))`, [r.user_id, now]);
    await appendAudit(ctx, c, { chainId: r.user_id, actorKind: "system", action: "account.closed", resourceKind: "account_closure", resourceId: r.id, detail: { export_files: f.length } });
    return f as { id: string; storage_ref: string }[];
  });
  if (!files) return "blocked";
  for (const f of files) await closureSvc(ctx).exportStore.remove(ctx, f.id, f.storage_ref);
  await deleteStripeCustomers(ctx, r.user_id);
  return "closed";
}

async function tryPurge(ctx: AppContext, r: ClosureRow): Promise<boolean> {
  if (await legalHoldOf(ctx.cron, r.user_id)) {
    await ctx.cron.query("update account_closures set blocked_by = '{legal_hold}' where id = $1 and state = 'closed'", [r.id]);
    return false;
  }
  const ledger = optSvc(ctx, "erasureLedger");
  if (!ledger) {
    // Erasure is recorded outside the database first, or not at all (design section 3).
    await raiseAlert(ctx, ctx.cron, { severity: "warn", kind: "closure_ledger_not_configured", subject: "erasureLedger" });
    return false;
  }
  await eraseAccount(ctx, ledger, r.user_id, "closure");
  const u = await ctx.cron.query("update account_closures set state = 'purged', purged_at = $2, blocked_by = '{}' where id = $1 and state = 'closed'", [r.id, ctx.clock.now()]);
  return u.rowCount === 1;
}

/** Seal once nothing more can be written about the person: every released name's ciphertext destroyed after its hold (ST-95). */
async function trySeal(ctx: AppContext, r: ClosureRow): Promise<boolean> {
  const pending = await ctx.cron.query(
    `select exists (select 1 from domain_releases where user_id = $1 and destroyed_at is null)
         or exists (select 1 from domains where user_id = $1 and released_at is null)
         or exists (select 1 from secret_versions where user_id = $1 and destroyed_at is null) as waiting`, [r.user_id]);
  if (pending.rows[0].waiting) return false;
  return tx(ctx.cron, async (c) => {
    const u = await c.query("update account_closures set state = 'sealed', sealed_at = $2 where id = $1 and state = 'purged' returning id", [r.id, ctx.clock.now()]);
    if (u.rowCount !== 1) return false;
    await appendAudit(ctx, c, { chainId: r.user_id, actorKind: "system", action: "chain.closed", resourceKind: "account_closure", resourceId: r.id });
    return true;
  });
}

export { OPEN_CLOSURE_STATES as CLOSURE_OPEN_STATES };
