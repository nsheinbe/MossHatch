import { tx } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { appendAudit, SYSTEM_CHAIN } from "../audit.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { notifyUser } from "../auth/mail.ts";
import type { KmsTrailEvent, VaultKekClass, VaultKmsAdmin, VaultRole } from "./kms/types.ts";
import { vaultOf } from "./context.ts";
import { rewrapAll } from "./jobs.ts";
import { VAULT_MAIL } from "./mail.ts";

/**
 * KMS compromise response (PLAN 4.3b Blast radius and Loss radius; runbook docs/runbooks/kms-compromise.md):
 * revoke (explicit Deny on the vault roles), deny (per-owner or key-policy), disable the key, scope the exposure from the
 * trail, build the per-customer affected list, send notices, and migrate every wrapped key to a new KEK with ReEncrypt.
 * The functions are the steps; `runCompromiseDrill` runs them in order and times each one.
 */

const PAD_MS = 5 * 60_000;
const REVEAL_OR_READ = ["secret.reveal.authorized", "secret.reveal.released", "secret.read", "connection.credential.used"];

export interface AffectedSecret { record_id: string; kind: "secret" | "connection"; domain_id: string; env: string; decrypts: number; audited: boolean }
export interface AffectedCustomer { user_id: string; records: AffectedSecret[]; unaudited: number }

/**
 * Who was exposed: successful Decrypt (and ReEncrypt) events in the window, optionally only from the compromised
 * principals, grouped by the encryption context's `owner_id` and `secret_id`, confirmed against the database (a
 * context whose owner does not own the record is dropped, not trusted), and marked audited when a reveal or read row for
 * the record exists in the padded window. Unaudited decrypts are the ones the attacker made.
 */
export async function affectedFromTrail(ctx: Pick<AppContext, "cron">, events: KmsTrailEvent[], o: { from: Date; to: Date; principals?: string[] }): Promise<AffectedCustomer[]> {
  const hits = new Map<string, Map<string, number>>();
  for (const e of events) {
    if ((e.eventName !== "Decrypt" && e.eventName !== "ReEncrypt") || e.errorCode || e.at < o.from || e.at >= o.to) continue;
    if (o.principals && !o.principals.includes(e.principal)) continue;
    const owner = e.encryptionContext?.owner_id, rec = e.encryptionContext?.secret_id;
    if (!owner || !rec) continue;
    const m = hits.get(owner) ?? new Map<string, number>();
    m.set(rec, (m.get(rec) ?? 0) + 1);
    hits.set(owner, m);
  }
  const out: AffectedCustomer[] = [];
  for (const [owner, recs] of hits) {
    const ids = [...recs.keys()];
    const found = (await ctx.cron.query(
      `select id, 'secret' as kind, domain_id, env from secrets where user_id = $1 and id = any($2::uuid[])
       union all
       select k.id, 'connection', n.domain_id, 'prod' from connection_credentials k join connections n on n.id = k.connection_id where k.user_id = $1 and k.id = any($2::uuid[])`,
      [owner, ids.filter((x) => /^[0-9a-f-]{36}$/.test(x))])).rows;
    if (!found.length) continue;
    const audited = new Set((await ctx.cron.query(
      "select distinct resource_id from audit_log where chain_id = $1 and action = any($2::text[]) and at >= $3 and at < $4 and (resource_id = any($5::text[]) or detail->>'credential_id' = any($5::text[]))",
      [owner, REVEAL_OR_READ, new Date(o.from.getTime() - PAD_MS), new Date(o.to.getTime() + PAD_MS), ids])).rows.map((r) => r.resource_id as string));
    const credAudited = new Set((await ctx.cron.query(
      "select distinct detail->>'credential_id' as id from audit_log where chain_id = $1 and action = 'connection.credential.used' and at >= $2 and at < $3",
      [owner, new Date(o.from.getTime() - PAD_MS), new Date(o.to.getTime() + PAD_MS)])).rows.map((r) => r.id as string));
    const records = found.map((f) => ({ record_id: f.id as string, kind: f.kind as "secret" | "connection", domain_id: f.domain_id as string, env: f.env as string, decrypts: recs.get(f.id) ?? 0, audited: audited.has(f.id) || credAudited.has(f.id) }));
    out.push({ user_id: owner, records: records.sort((a, b) => a.record_id.localeCompare(b.record_id)), unaudited: records.filter((r) => !r.audited).length });
  }
  return out.sort((a, b) => a.user_id.localeCompare(b.user_id));
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
export interface DrillResult { incidentId: string; steps: DrillStep[]; totalMs: number; affected: AffectedCustomer[]; noticesSent: number; rewrapped: number; newKeks: Record<VaultKekClass, string>; oldKeks: Record<VaultKekClass, string> }

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
  const affected = await step("affected_list", () => affectedFromTrail(ctx, events, { from: o.window.from, to: o.window.to, principals: o.compromisedPrincipals }));
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
  await tx(ctx.cron, (c) => appendAudit(ctx, c, { chainId: SYSTEM_CHAIN, actorKind: "system", action: "vault.compromise_drill", resourceKind: "incident", resourceId: o.incidentId, detail: { customers: affected.length, rewrapped, notices: noticesSent, total_ms: totalMs } }));
  return { incidentId: o.incidentId, steps, totalMs, affected, noticesSent, rewrapped, newKeks, oldKeks };
}
