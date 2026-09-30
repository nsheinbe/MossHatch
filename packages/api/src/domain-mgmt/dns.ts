import { z } from "zod";
import { withNoUser, withUser, type PoolClient } from "@mosshatch/db";
import { DNS_RECORD_TYPES, RegistrarError, type DnsRecord, type DnsRecordType } from "@mosshatch/registrar/port";
import { canonicalZone, normalizeName, normalizeRecord, validateZone, zoneHash } from "@mosshatch/registrar/dns";
import type { AppContext } from "../ports.ts";
import { HttpError, json } from "../http/router.ts";
import type { HandlerReq, HandlerResult } from "../http/types.ts";
import type { JobRow } from "../jobs/registry.ts";
import { hit } from "../ratelimit.ts";
import { assertWritesOpen, audit, DAY_MS, mapRegistrarError, notifyDomainEvent, ownedDomain, registrarOf, sha256hex, userIdOf, type DomainRow } from "./common.ts";
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
async function lockDomainZone(c: PoolClient, domainId: string): Promise<void> {
  await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey(domainId)]);
}

async function liveZone(ctx: AppContext, d: DomainRow): Promise<DnsRecord[]> {
  const z = await registrarOf(ctx).getDns(d.fqdn_ascii);
  if (!z.hosted) throw new HttpError(409, "dns_not_hosted", "dns_not_hosted", undefined, { message: "DNS for this domain is hosted elsewhere, so it cannot be edited here." });
  return canonicalZone(z.records);
}

// ---- read -------------------------------------------------------------------------------------------------------------------------

export async function dnsReadHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const d = await withUser(ctx.runtime, userId, (c) => ownedDomain(c, userId, req.params.fqdn ?? ""));
  let z;
  try { z = await registrarOf(ctx).getDns(d.fqdn_ascii); } catch (e) { throw mapRegistrarError(e); }
  const snaps = (await withUser(ctx.runtime, userId, (c) => c.query("select count(*)::int as n from dns_snapshots where domain_id = $1 and expires_at > $2", [d.id, ctx.clock.now()]))).rows[0].n as number;
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
    return await withUser(ctx.runtime, userId, async (c) => {
      const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
      await assertWritesOpen(c);
      await lockDomainZone(c, d.id);            // one writer per domain; the read below happens under the lock
      const live = await liveZone(ctx, d);
      const plan = build(live, d.fqdn_ascii);
      const desired = canonicalZone(plan.desired);
      checkShape(desired);
      validateZone(desired);
      const diff = diffZones(live, desired);
      if (diff.added.length === 0 && diff.removed.length === 0) return json({ changed: false, zone_hash: zoneHash(live) });
      assertSafeDiff(diff, plan.named);
      const sensitive = sensitiveOf(d.fqdn_ascii, diff);
      const now = ctx.clock.now();
      const snap = (await c.query(
        `insert into dns_snapshots (user_id, domain_id, reason, zone_hash, records, added_count, removed_count, sensitive_count, taken_at, expires_at)
         values ($1,$2,'pre_write',$3,$4,$5,$6,$7,$8,$9) returning id`,
        [userId, d.id, zoneHash(live), JSON.stringify(live), diff.added.length, diff.removed.length, sensitive.length, now, new Date(now.getTime() + SNAPSHOT_TTL_MS)])).rows[0];
      let written;
      try { written = await registrarOf(ctx).replaceZone(d.fqdn_ascii, desired); }
      catch (e) {
        // A write that did not read back may have half-applied: put the snapshot back before reporting the failure.
        if (e instanceof RegistrarError && e.code === "dns_readback_mismatch") { try { await registrarOf(ctx).replaceZone(d.fqdn_ascii, live); } catch { /* the detector and the next read will show the zone */ } }
        throw e;
      }
      await c.query("update dns_snapshots set after_hash = $2 where id = $1", [snap.id, written.hash]);
      await audit(ctx, c, userId, "dns.write", { resourceKind: "domain", resourceId: d.id, detail: { snapshot: snap.id, added: diff.added.length, removed: diff.removed.length, sensitive: sensitive.length, actor: "session" } });
      if (sensitive.length > 0) {
        // The residual risk of D-034: a human session is not gated, so every address is told and the change can be rolled back.
        await audit(ctx, c, userId, "dns.sensitive_change", { resourceKind: "domain", resourceId: d.id, detail: { snapshot: snap.id, count: sensitive.length } });
        const lines = sensitive.slice(0, 10).map((s) => `- ${s.type} ${s.name === "" ? "@ (the domain itself)" : s.name}`).join("\n");
        await notifyDomainEvent(ctx, c, userId, {
          kind: "dns.sensitive_changed", domainId: d.id, subject: "A sensitive DNS record on your Mosshatch domain changed",
          text: `A change from your signed-in session touched ${sensitive.length} sensitive DNS record${sensitive.length === 1 ? "" : "s"} on ${d.fqdn_ascii}:\n${lines}\n\nThese records control mail, certificates and where the domain points. You can roll the change back from the DNS tab, under History.`,
        });
      }
      return json({
        changed: true, snapshot_id: snap.id, zone_hash: written.hash, added: diff.added.length, removed: diff.removed.length,
        sensitive: sensitive.length > 0, sensitive_records: sensitive, rollback: `/api/v1/domains/${d.fqdn_ascii}/dns/snapshots/${snap.id}/rollback`,
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
    const rows = (await c.query("select id, reason, zone_hash, after_hash, added_count, removed_count, sensitive_count, taken_at, expires_at, rolled_back_at from dns_snapshots where domain_id = $1 and expires_at > $2 order by taken_at desc, id desc limit 50", [d.id, ctx.clock.now()])).rows;
    return json({ domain: d.fqdn_ascii, snapshots: rows.map((r) => ({ id: r.id, reason: r.reason, zone_hash: r.zone_hash, after_hash: r.after_hash, added: r.added_count, removed: r.removed_count, sensitive: r.sensitive_count, taken_at: new Date(r.taken_at).toISOString(), expires_at: new Date(r.expires_at).toISOString(), rolled_back_at: r.rolled_back_at ? new Date(r.rolled_back_at).toISOString() : null })) });
  });
}

/** One-click rollback: the zone as it was before the chosen write. It takes its own snapshot first, so a rollback can be rolled back too. */
export async function rollbackHandler(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req; const userId = userIdOf(req);
  const sid = req.params.sid ?? "";
  try {
    return await withUser(ctx.runtime, userId, async (c) => {
      const d = await ownedDomain(c, userId, req.params.fqdn ?? "");
      const snap = /^[0-9a-f-]{36}$/i.test(sid) ? (await c.query("select * from dns_snapshots where id = $1 and domain_id = $2 and expires_at > $3", [sid, d.id, ctx.clock.now()])).rows[0] : undefined;
      if (!snap) throw new HttpError(404, "not_found");
      await assertWritesOpen(c);
      await lockDomainZone(c, d.id);
      const live = await liveZone(ctx, d);
      const target = canonicalZone(snap.records as DnsRecord[]);
      const diff = diffZones(live, target);
      if (diff.added.length === 0 && diff.removed.length === 0) return json({ changed: false, zone_hash: zoneHash(live) });
      const sensitive = sensitiveOf(d.fqdn_ascii, diff);
      const now = ctx.clock.now();
      const back = (await c.query(
        `insert into dns_snapshots (user_id, domain_id, reason, zone_hash, records, added_count, removed_count, sensitive_count, taken_at, expires_at)
         values ($1,$2,'pre_rollback',$3,$4,$5,$6,$7,$8,$9) returning id`,
        [userId, d.id, zoneHash(live), JSON.stringify(live), diff.added.length, diff.removed.length, sensitive.length, now, new Date(now.getTime() + SNAPSHOT_TTL_MS)])).rows[0];
      const written = await registrarOf(ctx).replaceZone(d.fqdn_ascii, target);
      await c.query("update dns_snapshots set after_hash = $2 where id = $1", [back.id, written.hash]);
      await c.query("update dns_snapshots set rolled_back_at = $2 where id = $1", [snap.id, now]);
      await audit(ctx, c, userId, "dns.rollback", { resourceKind: "domain", resourceId: d.id, detail: { snapshot: snap.id, undo_snapshot: back.id, added: diff.added.length, removed: diff.removed.length, sensitive: sensitive.length } });
      if (sensitive.length > 0) {
        await notifyDomainEvent(ctx, c, userId, {
          kind: "dns.sensitive_changed", domainId: d.id, subject: "A sensitive DNS record on your Mosshatch domain changed",
          text: `A rollback from your signed-in session touched ${sensitive.length} sensitive DNS record${sensitive.length === 1 ? "" : "s"} on ${d.fqdn_ascii}. You can undo it from the DNS tab, under History.`,
        });
      }
      return json({ changed: true, restored_snapshot_id: snap.id, undo_snapshot_id: back.id, zone_hash: written.hash, added: diff.added.length, removed: diff.removed.length, sensitive: sensitive.length > 0 });
    });
  } catch (e) { throw mapRegistrarError(e); }
}

/** Job `dns.snapshot_sweep` (daily): snapshots are kept 30 days. */
export async function snapshotSweepJob(ctx: AppContext, _job: JobRow): Promise<void> {
  await ctx.cron.query("delete from dns_snapshots where expires_at <= $1", [ctx.clock.now()]);
}

export { normalizeName };
