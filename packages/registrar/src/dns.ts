import { createHash } from "node:crypto";
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

/** TXT strings longer than this are split or refused by the caller; OpenSRS documents up to 254 characters (RCP KB 201000063118). */
export const TXT_MAX = 254;

export function normalizeName(name: string): string {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  return n === "@" ? "" : n;
}
export function normalizeRecord(r: DnsRecord): DnsRecord {
  const out: DnsRecord = { type: r.type, name: normalizeName(r.name), value: r.type === "TXT" ? r.value : r.value.trim().toLowerCase().replace(/\.$/, "") };
  if (r.priority !== undefined) out.priority = r.priority;
  if (r.weight !== undefined) out.weight = r.weight;
  if (r.port !== undefined) out.port = r.port;
  return out;
}
const key = (r: DnsRecord) => `${r.type}|${r.name}|${r.value}|${r.priority ?? ""}|${r.weight ?? ""}|${r.port ?? ""}`;
/** Normalised, de-duplicated, sorted: the form hashes and comparisons use. */
export function canonicalZone(records: readonly DnsRecord[]): DnsRecord[] {
  const m = new Map<string, DnsRecord>();
  for (const r of records) { const n = normalizeRecord(r); m.set(key(n), n); }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]);
}
export function zoneHash(records: readonly DnsRecord[]): string {
  return createHash("sha256").update(canonicalZone(records).map(key).join("\n")).digest("hex");
}
/** Refuses what SystemDNS cannot hold (types other than the six, over-long TXT). Messages carry codes, never record values. */
export function validateZone(records: readonly DnsRecord[]): void {
  for (const r of records) {
    if (!(DNS_RECORD_TYPES as readonly string[]).includes(r.type)) throw new RegistrarError("rejected", "record type is not supported", { retryable: false, outcomeUnknown: false, code: "unsupported_record_type" });
    if (r.type === "TXT" && r.value.length > TXT_MAX) throw new RegistrarError("rejected", "TXT value is too long", { retryable: false, outcomeUnknown: false, code: "txt_too_long" });
    if (r.value.length === 0) throw new RegistrarError("rejected", "record value is empty", { retryable: false, outcomeUnknown: false, code: "empty_value" });
  }
}
/** The payload shape both overwrite semantics agree on: every type present, empty when the zone should have none. */
export function zonePayload(records: readonly DnsRecord[]): Record<(typeof DNS_RECORD_TYPES)[number], DnsRecord[]> {
  const out = Object.fromEntries(DNS_RECORD_TYPES.map((t) => [t, [] as DnsRecord[]])) as Record<(typeof DNS_RECORD_TYPES)[number], DnsRecord[]>;
  for (const r of canonicalZone(records)) out[r.type].push(r);
  return out;
}
