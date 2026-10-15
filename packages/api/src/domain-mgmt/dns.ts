import { z } from "zod";
import { withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import { DNS_RECORD_TYPES, RegistrarError, type DnsRecord, type DnsRecordType } from "@mosshatch/registrar/port";
import { canonicalZone, normalizeName, normalizeRecord, validateZone, withDnsTtl, zoneHash } from "@mosshatch/registrar/dns";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import type { JobRow } from "../jobs/registry.ts";
import { hit } from "../ratelimit.ts";
import { appendAudit, type AuditEntry } from "../audit.ts";
import { assertWritesOpen, audit, DAY_MS, mapRegistrarError, notFound, notifyDomainEvent, ownedDomain, registrarOf, sha256hex, userIdOf, type DomainRow } from "./common.ts";
import { classifyRecord, normalizeOwner, type SensitiveReason } from "./classify.ts";
import { approveSessionDns } from "./dns-approval.ts";
import { lockUser } from "../agents/common.ts";

/** Plan 4.3b write safety: more than 5 deleted records, or any MX, TXT or SRV the intent does not name, refuses the write. */
export const MAX_DELETES = 5;
export const SNAPSHOT_TTL_MS = 30 * DAY_MS;
const PROTECTED_TYPES = new Set<DnsRecordType>(["MX", "TXT", "SRV"]);

const key = (r: DnsRecord) => JSON.stringify([r.type, r.name, r.value, r.priority ?? null, r.weight ?? null, r.port ?? null, r.ttl ?? null]);
/** A stable id for a record, so the web app can PATCH or DELETE one (the provider has no record ids). */
export const recordId = (r: DnsRecord): string => "r_" + sha256hex(key(normalizeRecord(r))).slice(0, 20);

const num = z.number().int().min(0).max(65535);
export const RecordIn = z.object({
  type: z.enum(DNS_RECORD_TYPES as unknown as [DnsRecordType, ...DnsRecordType[]]),
  name: z.string().trim().max(253),
  value: z.string().min(1).max(4096),
  priority: num.optional(), weight: num.optional(), port: num.optional(), ttl: z.number().int().min(0).max(2147483647).optional(),
}).strict();
export const NamedIn = z.object({ type: z.enum(DNS_RECORD_TYPES as unknown as [DnsRecordType, ...DnsRecordType[]]), name: z.string().trim().max(253), value: z.string().max(4096).optional() }).strict();
export const PutBody = z.object({ records: z.array(RecordIn).max(500), remove: z.array(NamedIn).max(500).optional() }).strict();
export const AddBody = z.object({ records: z.array(RecordIn).min(1).max(100) }).strict();
export const PatchBody = z.object({ value: z.string().min(1).max(4096).optional(), priority: num.optional(), weight: num.optional(), port: num.optional(), ttl: z.number().int().min(0).max(2147483647).optional() }).strict()
  .refine((b) => Object.keys(b).length > 0);

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(422, "invalid_record");
  return r.data;
}

/** Relative, lower-case, A-label form of the record, so `@`, a trailing dot and a name written with the zone all agree. */
function toRecord(zone: string, r: z.infer<typeof RecordIn>): DnsRecord {
  const out: DnsRecord = { type: r.type, name: normalizeOwner(r.name, zone), value: r.value };
  if (r.priority !== undefined) out.priority = r.priority;
  if (r.weight !== undefined) out.weight = r.weight;
  if (r.port !== undefined) out.port = r.port;
  if (r.ttl !== undefined) out.ttl = r.ttl;
  return normalizeRecord(out);
}

/** Shape rules the provider would reject or that break a zone: MX and SRV fields, a CNAME beside other records, a CNAME at the apex. */
export function checkShape(records: readonly DnsRecord[]): void {
  const byName = new Map<string, Set<DnsRecordType>>();
  for (const r of records) {
    if (r.type === "MX" && r.priority === undefined) throw new HttpError(422, "mx_needs_priority");
    if (r.type === "SRV" && (r.priority === undefined || r.weight === undefined || r.port === undefined)) throw new HttpError(422, "srv_needs_fields");
    const set = byName.get(r.name) ?? new Set(); set.add(r.type); byName.set(r.name, set);
  }
  for (const [name, types] of byName) {
    if (types.has("CNAME") && name === "") throw new HttpError(422, "cname_at_apex");
    if (types.has("CNAME") && types.size > 1) throw new HttpError(422, "cname_conflict");
  }
}

interface Named { type: DnsRecordType; name: string; value?: string }
const covers = (n: Named, r: DnsRecord): boolean => n.type === r.type && n.name === r.name && (n.value === undefined || normalizeRecord({ ...r, value: n.value }).value === r.value);

export interface Diff { added: DnsRecord[]; removed: DnsRecord[] }
export function diffZones(live: readonly DnsRecord[], desired: readonly DnsRecord[]): Diff {
  const l = canonicalZone(live), d = canonicalZone(desired);
  const lk = new Set(l.map(key)), dk = new Set(d.map(key));
  return { added: d.filter((r) => !lk.has(key(r))), removed: l.filter((r) => !dk.has(key(r))) };
}

/** Safety rules of the plan, applied to the difference between the fresh read and the desired zone. */
export function assertSafeDiff(diff: Diff, named: readonly Named[]): void {
  if (diff.removed.length > MAX_DELETES) throw new HttpError(422, "too_many_deletes");
  for (const r of diff.removed) if (PROTECTED_TYPES.has(r.type) && !named.some((n) => covers(n, r))) throw new HttpError(422, "unrelated_delete");
}

export interface Sensitive { type: DnsRecordType; name: string; reasons: SensitiveReason[] }
export function sensitiveOf(zone: string, diff: Diff, live: readonly DnsRecord[] = []): Sensitive[] {
  const out = new Map<string, Sensitive>();
  const dependencies = new Set<string>();
  // MX/SRV/CNAME targets may use arbitrary labels. Follow aliases to address records.
  for (const r of [...live, ...diff.added]) {
    if (["MX", "SRV", "CNAME", "NS"].includes(r.type)) dependencies.add(normalizeOwner(r.value, zone));
    if (["HTTPS", "SVCB"].includes(r.type)) dependencies.add(normalizeOwner(r.value.split(/\s+/)[1] ?? "", zone));
  }
  for (const r of [...diff.added, ...diff.removed]) {
    const reasons = new Set(classifyRecord(r, zone).reasons);
    if (dependencies.has(normalizeOwner(r.name, zone))) reasons.add("service_dependency");
    if (["A", "AAAA", "CNAME"].includes(r.type) && live.some((x) => x.name === r.name && ["A", "AAAA", "CNAME"].includes(x.type))) reasons.add("production_host");
    if (diff.removed.some((x) => key(x) === key(r))) reasons.add("deletion");
    if (!reasons.size) continue;
    const k = `${r.type}|${r.name}`;
    const existing = out.get(k);
    out.set(k, { type: r.type, name: r.name, reasons: [...new Set([...(existing?.reasons ?? []), ...reasons])] });
  }
  return [...out.values()];
}

/** Default TTL is part of the immutable target, never introduced only after approval. */
export const materializeTtl = withDnsTtl;

const publicRecord = (zone: string, r: DnsRecord) => {
  const c = classifyRecord(r, zone);
  return { id: recordId(r), ...r, editable: (DNS_RECORD_TYPES as readonly string[]).includes(r.type), name: r.name === "" ? "@" : r.name, sensitive: c.sensitive, reasons: c.reasons };
};

const lockKey = (domainId: string) => `mh.dns:${domainId}`;

interface ZoneSession {
  /** One transaction on the session's connection, as the person (RLS applies). */
  step: <R>(f: (c: PoolClient) => Promise<R>) => Promise<R>;
  /** Take the domain's zone lock until the session ends. */
  lock: (c: PoolClient, domainId: string) => Promise<void>;
}

/**
 * A zone write in several transactions on one pooled connection, holding the per-domain lock from the fresh read to the follow-up: a
 * session-level advisory lock on the same key the transaction-level writers take (the two kinds exclude each other). The pre-write
 * snapshot and an intent audit row commit BEFORE the registrar is called, so an unknown outcome, or a failure after the write, never
 * loses them (plan 4.3b: the pre-write zone is stored with a rollback).
 */
async function zoneSession<T>(ctx: AppContext, userId: string, fn: (s: ZoneSession) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new HttpError(401, "unauthorized");
  const conn = await ctx.runtime.connect();
  const held: string[] = [];
  let broken = false;
  const step = async <R>(f: (c: PoolClient) => Promise<R>): Promise<R> => {
    await conn.query("begin");
    try {
      await conn.query("select set_config('app.user_id', $1, true)", [userId]);
      const r = await f(conn);
      await conn.query("commit");
      return r;
    } catch (e) {
      await conn.query("rollback").catch(() => { broken = true; });
      throw e;
    }
  };
  const lock = async (c: PoolClient, domainId: string) => {
    await c.query("select pg_advisory_lock(hashtextextended($1, 0))", [lockKey(domainId)]);
    held.push(lockKey(domainId));
  };
  try { return await fn({ step, lock }); }
  finally {
    for (const k of held) await conn.query("select pg_advisory_unlock(hashtextextended($1, 0))", [k]).catch(() => { broken = true; });
    conn.release(broken);                                    // a connection that may still hold the lock is closed, never pooled
  }
}

/**
 * Who a zone write is for: kept on the snapshot (`actor_kind`) and as the actor of every audit row the write makes, with the notice the
 * owner gets when a sensitive record changed (`maybe`: the registrar did not confirm the write, so it may have landed).
 */
export interface ZoneWriter {
  snapshotKind: "user" | "recipe" | "agent";
  actorKind: AuditEntry["actorKind"];
  actorId?: string;
  requestId?: string;
  /** Null sends nothing: a caller that sends its own notice in `after` (an approved agent change) returns null for the applied case. */
  notice: (n: { fqdn: string; sensitive: Sensitive[]; maybe: boolean }) => { subject: string; text: string } | null;
}

/** The DNS tab: the signed-in person. Its audit rows are the same as `audit()` writes (actor `user`, the person's id). */
const sessionWriter = (userId: string): ZoneWriter => ({
  snapshotKind: "user", actorKind: "user", actorId: userId,
  notice: ({ fqdn, sensitive, maybe }) => maybe
    ? { subject: "A sensitive DNS record on your Mosshatch domain may have changed", text: `A change from your signed-in session to ${sensitive.length} sensitive DNS record${sensitive.length === 1 ? "" : "s"} on ${fqdn} may have been applied: our registrar did not confirm it.\n${sensitiveLines(sensitive)}\n\nThese records control mail, certificates and where the domain points. Review the saved receipt in the DNS tab, under History. An uncertain outcome must be reconciled before another change or rollback. Rollback needs a new review and cannot undo cached answers or lost mail.` }
    : { subject: "A sensitive DNS record on your Mosshatch domain changed", text: `A change from your signed-in session touched ${sensitive.length} sensitive DNS record${sensitive.length === 1 ? "" : "s"} on ${fqdn}:\n${sensitiveLines(sensitive)}\n\nThese records control mail, certificates and where the domain points. Review the saved receipt in the DNS tab, under History. An uncertain outcome must be reconciled before another change or rollback. Rollback needs a new review and cannot undo cached answers or lost mail.` },
});

const zoneAudit = (ctx: AppContext, c: PoolClient, userId: string, w: ZoneWriter, action: string, domainId: string, detail: Record<string, unknown>) =>
  appendAudit(ctx, c, { chainId: userId, actorKind: w.actorKind, actorId: w.actorId, action, resourceKind: "domain", resourceId: domainId, detail });

/** The pre-write zone (and the hash of the zone the write asks for), committed as `pending` with an intent audit row before the registrar is called. */
async function takeSnapshot(ctx: AppContext, c: PoolClient, userId: string, d: DomainRow, reason: "pre_write" | "pre_rollback", live: DnsRecord[], target: DnsRecord[], diff: Diff, sensitive: Sensitive[], extra: Record<string, unknown> = {}, w: ZoneWriter = sessionWriter(userId)): Promise<string> {
  const now = ctx.clock.now();
  const snap = (await c.query(
    `insert into dns_snapshots (user_id, domain_id, reason, zone_hash, records, added_count, removed_count, sensitive_count, actor_kind, taken_at, expires_at, write_state, intended_hash, intended_records, agent_request_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,$14) returning id`,
    [userId, d.id, reason, zoneHash(live), JSON.stringify(live), diff.added.length, diff.removed.length, sensitive.length, w.snapshotKind, now, new Date(now.getTime() + SNAPSHOT_TTL_MS), zoneHash(target), JSON.stringify(target), w.requestId ?? null])).rows[0];
  await zoneAudit(ctx, c, userId, w, "dns.write_intent", d.id, { snapshot: snap.id, reason, added: diff.added.length, removed: diff.removed.length, sensitive: sensitive.length, ...extra });
  return snap.id as string;
}

/**
 * Send the zone once. A confirmed pre-mutation refusal marks the snapshot `refused` and
 * leaves the history. Any other failure may have landed: the snapshot stays for rollback marked `unknown`, the audit says so, and a change
 * that may have touched sensitive records is announced like one that did. `failed` (the caller's own rows for the outcome) runs first in
 * the same transaction, before any audit row.
 */
async function sendZone(ctx: AppContext, s: ZoneSession, userId: string, d: DomainRow, live: DnsRecord[], target: DnsRecord[], snapId: string, sensitive: Sensitive[], w: ZoneWriter = sessionWriter(userId), failed?: ZoneFailed): Promise<{ hash: string }> {
  const port = registrarOf(ctx);
  try {
    const accepted = await port.replaceZone(d.fqdn_ascii, target, { expectedHash: zoneHash(live) });
    // Independently verify complete state even when an adapter only acknowledged acceptance.
    const observed = await liveZone(ctx, d);
    if (zoneHash(observed.records) !== zoneHash(target) || accepted.hash !== zoneHash(target)) {
      throw new RegistrarError("unknown", "dns_readback_mismatch", { outcomeUnknown: true, retryable: false, code: "dns_readback_mismatch" });
    }
    return { hash: zoneHash(observed.records) };
  }
  catch (e) {
    const refused = e instanceof RegistrarError && !e.outcomeUnknown && e.kind !== "unknown" && e.code !== "dns_readback_mismatch";
    await s.step(async (c) => {
      if (failed) await failed(c, refused ? "refused" : "unknown");
      if (refused) {
        await c.query("update dns_snapshots set write_state = 'refused' where id = $1 and write_state = 'pending'", [snapId]);
        await zoneAudit(ctx, c, userId, w, "dns.write_refused", d.id, { snapshot: snapId });
        return;
      }
      await c.query("update dns_snapshots set write_state = 'unknown' where id = $1 and write_state = 'pending'", [snapId]);
      await zoneAudit(ctx, c, userId, w, "dns.write_outcome_unknown", d.id, { snapshot: snapId, sensitive: sensitive.length });
      const maybe = sensitive.length > 0 ? w.notice({ fqdn: d.fqdn_ascii, sensitive, maybe: true }) : null;
      if (maybe) await notifyDomainEvent(ctx, c, userId, { kind: "dns.sensitive_changed", domainId: d.id, ...maybe });
    }).catch(() => undefined);                               // the snapshot is already committed; the original error is the answer
    if (!refused) throw new HttpError(502, "outcome_unknown", undefined, undefined, { operation_id: snapId, accepted: null, authoritative_visibility: "unknown", propagation: "not_sampled" });
    throw e;
  }
}

const sensitiveLines = (sensitive: Sensitive[]) => sensitive.slice(0, 10).map((x) => `- ${x.type} ${x.name === "" ? "@ (the domain itself)" : x.name}`).join("\n");

async function liveZone(ctx: AppContext, d: DomainRow): Promise<{ records: DnsRecord[]; defaultTtl?: number }> {
  const z = await registrarOf(ctx).getDns(d.fqdn_ascii);
  if (!z.hosted) throw new HttpError(409, "dns_not_hosted", "dns_not_hosted", undefined, { message: "DNS for this domain is hosted elsewhere, so it cannot be edited here." });
  return { records: canonicalZone(z.records), defaultTtl: z.defaultTtl };
}

/** What a writer asks for, computed from the fresh read under the lock: the zone to send, its difference from the read, the sensitive records. */
export interface ZoneChange { desired: DnsRecord[]; diff: Diff; sensitive: Sensitive[] }
export interface ZoneWriteResult<T> { domain: DomainRow; live: DnsRecord[]; change: ZoneChange | null; snapshotId: string | null; zoneHash: string; after: T | undefined }
/** The caller's rows when the registrar write failed: `refused` changed nothing, `unknown` may have landed. */
export type ZoneFailed = (c: PoolClient, outcome: "refused" | "unknown") => Promise<void>;

/**
 * The DNS tab's write safety for every other writer (a recipe, a connection's removal, an agent token). One call is the whole write,
 * on one pooled connection that holds the per-domain lock from the fresh read until the follow-up commits (session-level, on the key
 * the transaction-level writers take, so the two kinds exclude each other):
 *  1. one transaction: the owner's live domain, the kill switch, the lock, a fresh read and `plan` on it, then `claim` (the caller's own
 *     rows and locks that must commit with the decision to write, taken before any audit row); when the plan changes anything, the
 *     pre-write snapshot (`pending`, with the hash of the zone asked for) and a `dns.write_intent` row. It commits BEFORE the registrar
 *     is called, so a write whose outcome is unknown never loses its snapshot (plan 4.3b, migration 0660);
 *  2. the registrar write, outside any transaction: a refusal marks the snapshot `refused`; any other failure marks it `unknown` (kept
 *     for rollback), audits it, tells the owner when a sensitive record may have changed, and the registrar's error is rethrown; `failed`
 *     runs in that transaction;
 *  3. the follow-up transaction: the snapshot `applied` with the hash read back, the `dns.write` row (`detail` added to it), the notice
 *     when a sensitive record changed, and `after`, the caller's own rows, in the same transaction and under the same lock.
 * When the plan is null or changes nothing, no snapshot is taken, the registrar is not called and `after` runs in step 1.
 * Errors thrown by `plan`, `claim` or `after` roll their transaction back (a refusal from `plan` or `claim` writes nothing); registrar
 * errors are the port's own (map them with `mapRegistrarError`).
 */
export async function writeZoneLocked<T = undefined>(
  ctx: AppContext, userId: string, domainId: string, w: ZoneWriter,
  plan: (live: DnsRecord[], d: DomainRow, defaultTtl?: number) => ZoneChange | null,
  opts: {
    detail?: Record<string, unknown>;
    snapshotReason?: "pre_write" | "pre_rollback";
    claim?: (c: PoolClient, r: { domain: DomainRow }) => Promise<void>;
    failed?: ZoneFailed;
    after?: (c: PoolClient, r: { domain: DomainRow; snapshotId: string | null; zoneHash: string; change: ZoneChange | null }) => Promise<T>;
  } = {},
): Promise<ZoneWriteResult<T>> {
  return zoneSession(ctx, userId, async (s) => {
    const pre = await s.step(async (c) => {
      // Closure/recovery take this grant lock before changing domain rows. Keep that order here.
      await lockUser(c, userId);
      const d = /^[0-9a-f-]{36}$/i.test(domainId) ? (await c.query("select * from domains where id = $1 and user_id = $2 and released_at is null", [domainId, userId])).rows[0] as DomainRow | undefined : undefined;
      if (!d) throw notFound();
      await assertWritesOpen(c);
      await s.lock(c, d.id);
      if (!(await c.query("select 1 from domains where id=$1 and user_id=$2 and released_at is null for share", [d.id, userId])).rowCount) throw notFound();
      const fresh = await liveZone(ctx, d), live = fresh.records;
      await reconcilePending(ctx, c, userId, d, live);
      const unresolved = await c.query("select 1 from dns_snapshots where domain_id=$1 and write_state in ('pending','unknown') limit 1", [d.id]);
      if (unresolved.rowCount) throw new HttpError(409, "dns_reconciliation_required");
      const change = plan(live, d, fresh.defaultTtl);
      if (change) {
        change.desired = materializeTtl(change.desired, live, fresh.defaultTtl);
        checkShape(change.desired); validateZone(change.desired, live);
        change.diff = diffZones(live, change.desired);
        change.sensitive = sensitiveOf(d.fqdn_ascii, change.diff, live);
      }
      await assertWritesOpen(c);
      if (opts.claim) await opts.claim(c, { domain: d });
      if (!change || (change.diff.added.length === 0 && change.diff.removed.length === 0)) {
        const after = opts.after ? await opts.after(c, { domain: d, snapshotId: null, zoneHash: zoneHash(live), change: null }) : undefined;
        return { d, live, change: null, snapId: null, after };
      }
      return { d, live, change, snapId: await takeSnapshot(ctx, c, userId, d, opts.snapshotReason ?? "pre_write", live, change.desired, change.diff, change.sensitive, {}, w), after: undefined };
    });
    const { d, live, change, snapId } = pre;
    if (!change || !snapId) return { domain: d, live, change: null, snapshotId: null, zoneHash: zoneHash(live), after: pre.after };
    const written = await sendZone(ctx, s, userId, d, live, change.desired, snapId, change.sensitive, w, opts.failed);
    const after = await s.step(async (c) => {
      await c.query("update dns_snapshots set after_hash = $2, write_state = 'applied', observed_hash=$2, observed_at=$3, reconciliation_state='desired_observed' where id = $1 and write_state = 'pending'", [snapId, written.hash, ctx.clock.now()]);
      await zoneAudit(ctx, c, userId, w, "dns.write", d.id, { snapshot: snapId, added: change.diff.added.length, removed: change.diff.removed.length, sensitive: change.sensitive.length, ...opts.detail });
      const applied = change.sensitive.length > 0 ? w.notice({ fqdn: d.fqdn_ascii, sensitive: change.sensitive, maybe: false }) : null;
      if (applied) await notifyDomainEvent(ctx, c, userId, { kind: "dns.sensitive_changed", domainId: d.id, ...applied });
      return opts.after ? opts.after(c, { domain: d, snapshotId: snapId, zoneHash: written.hash, change }) : undefined;
    });
    return { domain: d, live, change, snapshotId: snapId, zoneHash: written.hash, after };
  });
}

// ---- read -------------------------------------------------------------------------------------------------------------------------

export async function dnsReadHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const d = await withUser(ctx.runtime, userId, (c) => ownedDomain(c, userId, req.params.fqdn ?? ""));
  let z;
  try { z = await registrarOf(ctx).getDns(d.fqdn_ascii); } catch (e) { throw mapRegistrarError(e); }
  const snaps = (await withUser(ctx.runtime, userId, (c) => c.query("select count(*)::int as n from dns_snapshots where domain_id = $1 and expires_at > $2 and write_state <> 'refused'", [d.id, ctx.clock.now()]))).rows[0].n as number;
  if (!z.hosted) {
    return json({ domain: d.fqdn_ascii, hosted: false, read_only: true, nameservers: d.nameservers, records: [], message: "DNS for this domain is hosted elsewhere, at the nameservers listed. Change records there.", sync_state: "not_hosted", snapshots: snaps });
  }
  const recs = canonicalZone(z.records);
  return json({ domain: d.fqdn_ascii, hosted: true, read_only: false, records: recs.map((r) => publicRecord(d.fqdn_ascii, r)), zone_hash: zoneHash(recs), sync_state: "in_sync", snapshots: snaps });
}

// ---- write ------------------------------------------------------------------------------------------------------------------------

interface Plan { desired: DnsRecord[]; named: Named[] }

async function applyChange(req: HandlerReq, build: (live: DnsRecord[], zone: string) => Plan, rollbackOf?: string): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const rl = await withNoUser(ctx.runtime, (c) => hit(ctx, c, `dns:write:${userId}`, { bucket: "dns_write", max: 120, windowSeconds: 3600 }));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(rl.retryAfterSeconds) });
  const domain = await withUser(ctx.runtime, userId, (c) => ownedDomain(c, userId, req.params.fqdn ?? ""));
  let approvalPlan: { live: DnsRecord[]; change: ZoneChange } | undefined;
  try {
    const result = await writeZoneLocked(ctx, userId, domain.id, sessionWriter(userId), (live, d, defaultTtl) => {
      const p = build(live, d.fqdn_ascii);
      const desired = materializeTtl(p.desired, live, defaultTtl);
      checkShape(desired); validateZone(desired, live);
      const diff = diffZones(live, desired);
      assertSafeDiff(diff, p.named);
      const change = { desired, diff, sensitive: sensitiveOf(d.fqdn_ascii, diff, live) };
      approvalPlan = { live, change };
      return change;
    }, {
      detail: { actor: "session" }, snapshotReason: rollbackOf ? "pre_rollback" : "pre_write",
      claim: async (c) => {
        if (approvalPlan) await approveSessionDns(req, c, domain, approvalPlan.live, approvalPlan.change);
      },
      after: async (c, done) => {
        if (done.change?.sensitive.length) await audit(ctx, c, userId, "dns.sensitive_change", { resourceKind: "domain", resourceId: domain.id, detail: { snapshot: done.snapshotId, count: done.change.sensitive.length } });
        if (rollbackOf && done.snapshotId) await c.query("update dns_snapshots set rolled_back_at=$2 where id=$1 and rolled_back_at is null", [rollbackOf, ctx.clock.now()]);
      },
    });
    if (!result.change || !result.snapshotId) return json({ changed: false, zone_hash: result.zoneHash });
    return json({ changed: true, snapshot_id: result.snapshotId, operation_id: result.snapshotId, zone_hash: result.zoneHash,
      accepted: true, provider_state: "desired_observed", authoritative_visibility: "not_checked", propagation: "not_sampled",
      added: result.change.diff.added.length, removed: result.change.diff.removed.length,
      sensitive: result.change.sensitive.length > 0, sensitive_records: result.change.sensitive,
      rollback: `/api/v1/domains/${domain.fqdn_ascii}/dns-snapshots/${result.snapshotId}/rollback` });
  } catch (e) { throw mapRegistrarError(e); }
}

export const dnsAddHandler = (req: HandlerReq) => {
  const body = parse(AddBody, req.body);
  return applyChange(req, (live, zone) => ({ desired: [...live, ...body.records.map((r) => toRecord(zone, r))], named: [] }));
};

export const dnsPutHandler = (req: HandlerReq) => {
  const body = parse(PutBody, req.body);
  return applyChange(req, (live, zone) => ({
    // Full editable-zone replacement must never delete upstream types the editor cannot express.
    desired: [...live.filter((r) => !(DNS_RECORD_TYPES as readonly string[]).includes(r.type)), ...body.records.map((r) => toRecord(zone, r))],
    named: (body.remove ?? []).map((n) => ({ type: n.type, name: normalizeOwner(n.name, zone), ...(n.value !== undefined ? { value: n.value } : {}) })),
  }));
};

export const dnsPatchHandler = (req: HandlerReq) => {
  const body = parse(PatchBody, req.body);
  const id = req.params.id ?? "";
  return applyChange(req, (live) => {
    const cur = live.find((r) => recordId(r) === id);
    if (!cur) throw new HttpError(404, "not_found");
    const next: DnsRecord = { ...cur, ...(body.value !== undefined ? { value: body.value } : {}), ...(body.priority !== undefined ? { priority: body.priority } : {}), ...(body.weight !== undefined ? { weight: body.weight } : {}), ...(body.port !== undefined ? { port: body.port } : {}), ...(body.ttl !== undefined ? { ttl: body.ttl } : {}) };
    return { desired: [...live.filter((r) => r !== cur), normalizeRecord(next)], named: [{ type: cur.type, name: cur.name }] };
  });
};

export const dnsDeleteHandler = (req: HandlerReq) => {
  const id = req.params.id ?? "";
  return applyChange(req, (live) => {
    const cur = live.find((r) => recordId(r) === id);
    if (!cur) throw new HttpError(404, "not_found");
    return { desired: live.filter((r) => r !== cur), named: [{ type: cur.type, name: cur.name, value: cur.value }] };
  });
};

// ---- snapshots and rollback -------------------------------------------------------------------------------------------------------

/** Reconciliation only reads provider state. A before/partial read never authorizes retry after timeout. */
async function reconcilePending(ctx: AppContext, c: PoolClient, userId: string, d: DomainRow, live: DnsRecord[]): Promise<void> {
  const rows = (await c.query("select id, zone_hash, intended_hash, agent_request_id from dns_snapshots where domain_id=$1 and write_state in ('pending','unknown') order by taken_at, id for update", [d.id])).rows;
  const observed = zoneHash(live);
  for (const row of rows) {
    const state = row.intended_hash === observed ? "desired_observed" : row.zone_hash === observed ? "before_observed" : "partial_observed";
    await c.query("update dns_snapshots set observed_hash=$2, observed_at=$3, reconciliation_state=$4 where id=$1 and write_state in ('pending','unknown')", [row.id, observed, ctx.clock.now(), state]);
    if (state !== "desired_observed") continue;
    await c.query("update dns_snapshots set write_state='applied', after_hash=$2 where id=$1 and write_state in ('pending','unknown')", [row.id, observed]);
    if (row.agent_request_id) await c.query("update agent_requests set state='completed' where id=$1 and user_id=$2 and domain_id=$3 and state='approved'", [row.agent_request_id, userId, d.id]);
    await audit(ctx, c, userId, "dns.write_reconciled", { resourceKind: "domain", resourceId: d.id, detail: { snapshot: row.id } });
  }
}

export async function snapshotsHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  return zoneSession(ctx, userId, (s) => s.step(async (c) => {
    const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
    await s.lock(c, d.id);
    // History remains available when the provider cannot be reached. No provider writes here.
    let fresh: Awaited<ReturnType<typeof liveZone>> | undefined;
    try { fresh = await liveZone(ctx, d); } catch { /* keep the last observation */ }
    if (fresh) await reconcilePending(ctx, c, userId, d, fresh.records);
    const rows = (await c.query("select id, reason, zone_hash, after_hash, intended_hash, write_state, reconciliation_state, observed_hash, observed_at, added_count, removed_count, sensitive_count, taken_at, expires_at, rolled_back_at from dns_snapshots where domain_id = $1 and (expires_at > $2 or write_state in ('pending','unknown')) and write_state <> 'refused' order by taken_at desc, id desc limit 50", [d.id, ctx.clock.now()])).rows;
    return json({ domain: d.fqdn_ascii, snapshots: rows.map((r) => ({ id: r.id, operation_id: r.id, reason: r.reason, zone_hash: r.zone_hash, after_hash: r.after_hash, intended_hash: r.intended_hash, write_state: r.write_state, reconciliation_state: r.reconciliation_state,
      observed_hash: r.observed_hash, observed_at: r.observed_at ? new Date(r.observed_at).toISOString() : null,
      provider_state: r.reconciliation_state, authoritative_visibility: "not_checked", propagation: "not_sampled",
      added: r.added_count, removed: r.removed_count, sensitive: r.sensitive_count, taken_at: new Date(r.taken_at).toISOString(), expires_at: new Date(r.expires_at).toISOString(), rolled_back_at: r.rolled_back_at ? new Date(r.rolled_back_at).toISOString() : null })) });
  }));
}

/**
 * One-click rollback: the zone as it was before the chosen write. It takes its own snapshot first, so a rollback can be rolled back too.
 * A rollback is a DNS write and keeps the write-safety rules. When the zone is exactly as the chosen write left it (its `after_hash`), the
 * records the rollback removes are that write's own and count as named; otherwise later changes would be undone with it, so nothing is
 * named and a rollback that deletes an MX, TXT or SRV record (or more than 5 records) is refused: undo the later writes first.
 */
export async function rollbackHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const sid = req.params.sid ?? "";
  const d = await withUser(ctx.runtime, userId, (c) => ownedDomain(c, userId, req.params.fqdn ?? ""));
  const snap = /^[0-9a-f-]{36}$/i.test(sid) ? (await withUser(ctx.runtime, userId, (c) => c.query("select * from dns_snapshots where id=$1 and domain_id=$2 and (expires_at>$3 or write_state in ('pending','unknown')) and write_state<>'refused'", [sid, d.id, ctx.clock.now()]))).rows[0] : undefined;
  if (!snap) throw new HttpError(404, "not_found");
  const result = await applyChange(req, (live) => {
    const desired = canonicalZone(snap.records as DnsRecord[]);
    const diff = diffZones(live, desired);
    const exact = (snap.after_hash ?? snap.intended_hash) === zoneHash(live);
    assertSafeDiff(diff, exact ? diff.removed.map((r) => ({ type: r.type, name: r.name, value: r.value })) : []);
    return { desired, named: exact ? diff.removed : [] };
  }, sid);
  if (result.status === 200 && result.json && (result.json as { changed?: boolean }).changed) {
    const body = result.json as Record<string, unknown>;
    return json({ ...body, restored_snapshot_id: sid, undo_snapshot_id: body.snapshot_id });
  }
  return result;
}

/** Job `dns.snapshot_sweep` (daily): snapshots are kept 30 days. */
export async function snapshotSweepJob(ctx: AppContext, _job: JobRow): Promise<void> {
  await ctx.cron.query("delete from dns_snapshots where expires_at <= $1 and write_state not in ('pending','unknown')", [ctx.clock.now()]);
}

export { normalizeName };
