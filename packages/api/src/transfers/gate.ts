import { tx, withUser, type PoolClient } from "@mosshatch/db";
import { RegistrarError, TRANSFER_DENIAL_REASONS, type TransferDenialReason } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { appendAudit } from "../audit.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { FREEZE_TTL_MS, mintEmailActionToken } from "../auth/email-actions.ts";
import { ordersSvc } from "../orders/support.ts";
import { releaseDomain } from "../domains/release.ts";
import { DAY_MS, timingFor, transferPolicy } from "./policy.ts";
import { logTransfer, mailUser, UUID_RE } from "./store.ts";
import { registrarWords } from "./registrar-words.ts";

/**
 * The Gate (transfer-out) with a wholesale upstream (plan 4.3b "The Gate with a wholesale upstream"). Neither OpenSRS nor Openprovider
 * has an API to start, approve or decline an outbound transfer: the owner unlocks and takes a code here (both behind the passkey, in
 * domain-mgmt), the gaining registrar starts the transfer, and the registrar of record emails the registrant to approve or decline,
 * with five days of silence counting as approval. This module shows that honestly (GET /domains/:id/gate), mails the owner when a
 * requested transfer starts, releases the domain once it has left (cause `transferred_out`), and offers the operator a denial that
 * accepts only the Transfer Policy reasons.
 */

const iso = (x: unknown) => (x ? new Date(x as string).toISOString() : null);
/** The Gate's texts for a domain held at `registrar` (`domains.registrar`). */
export function approvalNote(registrar: string | null | undefined): string {
  return `${registrarWords(registrar).ours} emails the registrant to approve or decline the transfer. Silence for five days counts as approval. That email is the last checkpoint, and we cannot approve or decline it for you.`;
}
export function cancelNote(registrar: string | null | undefined): string {
  const w = registrarWords(registrar);
  return `Until the new registrar uses the code, lock the domain again: that replaces the code. Once a transfer is pending, only a decline in the email from ${w.from}, or ${w.support}, can end it. Stop this transfer locks the domain, replaces the code and asks ${w.support} for help.`;
}
export function gateSteps(registrar: string | null | undefined): string[] {
  return [
    "Unlock the domain with your passkey.",
    "Get the transfer code with your passkey. We show it once and replace it after 24 hours or when you lock the domain again.",
    "Give the code to your new registrar and start the transfer there.",
    `${registrarWords(registrar).ours} emails the registrant to approve or decline. Silence for five days counts as approval.`,
  ];
}

type Block = { code: "too_new" | "recently_transferred" | "change_of_registrant" | "dispute_lock" | "contact_change_pending"; message: string; until: string | null };

/** GET /api/v1/domains/:id/gate. Owner only; a released domain stays readable through its hold, like its export. */
export async function gateHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = req.principal.userId;
  if (req.principal.kind !== "session" || !userId) throw new HttpError(401, "unauthorized");
  const id = req.params.id ?? "";
  return withUser(ctx.runtime, userId, async (c) => {
    const now = ctx.clock.now();
    const d = UUID_RE.test(id)
      ? (await c.query("select * from domains where id = $1 and user_id = $2 and (released_at is null or release_hold_until > $3)", [id, userId, now])).rows[0]
      : undefined;
    if (!d) throw new HttpError(404, "not_found");
    const sec = (await c.query("select * from domain_security where domain_id = $1", [d.id])).rows[0];
    const policy = await transferPolicy(c, d.tld);
    const lockMs = (policy?.lockDays ?? 60) * DAY_MS;
    const blocks: Block[] = [];
    // C-06: "too new" and "recently transferred" are computed from dates, with the day they lift.
    const created = d.registry_created_at ?? d.registered_at;
    if (created && new Date(created).getTime() + lockMs > now.getTime()) blocks.push({ code: "too_new", message: "A name can move to another registrar 60 days after it was registered.", until: new Date(new Date(created).getTime() + lockMs).toISOString() });
    const lastIn = (await c.query("select completed_at from transfers_in where domain_id = $1 and state = 'completed' order by completed_at desc limit 1", [d.id])).rows[0]?.completed_at;
    if (lastIn && new Date(lastIn).getTime() + lockMs > now.getTime()) blocks.push({ code: "recently_transferred", message: "A name can move to another registrar 60 days after its last transfer.", until: new Date(new Date(lastIn).getTime() + lockMs).toISOString() });
    if (sec?.transfer_lock_until && new Date(sec.transfer_lock_until) > now && sec.transfer_lock_reason !== "transfer_in") blocks.push({ code: "change_of_registrant", message: "The registrant changed, so the name cannot move to another registrar for 60 days.", until: iso(sec.transfer_lock_until) });
    if (d.dispute_lock_state) blocks.push({ code: "dispute_lock", message: "A dispute is open, so the name cannot move until the dispute provider or a court says otherwise.", until: null });
    if (((await c.query("select 1 from contact_changes where domain_id = $1 and state = 'awaiting_approval' limit 1", [d.id])).rowCount ?? 0) > 0) blocks.push({ code: "contact_change_pending", message: "A change of registrant is waiting for approval.", until: null });
    const until = blocks.map((b) => b.until).filter((x): x is string => !!x).sort().pop() ?? null;

    const away = (await c.query("select * from domain_transfers_away where domain_id = $1 order by requested_at desc limit 5", [d.id])).rows;
    const open = away.find((r) => r.state === "open" || r.state === "stopped");
    const codeOut = !!sec?.code_issued_at && (!sec.code_rerandomized_at || new Date(sec.code_rerandomized_at) < new Date(sec.code_issued_at));
    const ticket = (await c.query("select kind, opened_at, sla_due_at from domain_tickets where domain_id = $1 and kind in ('code_request','stop_transfer') and state = 'open' order by opened_at desc", [d.id])).rows;
    const codeTicket = ticket.find((t) => t.kind === "code_request");
    const log = (await c.query("select event, direction, actor_kind, at from transfer_log where domain_id = $1 order by at desc limit 10", [d.id])).rows;
    const state = d.released_at ? "left"
      : open ? (open.explained ? "traveling" : "needs_attention")
      : blocks.length ? "blocked"
      : codeTicket ? "code_requested"
      : codeOut && !d.locked ? "code_issued"
      : !d.locked ? "unlocked" : "locked";
    return json({
      domain: d.fqdn_ascii, domain_id: d.id, state,
      locked: d.locked, unlocked_at: iso(sec?.unlocked_at),
      code: {
        issued_at: iso(sec?.code_issued_at), replace_at: iso(sec?.code_rerandomize_at), outstanding: codeOut, shown_once: true,
        by_support: d.tld === "io",
        request: codeTicket ? { opened_at: iso(codeTicket.opened_at), due_at: iso(codeTicket.sla_due_at), message: "Codes for this extension are set by our registrar's support team. We send the code within 5 days." } : null,
      },
      transferable: blocks.length === 0 && !d.released_at, transferable_from: until, blocks,
      pending: open ? {
        requested_at: iso(open.requested_at), gaining_registrar: open.gaining_registrar, upstream_status: open.upstream_status, requested_by_you: open.explained,
        decline_by: new Date(new Date(open.requested_at).getTime() + 5 * DAY_MS).toISOString(), stopped: open.state === "stopped", stop_available: true,
      } : null,
      steps: gateSteps(d.registrar), approval: approvalNote(d.registrar), cancel: cancelNote(d.registrar), can_cancel_upstream: ordersSvc(ctx).registrar.capabilities().cancelTransferAway,
      // C-04: a payment dispute, an unpaid balance or a card problem never blocks unlock or code release.
      billing_blocks_transfer: false,
      timing: timingFor(d.tld),
      released: d.released_at ? { at: iso(d.released_at), cause: d.release_reason } : null,
      log: log.map((r) => ({ event: r.event, direction: r.direction, actor: r.actor_kind, at: iso(r.at) })),
    });
  });
}

/**
 * Part of `transfer_in.poll`: the Gate's follow-up on what `transfer.poll` (domain-mgmt) saw.
 *  - a transfer the owner asked for (a committed code issue explains it) gets one notice with a freeze link;
 *  - a transfer that completed releases the domain once, after the adapter confirms the name is no longer ours.
 */
export async function gateSweep(ctx: AppContext): Promise<{ notified: number; released: number }> {
  let notified = 0, released = 0;
  const now = ctx.clock.now();
  const requested = (await ctx.cron.query(
    `select t.id, t.user_id, t.domain_id, t.requested_at, d.fqdn_ascii from domain_transfers_away t join domains d on d.id = t.domain_id
      where t.state = 'open' and t.explained and t.gate_notified_at is null and d.released_at is null`)).rows;
  for (const r of requested) {
    const sent = await tx(ctx.cron, async (c) => {
      const u = await c.query("update domain_transfers_away set gate_notified_at = $2 where id = $1 and gate_notified_at is null", [r.id, now]);
      if (u.rowCount !== 1) return false;
      const { token } = await mintEmailActionToken(ctx, c, { userId: r.user_id, purpose: "freeze", eventId: r.domain_id, ttlMs: FREEZE_TTL_MS });
      await mailUser(ctx, c, r.user_id, "transfer_away_started", {
        fqdn: r.fqdn_ascii, requestedAt: new Date(r.requested_at).toISOString(), declineBy: new Date(new Date(r.requested_at).getTime() + 5 * DAY_MS).toISOString(), freezeToken: token,
      }, `transfer.away_started:${r.id}`);
      await logTransfer(ctx, c, { userId: r.user_id, direction: "out", event: "away_requested", actor: "system", domainId: r.domain_id, detail: { transfer_away: r.id } });
      return true;
    });
    if (sent) notified++;
  }

  const port = ordersSvc(ctx).registrar;
  const left = (await ctx.cron.query(
    `select t.id, t.user_id, t.domain_id, t.explained, d.fqdn_ascii from domain_transfers_away t join domains d on d.id = t.domain_id
      where t.state = 'completed' and t.released_at is null`)).rows;
  for (const r of left) {
    let still;
    try { still = await port.getDomain(r.fqdn_ascii); } catch (e) { if (e instanceof RegistrarError) continue; throw e; }
    if (still) continue;   // the adapter still shows it: not gone, nothing released
    const res = await releaseDomain(ctx, r.domain_id, "transferred_out");
    await tx(ctx.cron, async (c) => {
      const u = await c.query("update domain_transfers_away set released_at = $2 where id = $1 and released_at is null", [r.id, now]);
      if (u.rowCount !== 1) return;
      await logTransfer(ctx, c, { userId: r.user_id, direction: "out", event: "away_completed", actor: "system", domainId: r.domain_id, detail: { requested: r.explained, released: res.released } });
    });
    if (res.released) released++;
  }
  return { notified, released };
}

/** I.A.3.8: reasons a registrar MUST deny. The rest of TRANSFER_DENIAL_REASONS are I.A.3.7 reasons it MAY deny. */
export const MUST_DENY: readonly TransferDenialReason[] = ["udrp", "urs", "court_order", "tdrp", "cor_lock"];
/** D-008 and C-05: Mosshatch never uses the unpaid-registration denial as leverage. */
export const NEVER_USED: readonly TransferDenialReason[] = ["non_payment"];

/**
 * C-05, the operator's denial console (no route: the operator works through the ops surface). Only the Transfer Policy reasons are
 * accepted, never "pay first"; the reason is recorded, the Stop ticket carries it to our registrar's support (neither OpenSRS nor
 * Openprovider has an API to NACK), and the registrant is emailed the reason.
 */
export async function denyTransferAway(ctx: AppContext, o: { domainId: string; reason: string; operator: string }): Promise<{ ticketId: string }> {
  if (!(TRANSFER_DENIAL_REASONS as readonly string[]).includes(o.reason)) throw new HttpError(422, "reason_not_allowed");
  const reason = o.reason as TransferDenialReason;
  if (NEVER_USED.includes(reason)) throw new HttpError(422, "reason_not_used");
  return tx(ctx.cron, async (c: PoolClient) => {
    const d = (await c.query("select id, user_id, fqdn_ascii from domains where id = $1 and released_at is null", [o.domainId])).rows[0];
    if (!d) throw new HttpError(404, "not_found");
    const open = (await c.query("select id from domain_transfers_away where domain_id = $1 and state in ('open','stopped') order by requested_at desc limit 1", [d.id])).rows[0];
    if (!open) throw new HttpError(409, "no_pending_transfer");
    const now = ctx.clock.now();
    await c.query("insert into domain_tickets (user_id, domain_id, kind, detail, sla_due_at, opened_at) values ($1,$2,'stop_transfer',$3,$4,$5) on conflict do nothing",
      [d.user_id, d.id, { denial_reason: reason, must_deny: MUST_DENY.includes(reason) }, new Date(now.getTime() + 4 * 3_600_000), now]);
    await c.query("update domain_tickets set detail = detail || $2::jsonb where domain_id = $1 and kind = 'stop_transfer' and state = 'open'", [d.id, { denial_reason: reason }]);
    const ticketId = (await c.query("select id from domain_tickets where domain_id = $1 and kind = 'stop_transfer' and state = 'open'", [d.id])).rows[0].id as string;
    await raiseAlert(ctx, c, { severity: "page", kind: "transfer.deny_requested", subject: d.id, detail: { domain_id: d.id, ticket_id: ticketId, reason } });
    await appendAudit(ctx, c, { chainId: d.user_id, actorKind: "support", action: "domain.transfer_denied", resourceKind: "domain", resourceId: d.id, detail: { reason, transfer_away: open.id } });
    await logTransfer(ctx, c, { userId: d.user_id, direction: "out", event: "away_denied", actor: "operator", domainId: d.id, detail: { reason } });
    await mailUser(ctx, c, d.user_id, "transfer_denied", { fqdn: d.fqdn_ascii, reason: reason as Exclude<TransferDenialReason, "unstated" | "non_payment"> }, `transfer.denied:${open.id}`);
    void o.operator;
    return { ticketId };
  });
}
