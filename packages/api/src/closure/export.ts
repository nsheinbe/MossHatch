import { z } from "zod";
import { tx, withUser, type PoolClient } from "@mosshatch/db";
import type { RegistrarPort } from "@mosshatch/registrar/port";
import type { AppContext, Envelope } from "../ports.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import { HttpError, json } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { hit } from "../ratelimit.ts";
import { sendMail } from "../email.ts";
import { buildMail } from "../mail/templates.ts";
import { enqueue, type JobRow } from "../jobs/registry.ts";
import { withLease } from "../jobs/engine.ts";
import { markExecuted, requireAction } from "../stepup/gate.ts";
import type { ActionSpec } from "../stepup/specs.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { REGISTRANT_FIELDS } from "../orders/registrant.ts";
import { b64u, randomBytes, safeEqual, sha256 } from "../util/bytes.ts";
import { zip } from "./zip.ts";
import { closureSvc } from "./services.ts";
import {
  EXPORT_BUILD_DEADLINE_MS, EXPORT_TTL_MS, EXPORTS_PER_30_DAYS, DAY_MS, TICKET_TTL_MS, TICKETS_PER_HOUR, UUID_RE, iso, notFound, sessionUser, verifiedAddresses,
} from "./common.ts";

/**
 * Export (PLAN 4.3b "Account closure, export and erasure", design section 4, C-48 access, C-52 DSAR tooling).
 *
 *   POST /account/export           step-up `account.export`; one in flight, three per 30 days; queues `account.export`
 *   account.export job             runs AS THE TENANT (runtime role, RLS), builds one JSON file plus a CSV per table, zips it,
 *                                  encrypts it under the PII key, marks it ready for 7 days and emails every verified address
 *   GET  /account/exports          the person's exports (never a storage reference)
 *   POST /account/exports/:id/link a one-time ticket (256 bits, SHA-256 stored, 5 minutes, bound to this session)
 *   POST /account/exports/:id/download  spends the ticket and returns the file (base64 in JSON: the router serves JSON or HTML only)
 *
 * Never in the file: secret values or ciphertext, token or code hashes, passkey public keys, session ids, the upstream registrar
 * profile password, or any row of another person (every query filters on the person's id and RLS bounds it again).
 */

export const EXPORT_FORMAT = "mosshatch-export-v1";

// ---- the step-up spec -----------------------------------------------------------------------------------------------------------

export const accountExportSpec: ActionSpec<Record<string, never>> = {
  type: "account.export", held: true, userInput: z.strictObject({}),
  async derive(_ctx, c, userId, targetId) {
    if (targetId !== userId) throw notFound();
    const u = (await c.query("select status from users where id = $1", [userId])).rows[0];
    if (!u) throw notFound();
    if (u.status !== "active") throw new HttpError(409, "account_not_active");
    return { params: { user_id: userId, format: EXPORT_FORMAT }, resourceId: userId };
  },
  summary: () => "Make a copy of your account data: your profile and addresses, registrant contact, domains, orders, payments and refunds, notices, consents, your audit trail, tokens, connected apps and cards. Secret values are never in it. We email you when it is ready, and it downloads for 7 days while you are signed in.",
};

// ---- building the file ----------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const plain = (v: unknown): unknown => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) throw new Error("export_binary_column");      // no bytea is ever selected: a hash or key must never slip in
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, plain(x)]));
  return v;
};
const rows = async (c: PoolClient, sql: string, params: unknown[]): Promise<Row[]> => (await c.query(sql, params)).rows.map((r) => plain(r) as Row);

async function tryDecrypt(ctx: AppContext, env: unknown, aads: string[]): Promise<string | null> {
  if (!env || typeof env !== "object") return null;
  for (const a of aads) { try { return await ctx.pii.decrypt(env as Envelope, a); } catch { /* next */ } }
  return null;
}

function registrarOf(ctx: AppContext): RegistrarPort | null {
  const s = ctx.services as { orders?: { registrar?: RegistrarPort }; registrar?: RegistrarPort };
  return s.orders?.registrar ?? s.registrar ?? null;
}

export interface ExportData { format: string; generated_at: string; account_id: string; notes: string[]; tables: Record<string, Row[]> }

/** Everything the person's export holds, read as the person (runtime role, RLS) with explicit column lists. */
export async function buildExportData(ctx: AppContext, userId: string): Promise<ExportData> {
  const now = ctx.clock.now();
  const t: Record<string, Row[]> = {};
  const notes: string[] = [];
  await withUser(ctx.runtime, userId, async (c) => {
    const $ = [userId];
    t.account = await rows(c, "select id, email::text as email, email_verified_at, billing_country, terms_version, terms_accepted_at, status, hardened_mode, device_login_enabled, agent_confirm_threshold_minor, created_at from users where id = $1", $);
    t.notification_addresses = await rows(c, "select id, address::text as address, kind, verified_at, removed_at, created_at from notification_addresses where user_id = $1 order by created_at, id", $);
    t.passkeys = await rows(c, "select id, label, backup_eligible, backup_state, transports, last_used_at, revoked_at, suspended_at, created_at from passkeys where user_id = $1 order by created_at, id", $);
    t.sessions = await rows(c, "select created_at, last_seen_at, expires_at, revoked_at, ip_prefix, ua_family from sessions where user_id = $1 order by created_at", $);
    t.recovery_requests = await rows(c, "select id, path, status, cooling_off_until, hold_until, completed_at, created_at from recovery_requests where user_id = $1 order by created_at, id", $);
    // The registrant contact is the person's own data: decrypted here, inside the encrypted file.
    const contacts = (await c.query("select id, fields_enc, email_verified_at, verification_state, verification_deadline_at, bounced_at, created_at from contacts where user_id = $1 order by created_at, id", $)).rows;
    t.contacts = [];
    for (const r of contacts) {
      const out: Row = { id: r.id };
      for (const f of REGISTRANT_FIELDS) out[f] = await tryDecrypt(ctx, (r.fields_enc as Record<string, unknown>)[f], [`contact:${userId}:${f}`]);
      Object.assign(out, plain({ email_verified_at: r.email_verified_at, verification_state: r.verification_state, verification_deadline_at: r.verification_deadline_at, bounced_at: r.bounced_at, created_at: r.created_at }));
      t.contacts.push(out);
    }
    t.domains = await rows(c, "select id, fqdn_ascii as fqdn, tld, state, registered_at, registry_created_at, expires_at, locked, privacy_status, auto_renew, nameservers, ds_present, released_at, release_reason, created_at from domains where user_id = $1 order by created_at, id", $);
    const orders = (await c.query(
      "select id, kind, fqdn_ascii as fqdn, domain_id, years, state, subtotal_minor, tax_ceiling_minor, total_minor, currency, stripe_payment_intent_id, livemode, failure_code, void_reason, checkout_ip_enc, created_at, updated_at from orders where user_id = $1 order by created_at, id", $)).rows;
    t.orders = [];
    for (const o of orders) {
      const { checkout_ip_enc, ...rest } = o;
      t.orders.push(plain({ ...rest, checkout_network: await tryDecrypt(ctx, checkout_ip_enc, [`order_ip:${o.id}`]) }) as Row);
    }
    t.payments = await rows(c, "select id, order_id, stripe_payment_intent_id, amount_minor, tax_minor, currency, status, captured_at, refunded_minor, dispute_state, billing_state, billing_country, card_brand, livemode, created_at from payments where user_id = $1 order by created_at, id", $);
    t.refunds = await rows(c, "select id, order_id, payment_id, stripe_refund_id, amount_minor, reason, created_at from refunds where user_id = $1 order by created_at, id", $);
    t.renewal_mandates = await rows(c, "select id, domain_id, price_ceiling_minor, charge_days_before_expiry, term_years, accepted_at, revoked_at, revoked_by, next_charge_at, retain_until from renewal_mandates where user_id = $1 order by accepted_at, id", $);
    t.notices = await rows(c, "select id, kind, domain_id, sent_at, template_version, stage, retain_until from notices where user_id = $1 order by sent_at, id", $);
    const consents = (await c.query("select id, kind, document_hash, version, accepted_at, ip_enc, ua_family, assertion_action_id, order_id, domain_id, retain_until from consents where user_id = $1 order by accepted_at, id", $)).rows;
    t.consents = [];
    for (const k of consents) {
      const { ip_enc, assertion_action_id, ...rest } = k;
      const aads = [k.order_id ? `order_ip:${k.order_id}` : "", assertion_action_id ? `consent_ip:${assertion_action_id}` : ""].filter(Boolean);
      t.consents.push(plain({ ...rest, network: await tryDecrypt(ctx, ip_enc, aads) }) as Row);
    }
    t.emails = await rows(c, "select kind, status, created_at from email_log where user_id = $1 order by created_at, id", $);
    // The account's own audit chain (design: "the account's own audit trail"): ids, codes and counts, as stored.
    t.audit_log = await rows(c, "select seq::integer as seq, at, actor_kind, actor_id, action, resource_kind, resource_id, detail, retention_class from audit_log where chain_id = $1 order by seq", $);
    t.tokens = await rows(c,
      `select b.id, b.kind, b.name, b.token_prefix, b.scopes, b.spend_cap_minor, b.spent_minor, b.expires_at, b.revoked_at, b.paused_at, b.last_used_at, b.created_at,
              b.oauth_client_id as connected_app_id, oc.client_name as connected_app_name_reported_by_client
         from bindings b left join oauth_clients oc on oc.id = b.oauth_client_id where b.user_id = $1 order by b.created_at, b.id`, $);
    t.agent_requests = await rows(c, "select id, binding_id, kind, state, domain_id, fqdn_ascii as fqdn, years, quoted_minor, created_at, decided_at, decision_reason, order_id from agent_requests where user_id = $1 order by created_at, id", $);
    t.cards = await rows(c, "select id, domain_id, slug, species, family, rarity, traits, hatched_on, indexable, published_at, unpublished_at, unpublish_reason, takedown_state, created_at from cards where user_id = $1 order by created_at, id", $);
    // Names and version metadata only (design section 4). Values come only through the CLI pull or a step-up reveal.
    t.secrets = await rows(c, "select id, domain_id, env, name, current_version, created_at, updated_at, deleted_at from secrets where user_id = $1 order by created_at, id", $);
    t.connections = await rows(c, "select id, domain_id, service, status, created_at, ended_at from connections where user_id = $1 order by created_at, id", $);
    t.transfers_in = await rows(c, "select id, fqdn_ascii as fqdn, tld, years, state, created_at from transfers_in where user_id = $1 order by created_at, id", $);
    t.transfers_out = await rows(c, "select id, domain_id, gaining_registrar, upstream_status, requested_at, state from domain_transfers_away where user_id = $1 order by requested_at, id", $);
    t.exports = await rows(c, "select id, state, requested_at, ready_at, expires_at, download_count from account_exports where user_id = $1 order by requested_at, id", $);
  });
  // DNS records live at the registrar (the design's "domains and DNS records"): read them for names still here. A failure is noted, not fatal.
  t.dns_records = [];
  const reg = registrarOf(ctx);
  const live = t.domains!.filter((d) => d.released_at === null);
  if (!reg && live.length) notes.push("DNS records could not be read from the registrar when this file was made.");
  for (const d of reg ? live : []) {
    try {
      const zone = await reg!.getDns(String(d.fqdn));
      for (const r of zone.records) t.dns_records.push(plain({ domain_id: d.id, fqdn: d.fqdn, type: r.type, name: r.name, value: r.value, priority: r.priority ?? null }) as Row);
    } catch { notes.push(`DNS records for domain ${String(d.id)} could not be read from the registrar when this file was made.`); }
  }
  return { format: EXPORT_FORMAT, generated_at: now.toISOString(), account_id: userId, notes, tables: t };
}

/** RFC 4180 CSV. A text cell that a spreadsheet would run as a formula is prefixed with an apostrophe (CSV injection). */
export function toCsv(rs: Row[]): string {
  const cols: string[] = [];
  for (const r of rs) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    let s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (typeof v === "string" && /^[=+@\t\r]|^-[^0-9]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rs.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

const README = (d: ExportData) => `Your Mosshatch data (${d.format})

Made ${d.generated_at} for account ${d.account_id}.

export.json holds everything in one file. The tables folder holds the same rows as one CSV file per table.
Money amounts are in minor units (cents). Times are UTC.

Not in this file, on purpose:
- secret values and their encrypted form. Use the CLI pull or reveal a secret with your passkey.
- token, code and session hashes, and passkey public keys.
- anyone else's data.

Questions: privacy@mosshatch.com
${d.notes.length ? "\nNotes:\n" + d.notes.map((n) => `- ${n}`).join("\n") + "\n" : ""}`;

export function exportZip(d: ExportData, at: Date): Buffer {
  const entries = [
    { name: "README.txt", data: README(d) },
    { name: "export.json", data: JSON.stringify(d, null, 2) + "\n" },
    ...Object.entries(d.tables).map(([name, rs]) => ({ name: `tables/${name}.csv`, data: toCsv(rs) })),
  ];
  return zip(entries, at);
}

// ---- the job ---------------------------------------------------------------------------------------------------------------------

/** `account.export`: build, store, mark ready, mail. Safe to run twice: a ready or cancelled export is left alone. */
export async function exportJob(ctx: AppContext, job: JobRow): Promise<void> {
  const exportId = String(job.payload.export_id ?? "");
  const userId = String(job.payload.user_id ?? job.user_id ?? "");
  if (!UUID_RE.test(exportId) || !UUID_RE.test(userId)) return;
  const claim = await withLease(ctx, job, async (c) => {
    const u = (await c.query("select status from users where id = $1", [userId])).rows[0];
    if (!u || u.status !== "active") {
      await c.query("update account_exports set state = 'cancelled', failure_code = 'account_not_active' where id = $1 and user_id = $2 and state in ('requested','building')", [exportId, userId]);
      return false;
    }
    const r = await c.query("update account_exports set state = 'building' where id = $1 and user_id = $2 and state in ('requested','building') returning id", [exportId, userId]);
    return r.rowCount === 1;
  }, { userId });
  if (!claim) return;
  const data = await buildExportData(ctx, userId);
  const file = exportZip(data, ctx.clock.now());
  const ref = await closureSvc(ctx).exportStore.put(ctx, userId, exportId, file);
  const now = ctx.clock.now();
  const expires = new Date(now.getTime() + EXPORT_TTL_MS);
  await withLease(ctx, job, async (c) => {
    const r = await c.query(
      "update account_exports set state = 'ready', ready_at = $3, expires_at = $4, storage_ref = $5, size_bytes = $6, sha256 = $7 where id = $1 and user_id = $2 and state = 'building' returning id",
      [exportId, userId, now, expires, ref, file.length, sha256(file).toString("hex")]);
    if (r.rowCount !== 1) return;
    await appendAudit(ctx, c, { chainId: userId, actorKind: "system", action: "account.export.ready", resourceKind: "account_export", resourceId: exportId, detail: { bytes: file.length, tables: Object.keys(data.tables).length } });
    for (const a of await verifiedAddresses(c, userId)) {
      await sendMail(c, ctx.email, buildMail("account_export_ready", { readyAt: now.toISOString(), expiresAt: expires.toISOString() }, { to: [a.address], dedupeKey: `account.export.ready:${exportId}:${a.id}`, userId, origin: ctx.config.origin }));
    }
  }, { userId });
}

/** `account.export_sweep` (hourly): expired files are deleted, stuck requests failed (design: delivered within 30 days, target 24 hours). */
export async function exportSweep(ctx: AppContext): Promise<{ expired: number; failed: number; tickets: number }> {
  const now = ctx.clock.now();
  const store = closureSvc(ctx).exportStore;
  const due = (await ctx.cron.query("select id, user_id, storage_ref from account_exports where state = 'ready' and expires_at <= $1 limit 500", [now])).rows;
  let expired = 0;
  for (const e of due) {
    await store.remove(ctx, e.id, e.storage_ref);
    await tx(ctx.cron, async (c) => {
      const r = await c.query("update account_exports set state = 'expired', storage_ref = null, file_deleted_at = $2 where id = $1 and state = 'ready'", [e.id, now]);
      if (r.rowCount === 1) { expired++; await appendAudit(ctx, c, { chainId: e.user_id, actorKind: "system", action: "account.export.expired", resourceKind: "account_export", resourceId: e.id }); }
    });
  }
  const stuck = await ctx.cron.query("update account_exports set state = 'failed', failure_code = 'deadline' where state in ('requested','building') and requested_at < $1 returning id", [new Date(now.getTime() - EXPORT_BUILD_DEADLINE_MS)]);
  for (const s of stuck.rows) await raiseAlert(ctx, ctx.cron, { severity: "warn", kind: "account_export_failed", subject: s.id, detail: { export_id: s.id } });
  const t = await ctx.cron.query("delete from account_export_tickets where expires_at < $1", [new Date(now.getTime() - DAY_MS)]);
  return { expired, failed: stuck.rowCount ?? 0, tickets: t.rowCount ?? 0 };
}

// ---- routes ----------------------------------------------------------------------------------------------------------------------

const view = (r: Row) => ({
  id: r.id, state: r.state, requested_at: iso(r.requested_at as Date), ready_at: iso(r.ready_at as Date | null), expires_at: iso(r.expires_at as Date | null),
  size_bytes: r.size_bytes ?? null, download_count: r.download_count ?? 0,
});

export async function requestExport(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const action = requireAction(req, "account.export");
  const { ctx } = req;
  const now = ctx.clock.now();
  const row = await withUser(ctx.runtime, userId, async (c) => {
    await c.query("select id from users where id = $1 for update", [userId]);
    const u = (await c.query("select status from users where id = $1", [userId])).rows[0];
    if (!u || u.status !== "active") throw new HttpError(409, "account_not_active");
    // Counted from the rows themselves: one in flight, three per rolling 30 days (own targets). A refusal does not use the action.
    const open = await c.query("select 1 from account_exports where user_id = $1 and state in ('requested','building') limit 1", [userId]);
    if (open.rowCount) throw new HttpError(409, "export_in_progress");
    const recent = Number((await c.query("select count(*)::int as n from account_exports where user_id = $1 and requested_at > $2", [userId, new Date(now.getTime() - 30 * DAY_MS)])).rows[0].n);
    if (recent >= EXPORTS_PER_30_DAYS) throw new HttpError(429, "rate_limited", undefined, { "Retry-After": String(86_400) });
    await markExecuted(c, action);
    const r = (await c.query("insert into account_exports (user_id, requested_at, state, action_id) values ($1,$2,'requested',$3) returning *", [userId, now, action.id])).rows[0];
    await enqueue(c, { kind: "account.export", userId, payload: { export_id: r.id, user_id: userId }, dedupeKey: `account.export:${r.id}` });
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "account.export.requested", resourceKind: "account_export", resourceId: r.id, detail: { action_id: action.id } });
    return r;
  });
  return json({ export: view(row) }, 202);
}

export async function listExports(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const rs = await withUser(req.ctx.runtime, userId, (c) => c.query("select * from account_exports where user_id = $1 order by requested_at desc limit 20", [userId]));
  return json({ exports: rs.rows.map(view) });
}

/** One code path for "not yours" and "does not exist" (ST-93). */
async function ownedExport(c: PoolClient, userId: string, id: string): Promise<Row> {
  if (!UUID_RE.test(id)) throw notFound();
  const r = (await c.query("select * from account_exports where id = $1 and user_id = $2", [id, userId])).rows[0];
  if (!r) throw notFound();
  return r;
}

export async function exportLink(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const { ctx } = req;
  const sessionHash = req.principal.sessionIdHash!;
  const id = req.params.id ?? "";
  const out = await withUser(ctx.runtime, userId, async (c) => {
    const e = await ownedExport(c, userId, id);
    const now = ctx.clock.now();
    if (e.state !== "ready" || !e.expires_at || new Date(e.expires_at as Date) <= now) throw new HttpError(409, "export_unavailable");
    const lim = await hit(ctx, c, `account.export.ticket:${userId}`, TICKETS_PER_HOUR);
    if (!lim.allowed) throw new HttpError(429, "rate_limited", undefined, { "Retry-After": String(lim.retryAfterSeconds) });
    const token = b64u(randomBytes(32));
    const expires = new Date(now.getTime() + TICKET_TTL_MS);
    await c.query("insert into account_export_tickets (export_id, user_id, token_hash, session_id_hash, expires_at, created_at) values ($1,$2,$3,$4,$5,$6)", [e.id, userId, sha256(token), sessionHash, expires, now]);
    return { token, expires };
  });
  return json({ href: `/api/v1/account/exports/${id}/download`, token: out.token, expires_at: out.expires.toISOString() }, 201, { headers: { "Cache-Control": "no-store, private" } });
}

const DownloadBody = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export async function downloadExport(req: HandlerReq): Promise<HandlerResult> {
  const userId = sessionUser(req);
  const { ctx } = req;
  const sessionHash = req.principal.sessionIdHash!;
  const body = DownloadBody.safeParse(req.body);
  if (!body.success) throw new HttpError(400, "invalid_request");
  const id = req.params.id ?? "";
  const e = await withUser(ctx.runtime, userId, async (c) => {
    const row = await ownedExport(c, userId, id);
    const now = ctx.clock.now();
    const t = (await c.query("select id, session_id_hash, expires_at, used_at from account_export_tickets where export_id = $1 and user_id = $2 and token_hash = $3 for update", [row.id, userId, sha256(body.data.token)])).rows[0];
    // A missing, spent, expired or other-session ticket all answer the same.
    if (!t || t.used_at || new Date(t.expires_at) <= now || !safeEqual(Buffer.from(t.session_id_hash), sessionHash)) throw new HttpError(403, "link_invalid");
    if (row.state !== "ready" || !row.expires_at || new Date(row.expires_at as Date) <= now || !row.storage_ref) throw new HttpError(409, "export_unavailable");
    const used = await c.query("update account_export_tickets set used_at = $2 where id = $1 and used_at is null", [t.id, now]);
    if (used.rowCount !== 1) throw new HttpError(403, "link_invalid");
    await c.query("update account_exports set download_count = download_count + 1, last_downloaded_at = $2 where id = $1", [row.id, now]);
    await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "account.export.downloaded", resourceKind: "account_export", resourceId: String(row.id) });
    return row;
  });
  const file = await closureSvc(ctx).exportStore.get(ctx, userId, String(e.id), String(e.storage_ref));
  if (!file || sha256(file).toString("hex") !== e.sha256) throw new HttpError(409, "export_unavailable");
  const day = new Date(e.ready_at as Date).toISOString().slice(0, 10);
  return json({ filename: `mosshatch-export-${day}.zip`, content_type: "application/zip", size_bytes: file.length, sha256: e.sha256, data: file.toString("base64") }, 200,
    { headers: { "Cache-Control": "no-store, private" } });
}
