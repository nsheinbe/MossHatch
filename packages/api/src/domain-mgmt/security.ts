import { withUser, type PoolClient } from "@mosshatch/db";
import { RegistrarError } from "@mosshatch/registrar/port";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { markExecuted } from "../stepup/gate.ts";
import { enqueue, type JobRow } from "../jobs/registry.ts";
import { withLease } from "../jobs/engine.ts";
import { appendAudit } from "../audit.ts";
import {
  addBusinessDays, assertWritesOpen, audit, CODE_LIFETIME_MS, DAY_MS, ensureSecurityRow, isHostedNs, mapRegistrarError, normalizeFqdn, notifyDomainEvent,
  ownedDomain, registrarOf, takeFuse, userIdOf, type DomainRow,
} from "./common.ts";
import { assertTransferAllowed } from "./specs.ts";

type Params = Record<string, unknown>;

/** The committed action must be for this exact operation on this exact domain; otherwise it is as good as none (403 step_up_required). */
function actionParams(req: HandlerReq, op: string | string[]): Params {
  const a = req.action;
  const p = (a?.params ?? {}) as Params;
  const ops = Array.isArray(op) ? op : [op];
  const fqdn = normalizeFqdn(req.params.fqdn ?? "");
  if (!a || !ops.includes(String(p.op)) || !fqdn || p.fqdn !== fqdn) throw new HttpError(403, "step_up_required", undefined, undefined, { type: a?.type });
  return p;
}
const actionOf = (req: HandlerReq) => req.action!;

// ---- unlock and lock ---------------------------------------------------------------------------------------------------------------

export async function unlockHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const p = actionParams(req, "unlock");
  await takeFuse(ctx, "unlock");
  try {
    return await withUser(ctx.runtime, userId, async (c) => {
      await assertWritesOpen(c);
      const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
      if (d.id !== p.domain_id) throw new HttpError(403, "step_up_required");
      await assertTransferAllowed(ctx, c, d);
      await markExecuted(c, actionOf(req));
      await registrarOf(ctx).setLock(d.fqdn_ascii, false);
      const u = await c.query("update domains set locked = false where id = $1 and locked", [d.id]);
      if (u.rowCount !== 1) throw new HttpError(409, "already_unlocked");
      await ensureSecurityRow(c, d);
      await c.query("update domain_security set unlocked_at = $2 where domain_id = $1", [d.id, ctx.clock.now()]);
      await audit(ctx, c, userId, "domain.unlocked", { resourceKind: "domain", resourceId: d.id, detail: { action: actionOf(req).id } });
      await notifyDomainEvent(ctx, c, userId, {
        kind: "domain.unlocked", domainId: d.id, subject: "A domain on your Mosshatch account was unlocked",
        text: `${d.fqdn_ascii} was unlocked with your passkey. While it is unlocked, another registrar can start a transfer with a transfer authorization code.`,
      });
      return json({ domain: d.fqdn_ascii, locked: false });
    });
  } catch (e) { throw mapRegistrarError(e); }
}

/** Whether a code was issued and has not yet been replaced by one nobody saw. */
async function codeOutstanding(c: PoolClient, domainId: string): Promise<boolean> {
  const s = (await c.query("select code_issued_at, code_rerandomized_at from domain_security where domain_id = $1", [domainId])).rows[0];
  return !!s?.code_issued_at && (!s.code_rerandomized_at || new Date(s.code_rerandomized_at) < new Date(s.code_issued_at));
}

/** Replace the code with one nobody sees. `.io` codes are set by OpenSRS support, so there is nothing to replace. */
async function rerandomize(ctx: AppContext, fqdn: string): Promise<void> {
  try { await registrarOf(ctx).rerandomizeAuthCode(fqdn); }
  catch (e) { if (!(e instanceof RegistrarError && e.code === "code_by_support")) throw e; }
}

/** Locking is the safe direction: no step-up, no fuse, and it works while writes are paused. It also replaces an outstanding code (ST-120). */
export async function lockHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  try {
    return await withUser(ctx.runtime, userId, async (c) => {
      const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
      const port = registrarOf(ctx);
      await port.setLock(d.fqdn_ascii, true);
      let replaced = false;
      if (await codeOutstanding(c, d.id)) { await rerandomize(ctx, d.fqdn_ascii); replaced = true; }
      await c.query("update domains set locked = true where id = $1", [d.id]);
      await ensureSecurityRow(c, d);
      if (replaced) await c.query("update domain_security set code_rerandomized_at = $2, code_rerandomize_at = null where domain_id = $1", [d.id, ctx.clock.now()]);
      await audit(ctx, c, userId, "domain.locked", { resourceKind: "domain", resourceId: d.id, detail: { code_replaced: replaced } });
      return json({ domain: d.fqdn_ascii, locked: true, code_replaced: replaced });
    });
  } catch (e) { throw mapRegistrarError(e); }
}

// ---- transfer-out code -------------------------------------------------------------------------------------------------------------

/**
 * Issue the code (ST-120, ST-22). The port returns it once; it goes into this response and nowhere else: not the audit row,
 * not a job payload, not a column, not a log line. Only the issue time is stored. A replacement is queued for 24 hours later.
 */
export async function issueCodeHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const p = actionParams(req, "transfer_out");
  await takeFuse(ctx, "code_issue");
  try {
    return await withUser(ctx.runtime, userId, async (c) => {
      await assertWritesOpen(c);
      const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
      if (d.id !== p.domain_id) throw new HttpError(403, "step_up_required");
      await assertTransferAllowed(ctx, c, d);
      if (d.locked) throw new HttpError(409, "domain_locked");
      await markExecuted(c, actionOf(req));
      await ensureSecurityRow(c, d);
      let issued: { code: string; issuedAt: Date };
      try { issued = await registrarOf(ctx).issueAuthCode(d.fqdn_ascii); }
      catch (e) {
        if (e instanceof RegistrarError && e.code === "code_by_support") {
          // .io: OpenSRS support sets the code. Keep a human request open with the 5-calendar-day duty of C-03.
          const due = new Date(ctx.clock.now().getTime() + 5 * DAY_MS);
          await c.query("insert into domain_tickets (user_id, domain_id, kind, detail, sla_due_at, opened_at) values ($1,$2,'code_request',$3,$4,$5) on conflict do nothing", [userId, d.id, { action: actionOf(req).id }, due, ctx.clock.now()]);
          await audit(ctx, c, userId, "domain.code_requested", { resourceKind: "domain", resourceId: d.id });
          return json({ status: "requested", message: "Codes for this extension are set by our registrar's support team. We opened a request and will send the code within 5 days." }, 202);
        }
        throw e;
      }
      const due = new Date(issued.issuedAt.getTime() + CODE_LIFETIME_MS);
      await c.query("update domain_security set code_issued_at = $2, code_rerandomize_at = $3, code_rerandomized_at = null where domain_id = $1", [d.id, issued.issuedAt, due]);
      await enqueue(c, { kind: "domain.code_rerandomize", payload: { domain_id: d.id }, userId, runAt: due, dedupeKey: `code-rr:${d.id}:${issued.issuedAt.getTime()}` });
      await audit(ctx, c, userId, "domain.code_issued", { resourceKind: "domain", resourceId: d.id, detail: { action: actionOf(req).id } });
      await notifyDomainEvent(ctx, c, userId, {
        kind: "domain.code_issued", domainId: d.id, subject: "A transfer code was created for a domain on your Mosshatch account",
        text: `A transfer authorization code was created for ${d.fqdn_ascii} with your passkey. It was shown once and is replaced by a new one after 24 hours or when you lock the domain again. We cannot show it again.`,
      });
      return json({ domain: d.fqdn_ascii, code: issued.code, issued_at: issued.issuedAt.toISOString(), replaced_at: due.toISOString(), shown_once: true });
    });
  } catch (e) { throw mapRegistrarError(e); }
}

/** Job `domain.code_rerandomize`: the 24-hour replacement. Superseded issues find nothing due and do nothing. */
export async function codeRerandomizeJob(ctx: AppContext, job: JobRow): Promise<void> {
  const id = typeof job.payload?.domain_id === "string" ? job.payload.domain_id : null;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
  const row = (await ctx.cron.query(
    `select d.id, d.user_id, d.fqdn_ascii, s.code_rerandomize_at from domain_security s join domains d on d.id = s.domain_id
      where s.domain_id = $1 and d.released_at is null and s.code_rerandomize_at is not null and s.code_rerandomize_at <= $2`, [id, ctx.clock.now()])).rows[0];
  if (!row) return;
  await rerandomize(ctx, row.fqdn_ascii);
  await withLease(ctx, job, async (c) => {
    const u = await c.query("update domain_security set code_rerandomized_at = $2, code_rerandomize_at = null where domain_id = $1 and code_rerandomize_at is not null", [id, ctx.clock.now()]);
    if (u.rowCount === 1) await appendAudit(ctx, c, { chainId: row.user_id, actorKind: "system", action: "domain.code_rerandomized", resourceKind: "domain", resourceId: id, detail: { reason: "24h" } });
  });
}

// ---- nameservers and DS ------------------------------------------------------------------------------------------------------------

export async function nameserversHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const p = actionParams(req, "nameservers");
  await takeFuse(ctx, "ns_change");
  const ns = p.nameservers as string[];
  try {
    return await withUser(ctx.runtime, userId, async (c) => {
      await assertWritesOpen(c);
      const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
      if (d.id !== p.domain_id) throw new HttpError(403, "step_up_required");
      await markExecuted(c, actionOf(req));
      // The registrar refuses too (`dnssec_would_break`); this reads the truth upstream in case our copy of ds_present is stale.
      const port = registrarOf(ctx);
      await port.setNameservers(d.fqdn_ascii, ns, { targetSigned: p.target_signed === true });
      await c.query("update domains set nameservers = $2, dns_hosted_here = $3 where id = $1", [d.id, ns, isHostedNs(ns)]);
      await audit(ctx, c, userId, "domain.nameservers_changed", { resourceKind: "domain", resourceId: d.id, detail: { count: ns.length, hosted_here: isHostedNs(ns) } });
      await notifyDomainEvent(ctx, c, userId, {
        kind: "domain.nameservers_changed", domainId: d.id, subject: "The nameservers of a domain on your Mosshatch account changed",
        text: `The nameservers of ${d.fqdn_ascii} were changed to ${ns.join(", ")} with your passkey.`,
      });
      return json({ domain: d.fqdn_ascii, nameservers: ns, dns_hosted_here: isHostedNs(ns) });
    });
  } catch (e) { throw mapRegistrarError(e); }
}

export const DS_NOTE = "DNSSEC records are relayed to the registry as you enter them. We do not offer DNSSEC signing, and it is not available for .io. Nameserver addresses (glue records, IPv4 or IPv6) are not supported yet: use nameservers under another domain.";

export async function dsListHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const d = await withUser(ctx.runtime, userId, (c) => ownedDomain(c, userId, req.params.fqdn ?? ""));
  const supported = d.tld !== "io";
  let records: unknown[] = [];
  if (supported) { try { records = await registrarOf(ctx).getDs(d.fqdn_ascii); } catch (e) { throw mapRegistrarError(e); } }
  return json({ supported, glue_supported: false, note: supported ? DS_NOTE : "DNSSEC is not available for .io. " + DS_NOTE, records, ds_present: d.ds_present });
}

export async function dsChangeHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const p = actionParams(req, ["ds_add", "ds_remove"]);
  const ds = p.ds as { keyTag: number; algorithm: number; digestType: number; digest: string };
  await takeFuse(ctx, "ns_change");
  try {
    return await withUser(ctx.runtime, userId, async (c) => {
      await assertWritesOpen(c);
      const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
      if (d.id !== p.domain_id) throw new HttpError(403, "step_up_required");
      await markExecuted(c, actionOf(req));
      const port = registrarOf(ctx);
      if (p.op === "ds_add") await port.addDs(d.fqdn_ascii, ds); else await port.removeDs(d.fqdn_ascii, ds);
      const now = (await port.getDs(d.fqdn_ascii)).length > 0;
      await c.query("update domains set ds_present = $2 where id = $1", [d.id, now]);
      await audit(ctx, c, userId, p.op === "ds_add" ? "domain.ds_added" : "domain.ds_removed", { resourceKind: "domain", resourceId: d.id, detail: { ds_present: now } });
      await notifyDomainEvent(ctx, c, userId, {
        kind: "domain.ds_changed", domainId: d.id, subject: "A DNSSEC record of a domain on your Mosshatch account changed",
        text: `A DNSSEC record of ${d.fqdn_ascii} was ${p.op === "ds_add" ? "added" : "removed"} with your passkey.`,
      });
      return json({ domain: d.fqdn_ascii, ds_present: now });
    });
  } catch (e) { throw mapRegistrarError(e); }
}

// ---- read: security state ----------------------------------------------------------------------------------------------------------

export type AttentionKind = "unrequested_transfer" | "dispute_lock" | "registrant_unverified" | "registrant_suspended";
export interface Attention { kind: AttentionKind; message: string }

/** The one blocking item, in the plan's order (4.3b "needs attention"). Only the items this module owns. */
export async function attentionOf(ctx: Pick<AppContext, "clock">, c: PoolClient, d: DomainRow): Promise<Attention | null> {
  const t = (await c.query("select gaining_registrar, requested_at from domain_transfers_away where domain_id = $1 and state in ('open','stopped') and not explained order by requested_at desc limit 1", [d.id])).rows[0];
  if (t) {
    const who = t.gaining_registrar ? String(t.gaining_registrar) : "another registrar";
    return { kind: "unrequested_transfer", message: `A transfer to ${who} started ${new Date(t.requested_at).toISOString()}. You did not ask for it. Decline it in the email from OpenSRS, or press Stop this transfer.` };
  }
  const v = (await c.query("select state, deadline_at from registrant_verifications where domain_id = $1 and state in ('pending','suspended') order by created_at desc limit 1", [d.id])).rows[0];
  if (v?.state === "suspended") return { kind: "registrant_suspended", message: "This domain is on hold because the registrant email was not verified in time. Verify it to lift the hold." };
  if (d.dispute_lock_state) return { kind: "dispute_lock", message: "This domain is locked because of a dispute. Contact changes and transfers are frozen until the dispute provider or registrar says otherwise." };
  if (v?.state === "pending" && new Date(v.deadline_at).getTime() - ctx.clock.now().getTime() < 5 * DAY_MS) return { kind: "registrant_unverified", message: "Verify the registrant email before the deadline, or the domain will be put on hold." };
  return null;
}

export async function securityHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  return withUser(ctx.runtime, userId, async (c) => {
    const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
    const s = (await c.query("select * from domain_security where domain_id = $1", [d.id])).rows[0];
    const u = (await c.query("select frozen_at from users where id = $1", [userId])).rows[0];
    const pending = (await c.query("select id, state, registrant_change, approval_deadline_at from contact_changes where domain_id = $1 and state = 'awaiting_approval' order by created_at desc limit 1", [d.id])).rows[0];
    const ver = (await c.query("select state, reason, deadline_at, verified_at from registrant_verifications where domain_id = $1 order by created_at desc limit 1", [d.id])).rows[0];
    const attention = await attentionOf(ctx, c, d);
    const paused = (await c.query("select value from flags where name = 'registrar_writes_paused'")).rows[0]?.value !== false;
    const iso = (x: unknown) => (x ? new Date(x as string).toISOString() : null);
    return json({
      domain: d.fqdn_ascii,
      state: attention?.kind === "unrequested_transfer" ? "needs_attention" : d.state,
      attention,
      locked: d.locked, unlocked_at: iso(s?.unlocked_at),
      dispute_lock: d.dispute_lock_state ? { state: d.dispute_lock_state, message: "Contact changes and transfers are frozen while this dispute is open." } : null,
      transfer_lock_until: iso(s?.transfer_lock_until) && new Date(s.transfer_lock_until) > ctx.clock.now() ? iso(s.transfer_lock_until) : null,
      transfer_code: { issued_at: iso(s?.code_issued_at), replaced: !!s?.code_issued_at && !!s.code_rerandomized_at && new Date(s.code_rerandomized_at) >= new Date(s.code_issued_at), replace_at: iso(s?.code_rerandomize_at) },
      nameservers: d.nameservers, dns_hosted_here: d.dns_hosted_here, ds_present: d.ds_present,
      contact_change: pending ? { id: pending.id, state: pending.state, registrant_change: pending.registrant_change, approval_deadline_at: iso(pending.approval_deadline_at) } : null,
      registrant_verification: ver ? { state: ver.state, reason: ver.reason, deadline_at: iso(ver.deadline_at), verified_at: iso(ver.verified_at) } : null,
      account_frozen: !!u?.frozen_at,
      registrar_writes_paused: paused,
    });
  });
}

export { addBusinessDays };
