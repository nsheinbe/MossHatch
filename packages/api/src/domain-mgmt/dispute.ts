import { tx } from "@mosshatch/db";
import { RegistrarError } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { notifyUser } from "../auth/mail.ts";
import { closeAlerts, raiseAlert } from "../ops/alerts.ts";
import { addBusinessDays, ensureSecurityRow, registrarOf } from "./common.ts";

/**
 * Dispute lock (C-23). Settable only on a registrar instruction, so there is no customer route: an operator calls this with the
 * provider's request in hand. It freezes contact edits and transfer-out (the step-up specs and handlers refuse with 423
 * `dispute_lock`), keeps the domain locked at the registrar, raises a 24x7 alert and opens a ticket due in 2 business days to supply
 * the data. Clearing it (withdrawal, decision) has a 1 business day duty, recorded on the ticket. A payment dispute is NOT this state
 * and never blocks unlock or code release (Transfer Policy I.A.5.4).
 */
export const DISPUTE_STATES = ["udrp_locked", "udrp_decision_pending", "urs_locked", "io_policy_locked"] as const;
export type DisputeState = (typeof DISPUTE_STATES)[number];
export const DISPUTE_SUPPLY_DATA_BUSINESS_DAYS = 2;
export const DISPUTE_RELEASE_BUSINESS_DAYS = 1;

export async function setDisputeLock(ctx: AppContext, o: { domainId: string; state: DisputeState; staffId: string }): Promise<{ ticketId: string | null; dueAt: Date }> {
  if (!(DISPUTE_STATES as readonly string[]).includes(o.state)) throw new Error("bad_dispute_state");
  const d = (await ctx.cron.query("select id, user_id, fqdn_ascii from domains where id = $1 and released_at is null", [o.domainId])).rows[0];
  if (!d) throw new Error("not_found");
  const now = ctx.clock.now();
  const due = addBusinessDays(now, DISPUTE_SUPPLY_DATA_BUSINESS_DAYS);
  // Lock at the registrar first; the state below is recorded either way so the product side is frozen even if the call fails.
  let locked = true;
  try { await registrarOf(ctx).setLock(d.fqdn_ascii, true); } catch (e) { if (!(e instanceof RegistrarError)) throw e; locked = false; }
  return tx(ctx.cron, async (c) => {
    await c.query("update domains set dispute_lock_state = $2, locked = locked or $3 where id = $1", [d.id, o.state, locked]);
    await ensureSecurityRow(c, d);
    // A dispute lock ends the owner's unlock: the posture job keeps the name locked from now on.
    await c.query("update domain_security set unlocked_at = null where domain_id = $1", [d.id]);
    const t = await c.query(
      "insert into domain_tickets (user_id, domain_id, kind, detail, sla_due_at, opened_at) values ($1,$2,'dispute_lock',$3,$4,$5) on conflict do nothing returning id",
      [d.user_id, d.id, { state: o.state, supply_data_by_business_days: DISPUTE_SUPPLY_DATA_BUSINESS_DAYS, registrar_locked: locked }, due, now]);
    await raiseAlert(ctx, c, { severity: "page", kind: "domain.dispute_lock", subject: d.id, detail: { domain_id: d.id, state: o.state, registrar_locked: locked } });
    await appendAudit(ctx, c, { chainId: d.user_id, actorKind: "support", actorId: o.staffId, action: "domain.dispute_lock_set", resourceKind: "domain", resourceId: d.id, detail: { state: o.state, registrar_locked: locked } });
    await notifyUser(ctx, c, d.user_id, { kind: "domain.dispute_lock", dedupeKey: `dispute-lock:${d.id}:${now.getTime()}`, immediate: true, subject: "A domain on your account is locked because of a dispute",
      text: `${d.fqdn_ascii} is locked because a dispute provider or our registrar told us to. Contact changes and transfers are frozen until the dispute ends. Renewals continue.` });
    return { ticketId: (t.rows[0]?.id as string | undefined) ?? null, dueAt: due };
  });
}

export async function clearDisputeLock(ctx: AppContext, o: { domainId: string; staffId: string }): Promise<void> {
  const d = (await ctx.cron.query("select id, user_id, fqdn_ascii from domains where id = $1", [o.domainId])).rows[0];
  if (!d) throw new Error("not_found");
  const now = ctx.clock.now();
  await tx(ctx.cron, async (c) => {
    const u = await c.query("update domains set dispute_lock_state = null where id = $1 and dispute_lock_state is not null returning id", [d.id]);
    if (u.rowCount !== 1) return;
    await c.query("update domain_tickets set state = 'closed', closed_at = $2, detail = detail || $3::jsonb where domain_id = $1 and kind = 'dispute_lock' and state = 'open'",
      [d.id, now, { release_due_by: addBusinessDays(now, DISPUTE_RELEASE_BUSINESS_DAYS).toISOString() }]);
    await closeAlerts(c, "domain.dispute_lock", d.id);
    await appendAudit(ctx, c, { chainId: d.user_id, actorKind: "support", actorId: o.staffId, action: "domain.dispute_lock_cleared", resourceKind: "domain", resourceId: d.id, detail: {} });
    await notifyUser(ctx, c, d.user_id, { kind: "domain.dispute_lock_cleared", dedupeKey: `dispute-clear:${d.id}:${now.getTime()}`, immediate: true, subject: "The dispute lock on a domain was lifted",
      text: `The dispute lock on ${d.fqdn_ascii} was lifted. Contact changes and transfers work again.` });
  });
}
