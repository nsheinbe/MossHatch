import type { DnsRecord, DnsRecordType } from "@mosshatch/registrar/port";
import { DNS_RECORD_TYPES, RegistrarError } from "@mosshatch/registrar/port";
import { TXT_MAX, canonicalZone, normalizeName, normalizeRecord, validateZone, zoneHash } from "@mosshatch/registrar/dns";
import { HttpError } from "../http/router.ts";
import { hashOf } from "../util/bytes.ts";
import { checkShape, diffZones, sensitiveOf } from "../domain-mgmt/dns.ts";

/**
 * The one diff every connect writer uses (DC-02). Presets, Domain Connect templates, pasted records and the
 * model all come through here. The hash is SHA-256 of the canonical plan. Apply recomputes it against a fresh
 * zone read and writes nothing when it differs.
 */

export type ConnectSource = "preset" | "domainconnect" | "recipe" | "pasted" | "ai";

export interface ConnectWarning { code: string; message: string }
export interface ConnectBlocked { code: string; message: string }
export interface ConnectSensitive { type: string; name: string; reasons: string[] }

export interface ConnectPlan {
  v: 1;
  source: ConnectSource;
  source_id: string;
  source_version: number;
  domain_id: string;
  fqdn: string;
  zone_before: string;
  dns: { add: DnsRecord[]; remove: DnsRecord[] };
  warnings: ConnectWarning[];
  blocked: ConnectBlocked | null;
  sensitive: ConnectSensitive[];
}

/** A record a caller asked for, before it is known to be a type this product stores. */
export interface ConnectRecordIn { type: string; name: string; value: string; priority?: number; weight?: number; port?: number }

export interface SpfMerge { name: string; mechanisms: readonly string[] }

export interface ConnectRequest {
  source: ConnectSource;
  source_id: string;
  source_version: number;
  domain_id: string;
  fqdn: string;
  /** False when the zone is not edited here. The plan is then blocked and nothing is applicable. */
  hosted: boolean;
  live: readonly DnsRecord[];
  add?: readonly ConnectRecordIn[];
  remove?: readonly ConnectRecordIn[];
  /** Relative names whose existing A and AAAA are replaced by the ones in `add` (a template that must not split the host). */
  replace_addresses?: readonly string[];
  /** Mechanisms to merge into the single `v=spf1` TXT at that name. A second SPF is never added. */
  spf?: readonly SpfMerge[];
  /** The caller asked for an apex ALIAS/ANAME, which this product does not store as a CNAME. */
  alias?: boolean;
  warnings?: readonly ConnectWarning[];
  /** TXT length cap. SystemDNS stays at 254; Openprovider may pass a higher cap once the adapter accepts it. */
  txtMax?: number;
}

const SUPPORTED = new Set<string>(DNS_RECORD_TYPES);
const ALL_QUAL = /^(.*?)(\s[+\-~?]all)\s*$/i;

export const planHash = (p: ConnectPlan): Buffer => hashOf(p);
export const planHashHex = (p: ConnectPlan): string => planHash(p).toString("hex");

/**
 * Merge mechanisms into the one SPF record at a name. Mechanisms already present are left as they are.
 * A trailing `all` qualifier stays last. A second `v=spf1` record, or a mechanism that is itself an SPF
 * record, is refused (`spf_duplicate`) rather than written beside the first.
 */
export function mergeSpf(existing: string | null, mechanisms: readonly string[]): { ok: true; value: string } | { ok: false; code: "spf_duplicate" } {
  const mechs = mechanisms.map((m) => m.trim()).filter(Boolean);
  if (mechs.some((m) => /^v=spf1\b/i.test(m))) return { ok: false, code: "spf_duplicate" };
  if (existing === null) return { ok: true, value: ["v=spf1", ...mechs].join(" ") };
  const current = existing.trim().replace(/\s+/g, " ");
  if (!/^v=spf1\b/i.test(current)) return { ok: false, code: "spf_duplicate" };
  let body = current.replace(/^v=spf1\s*/i, "");
  let all = "";
  const tail = body.match(ALL_QUAL);
  if (tail) { body = (tail[1] ?? "").trim(); all = (tail[2] ?? "").trim(); }
  const have = new Set(body.split(/\s+/).filter(Boolean).map((s) => s.toLowerCase()));
  const extra = mechs.filter((m) => !have.has(m.toLowerCase()));
  const parts = ["v=spf1", ...body.split(/\s+/).filter(Boolean), ...extra];
  if (all) parts.push(all);
  return { ok: true, value: parts.join(" ") };
}

function blocked(code: string, message: string): ConnectBlocked { return { code, message }; }

function loose(r: ConnectRecordIn): DnsRecord | null {
  if (!SUPPORTED.has(r.type)) return null;
  const value = r.type === "TXT" || r.type === "CAA" ? r.value.trim() : r.value;
  const out: DnsRecord = { type: r.type as DnsRecordType, name: normalizeName(r.name), value };
  if (r.priority !== undefined) out.priority = r.priority;
  if (r.weight !== undefined) out.weight = r.weight;
  if (r.port !== undefined) out.port = r.port;
  return normalizeRecord(out);
}

const same = (a: DnsRecord, b: DnsRecord) =>
  a.type === b.type && a.name === b.name && a.value === b.value && a.priority === b.priority && a.weight === b.weight && a.port === b.port;

const isSpf = (r: DnsRecord) => r.type === "TXT" && /^v=spf1\b/i.test(r.value.trim());
const wild = (name: string) => name === "*" || name.split(".").some((l) => l.includes("*"));

function shapeCode(e: unknown): ConnectBlocked | null {
  if (e instanceof HttpError) {
    if (e.code === "cname_at_apex") return blocked("cname_at_apex", "A CNAME cannot be the apex.");
    if (e.code === "cname_conflict") return blocked("cname_conflict", "A CNAME cannot share its name with another record.");
    return blocked(e.code, "The records are not a valid zone.");
  }
  if (e instanceof RegistrarError) {
    if (e.code === "txt_too_long") return blocked("txt_too_long", "A TXT value is too long.");
    if (e.code === "unsupported_record_type") return blocked("unsupported_type", "A record type is not supported.");
    return blocked(e.code ?? "unsupported_type", "The records are not a valid zone.");
  }
  return null;
}

function emptyPlan(req: ConnectRequest, live: DnsRecord[], block: ConnectBlocked | null, warnings: ConnectWarning[]): ConnectPlan {
  return {
    v: 1, source: req.source, source_id: req.source_id, source_version: req.source_version,
    domain_id: req.domain_id, fqdn: req.fqdn, zone_before: zoneHash(live),
    dns: { add: [], remove: [] }, warnings, blocked: block, sensitive: [],
  };
}

/**
 * Build the plan from a request and the live zone. Shape failures become `blocked` codes. The function does
 * not throw for a record the product refuses, and it does not write.
 */
export function buildConnectPlan(req: ConnectRequest): ConnectPlan {
  const live = canonicalZone(req.live);
  const warnings = [...(req.warnings ?? [])];
  const cap = req.txtMax ?? TXT_MAX;
  if (!req.hosted) return emptyPlan(req, live, blocked("dns_not_hosted", "DNS for this domain is hosted elsewhere, so it cannot be edited here."), warnings);
  if (req.alias) return emptyPlan(req, live, blocked("needs_alias", "This host needs an ALIAS or ANAME at the apex, which is not available while DNS stays here."), warnings);

  const added: DnsRecord[] = [];
  for (const raw of req.add ?? []) {
    if (wild(normalizeName(raw.name))) return emptyPlan(req, live, blocked("wildcard_refused", "Wildcard records are not added from a preset or a template."), warnings);
    if (raw.type === "NS" || raw.type === "REDIR301" || raw.type === "REDIR302") return emptyPlan(req, live, blocked("unsupported_type", "This record type is not written."), warnings);
    if (raw.type === "CAA" && !/^\d+\s+(issue|issuewild|iodef)\s+".+"$/.test(raw.value.trim())) return emptyPlan(req, live, blocked("unsupported_type", "A CAA value is not issue, issuewild, or iodef."), warnings);
    const rec = loose(raw);
    if (!rec) return emptyPlan(req, live, blocked("unsupported_type", "A record type is not supported."), warnings);
    if (rec.type === "CNAME" && rec.name === "") return emptyPlan(req, live, blocked("cname_at_apex", "A CNAME cannot be the apex."), warnings);
    if (rec.type === "TXT" && rec.value.length > cap) return emptyPlan(req, live, blocked("txt_too_long", "A TXT value is too long."), warnings);
    added.push(rec);
  }
  const removed: DnsRecord[] = [];
  for (const raw of req.remove ?? []) {
    const rec = loose(raw);
    if (!rec) return emptyPlan(req, live, blocked("unsupported_type", "A record type is not supported."), warnings);
    removed.push(rec);
  }

  const byName = new Map<string, DnsRecord[]>();
  for (const r of added) {
    const list = byName.get(r.name) ?? [];
    list.push(r);
    byName.set(r.name, list);
  }
  for (const list of byName.values()) {
    const types = new Set(list.map((r) => r.type));
    if (types.has("CNAME") && (types.size > 1 || list.filter((r) => r.type === "CNAME").length > 1)) {
      return emptyPlan(req, live, blocked("cname_conflict", "A CNAME cannot share its name with another record."), warnings);
    }
  }

  let desired = live.filter((r) => !removed.some((x) => same(x, r)));
  for (const spec of req.spf ?? []) {
    const name = normalizeName(spec.name);
    const existing = desired.filter((r) => r.name === name && isSpf(r));
    if (existing.length > 1) return emptyPlan(req, live, blocked("spf_duplicate", "This name already has more than one SPF record."), warnings);
    if (added.some((r) => r.name === name && isSpf(r))) return emptyPlan(req, live, blocked("spf_duplicate", "SPF is merged into the one record at this name, not added beside it."), warnings);
    const merged = mergeSpf(existing[0]?.value ?? null, spec.mechanisms);
    if (!merged.ok) return emptyPlan(req, live, blocked("spf_duplicate", "SPF could not be merged into the record already at this name."), warnings);
    desired = desired.filter((r) => !(r.name === name && isSpf(r)));
    desired.push(normalizeRecord({ type: "TXT", name, value: merged.value }));
  }

  const replaceAddr = new Set((req.replace_addresses ?? []).map(normalizeName));
  const cnames = added.filter((r) => r.type === "CNAME");
  const rest = added.filter((r) => r.type !== "CNAME");
  for (const r of cnames) desired = [...desired.filter((x) => x.name !== r.name), r];
  const cleared = new Set<string>();
  for (const r of rest) {
    if (desired.some((x) => x.name === r.name && x.type === "CNAME")) {
      return emptyPlan(req, live, blocked("cname_conflict", "A CNAME cannot share its name with another record."), warnings);
    }
    if (r.type === "MX" || r.type === "SRV") {
      const k = `${r.type}|${r.name}`;
      if (!cleared.has(k)) { desired = desired.filter((x) => !(x.type === r.type && x.name === r.name)); cleared.add(k); }
    } else if ((r.type === "A" || r.type === "AAAA") && replaceAddr.has(r.name)) {
      const k = `addr|${r.name}`;
      if (!cleared.has(k)) { desired = desired.filter((x) => !((x.type === "A" || x.type === "AAAA") && x.name === r.name)); cleared.add(k); }
    }
    desired.push(r);
  }

  desired = canonicalZone(desired);
  try { checkShape(desired); validateZone(desired, { txtMax: cap }); }
  catch (e) {
    const b = shapeCode(e);
    if (b) return emptyPlan(req, live, b, warnings);
    throw e;
  }
  const diff = diffZones(live, desired);
  const sensitive = sensitiveOf(req.fqdn, diff).map((s) => ({ type: s.type, name: s.name, reasons: [...s.reasons] }));
  return {
    v: 1, source: req.source, source_id: req.source_id, source_version: req.source_version,
    domain_id: req.domain_id, fqdn: req.fqdn, zone_before: zoneHash(live),
    dns: { add: diff.added, remove: diff.removed }, warnings, blocked: null, sensitive,
  };
}
