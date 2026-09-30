import { z } from "zod";
import { withUser, type PoolClient } from "@mosshatch/db";
import { DNS_RECORD_TYPES, type DnsRecord, type DnsRecordType } from "@mosshatch/registrar/port";
import { canonicalZone, normalizeRecord, validateZone, zoneHash } from "@mosshatch/registrar/dns";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { appendAudit } from "../audit.ts";
import { hashOf } from "../util/bytes.ts";
import { allows } from "../bindings/scopes.ts";
import { assertWritesOpen, mapRegistrarError, notifyDomainEvent, ownedDomain, registrarOf, type DomainRow } from "../domain-mgmt/common.ts";
import { classifyRecord, normalizeOwner } from "../domain-mgmt/classify.ts";
import { assertSafeDiff, checkShape, diffZones, recordId, sensitiveOf, SNAPSHOT_TTL_MS } from "../domain-mgmt/dns.ts";
import { createRequest, type Proposal, type RequestRow } from "./requests.ts";
import { notFound, untrusted, type Caller } from "./common.ts";

/**
 * DNS for agents (PLAN 4.5 DNS row, D-011, D-034, threat row 36, ST-131). `dns.read` reads the zone; `dns.write` changes it.
 * A change whose difference from a fresh read touches a sensitive record (MX, NS, DS, SRV, apex, `www`, underscore labels,
 * wildcards, mail hosts, SPF/DMARC/DKIM and verification TXT) is not written: it becomes a pending request that only a
 * `dns.sensitive.approve` passkey assertion, binding the request and the before and after zone hashes, can apply.
 */

const num = z.number().int().min(0).max(65535);
const Rec = z.strictObject({
  type: z.enum(DNS_RECORD_TYPES as unknown as [DnsRecordType, ...DnsRecordType[]]),
  name: z.string().trim().max(253), value: z.string().min(1).max(2048),
  priority: num.optional(), weight: num.optional(), port: num.optional(),
});
const Named = z.strictObject({ type: z.enum(DNS_RECORD_TYPES as unknown as [DnsRecordType, ...DnsRecordType[]]), name: z.string().trim().max(253), value: z.string().max(2048).optional() });
export const DnsChangeInput = z.strictObject({ records: z.array(Rec).max(50).default([]), remove: z.array(Named).max(20).default([]) })
  .refine((b) => b.records.length + b.remove.length > 0);

function toRecord(zone: string, r: z.infer<typeof Rec>): DnsRecord {
  const out: DnsRecord = { type: r.type, name: normalizeOwner(r.name, zone), value: r.value };
  if (r.priority !== undefined) out.priority = r.priority;
  if (r.weight !== undefined) out.weight = r.weight;
  if (r.port !== undefined) out.port = r.port;
  return normalizeRecord(out);
}

/** A record as the agent sees it: values are data from the zone, cleaned of control characters and capped. */
const shown = (zone: string, r: DnsRecord) => {
  const c = classifyRecord(r, zone);
  return { id: recordId(r), type: r.type, name: r.name === "" ? "@" : untrusted(r.name, 253), value: untrusted(r.value, 1024), ...(r.priority !== undefined ? { priority: r.priority } : {}), ...(r.weight !== undefined ? { weight: r.weight } : {}), ...(r.port !== undefined ? { port: r.port } : {}), sensitive: c.sensitive };
};

async function domainFor(ctx: AppContext, caller: Caller, fqdn: string, capability: "dns.read" | "dns.write"): Promise<DomainRow> {
  let d: DomainRow;
  try { d = await withUser(ctx.runtime, caller.userId, (c) => ownedDomain(c, caller.userId, fqdn)); } catch { throw notFound(); }
  if (!allows(caller.scopes, capability, d.id, null)) throw new HttpError(403, "scope_missing");
  return d;
}

async function liveZone(ctx: AppContext, d: DomainRow): Promise<DnsRecord[]> {
  let z;
  try { z = await registrarOf(ctx).getDns(d.fqdn_ascii); } catch (e) { throw mapRegistrarError(e); }
  if (!z.hosted) throw new HttpError(409, "dns_not_hosted");
  return canonicalZone(z.records);
}

export async function agentDnsRead(ctx: AppContext, caller: Caller, fqdn: string) {
  const d = await domainFor(ctx, caller, fqdn, "dns.read");
  const recs = await liveZone(ctx, d);
  return { domain: d.fqdn_ascii, zone_hash: zoneHash(recs), records: recs.slice(0, 500).map((r) => shown(d.fqdn_ascii, r)), truncated: recs.length > 500 };
}

const lockZone = (c: PoolClient, domainId: string) => c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`mh.dns:${domainId}`]);

/** Write a zone under the domain lock with a 30-day snapshot (the same safety rules as the owner's own edits). */
async function writeZone(ctx: AppContext, c: PoolClient, userId: string, d: DomainRow, live: DnsRecord[], desired: DnsRecord[], actor: { kind: "agent" | "cli" | "user"; id: string }, sensitive: number) {
  const diff = diffZones(live, desired);
  const now = ctx.clock.now();
  const snap = (await c.query(
    `insert into dns_snapshots (user_id, domain_id, reason, zone_hash, records, added_count, removed_count, sensitive_count, actor_kind, taken_at, expires_at)
     values ($1,$2,'pre_write',$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [userId, d.id, zoneHash(live), JSON.stringify(live), diff.added.length, diff.removed.length, sensitive, actor.kind === "cli" ? "agent" : actor.kind, now, new Date(now.getTime() + SNAPSHOT_TTL_MS)])).rows[0];
  const written = await registrarOf(ctx).replaceZone(d.fqdn_ascii, desired);
  await c.query("update dns_snapshots set after_hash = $2 where id = $1", [snap.id, written.hash]);
  await appendAudit(ctx, c, { chainId: userId, actorKind: actor.kind, actorId: actor.id, action: "dns.write", resourceKind: "domain", resourceId: d.id, detail: { snapshot: snap.id, added: diff.added.length, removed: diff.removed.length, sensitive, actor: actor.kind } });
  return { snapshot_id: snap.id as string, zone_hash: written.hash, added: diff.added.length, removed: diff.removed.length };
}

export type DnsOutcome = ({ applied: true } & Awaited<ReturnType<typeof writeZone>>) | ({ applied: false; changed: false }) | (Proposal & { applied: false; sensitive_records: number });

/** `dns.write`: apply a non-sensitive change, or park a sensitive one as a pending request (nothing is written). */
export async function agentDnsChange(ctx: AppContext, caller: Caller, fqdn: string, raw: unknown): Promise<DnsOutcome> {
  const body = DnsChangeInput.safeParse(raw);
  if (!body.success) throw new HttpError(422, "invalid_record");
  const d = await domainFor(ctx, caller, fqdn, "dns.write");
  const plan = (live: DnsRecord[]) => {
    const named = body.data.remove.map((n) => ({ type: n.type, name: normalizeOwner(n.name, d.fqdn_ascii), ...(n.value !== undefined ? { value: n.value } : {}) }));
    const keep = live.filter((r) => !named.some((n) => n.type === r.type && n.name === r.name && (n.value === undefined || normalizeRecord({ ...r, value: n.value }).value === r.value)));
    const desired = canonicalZone([...keep, ...body.data.records.map((r) => toRecord(d.fqdn_ascii, r))]);
    checkShape(desired);
    validateZone(desired);
    const diff = diffZones(live, desired);
    assertSafeDiff(diff, named);
    return { desired, diff, sensitive: sensitiveOf(d.fqdn_ascii, diff) };
  };
  // First pass outside the lock: a sensitive change never takes the write lock or reaches the registrar's write path.
  let live: DnsRecord[];
  let first;
  try { live = await liveZone(ctx, d); first = plan(live); } catch (e) { throw mapRegistrarError(e); }
  if (first.diff.added.length === 0 && first.diff.removed.length === 0) return { applied: false, changed: false };
  if (first.sensitive.length > 0) {
    const params = {
      domain_id: d.id, fqdn: d.fqdn_ascii, before_hash: zoneHash(live), after_hash: zoneHash(first.desired),
      added: first.diff.added.map((r) => shown(d.fqdn_ascii, r)), removed: first.diff.removed.map((r) => shown(d.fqdn_ascii, r)),
      sensitive: first.sensitive.map((s) => ({ type: s.type, name: s.name === "" ? "@" : s.name, reasons: s.reasons })),
      desired: first.desired,
    };
    const p = await createRequest(ctx, caller, {
      kind: "dns_change", requestHash: hashOf({ kind: "dns_change", domain_id: d.id, before: params.before_hash, after: params.after_hash }), domainId: d.id, fqdn: d.fqdn_ascii,
      years: null, quotedMinor: 0n, priceHash: null, params, facts: { bindingName: "", kind: "dns_change", fqdn: d.fqdn_ascii, years: null, totalMinor: 0n, sensitive: first.sensitive.length },
    });
    return { ...p, applied: false, sensitive_records: first.sensitive.length };
  }
  try {
    return await withUser(ctx.runtime, caller.userId, async (c) => {
      await assertWritesOpen(c);
      await lockZone(c, d.id);
      const fresh = await liveZone(ctx, d);
      const again = plan(fresh);
      // The zone moved between the reads and the change is now sensitive: refuse rather than write (the agent can propose again).
      if (again.sensitive.length > 0) throw new HttpError(409, "zone_changed");
      if (again.diff.added.length === 0 && again.diff.removed.length === 0) return { applied: false as const, changed: false as const };
      return { applied: true as const, ...(await writeZone(ctx, c, caller.userId, d, fresh, again.desired, { kind: caller.kind, id: caller.bindingId }, 0)) };
    });
  } catch (e) { throw mapRegistrarError(e); }
}

/**
 * Apply an approved sensitive change exactly as proposed: the live zone must still hash to the value the person signed,
 * and the zone written is the one hashed into the request. A moved zone voids the request (409) and writes nothing.
 */
export async function applyApprovedDns(ctx: AppContext, c: PoolClient, userId: string, r: RequestRow, actionId: string): Promise<{ zone_hash: string; snapshot_id: string }> {
  const d = await ownedDomain(c, userId, String(r.params.fqdn));
  if (d.id !== r.domain_id) throw notFound();
  await assertWritesOpen(c);
  await lockZone(c, d.id);
  const live = await liveZone(ctx, d);
  if (zoneHash(live) !== r.params.before_hash) throw new HttpError(409, "zone_changed");
  const desired = canonicalZone(r.params.desired as DnsRecord[]);
  if (zoneHash(desired) !== r.params.after_hash) throw new HttpError(409, "params_changed");
  checkShape(desired);
  validateZone(desired);
  const sensitive = sensitiveOf(d.fqdn_ascii, diffZones(live, desired)).length;
  const w = await writeZone(ctx, c, userId, d, live, desired, { kind: "user", id: userId }, sensitive);
  await appendAudit(ctx, c, { chainId: userId, actorKind: "user", actorId: userId, action: "dns.sensitive_approved", resourceKind: "agent_request", resourceId: r.id, detail: { action_id: actionId, snapshot: w.snapshot_id } });
  await notifyDomainEvent(ctx, c, userId, {
    kind: "dns.sensitive_changed", domainId: d.id, subject: "A sensitive DNS record on your Mosshatch domain changed",
    text: `You approved a change from one of your tokens that touched ${sensitive} sensitive DNS record${sensitive === 1 ? "" : "s"} on ${d.fqdn_ascii}. You can roll it back from the DNS tab, under History.`,
  });
  return { zone_hash: w.zone_hash, snapshot_id: w.snapshot_id };
}
