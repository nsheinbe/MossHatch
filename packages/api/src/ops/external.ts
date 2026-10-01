import type { AppContext } from "../ports.ts";
import { norm, soft, type DnsResolver } from "../mail/dns.ts";
import { raiseAlert } from "./alerts.ts";

/*
 * External checks on the two brand domains (PLAN 4.6 row 28, D-033). What is proven here is the comparison logic
 * against fake resolvers. NOT verifiable from the build container: the live records, and who owns the names
 * (public RDAP on 2026-09-29 showed both created that day at Namecheap; the registrant is not public).
 */

export interface Expectation { domain: string; rrtype: "NS" | "MX" | "A"; expected: string[] }
export interface ExternalFinding { domain: string; rrtype: "NS" | "MX" | "A"; kind: "mismatch" | "dns_error"; expected: string[]; actual: string[] }

const sortedNorm = (xs: string[]) => [...new Set(xs.map(norm))].sort();

async function lookup(r: DnsResolver, domain: string, t: Expectation["rrtype"]): Promise<string[]> {
  if (t === "NS") return sortedNorm(await soft(r.resolveNs(domain)));
  if (t === "A") return sortedNorm(await soft(r.resolve4(domain)));
  // A null MX (RFC 7505: exchange ".") is "no mail exchanger" here, so hatchkind.com's expectation is the empty list.
  return sortedNorm((await soft(r.resolveMx(domain))).map((m) => m.exchange).filter((x) => x !== "" && x !== "."));
}

/** ST-111: compare NS, MX and apex A with the stored expectation. Any difference is a finding (S1 when alerted). */
export async function runExternalChecks(resolver: DnsResolver, expectations: Expectation[]): Promise<ExternalFinding[]> {
  const out: ExternalFinding[] = [];
  for (const e of expectations) {
    const expected = sortedNorm(e.expected);
    try {
      const actual = await lookup(resolver, e.domain, e.rrtype);
      if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) out.push({ domain: e.domain, rrtype: e.rrtype, kind: "mismatch", expected, actual });
    } catch {
      out.push({ domain: e.domain, rrtype: e.rrtype, kind: "dns_error", expected, actual: [] });
    }
  }
  return out;
}

export async function loadExpectations(ctx: Pick<AppContext, "cron">): Promise<Expectation[]> {
  return (await ctx.cron.query("select domain, rrtype, expected from external_expectations order by domain, rrtype")).rows as Expectation[];
}

/** Daily job body: run the comparison and page on a difference. A resolver failure is a warning (it proves nothing about the records). */
export async function externalChecksJob(ctx: Pick<AppContext, "cron" | "services">, resolver: DnsResolver): Promise<ExternalFinding[]> {
  const findings = await runExternalChecks(resolver, await loadExpectations(ctx));
  for (const f of findings) {
    await raiseAlert(ctx, ctx.cron, {
      severity: f.kind === "mismatch" ? "page" : "warn", kind: f.kind === "mismatch" ? "external.dns_changed" : "external.dns_unreachable",
      subject: `${f.domain}:${f.rrtype}`, detail: { domain: f.domain, rrtype: f.rrtype, expected: f.expected.slice(0, 8), actual: f.actual.slice(0, 8) },
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------
// Expiry alarms at 90, 60 and 30 days
// ---------------------------------------------------------------------------------------------------------------

export const EXPIRY_THRESHOLDS = [90, 60, 30] as const;

/** Each threshold fires once per expiry date; moving `expires_at` past 90 days (a renewal) resets it. Past expiry is a page. */
export async function checkDomainExpiry(ctx: Pick<AppContext, "cron" | "clock" | "services">): Promise<{ domain: string; days: number; threshold: number | null }[]> {
  const now = ctx.clock.now().getTime();
  const rows = (await ctx.cron.query("select domain, expires_at, alerted_days from owned_domains_watch where expires_at is not null")).rows;
  const fired: { domain: string; days: number; threshold: number | null }[] = [];
  for (const r of rows) {
    const days = Math.floor((new Date(r.expires_at).getTime() - now) / 86_400_000);
    const already = new Set<number>(r.alerted_days);
    if (days > EXPIRY_THRESHOLDS[0]) { if (already.size) await ctx.cron.query("update owned_domains_watch set alerted_days = '{}' where domain = $1", [r.domain]); continue; }
    const hit = EXPIRY_THRESHOLDS.filter((t) => days <= t).at(-1) as number;   // the tightest threshold crossed
    if (already.has(hit) && days >= 0) continue;
    const crossed = EXPIRY_THRESHOLDS.filter((t) => t >= hit);
    await raiseAlert(ctx, ctx.cron, {
      severity: days < 0 ? "page" : hit === 90 ? "info" : "warn", kind: "domain.expiry", subject: `${r.domain}:${hit}`,
      detail: { domain: r.domain, days_left: days, threshold: hit },
    });
    await ctx.cron.query("update owned_domains_watch set alerted_days = $2 where domain = $1", [r.domain, crossed]);
    fired.push({ domain: r.domain, days, threshold: hit });
  }
  return fired;
}

// ---------------------------------------------------------------------------------------------------------------
// Published email records: DMARC, SPF, null MX, CAA (ST-112)
// ---------------------------------------------------------------------------------------------------------------

export interface EmailDnsSpec {
  domain: string;
  /** hatchkind.com sends and receives no mail: `v=spf1 -all` and a null MX (RFC 7505). mosshatch.com receives mail and must have a real MX. */
  nullMx: boolean;
  /** SPF includes required when the domain sends or receives (e.g. the mailbox provider). Ignored when nullMx. */
  spfIncludes: string[];
  /** CA identifiers allowed in CAA `issue` and `issuewild`. Confirm the Vercel-issuing CA before publishing. */
  caaIssuers: string[];
}
export interface EmailDnsFinding { domain: string; check: "dmarc" | "spf" | "mx" | "caa"; code: string }

const txt = async (r: DnsResolver, name: string) => (await soft(r.resolveTxt(name))).map((p) => p.join("").trim());
const tags = (rec: string) => Object.fromEntries(rec.split(";").map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim().toLowerCase()]; }));

export async function checkEmailDnsRecords(resolver: DnsResolver, specs: EmailDnsSpec[]): Promise<EmailDnsFinding[]> {
  const out: EmailDnsFinding[] = [];
  for (const s of specs) {
    const f = (check: EmailDnsFinding["check"], code: string) => out.push({ domain: s.domain, check, code });
    try {
      const dm = (await txt(resolver, `_dmarc.${s.domain}`)).filter((t) => /^v=DMARC1/i.test(t));
      if (dm.length !== 1) f("dmarc", dm.length ? "multiple" : "missing");
      else { const t = tags(dm[0]!); if (t.p !== "reject") f("dmarc", "policy_not_reject"); else if (t.adkim !== "s" || t.aspf !== "s") f("dmarc", "not_strict"); }

      const spf = (await txt(resolver, s.domain)).filter((t) => /^v=spf1(\s|$)/i.test(t));
      if (spf.length !== 1) f("spf", spf.length ? "multiple" : "missing");
      else if (s.nullMx) { if (spf[0]!.replace(/\s+/g, " ").toLowerCase() !== "v=spf1 -all") f("spf", "not_dash_all_only"); }
      else {
        const low = spf[0]!.toLowerCase();
        if (!/[-~]all$/.test(low)) f("spf", "not_closed");
        for (const inc of s.spfIncludes) if (!low.includes(inc.toLowerCase())) f("spf", "include_missing");
      }

      const mx = await soft(resolver.resolveMx(s.domain));
      const isNull = (m: { exchange: string }) => m.exchange === "" || m.exchange === ".";
      if (s.nullMx) { if (mx.length !== 1 || !isNull(mx[0]!)) f("mx", "not_null_mx"); }
      else if (mx.length === 0) f("mx", "missing"); else if (mx.some(isNull)) f("mx", "null_mx_on_receiving_domain");

      const caa = await soft(resolver.resolveCaa(s.domain));
      const issuers = caa.flatMap((c) => [c.issue, c.issuewild]).filter((v): v is string => typeof v === "string").map((v) => v.split(";")[0]!.trim().toLowerCase()).filter(Boolean);
      if (!caa.some((c) => typeof c.issue === "string")) f("caa", "missing");
      else if (issuers.some((i) => !s.caaIssuers.map((x) => x.toLowerCase()).includes(i))) f("caa", "unexpected_issuer");
    } catch { f("dmarc", "dns_error"); }
  }
  return out;
}

/** Defaults for the two brand domains. The CAA issuer list is a placeholder to confirm against the CA that Vercel issues from. */
export const BRAND_EMAIL_DNS: EmailDnsSpec[] = [
  { domain: "mosshatch.com", nullMx: false, spfIncludes: [], caaIssuers: ["letsencrypt.org"] },
  { domain: "hatchkind.com", nullMx: true, spfIncludes: [], caaIssuers: ["letsencrypt.org"] },
];

export async function emailDnsJob(ctx: Pick<AppContext, "cron" | "services">, resolver: DnsResolver, specs: EmailDnsSpec[] = BRAND_EMAIL_DNS): Promise<EmailDnsFinding[]> {
  const findings = await checkEmailDnsRecords(resolver, specs);
  for (const f of findings) await raiseAlert(ctx, ctx.cron, { severity: "warn", kind: "external.email_dns", subject: `${f.domain}:${f.check}`, detail: { domain: f.domain, check: f.check, code: f.code } });
  return findings;
}
