import type { Config, EmailMessage, EmailPort } from "../ports.ts";
import { norm, soft, type DnsResolver } from "./dns.ts";

export interface MailDomainExpectation {
  /** Substring that must appear in the SPF record, e.g. the include of the sending provider. */
  spfInclude: string;
  /** DKIM selectors that must publish a key. */
  dkimSelectors: string[];
}
export interface MailDomainResult {
  ok: boolean;
  domain: string;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  /** Enumerated codes only. */
  failures: string[];
}

const txtOf = async (r: DnsResolver, name: string): Promise<string[]> => (await soft(r.resolveTxt(name))).map((parts) => parts.join(""));

function parseTags(rec: string): Record<string, string> {
  const t: Record<string, string> = {};
  for (const part of rec.split(";")) { const i = part.indexOf("="); if (i > 0) t[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim().toLowerCase(); }
  return t;
}

/**
 * ST-146: SPF, DKIM and strict DMARC on the sending domain.
 *  - SPF: exactly one `v=spf1` record, containing the provider include, ending in `-all` or `~all`.
 *  - DKIM: every selector publishes `v=DKIM1` with a non-empty `p=` (a revoked key has an empty p).
 *  - DMARC: `p=reject` or `p=quarantine` with strict alignment (`adkim=s`, `aspf=s`) and no `pct` below 100.
 * A resolver error (timeout, SERVFAIL) fails closed with `dns_error`.
 */
export async function verifyMailDomain(resolver: DnsResolver, domain: string, exp: MailDomainExpectation): Promise<MailDomainResult> {
  const d = norm(domain);
  const failures: string[] = [];
  let spf = false, dkim = false, dmarc = false;
  try {
    const spfs = (await txtOf(resolver, d)).filter((t) => /^v=spf1(\s|$)/i.test(t));
    if (spfs.length === 0) failures.push("spf_missing");
    else if (spfs.length > 1) failures.push("spf_multiple");
    else if (!spfs[0]!.toLowerCase().includes(exp.spfInclude.toLowerCase())) failures.push("spf_provider_missing");
    else if (!/[-~]all\s*$/i.test(spfs[0]!.trim())) failures.push("spf_not_closed");
    else spf = true;

    let dk = exp.dkimSelectors.length > 0;
    for (const sel of exp.dkimSelectors) {
      const recs = (await txtOf(resolver, `${sel}._domainkey.${d}`)).filter((t) => /^v=DKIM1/i.test(t.trim()));
      const good = recs.some((t) => { const p = parseTags(t).p; return !!p && p.length > 0; });
      if (!good) { dk = false; failures.push(`dkim_${recs.length ? "revoked" : "missing"}:${sel}`); }
    }
    dkim = dk;

    const dm = (await txtOf(resolver, `_dmarc.${d}`)).filter((t) => /^v=DMARC1/i.test(t.trim()));
    if (dm.length !== 1) failures.push(dm.length ? "dmarc_multiple" : "dmarc_missing");
    else {
      const t = parseTags(dm[0]!);
      if (t.p !== "reject" && t.p !== "quarantine") failures.push("dmarc_policy");
      else if (t.adkim !== "s" || t.aspf !== "s") failures.push("dmarc_not_strict");
      else if (t.pct !== undefined && t.pct !== "100") failures.push("dmarc_pct");
      else dmarc = true;
    }
  } catch { failures.push("dns_error"); }
  return { ok: failures.length === 0 && spf && dkim && dmarc, domain: d, spf, dkim, dmarc, failures };
}

export class MailGateError extends Error {
  override name = "MailGateError";
  constructor(public kind: string, public failures: string[]) { super("mail_gate_closed"); }
}

/** Mail kinds that carry money records and must never leave from a domain whose authentication is unverified. */
export const GATED_KINDS: ReadonlySet<string> = new Set(["receipt", "void_notice"]);

export interface GatedEmailOpts {
  config: Pick<Config, "mode">;
  resolver: DnsResolver;
  domain: string;
  expectation: MailDomainExpectation;
  now: () => number;
  /** How long a passing (or failing) verdict is reused. */
  ttlMs?: number;
  gatedKinds?: ReadonlySet<string>;
}

/**
 * In staging and production a receipt or void notice is sent only when the sending domain passed
 * verifyMailDomain within the last `ttlMs` (default 15 minutes); otherwise it throws MailGateError and the job retries.
 * Local and preview never reach a real transport, so the gate does not apply there.
 */
export class GatedEmail implements EmailPort {
  private verdict?: { at: number; result: MailDomainResult };
  constructor(private inner: EmailPort, private o: GatedEmailOpts) {}
  async check(): Promise<MailDomainResult> {
    const ttl = this.o.ttlMs ?? 15 * 60_000;
    const t = this.o.now();
    if (!this.verdict || t - this.verdict.at > ttl) this.verdict = { at: t, result: await verifyMailDomain(this.o.resolver, this.o.domain, this.o.expectation) };
    return this.verdict.result;
  }
  async send(msg: EmailMessage): Promise<{ id: string }> {
    const gated = (this.o.gatedKinds ?? GATED_KINDS).has(msg.kind);
    if (gated && (this.o.config.mode === "production" || this.o.config.mode === "staging")) {
      const v = await this.check();
      if (!v.ok) throw new MailGateError(msg.kind, v.failures);
    }
    return this.inner.send(msg);
  }
}
