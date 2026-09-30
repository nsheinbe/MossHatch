import { z } from "zod";
import { withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import { DNS_RECORD_TYPES, RegistrarError, type DnsRecord, type DnsRecordType } from "@mosshatch/registrar/port";
import { canonicalZone, normalizeName, normalizeRecord, validateZone, zoneHash } from "@mosshatch/registrar/dns";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import type { JobRow } from "../jobs/registry.ts";
import { hit } from "../ratelimit.ts";
import { appendAudit, type AuditEntry } from "../audit.ts";
import { assertWritesOpen, audit, DAY_MS, mapRegistrarError, notFound, notifyDomainEvent, ownedDomain, registrarOf, sha256hex, userIdOf, type DomainRow } from "./common.ts";
import { classifyRecord, normalizeOwner, type SensitiveReason } from "./classify.ts";

/** Plan 4.3b write safety: more than 5 deleted records, or any MX, TXT or SRV the intent does not name, refuses the write. */
export const MAX_DELETES = 5;
export const SNAPSHOT_TTL_MS = 30 * DAY_MS;
const PROTECTED_TYPES = new Set<DnsRecordType>(["MX", "TXT", "SRV"]);

const key = (r: DnsRecord) => `${r.type}|${r.name}|${r.value}|${r.priority ?? ""}|${r.weight ?? ""}|${r.port ?? ""}`;
/** A stable id for a record, so the web app can PATCH or DELETE one (the provider has no record ids). */
export const recordId = (r: DnsRecord): string => "r_" + sha256hex(key(normalizeRecord(r))).slice(0, 20);

const num = z.number().int().min(0).max(65535);
export const RecordIn = z.object({
  type: z.enum(DNS_RECORD_TYPES as unknown as [DnsRecordType, ...DnsRecordType[]]),
  name: z.string().trim().max(253),
  value: z.string().min(1).max(4096),
  priority: num.optional(), weight: num.optional(), port: num.optional(),
}).strict();
export const NamedIn = z.object({ type: z.enum(DNS_RECORD_TYPES as unknown as [DnsRecordType, ...DnsRecordType[]]), name: z.string().trim().max(253), value: z.string().max(4096).optional() }).strict();
export const PutBody = z.object({ records: z.array(RecordIn).max(500), remove: z.array(NamedIn).max(500).optional() }).strict();
export const AddBody = z.object({ records: z.array(RecordIn).min(1).max(100) }).strict();
export const PatchBody = z.object({ value: z.string().min(1).max(4096).optional(), priority: num.optional(), weight: num.optional(), port: num.optional() }).strict()
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
export function sensitiveOf(zone: string, diff: Diff): Sensitive[] {
  const out: Sensitive[] = []; const seen = new Set<string>();
  for (const r of [...diff.added, ...diff.removed]) {
    const c = classifyRecord(r, zone);
    if (!c.sensitive) continue;
    const k = `${r.type}|${r.name}`; if (seen.has(k)) continue; seen.add(k);
    out.push({ type: r.type, name: r.name, reasons: c.reasons });
  }
  return out;
}

const publicRecord = (zone: string, r: DnsRecord) => {
  const c = classifyRecord(r, zone);
  return { id: recordId(r), ...r, name: r.name === "" ? "@" : r.name, sensitive: c.sensitive, reasons: c.reasons };
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
  notice: (n: { fqdn: string; sensitive: Sensitive[]; maybe: boolean }) => { subject: string; text: string };
}

/** The DNS tab: the signed-in person. Its audit rows are the same as `audit()` writes (actor `user`, the person's id). */
const sessionWriter = (userId: string): ZoneWriter => ({
  snapshotKind: "user", actorKind: "user", actorId: userId,
  notice: ({ fqdn, sensitive, maybe }) => maybe
    ? { subject: "A sensitive DNS record on your Mosshatch domain may have changed", text: `A change from your signed-in session to ${sensitive.length} sensitive DNS record${sensitive.length === 1 ? "" : "s"} on ${fqdn} may have been applied: our registrar did not confirm it.\n${sensitiveLines(sensitive)}\n\nThese records control mail, certificates and where the domain points. You can roll the change back from the DNS tab, under History.` }
    : { subject: "A sensitive DNS record on your Mosshatch domain changed", text: `A change from your signed-in session touched ${sensitive.length} sensitive DNS record${sensitive.length === 1 ? "" : "s"} on ${fqdn}:\n${sensitiveLines(sensitive)}\n\nThese records control mail, certificates and where the domain points. You can roll the change back from the DNS tab, under History.` },
});

const zoneAudit = (ctx: AppContext, c: PoolClient, userId: string, w: ZoneWriter, action: string, domainId: string, detail: Record<string, unknown>) =>
  appendAudit(ctx, c, { chainId: userId, actorKind: w.actorKind, actorId: w.actorId, action, resourceKind: "domain", resourceId: domainId, detail });

/** The pre-write zone (and the hash of the zone the write asks for), committed as `pending` with an intent audit row before the registrar is called. */
async function takeSnapshot(ctx: AppContext, c: PoolClient, userId: string, d: DomainRow, reason: "pre_write" | "pre_rollback", live: DnsRecord[], target: DnsRecord[], diff: Diff, sensitive: Sensitive[], extra: Record<string, unknown> = {}, w: ZoneWriter = sessionWriter(userId)): Promise<string> {
  const now = ctx.clock.now();
  const snap = (await c.query(
    `insert into dns_snapshots (user_id, domain_id, reason, zone_hash, records, added_count, removed_count, sensitive_count, actor_kind, taken_at, expires_at, write_state, intended_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12) returning id`,
    [userId, d.id, reason, zoneHash(live), JSON.stringify(live), diff.added.length, diff.removed.length, sensitive.length, w.snapshotKind, now, new Date(now.getTime() + SNAPSHOT_TTL_MS), zoneHash(target)])).rows[0];
  await zoneAudit(ctx, c, userId, w, "dns.write_intent", d.id, { snapshot: snap.id, reason, added: diff.added.length, removed: diff.removed.length, sensitive: sensitive.length, ...extra });
  return snap.id as string;
}

/**
 * Send the zone. A refusal changed nothing (a write that did not read back is put back first), so its snapshot is marked `refused` and
 * leaves the history. Any other failure may have landed: the snapshot stays for rollback marked `unknown`, the audit says so, and a change
 * that may have touched sensitive records is announced like one that did.
 */
async function sendZone(ctx: AppContext, s: ZoneSession, userId: string, d: DomainRow, live: DnsRecord[], target: DnsRecord[], snapId: string, sensitive: Sensitive[], w: ZoneWriter = sessionWriter(userId)): Promise<{ hash: string }> {
  const port = registrarOf(ctx);
  try { return await port.replaceZone(d.fqdn_ascii, target); }
  catch (e) {
    let refused = e instanceof RegistrarError && !e.outcomeUnknown && e.kind !== "unknown";
    if (refused && (e as RegistrarError).code === "dns_readback_mismatch") {
      try { await port.replaceZone(d.fqdn_ascii, live); } catch { refused = false; /* the zone is not known now: keep the snapshot */ }
    }
    await s.step(async (c) => {
      if (refused) {
        await c.query("update dns_snapshots set write_state = 'refused' where id = $1 and write_state = 'pending'", [snapId]);
        await zoneAudit(ctx, c, userId, w, "dns.write_refused", d.id, { snapshot: snapId });
        return;
      }
      await c.query("update dns_snapshots set write_state = 'unknown' where id = $1 and write_state = 'pending'", [snapId]);
      await zoneAudit(ctx, c, userId, w, "dns.write_outcome_unknown", d.id, { snapshot: snapId, sensitive: sensitive.length });
      if (sensitive.length > 0) await notifyDomainEvent(ctx, c, userId, { kind: "dns.sensitive_changed", domainId: d.id, ...w.notice({ fqdn: d.fqdn_ascii, sensitive, maybe: true }) });
    }).catch(() => undefined);                               // the snapshot is already committed; the original error is the answer
    throw e;
  }
}

const sensitiveLines = (sensitive: Sensitive[]) => sensitive.slice(0, 10).map((x) => `- ${x.type} ${x.name === "" ? "@ (the domain itself)" : x.name}`).join("\n");

async function liveZone(ctx: AppContext, d: DomainRow): Promise<DnsRecord[]> {
  const z = await registrarOf(ctx).getDns(d.fqdn_ascii);
  if (!z.hosted) throw new HttpError(409, "dns_not_hosted", "dns_not_hosted", undefined, { message: "DNS for this domain is hosted elsewhere, so it cannot be edited here." });
  return canonicalZone(z.records);
}

/** What a writer asks for, computed from the fresh read under the lock: the zone to send, its difference from the read, the sensitive records. */
export interface ZoneChange { desired: DnsRecord[]; diff: Diff; sensitive: Sensitive[] }
export interface ZoneWriteResult<T> { domain: DomainRow; live: DnsRecord[]; change: ZoneChange | null; snapshotId: string | null; zoneHash: string; after: T | undefined }

/**
 * The DNS tab's write safety for every other writer (a recipe, a connection's removal, an agent token). One call is the whole write,
 * on one pooled connection that holds the per-domain lock from the fresh read until the follow-up commits (session-level, on the key
 * the transaction-level writers take, so the two kinds exclude each other):
 *  1. one transaction: the owner's live domain, the kill switch, the lock, a fresh read and `plan` on it; when the plan changes anything,
 *     the pre-write snapshot (`pending`, with the hash of the zone asked for) and a `dns.write_intent` row. It commits BEFORE the
 *     registrar is called, so a write whose outcome is unknown never loses its snapshot (plan 4.3b, migration 0660);
 *  2. the registrar write, outside any transaction: a refusal marks the snapshot `refused`; any other failure marks it `unknown` (kept
 *     for rollback), audits it, tells the owner when a sensitive record may have changed, and the registrar's error is rethrown;
 *  3. the follow-up transaction: the snapshot `applied` with the hash read back, the `dns.write` row (`detail` added to it), the notice
 *     when a sensitive record changed, and `after`, the caller's own rows, in the same transaction and under the same lock.
 * When the plan is null or changes nothing, no snapshot is taken, the registrar is not called and `after` runs in step 1.
 * Errors thrown by `plan` or `after` roll their transaction back; registrar errors are the port's own (map them with `mapRegistrarError`).
 */
export async function writeZoneLocked<T = undefined>(
  ctx: AppContext, userId: string, domainId: string, w: ZoneWriter,
  plan: (live: DnsRecord[], d: DomainRow) => ZoneChange | null,
  opts: { detail?: Record<string, unknown>; after?: (c: PoolClient, r: { domain: DomainRow; snapshotId: string | null; zoneHash: string; change: ZoneChange | null }) => Promise<T> } = {},
): Promise<ZoneWriteResult<T>> {
  return zoneSession(ctx, userId, async (s) => {
    const pre = await s.step(async (c) => {
      const d = /^[0-9a-f-]{36}$/i.test(domainId) ? (await c.query("select * from domains where id = $1 and user_id = $2 and released_at is null", [domainId, userId])).rows[0] as DomainRow | undefined : undefined;
      if (!d) throw notFound();
      await assertWritesOpen(c);
      await s.lock(c, d.id);
      const live = await liveZone(ctx, d);
      const change = plan(live, d);
      if (!change || (change.diff.added.length === 0 && change.diff.removed.length === 0)) {
        const after = opts.after ? await opts.after(c, { domain: d, snapshotId: null, zoneHash: zoneHash(live), change: null }) : undefined;
        return { d, live, change: null, snapId: null, after };
      }
      return { d, live, change, snapId: await takeSnapshot(ctx, c, userId, d, "pre_write", live, change.desired, change.diff, change.sensitive, {}, w), after: undefined };
    });
    const { d, live, change, snapId } = pre;
    if (!change || !snapId) return { domain: d, live, change: null, snapshotId: null, zoneHash: zoneHash(live), after: pre.after };
    const written = await sendZone(ctx, s, userId, d, live, change.desired, snapId, change.sensitive, w);
    const after = await s.step(async (c) => {
      await c.query("update dns_snapshots set after_hash = $2, write_state = 'applied' where id = $1 and write_state = 'pending'", [snapId, written.hash]);
      await zoneAudit(ctx, c, userId, w, "dns.write", d.id, { snapshot: snapId, added: change.diff.added.length, removed: change.diff.removed.length, sensitive: change.sensitive.length, ...opts.detail });
      if (change.sensitive.length > 0) await notifyDomainEvent(ctx, c, userId, { kind: "dns.sensitive_changed", domainId: d.id, ...w.notice({ fqdn: d.fqdn_ascii, sensitive: change.sensitive, maybe: false }) });
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

async function applyChange(req: HandlerReq, build: (live: DnsRecord[], zone: string) => Plan): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const rl = await withNoUser(ctx.runtime, (c) => hit(ctx, c, `dns:write:${userId}`, { bucket: "dns_write", max: 120, windowSeconds: 3600 }));
  if (!rl.allowed) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(rl.retryAfterSeconds) });
  try {
    return await zoneSession(ctx, userId, async (s) => {
      const pre = await s.step(async (c) => {
        const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
        await assertWritesOpen(c);
        await s.lock(c, d.id);                   // one writer per domain until the follow-up commits; the read below happens under the lock
        const live = await liveZone(ctx, d);
        const plan = build(live, d.fqdn_ascii);
        const desired = canonicalZone(plan.desired);
        checkShape(desired);
        validateZone(desired);
        const diff = diffZones(live, desired);
        if (diff.added.length === 0 && diff.removed.length === 0) return { d, live, desired, diff, sensitive: [] as Sensitive[], snapId: null };
        assertSafeDiff(diff, plan.named);
        const sensitive = sensitiveOf(d.fqdn_ascii, diff);
        return { d, live, desired, diff, sensitive, snapId: await takeSnapshot(ctx, c, userId, d, "pre_write", live, desired, diff, sensitive) };
      });
      const { d, live, diff, sensitive, snapId } = pre;
      if (!snapId) return json({ changed: false, zone_hash: zoneHash(live) });
      const written = await sendZone(ctx, s, userId, d, live, pre.desired, snapId, sensitive);
      await s.step(async (c) => {
        await c.query("update dns_snapshots set after_hash = $2, write_state = 'applied' where id = $1", [snapId, written.hash]);
        await audit(ctx, c, userId, "dns.write", { resourceKind: "domain", resourceId: d.id, detail: { snapshot: snapId, added: diff.added.length, removed: diff.removed.length, sensitive: sensitive.length, actor: "session" } });
        if (sensitive.length > 0) {
          // The residual risk of D-034: a human session is not gated, so every address is told and the change can be rolled back.
          await audit(ctx, c, userId, "dns.sensitive_change", { resourceKind: "domain", resourceId: d.id, detail: { snapshot: snapId, count: sensitive.length } });
          await notifyDomainEvent(ctx, c, userId, {
            kind: "dns.sensitive_changed", domainId: d.id, subject: "A sensitive DNS record on your Mosshatch domain changed",
            text: `A change from your signed-in session touched ${sensitive.length} sensitive DNS record${sensitive.length === 1 ? "" : "s"} on ${d.fqdn_ascii}:\n${sensitiveLines(sensitive)}\n\nThese records control mail, certificates and where the domain points. You can roll the change back from the DNS tab, under History.`,
          });
        }
      });
      return json({
        changed: true, snapshot_id: snapId, zone_hash: written.hash, added: diff.added.length, removed: diff.removed.length,
        sensitive: sensitive.length > 0, sensitive_records: sensitive, rollback: `/api/v1/domains/${d.fqdn_ascii}/dns-snapshots/${snapId}/rollback`,
      });
    });
  } catch (e) { throw mapRegistrarError(e); }
}

export const dnsAddHandler = (req: HandlerReq) => {
  const body = parse(AddBody, req.body);
  return applyChange(req, (live, zone) => ({ desired: [...live, ...body.records.map((r) => toRecord(zone, r))], named: [] }));
};

export const dnsPutHandler = (req: HandlerReq) => {
  const body = parse(PutBody, req.body);
  return applyChange(req, (_live, zone) => ({
    desired: body.records.map((r) => toRecord(zone, r)),
    named: (body.remove ?? []).map((n) => ({ type: n.type, name: normalizeOwner(n.name, zone), ...(n.value !== undefined ? { value: n.value } : {}) })),
  }));
};

export const dnsPatchHandler = (req: HandlerReq) => {
  const body = parse(PatchBody, req.body);
  const id = req.params.id ?? "";
  return applyChange(req, (live) => {
    const cur = live.find((r) => recordId(r) === id);
    if (!cur) throw new HttpError(404, "not_found");
    const next: DnsRecord = { ...cur, ...(body.value !== undefined ? { value: body.value } : {}), ...(body.priority !== undefined ? { priority: body.priority } : {}), ...(body.weight !== undefined ? { weight: body.weight } : {}), ...(body.port !== undefined ? { port: body.port } : {}) };
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

export async function snapshotsHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  return withUser(ctx.runtime, userId, async (c) => {
    const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
    const rows = (await c.query("select id, reason, zone_hash, after_hash, write_state, added_count, removed_count, sensitive_count, taken_at, expires_at, rolled_back_at from dns_snapshots where domain_id = $1 and expires_at > $2 and write_state <> 'refused' order by taken_at desc, id desc limit 50", [d.id, ctx.clock.now()])).rows;
    return json({ domain: d.fqdn_ascii, snapshots: rows.map((r) => ({ id: r.id, reason: r.reason, zone_hash: r.zone_hash, after_hash: r.after_hash, write_state: r.write_state, added: r.added_count, removed: r.removed_count, sensitive: r.sensitive_count, taken_at: new Date(r.taken_at).toISOString(), expires_at: new Date(r.expires_at).toISOString(), rolled_back_at: r.rolled_back_at ? new Date(r.rolled_back_at).toISOString() : null })) });
  });
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
  try {
    return await zoneSession(ctx, userId, async (s) => {
      const pre = await s.step(async (c) => {
        const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
        const snap = /^[0-9a-f-]{36}$/i.test(sid) ? (await c.query("select * from dns_snapshots where id = $1 and domain_id = $2 and expires_at > $3 and write_state <> 'refused'", [sid, d.id, ctx.clock.now()])).rows[0] : undefined;
        if (!snap) throw new HttpError(404, "not_found");
        await assertWritesOpen(c);
        await s.lock(c, d.id);
        const live = await liveZone(ctx, d);
        const target = canonicalZone(snap.records as DnsRecord[]);
        const diff = diffZones(live, target);
        if (diff.added.length === 0 && diff.removed.length === 0) return { d, live, target, diff, sensitive: [] as Sensitive[], snapId: snap.id as string, backId: null };
        // The zone the chosen write left: read back when it completed, or the zone it asked for when its outcome is not known.
        const left = (snap.after_hash ?? snap.intended_hash) as string | null;
        const exact = !!left && left === zoneHash(live);
        assertSafeDiff(diff, exact ? diff.removed.map((r) => ({ type: r.type, name: r.name, value: r.value })) : []);
        const sensitive = sensitiveOf(d.fqdn_ascii, diff);
        return { d, live, target, diff, sensitive, snapId: snap.id as string, backId: await takeSnapshot(ctx, c, userId, d, "pre_rollback", live, target, diff, sensitive, { rollback_of: snap.id }) };
      });
      const { d, live, diff, sensitive, snapId, backId } = pre;
      if (!backId) return json({ changed: false, zone_hash: zoneHash(live) });
      const written = await sendZone(ctx, s, userId, d, live, pre.target, backId, sensitive);
      const now = ctx.clock.now();
      await s.step(async (c) => {
        await c.query("update dns_snapshots set after_hash = $2, write_state = 'applied' where id = $1", [backId, written.hash]);
        await c.query("update dns_snapshots set rolled_back_at = $2 where id = $1", [snapId, now]);
        await audit(ctx, c, userId, "dns.rollback", { resourceKind: "domain", resourceId: d.id, detail: { snapshot: snapId, undo_snapshot: backId, added: diff.added.length, removed: diff.removed.length, sensitive: sensitive.length } });
        if (sensitive.length > 0) {
          await notifyDomainEvent(ctx, c, userId, {
            kind: "dns.sensitive_changed", domainId: d.id, subject: "A sensitive DNS record on your Mosshatch domain changed",
            text: `A rollback from your signed-in session touched ${sensitive.length} sensitive DNS record${sensitive.length === 1 ? "" : "s"} on ${d.fqdn_ascii}. You can undo it from the DNS tab, under History.`,
          });
        }
      });
      return json({ changed: true, restored_snapshot_id: snapId, undo_snapshot_id: backId, zone_hash: written.hash, added: diff.added.length, removed: diff.removed.length, sensitive: sensitive.length > 0 });
    });
  } catch (e) { throw mapRegistrarError(e); }
}

/** Job `dns.snapshot_sweep` (daily): snapshots are kept 30 days. */
export async function snapshotSweepJob(ctx: AppContext, _job: JobRow): Promise<void> {
  await ctx.cron.query("delete from dns_snapshots where expires_at <= $1", [ctx.clock.now()]);
}

export { normalizeName };
