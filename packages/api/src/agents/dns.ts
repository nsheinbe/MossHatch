import { z } from "zod";
import { withUser } from "@mosshatch/db";
import { DNS_RECORD_TYPES, type DnsRecord, type DnsRecordType } from "@mosshatch/registrar/port";
import { canonicalZone, normalizeRecord, validateZone, zoneHash } from "@mosshatch/registrar/dns";
import type { AppContext } from "../ports.ts";
import { HttpError } from "../http/router.ts";
import { hashOf } from "../util/bytes.ts";
import { allows } from "../bindings/scopes.ts";
import { mapRegistrarError, ownedDomain, registrarOf, type DomainRow } from "../domain-mgmt/common.ts";
import { classifyRecord, normalizeOwner } from "../domain-mgmt/classify.ts";
import { assertSafeDiff, checkShape, diffZones, recordId, sensitiveOf, writeZoneLocked, type Sensitive, type ZoneWriter } from "../domain-mgmt/dns.ts";
import { createRequest, type Proposal } from "./requests.ts";
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

const sensitiveLines = (sensitive: Sensitive[]) => sensitive.slice(0, 10).map((x) => `- ${x.type} ${x.name === "" ? "@ (the domain itself)" : x.name}`).join("\n");

/**
 * What the owner is told when a token's own write touched, or may have touched, a sensitive record. A direct agent write never does (a
 * sensitive change becomes a request instead), so in practice this is the text for a write whose outcome is unknown.
 */
const notice: ZoneWriter["notice"] = ({ fqdn, sensitive, maybe }) => {
  const n = `${sensitive.length} sensitive DNS record${sensitive.length === 1 ? "" : "s"} on ${fqdn}`;
  return maybe
    ? { subject: "A sensitive DNS record on your Mosshatch domain may have changed", text: `A change from one of your tokens to ${n} may have been applied: our registrar did not confirm it.\n${sensitiveLines(sensitive)}\n\nThese records control mail, certificates and where the domain points. You can roll the change back from the DNS tab, under History.` }
    : { subject: "A sensitive DNS record on your Mosshatch domain changed", text: `A change from one of your tokens touched ${n}:\n${sensitiveLines(sensitive)}\n\nYou can roll the change back from the DNS tab, under History.` };
};

export type DnsOutcome = { applied: true; snapshot_id: string; zone_hash: string; added: number; removed: number } | ({ applied: false; changed: false }) | (Proposal & { applied: false; sensitive_records: number });

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
  // The DNS tab's write safety: under the domain lock, against a fresh read, with the pre-write snapshot and intent committed before
  // the registrar is called, so a write whose outcome is unknown keeps its snapshot for rollback (plan 4.3b).
  let w;
  try {
    w = await writeZoneLocked(ctx, caller.userId, d.id, { snapshotKind: "agent", actorKind: caller.kind, actorId: caller.bindingId, notice }, (fresh) => {
      const a = plan(fresh);
      // The zone moved between the reads and the change is now sensitive: refuse rather than write (the agent can propose again).
      if (a.sensitive.length) throw new HttpError(409, "zone_changed");
      return a;
    }, { detail: { actor: caller.kind } });
  } catch (e) { throw mapRegistrarError(e); }
  if (!w.change || !w.snapshotId) return { applied: false, changed: false };
  return { applied: true, snapshot_id: w.snapshotId, zone_hash: w.zoneHash, added: w.change.diff.added.length, removed: w.change.diff.removed.length };
}

/**
 * The zone an approved sensitive change writes, checked against the fresh read under the lock: the live zone must still hash to the
 * value the person signed, and the zone written is the one hashed into the request. A moved zone is 409 `zone_changed` (nothing is
 * written); a request whose stored zone does not match its signed hash is 409 `params_changed`.
 */
export function approvedZonePlan(fqdn: string, p: { before_hash: string; after_hash: string; desired: unknown }) {
  return (live: DnsRecord[]) => {
    if (zoneHash(live) !== p.before_hash) throw new HttpError(409, "zone_changed");
    const desired = canonicalZone(p.desired as DnsRecord[]);
    if (zoneHash(desired) !== p.after_hash) throw new HttpError(409, "params_changed");
    checkShape(desired);
    validateZone(desired);
    const diff = diffZones(live, desired);
    return { desired, diff, sensitive: sensitiveOf(fqdn, diff) };
  };
}
