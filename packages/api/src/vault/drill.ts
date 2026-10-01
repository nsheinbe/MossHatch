import { tx } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { appendAudit, SYSTEM_CHAIN } from "../audit.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { notifyUser } from "../auth/mail.ts";
import type { KmsTrailEvent, VaultKekClass, VaultKmsAdmin, VaultRole } from "./kms/types.ts";
import { vaultOf } from "./context.ts";
import { rewrapAll } from "./jobs.ts";
import { VAULT_MAIL } from "./mail.ts";
import { MATCH_AFTER_MS, MATCH_BEFORE_MS, RECONCILE_AUDIT_ACTIONS } from "../ops/kms-reconcile.ts";

/**
 * KMS compromise response (PLAN 4.3b Blast radius and Loss radius; runbook docs/runbooks/kms-compromise.md):
 * revoke (explicit Deny on the vault roles), deny (per-owner or key-policy), disable the key, scope the exposure from the
 * trail, build the per-customer affected list, send notices, and migrate every wrapped key to a new KEK with ReEncrypt.
 * The functions are the steps; `runCompromiseDrill` runs them in order and times each one.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `decrypts` successful calls in the window; `unaudited` of them matched no audit row one-to-one; `audited` = none unmatched. */
export interface AffectedSecret { record_id: string; kind: "secret" | "connection"; domain_id: string; env: string; decrypts: number; unaudited: number; audited: boolean }
/** `unaudited`: how many of the customer's records had at least one unaudited decrypt. */
export interface AffectedCustomer { user_id: string; records: AffectedSecret[]; unaudited: number }
/** `unattributable`: successful calls whose context names no record of its owner (malformed or made-up ids). */
export interface TrailScope { affected: AffectedCustomer[]; unattributable: number }

/**
 * Who was exposed: successful Decrypt (and ReEncrypt) events in the window, optionally only from the compromised
 * principals, grouped by the encryption context's `owner_id` and `secret_id`, and confirmed against the database. The
 * context is attacker-chosen (the key policy pins only app, env and the key set), so an id that is not a canonical UUID,
 * or a record its owner does not hold, is counted as unattributable and never reaches a query. Each event is matched
 * one-to-one, as in audit.kms_reconcile, against a pre-decrypt audit row carrying the record's id (`decrypt_nonce`)
 * from 5 minutes before to 2 minutes after it; an event with no row left to consume is unaudited, however many reads
 * of the same record were legitimate. Unaudited decrypts are the ones the attacker made.
 */
export async function scopeTrail(ctx: Pick<AppContext, "cron">, events: KmsTrailEvent[], o: { from: Date; to: Date; principals?: string[] }): Promise<TrailScope> {
  const hits = new Map<string, Map<string, Date[]>>();
  let unattributable = 0;
  for (const e of events) {
    if ((e.eventName !== "Decrypt" && e.eventName !== "ReEncrypt") || e.errorCode || e.at < o.from || e.at >= o.to) continue;
    if (o.principals && !o.principals.includes(e.principal)) continue;
    const owner = e.encryptionContext?.owner_id, rec = e.encryptionContext?.secret_id;
    if (typeof owner !== "string" || typeof rec !== "string" || !UUID.test(owner) || !UUID.test(rec)) { unattributable++; continue; }
    const m = hits.get(owner) ?? new Map<string, Date[]>();
    const at = m.get(rec) ?? [];
    at.push(e.at);
    m.set(rec, at);
    hits.set(owner, m);
  }
  const out: AffectedCustomer[] = [];
  for (const [owner, recs] of hits) {
    const ids = [...recs.keys()];
    const found = (await ctx.cron.query(
      `select id::text, 'secret' as kind, domain_id, env from secrets where user_id = $1 and id = any($2::uuid[])
       union all
       select k.id::text, 'connection', n.domain_id, 'prod' from connection_credentials k join connections n on n.id = k.connection_id where k.user_id = $1 and k.id = any($2::uuid[])`,
      [owner, ids])).rows;
    const confirmed = new Set(found.map((f) => f.id as string));
    for (const [rec, ats] of recs) if (!confirmed.has(rec)) unattributable += ats.length;
    if (!found.length) continue;
    const times = ids.flatMap((id) => recs.get(id) ?? []).map((t) => t.getTime());
    const rows = (await ctx.cron.query(
      `select coalesce(detail->>'kms_ref', detail->>'decrypt_nonce') as token, at from audit_log
        where chain_id = $1 and action ~ $2 and at >= $3 and at <= $4 and coalesce(detail->>'kms_ref', detail->>'decrypt_nonce') = any($5::text[])
        order by at, seq`,
      [owner, RECONCILE_AUDIT_ACTIONS, new Date(times.reduce((a, b) => Math.min(a, b)) - MATCH_BEFORE_MS), new Date(times.reduce((a, b) => Math.max(a, b)) + MATCH_AFTER_MS), [...confirmed]])).rows as { token: string; at: Date }[];
    const records = found.map((f) => {
      const evs = [...(recs.get(f.id) ?? [])].map((t) => t.getTime()).sort((a, b) => a - b);
      const audits = rows.filter((r) => r.token === f.id).map((r) => ({ at: new Date(r.at).getTime(), used: false }));
      let unaudited = 0;
      for (const t of evs) {
        const a = audits.find((x) => !x.used && x.at >= t - MATCH_BEFORE_MS && x.at <= t + MATCH_AFTER_MS);
        if (a) a.used = true; else unaudited++;
      }
      return { record_id: f.id as string, kind: f.kind as "secret" | "connection", domain_id: f.domain_id as string, env: f.env as string, decrypts: evs.length, unaudited, audited: unaudited === 0 };
    });
    out.push({ user_id: owner, records: records.sort((a, b) => a.record_id.localeCompare(b.record_id)), unaudited: records.filter((r) => r.unaudited > 0).length });
  }
  return { affected: out.sort((a, b) => a.user_id.localeCompare(b.user_id)), unattributable };
}

/** The per-customer affected list alone (see `scopeTrail`). */
export async function affectedFromTrail(ctx: Pick<AppContext, "cron">, events: KmsTrailEvent[], o: { from: Date; to: Date; principals?: string[] }): Promise<AffectedCustomer[]> {
  return (await scopeTrail(ctx, events, o)).affected;
}

/** Everyone with live material under a KEK: the list when the key itself (not one session) is suspected. */
export async function customersUnderKek(ctx: Pick<AppContext, "cron">, kekRef: string): Promise<{ user_id: string; records: number }[]> {
  const r = await ctx.cron.query(
    `select user_id, count(*)::int as n from (
       select user_id from secret_versions where kek_ref = $1 and destroyed_at is null
       union all select user_id from connection_credentials where kek_ref = $1 and revoked_at is null) x group by user_id order by user_id`, [kekRef]);
  return r.rows.map((x) => ({ user_id: x.user_id as string, records: x.n as number }));
}

/** One notice per affected customer, counts only, sent at once; one audit row in each customer's chain. */
export async function sendCompromiseNotices(ctx: AppContext, incidentId: string, affected: AffectedCustomer[]): Promise<number> {
  let sent = 0;
  for (const a of affected) {
    await tx(ctx.cron, async (c) => {
      const mail = VAULT_MAIL.incident({ secrets: a.records.length, unaudited: a.unaudited, incidentRef: incidentId.replace(/-/g, "").slice(-8) }, ctx.config.origin);
      const r = await notifyUser(ctx, c, a.user_id, { kind: "vault.incident", subject: mail.subject, text: mail.text, dedupeKey: `vault.incident:${incidentId}:${a.user_id}`, immediate: true });
      await appendAudit(ctx, c, { chainId: a.user_id, actorKind: "system", action: "vault.incident.notice", resourceKind: "incident", resourceId: incidentId, detail: { records: a.records.length, unaudited: a.unaudited } });
      if (r.sent) sent++;
    });
  }
  return sent;
}

/**
 * The auto-deny (PLAN 4.6 row 2): an open `kms.decrypt_unaudited` alert attaches an explicit Deny on Decrypt to both
 * runtime roles through the incident identity. Reversible with `removeRoleDeny`, unlike DisableKey.
 */
export async function autoDenyOnUnauditedDecrypt(ctx: Pick<AppContext, "cron" | "services">, admin: VaultKmsAdmin): Promise<boolean> {
  const open = (await ctx.cron.query("select 1 from alerts where kind = 'kms.decrypt_unaudited' and state = 'open' limit 1")).rowCount;
  if (!open) return false;
  for (const r of ["vault-prod", "vault-nonprod"] as VaultRole[]) await admin.attachRoleDeny(r);
  await raiseAlert(ctx, ctx.cron, { severity: "page", kind: "vault.auto_deny_attached", subject: "kms" });
  return true;
}

export interface DrillStep { step: string; ms: number }
export interface DrillResult { incidentId: string; steps: DrillStep[]; totalMs: number; affected: AffectedCustomer[]; unattributable: number; noticesSent: number; rewrapped: number; newKeks: Record<VaultKekClass, string>; oldKeks: Record<VaultKekClass, string> }

/**
 * Run the drill end to end against the configured KMS (the fake here; the staging account in a live rehearsal).
 * Order: revoke and deny -> disable the old keys -> scope from the trail -> affected list -> notices -> new keys, old keys
 * enabled for the operator only, ReEncrypt everything -> disable the old keys for good -> lift the role deny (the new
 * keys are the only usable ones).
 */
export async function runCompromiseDrill(ctx: AppContext, o: { incidentId: string; window: { from: Date; to: Date }; compromisedPrincipals?: string[]; now?: () => number }): Promise<DrillResult> {
  const v = vaultOf(ctx);
  const admin = v.admin;
  if (!admin) throw new Error("drill: no incident identity configured");
  const now = o.now ?? (() => performance.now());
  const steps: DrillStep[] = [];
  const t0 = now();
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => { const s = now(); const r = await fn(); steps.push({ step: name, ms: Math.round((now() - s) * 100) / 100 }); return r; };

  const oldKeks = { "vault-prod": v.kms.currentKek("vault-prod"), "vault-nonprod": v.kms.currentKek("vault-nonprod") };
  await step("revoke_and_deny", async () => { for (const r of ["vault-prod", "vault-nonprod"] as VaultRole[]) await admin.attachRoleDeny(r); });
  await step("disable_keys", async () => { for (const k of Object.values(oldKeks)) await admin.disableKey(k); });
  const events = await step("scope_from_trail", () => admin.trail(o.window.from, o.window.to));
  const { affected, unattributable } = await step("affected_list", () => scopeTrail(ctx, events, { from: o.window.from, to: o.window.to, principals: o.compromisedPrincipals }));
  const noticesSent = await step("notices", () => sendCompromiseNotices(ctx, o.incidentId, affected));
  const newKeks = await step("new_keys", async () => {
    const out = { "vault-prod": await admin.createKey("vault-prod"), "vault-nonprod": await admin.createKey("vault-nonprod") };
    for (const cls of ["vault-prod", "vault-nonprod"] as VaultKekClass[]) { await admin.restrictToOperator(oldKeks[cls]); await admin.enableKey(oldKeks[cls]); await admin.setCurrentKek(cls, out[cls]); }
    return out;
  });
  const rewrapped = await step("reencrypt", async () => {
    let n = 0;
    for (const cls of ["vault-prod", "vault-nonprod"] as VaultKekClass[]) n += (await rewrapAll(ctx, oldKeks[cls], newKeks[cls])).rewrapped;
    return n;
  });
  await step("retire_old_keys", async () => { for (const k of Object.values(oldKeks)) await admin.disableKey(k); });
  await step("lift_role_deny", async () => { for (const r of ["vault-prod", "vault-nonprod"] as VaultRole[]) await admin.removeRoleDeny(r); });
  const totalMs = Math.round((now() - t0) * 100) / 100;
  await tx(ctx.cron, (c) => appendAudit(ctx, c, { chainId: SYSTEM_CHAIN, actorKind: "system", action: "vault.compromise_drill", resourceKind: "incident", resourceId: o.incidentId, detail: { customers: affected.length, unattributable, rewrapped, notices: noticesSent, total_ms: totalMs } }));
  return { incidentId: o.incidentId, steps, totalMs, affected, unattributable, noticesSent, rewrapped, newKeks, oldKeks };
}
