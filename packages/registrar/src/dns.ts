import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { DNS_RECORD_TYPES, RegistrarError, type DnsRecord } from "./port.ts";

/** Openprovider's own DNS. A registration through Openprovider is created with these, so its records are edited here. */
export const OPENPROVIDER_NAMESERVERS = ["ns1.openprovider.nl", "ns2.openprovider.be", "ns3.openprovider.eu"];

/**
 * Whether a name's nameservers are our registrar's own DNS (Openprovider's, or OpenSRS's SystemDNS, which is also the mock's), so its records
 * live and are edited here. The one rule behind `domains.dns_hosted_here` at registration, transfer-in, sync and a nameserver change
 * (docs/AUDIT-2026-10-07.md O8: it used to know SystemDNS only, and a new registration never set it).
 */
export function isProviderDns(nameservers: readonly string[]): boolean {
  const ns = nameservers.map((n) => n.trim().toLowerCase().replace(/\.$/, ""));
  return ns.length > 0 && (ns.every((n) => OPENPROVIDER_NAMESERVERS.includes(n)) || ns.every((n) => n.endsWith(".systemdns.com")));
}

/** New TXT strings use the portable SystemDNS limit. Longer existing provider records remain untouched. */
export const TXT_MAX = 254;
const editable = new Set<string>(DNS_RECORD_TYPES);
const hostValues = new Set(["A", "AAAA", "CNAME", "MX", "SRV"]);
const refused = (code: string): never => { throw new RegistrarError("rejected", "DNS record refused", { retryable: false, outcomeUnknown: false, code }); };

export function normalizeName(name: string): string {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  return n === "@" ? "" : n;
}
export function normalizeRecord(r: DnsRecord): DnsRecord {
  const type = r.type.toUpperCase();
  const out: DnsRecord = { type, name: normalizeName(r.name), value: hostValues.has(type) && r.value !== "." ? r.value.trim().toLowerCase().replace(/\.$/, "") : r.value };
  if (r.priority !== undefined) out.priority = r.priority;
  if (r.weight !== undefined) out.weight = r.weight;
  if (r.port !== undefined) out.port = r.port;
  if (r.ttl !== undefined) out.ttl = r.ttl;
  return out;
}
/** JSON tuple framing prevents TXT delimiters/newlines from colliding with fields or other records. */
const key = (r: DnsRecord) => JSON.stringify([r.type, r.name, r.value, r.priority ?? null, r.weight ?? null, r.port ?? null, r.ttl ?? null]);
/** Normalised, de-duplicated, sorted: the form hashes and comparisons use. */
export function canonicalZone(records: readonly DnsRecord[]): DnsRecord[] {
  const m = new Map<string, DnsRecord>();
  for (const r of records) { const n = normalizeRecord(r); m.set(key(n), n); }
  // Retain historical provider request ordering. This delimiter key orders only; identity/hash use framed JSON above.
  const order = (r: DnsRecord) => `${r.type}|${r.name}|${r.value}|${r.priority ?? ""}|${r.weight ?? ""}|${r.port ?? ""}`;
  return [...m.entries()].sort((a, b) => {
    const ak = order(a[1]), bk = order(b[1]);
    return ak < bk ? -1 : ak > bk ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  }).map((e) => e[1]);
}
export function zoneHash(records: readonly DnsRecord[]): string {
  return createHash("sha256").update(JSON.stringify(canonicalZone(records).map((r) => JSON.parse(key(r))))).digest("hex");
}
/** Materialise provider defaults before an immutable plan is approved; an existing record retains its TTL. */
export function withDnsTtl(records: readonly DnsRecord[], live: readonly DnsRecord[], defaultTtl?: number): DnsRecord[] {
  const withoutTtl = (r: DnsRecord) => { const { ttl: _ttl, ...rest } = normalizeRecord(r); return key(rest); };
  return canonicalZone(records.map((r) => {
    if (r.ttl !== undefined) return r;
    const existing = live.filter((old) => withoutTtl(old) === withoutTtl(r));
    const normalized = normalizeRecord(r);
    const rrsetTtls = new Set(live.filter((old) => old.type === normalized.type && normalizeName(old.name) === normalized.name).map((old) => old.ttl));
    const ttl = existing.length === 1 ? existing[0]!.ttl : rrsetTtls.size === 1 ? [...rrsetTtls][0] : defaultTtl;
    return ttl === undefined ? r : { ...r, ttl };
  }));
}
/** Validate new/changed records. Opaque or longer upstream records may only be preserved exactly. */
export function validateZone(records: readonly DnsRecord[], preserved: readonly DnsRecord[] = []): void {
  const unchanged = new Set(canonicalZone(preserved).map(key));
  for (const r of records) {
    if (unchanged.has(key(normalizeRecord(r)))) continue;
    if (!editable.has(r.type)) refused("unsupported_record_type");
    if (/[\x00-\x1f\x7f]/.test(r.name + r.value)) refused("invalid_record_content");
    const name = normalizeName(r.name);
    if (name.length > 253 || (name && !name.split(".").every((label, i) => /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)$/i.test(label) || (i === 0 && label === "*")))) refused("invalid_record_name");
    if (r.type === "TXT" && r.value.length > TXT_MAX) refused("txt_too_long");
    if (r.value.length === 0) refused("empty_value");
    if (r.ttl !== undefined && (!Number.isInteger(r.ttl) || r.ttl < 0 || r.ttl > 2147483647)) refused("invalid_ttl");
    for (const n of [r.priority, r.weight, r.port]) if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > 65535)) refused("invalid_record_number");
    if (r.type === "A" && isIP(r.value.trim()) !== 4) refused("invalid_ipv4");
    if (r.type === "AAAA" && isIP(r.value.trim()) !== 6) refused("invalid_ipv6");
  }
  // Unknown RR types cannot be deleted through the limited editing surface either.
  const wanted = new Set(canonicalZone(records).map(key));
  for (const r of canonicalZone(preserved)) if (!editable.has(r.type) && !wanted.has(key(r))) refused("unsupported_record_change");
}
/** SystemDNS cannot carry unknown records or TTL. Refuse rather than silently narrowing a zone. */
export function zonePayload(records: readonly DnsRecord[]): Record<(typeof DNS_RECORD_TYPES)[number], DnsRecord[]> {
  validateZone(records);
  const out = Object.fromEntries(DNS_RECORD_TYPES.map((t) => [t, [] as DnsRecord[]])) as Record<(typeof DNS_RECORD_TYPES)[number], DnsRecord[]>;
  for (const r of canonicalZone(records)) {
    if (r.ttl !== undefined) refused("dns_ttl_unsupported");
    out[r.type as (typeof DNS_RECORD_TYPES)[number]].push(r);
  }
  return out;
}
