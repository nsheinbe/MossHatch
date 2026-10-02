import { tx, withUser, type PoolClient } from "@mosshatch/db";
import type { TransferAwayStatus } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import type { JobRow } from "../jobs/registry.ts";
import { appendAudit } from "../audit.ts";
import { closeAlerts, raiseAlert } from "../ops/alerts.ts";
import { addBusinessDays, audit, DAY_MS, ensureSecurityRow, mapRegistrarError, notifyDomainEvent, ownedDomain, registrarOf, userIdOf, type DomainRow } from "./common.ts";
import { RegistrarError } from "@mosshatch/registrar/port";
import { registrarWords } from "../transfers/registrar-words.ts";

export const PENDING_STATUSES: TransferAwayStatus[] = ["pending_admin", "pending_owner", "pending_registry"];
/** Silence for five days counts as approval; the request is looked for that far back. */
export const TRANSFER_WINDOW_MS = 6 * DAY_MS;
export const DECLINE_WINDOW_MS = 5 * DAY_MS;
/** A transfer started with a code we issued must start inside the code's 24-hour life (plus an hour of grace); an older action does not explain it. */
export const CODE_WINDOW_MS = 25 * 3_600_000;
/** Neither upstream has a call to cancel a transfer away (docs/registrar-parity.md); `registrar` is the domain's `domains.registrar`. */
export function noCancelNote(registrar: string | null | undefined): string {
  const w = registrarWords(registrar);
  return `Only the owner's decline in the email from ${w.from}, or ${w.support}, can end a pending transfer. Stop re-locks the domain and replaces the code, and we asked for help.`;
}

const iso = (x: unknown) => (x ? new Date(x as string).toISOString() : null);

async function attentionNotice(ctx: AppContext, c: PoolClient, d: DomainRow, t: { gaining_registrar: string | null; requested_at: Date }): Promise<void> {
  const who = t.gaining_registrar ?? "another registrar";
  const decline = new Date(new Date(t.requested_at).getTime() + DECLINE_WINDOW_MS).toISOString();
  await notifyDomainEvent(ctx, c, d.user_id, {
    kind: "domain.transfer_unrequested", domainId: d.id, subject: "A transfer of your domain started and you did not ask for it",
    text: `A transfer of ${d.fqdn_ascii} to ${who} started ${new Date(t.requested_at).toISOString()}. You did not ask for it. Decline it in the email from ${registrarWords(d.registrar).from} before ${decline}, or press "Stop this transfer" on the domain page. Silence for five days counts as approval.`,
  });
}

/**
 * Job `transfer.poll` (every 5 minutes, ST-125): one `GET_TRANSFERS_AWAY` for the pending statuses. A pending transfer with no matching
 * committed `domain.transfer_out` action is unrequested: the domain becomes "needs attention", the operator is paged and the customer is
 * emailed with a freeze link. The 5-minute cadence keeps that inside the 10 minutes of the plan. The job never releases a domain: when
 * a transfer completes it records that and leaves the release to the domains module.
 */
export async function transferPoll(ctx: AppContext): Promise<{ seen: number; unrequested: number; closed: number }> {
  const port = registrarOf(ctx);
  const now = ctx.clock.now();
  const list = await port.getTransfersAway({ statuses: PENDING_STATUSES, since: new Date(now.getTime() - TRANSFER_WINDOW_MS) });
  let unrequested = 0, closed = 0;
  const live = new Set<string>();
  for (const t of list) {
    if (!PENDING_STATUSES.includes(t.status)) continue;
    const d = (await ctx.cron.query("select * from domains where fqdn_ascii = $1 and released_at is null", [t.fqdn.toLowerCase()])).rows[0] as DomainRow | undefined;
    if (!d) continue;   // not ours; the inventory reconciliation owns unknown names
    live.add(d.id);
    const explained = ((await ctx.cron.query(
      `select 1 from actions where user_id = $1 and type = 'domain.transfer_out' and state in ('committed','dispatching','executed') and params->>'domain_id' = $2
          and committed_at >= $3 and committed_at <= $4 limit 1`,
      [d.user_id, d.id, new Date(t.requestedAt.getTime() - CODE_WINDOW_MS), new Date(t.requestedAt.getTime() + 5 * 60_000)])).rowCount ?? 0) > 0;
    const isNew = await tx(ctx.cron, async (c) => {
      const r = await c.query(
        `insert into domain_transfers_away (user_id, domain_id, gaining_registrar, upstream_status, requested_at, detected_at, explained)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (domain_id, requested_at) do update set upstream_status = excluded.upstream_status returning id, (xmax = 0) as inserted`,
        [d.user_id, d.id, t.gainingRegistrar ?? null, t.status, t.requestedAt, now, explained]);
      const row = r.rows[0];
      if (!row.inserted) return false;
      if (explained) {
        await appendAudit(ctx, c, { chainId: d.user_id, actorKind: "system", action: "domain.transfer_away_seen", resourceKind: "domain", resourceId: d.id, detail: { transfer: row.id, requested: true } });
        return false;
      }
      await c.query("update domain_transfers_away set prev_domain_state = $2 where id = $1", [row.id, d.state]);
      await c.query("update domains set state = 'needs_attention' where id = $1 and state <> 'needs_attention'", [d.id]);
      const a = await raiseAlert(ctx, c, { severity: "page", kind: "transfer.unrequested", subject: d.id, detail: { domain_id: d.id, transfer_id: row.id } });
      await c.query("update domain_transfers_away set alert_id = $2, notified_at = $3 where id = $1", [row.id, a.id, now]);
      await appendAudit(ctx, c, { chainId: d.user_id, actorKind: "system", action: "domain.transfer_away_unrequested", resourceKind: "domain", resourceId: d.id, detail: { transfer: row.id } });
      await attentionNotice(ctx, c, d, { gaining_registrar: t.gainingRegistrar ?? null, requested_at: t.requestedAt });
      return true;
    });
    if (isNew) unrequested++;
  }

  // Rows we hold open: has the transfer ended (declined, cancelled) or completed since?
  const open = (await ctx.cron.query(
    "select t.id, t.user_id, t.domain_id, t.prev_domain_state, t.explained, t.state, d.fqdn_ascii from domain_transfers_away t join domains d on d.id = t.domain_id where t.state in ('open','stopped')")).rows;
  for (const t of open) {
    if (live.has(t.domain_id)) continue;
    let status: Awaited<ReturnType<typeof port.getDomain>>;
    try { status = await port.getDomain(t.fqdn_ascii); } catch { continue; }
    if (status && status.transferAwayInProgress) continue;
    const completed = status === null;
    await tx(ctx.cron, async (c) => {
      const u = await c.query("update domain_transfers_away set state = $2, closed_at = $3 where id = $1 and state in ('open','stopped') returning id", [t.id, completed ? "completed" : "ended", now]);
      if (u.rowCount !== 1) return;
      if (!completed && t.prev_domain_state) await c.query("update domains set state = $2 where id = $1 and state = 'needs_attention'", [t.domain_id, t.prev_domain_state]);
      if (!completed) await closeAlerts(c, "transfer.unrequested", t.domain_id);
      else await raiseAlert(ctx, c, { severity: "warn", kind: "transfer.completed", subject: t.domain_id, detail: { domain_id: t.domain_id, transfer_id: t.id, requested: t.explained } });
      await appendAudit(ctx, c, { chainId: t.user_id, actorKind: "system", action: completed ? "domain.transfer_away_completed" : "domain.transfer_away_ended", resourceKind: "domain", resourceId: t.domain_id, detail: { transfer: t.id } });
    });
    closed++;
  }
  return { seen: list.length, unrequested, closed };
}

export const transferPollJob = async (ctx: AppContext, _job: JobRow): Promise<void> => { await transferPoll(ctx); };

// ---- Stop -------------------------------------------------------------------------------------------------------------------------

/** Re-lock, replace the code, open the ticket (ST-125). Safe direction: no step-up, no fuse, works while registrar writes are paused. */
export async function stopHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  try {
    return await withUser(ctx.runtime, userId, async (c) => {
      const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
      const now = ctx.clock.now();
      let res: { pendingTransferRemains: boolean };
      try { res = await registrarOf(ctx).stopTransferAway(d.fqdn_ascii); }
      catch (e) { if (e instanceof RegistrarError && e.code === "code_by_support") res = { pendingTransferRemains: true }; else throw e; }
      await c.query("update domains set locked = true where id = $1", [d.id]);
      await ensureSecurityRow(c, d);
      await c.query("update domain_security set unlocked_at = null where domain_id = $1", [d.id]);   // the expected lock state is on again
      await c.query("update domain_security set code_rerandomized_at = $2, code_rerandomize_at = null where domain_id = $1 and code_issued_at is not null", [d.id, now]);
      const stopped = (await c.query("update domain_transfers_away set state = 'stopped', stopped_at = $2 where domain_id = $1 and state = 'open' returning id", [d.id, now])).rows.map((r) => r.id as string);
      const known = stopped.length > 0 || (await c.query("select 1 from domain_transfers_away where domain_id = $1 and state = 'stopped'", [d.id])).rowCount! > 0;
      let ticketId: string | null = null;
      if (res.pendingTransferRemains || known) {
        const t = await c.query(
          "insert into domain_tickets (user_id, domain_id, kind, detail, sla_due_at, opened_at) values ($1,$2,'stop_transfer',$3,$4,$5) on conflict do nothing returning id",
          [userId, d.id, { transfers: stopped.length, pending_remains: res.pendingTransferRemains }, new Date(now.getTime() + 4 * 3_600_000), now]);
        ticketId = t.rows[0]?.id ?? (await c.query("select id from domain_tickets where domain_id = $1 and kind = 'stop_transfer' and state = 'open'", [d.id])).rows[0]?.id ?? null;
        await raiseAlert(ctx, c, { severity: "page", kind: "transfer.stop_requested", subject: d.id, detail: { domain_id: d.id, ticket_id: ticketId } });
      }
      await audit(ctx, c, userId, "domain.transfer_stopped", { resourceKind: "domain", resourceId: d.id, detail: { pending_remains: res.pendingTransferRemains, ticket: ticketId } });
      await notifyDomainEvent(ctx, c, userId, {
        kind: "domain.transfer_stopped", domainId: d.id, subject: "Stop was pressed for a domain on your Mosshatch account",
        text: `${d.fqdn_ascii} was locked again and its transfer code was replaced. ${noCancelNote(d.registrar)}`,
      });
      return json({ domain: d.fqdn_ascii, relocked: true, code_replaced: true, pending_transfer_remains: res.pendingTransferRemains, ticket_id: ticketId, message: noCancelNote(d.registrar) });
    });
  } catch (e) { throw mapRegistrarError(e); }
}

export async function transferStateHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  return withUser(ctx.runtime, userId, async (c) => {
    const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
    const rows = (await c.query("select * from domain_transfers_away where domain_id = $1 order by requested_at desc limit 10", [d.id])).rows;
    const open = rows.find((r) => r.state === "open" || r.state === "stopped");
    const ticket = (await c.query("select id, kind, state, opened_at from domain_tickets where domain_id = $1 and kind in ('stop_transfer','code_request') and state = 'open' order by opened_at desc limit 1", [d.id])).rows[0];
    const dueAt = (r: { requested_at: Date }) => new Date(new Date(r.requested_at).getTime() + DECLINE_WINDOW_MS).toISOString();
    return json({
      domain: d.fqdn_ascii,
      state: !open ? "none" : open.state === "stopped" ? "stopped_pending" : open.explained ? "requested" : "unrequested",
      stop_available: !!open,
      can_cancel_upstream: false,
      note: open ? noCancelNote(d.registrar) : null,
      message: open && !open.explained ? `A transfer to ${open.gaining_registrar ?? "another registrar"} started ${iso(open.requested_at)}. You did not ask for it. Decline it in the email from ${registrarWords(d.registrar).from}, or press Stop this transfer.` : null,
      transfers: rows.map((r) => ({ id: r.id, gaining_registrar: r.gaining_registrar, upstream_status: r.upstream_status, requested_at: iso(r.requested_at), requested_by_you: r.explained, state: r.state, decline_by: dueAt(r) })),
      ticket: ticket ? { id: ticket.id, kind: ticket.kind, opened_at: iso(ticket.opened_at) } : null,
      timing: "A transfer can take several days and sometimes about two weeks. It stays Traveling until the registry confirms.",
    });
  });
}

// ---- Freeze (ST-148) --------------------------------------------------------------------------------------------------------------

/**
 * Job `domain.freeze_apply`, queued by the trigger on `users.frozen_at`. The Phase 2 primitives already ended the sessions and paused
 * the bindings; this locks each domain and replaces any outstanding code. It never unlocks, never touches nameservers and never
 * stops a renewal. A pending outbound transfer opens the Stop ticket (plan 4.3b item 7).
 */
export async function freezeApplyJob(ctx: AppContext, job: JobRow): Promise<void> {
  const userId = typeof job.payload?.user_id === "string" ? job.payload.user_id : job.user_id;
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return;
  const port = registrarOf(ctx);
  const domains = (await ctx.cron.query("select * from domains where user_id = $1 and released_at is null", [userId])).rows as DomainRow[];
  let failed = 0;
  for (const d of domains) {
    try {
      await port.setLock(d.fqdn_ascii, true);
      const sec = (await ctx.cron.query("select code_issued_at, code_rerandomized_at from domain_security where domain_id = $1", [d.id])).rows[0];
      const outstanding = !!sec?.code_issued_at && (!sec.code_rerandomized_at || new Date(sec.code_rerandomized_at) < new Date(sec.code_issued_at));
      if (outstanding) { try { await port.rerandomizeAuthCode(d.fqdn_ascii); } catch (e) { if (!(e instanceof RegistrarError && e.code === "code_by_support")) throw e; } }
      await tx(ctx.cron, async (c) => {
        const now = ctx.clock.now();
        await c.query("update domains set locked = true where id = $1", [d.id]);
        await c.query("update domain_security set unlocked_at = null where domain_id = $1", [d.id]);   // the expected lock state is on again
        if (outstanding) await c.query("update domain_security set code_rerandomized_at = $2, code_rerandomize_at = null where domain_id = $1", [d.id, now]);
        const t = (await c.query("select id from domain_transfers_away where domain_id = $1 and state = 'open'", [d.id])).rows;
        if (t.length) {
          await c.query("insert into domain_tickets (user_id, domain_id, kind, detail, sla_due_at, opened_at) values ($1,$2,'stop_transfer',$3,$4,$5) on conflict do nothing", [userId, d.id, { transfers: t.length, via: "freeze" }, new Date(now.getTime() + 4 * 3_600_000), now]);
          await raiseAlert(ctx, c, { severity: "page", kind: "transfer.stop_requested", subject: d.id, detail: { domain_id: d.id, via: "freeze" } });
        }
        await appendAudit(ctx, c, { chainId: userId, actorKind: "system", action: "domain.frozen", resourceKind: "domain", resourceId: d.id, detail: { code_replaced: outstanding, pending_transfers: t.length } });
      });
    } catch { failed++; }
  }
  if (failed) throw new Error(`freeze_partial:${failed}`);
}

export { addBusinessDays };
