import { domainToASCII } from "node:url";
import type { DnsRecord } from "@mosshatch/registrar/port";

/**
 * Sensitive-record classification (plan 4.3b "Sensitive records", threat row 36, ST-127). Pure and server-side.
 * Owner name first: any label starting with an underscore at any position, the apex, `www`, any wildcard, and the hosts
 * `autoconfig`, `autodiscover` and `mta-sts`. Then type: MX, NS, DS, SRV, and apex A, AAAA and CNAME. The TXT prefixes are only a backstop.
 */
export type SensitiveReason = "underscore_label" | "apex" | "www" | "wildcard" | "mail_host" | "type" | "txt_value" | "unverified_txt" | "production_host" | "service_dependency" | "deletion";
export interface Classification { sensitive: boolean; reasons: SensitiveReason[]; name: string }

const MAIL_HOSTS = new Set(["autoconfig", "autodiscover", "mta-sts", "mail", "smtp", "imap", "pop", "webmail"]);
const ALWAYS_SENSITIVE_TYPES = new Set(["MX", "NS", "DS", "SRV", "CAA", "DNSKEY", "CDNSKEY", "CDS", "RRSIG", "NSEC", "NSEC3", "TLSA", "HTTPS", "SVCB", "SSHFP"]);
/** Verification tokens providers ask for; a change to one moves control of the domain at that provider. */
const TXT_PREFIXES = [/^v=spf1\b/, /^v=dmarc1\b/, /^v=dkim1\b/, /^google-site-verification=/, /^ms=/, /^facebook-domain-verification=/, /^apple-domain-verification=/, /^atlassian-domain-verification=/, /^stripe-verification=/, /^docusign=/, /^_?github-challenge/, /^k=(rsa|ed25519);/, /^p=[a-z0-9+/=]{20,}/];

/**
 * Lower-case, drop the trailing dot, map `@` to the apex, convert to A-labels (punycode), and make the name relative to `zone`
 * when it was written as a full name. `""` is the apex.
 */
export function normalizeOwner(raw: string, zone?: string): string {
  let n = raw.normalize("NFKC").trim().toLowerCase().replace(/\.+$/, "");
  if (n === "@") return "";
  try { const a = domainToASCII(n); if (a) n = a; } catch { /* keep the lower-cased form */ }
  if (zone) {
    const z = normalizeOwner(zone);
    if (z && n === z) return "";
    if (z && n.endsWith("." + z)) n = n.slice(0, -(z.length + 1));
  }
  return n;
}

export function classifyRecord(r: Pick<DnsRecord, "type" | "name" | "value">, zone?: string): Classification {
  const name = normalizeOwner(r.name, zone);
  const labels = name === "" ? [] : name.split(".");
  const reasons = new Set<SensitiveReason>();
  if (labels.length === 0) reasons.add("apex");
  if (labels.some((l) => l.startsWith("_"))) reasons.add("underscore_label");
  if (labels[0] === "www") reasons.add("www");
  if (labels.some((l) => l === "*" || l.includes("*"))) reasons.add("wildcard");
  if (labels[0] !== undefined && MAIL_HOSTS.has(labels[0])) reasons.add("mail_host");
  if (labels.some((l) => ["prod", "production", "api", "auth", "login", "payments", "checkout"].includes(l))) reasons.add("production_host");
  if (ALWAYS_SENSITIVE_TYPES.has(r.type)) reasons.add("type");
  if (r.type === "TXT") {
    // Ownership tokens have no universal prefix. Unknown TXT is never assumed harmless.
    reasons.add("unverified_txt");
    const v = r.value.trim().replace(/^"|"$/g, "").trim().toLowerCase();
    if (TXT_PREFIXES.some((re) => re.test(v))) reasons.add("txt_value");
  }
  return { sensitive: reasons.size > 0, reasons: [...reasons], name };
}

export const isSensitive = (r: Pick<DnsRecord, "type" | "name" | "value">, zone?: string): boolean => classifyRecord(r, zone).sensitive;
