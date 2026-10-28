import dns from "node:dns/promises";
import tls from "node:tls";
import { withNoUser } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import type { JobRow } from "../jobs/registry.ts";
import { enqueue } from "../jobs/registry.ts";
import { flagOn } from "./flags.ts";

/**
 * DC-12. After a connect apply, read the desired records from each authoritative nameserver, then take
 * three matching answers from Cloudflare and Google, 30 seconds apart. Public resolvers are not asked
 * until the authoritative servers already have the new records. `.dev` and `.app` also need a certificate
 * for the name. The flag off means the job is not enqueued.
 */

export const VERIFY_DELAY_MS = 30_000;
const SAMPLES = 3;
const MAX_TRIES = 8;

export interface VerifyAnswer { type: string; name: string; value: string; priority?: number }

export interface ConnectVerifyProbe {
  /** One answer set per authoritative nameserver. Public resolvers are not this call. */
  authoritative(fqdn: string, nameservers: readonly string[], desired: readonly VerifyAnswer[]): Promise<VerifyAnswer[][]>;
  resolver(which: "cloudflare" | "google", fqdn: string, desired: readonly VerifyAnswer[]): Promise<VerifyAnswer[]>;
  tls(fqdn: string): Promise<boolean>;
}

const TYPE_CODE: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257 };

export function answersMatch(have: readonly VerifyAnswer[], want: readonly VerifyAnswer[]): boolean {
  return want.every((w) => have.some((h) => h.type === w.type && h.name === w.name && h.value === w.value && (w.priority ?? null) === (h.priority ?? null)));
}

/** A stored provider fact that already says the host is not ready. No new call to the provider. */
export function storedProviderBlocks(rows: readonly { service: string; provider_facts: unknown }[]): boolean {
  for (const row of rows) {
    const facts = row.provider_facts && typeof row.provider_facts === "object" ? row.provider_facts as Record<string, unknown> : {};
    if (row.service === "vercel" && facts.misconfigured === true) return true;
    if (row.service === "resend" && Array.isArray(facts.records)) {
      for (const rec of facts.records) {
        if (!rec || typeof rec !== "object" || !("status" in rec)) continue;
        const status = (rec as { status?: unknown }).status;
        if (typeof status === "string" && status !== "" && status !== "verified") return true;
      }
    }
  }
  return false;
}

function probeOf(ctx: AppContext): ConnectVerifyProbe | null {
  const probe = (ctx.services as { connectVerify?: ConnectVerifyProbe }).connectVerify;
  return probe ?? null;
}

const qname = (fqdn: string, name: string) => (!name || name === "@" ? fqdn : `${name}.${fqdn}`);

async function setState(ctx: AppContext, id: string, state: "pending" | "shedding" | "spread"): Promise<void> {
  await ctx.cron.query("update connect_plans set verify_state = $2 where id = $1 and state = 'applied'", [id, state]);
}

async function again(ctx: AppContext, userId: string, planId: string, samples: number, tries: number): Promise<void> {
  if (tries >= MAX_TRIES) return;
  await withNoUser(ctx.cron, (c) => enqueue(c, {
    kind: "dns.verify",
    payload: { plan_id: planId, samples, tries },
    dedupeKey: `dns.verify:${planId}:s${samples}:t${tries}`,
    userId,
    runAt: new Date(ctx.clock.now().getTime() + VERIFY_DELAY_MS),
  }));
}

/** Queue a check for an applied plan. Does nothing while `connect.verify` is off, and does not read public DNS. */
export async function enqueueVerify(ctx: AppContext, userId: string, planId: string): Promise<void> {
  if (!(await flagOn(ctx, "connect.verify"))) return;
  await withNoUser(ctx.cron, (c) => enqueue(c, {
    kind: "dns.verify", payload: { plan_id: planId, samples: 0, tries: 0 }, dedupeKey: `dns.verify:${planId}:s0:t0`, userId,
  }));
  await setState(ctx, planId, "pending");
}

export async function verifyJob(ctx: AppContext, job: JobRow): Promise<void> {
  if (!(await flagOn(ctx, "connect.verify"))) return;
  const probe = probeOf(ctx);
  const planId = typeof job.payload.plan_id === "string" ? job.payload.plan_id : "";
  if (!probe || !planId) return;
  const row = (await ctx.cron.query(
    `select p.id, p.user_id, p.state, p.applied_records, d.fqdn_ascii, d.nameservers, d.id as domain_id
       from connect_plans p join domains d on d.id = p.domain_id where p.id = $1`, [planId])).rows[0] as {
    id: string; user_id: string; state: string; applied_records: VerifyAnswer[] | null; fqdn_ascii: string; nameservers: string[]; domain_id: string;
  } | undefined;
  if (!row || row.state !== "applied") return;
  const desired = Array.isArray(row.applied_records) ? row.applied_records : [];
  if (desired.length === 0) return;
  const samples = Number(job.payload.samples ?? 0);
  const tries = Number(job.payload.tries ?? 0);
  const auth = await probe.authoritative(row.fqdn_ascii, row.nameservers ?? [], desired);
  if (auth.length === 0 || auth.some((one) => !answersMatch(one, desired))) {
    await setState(ctx, row.id, "shedding");
    await again(ctx, row.user_id, row.id, samples, tries + 1);
    return;
  }
  const facts = (await ctx.cron.query(
    "select service, provider_facts from connections where domain_id = $1 and ended_at is null and service = any($2::text[])",
    [row.domain_id, ["vercel", "resend"]])).rows as { service: string; provider_facts: unknown }[];
  if (storedProviderBlocks(facts)) {
    await setState(ctx, row.id, "shedding");
    await again(ctx, row.user_id, row.id, samples, tries + 1);
    return;
  }
  const cf = await probe.resolver("cloudflare", row.fqdn_ascii, desired);
  const gg = await probe.resolver("google", row.fqdn_ascii, desired);
  const tlsOk = !/\.(dev|app)$/i.test(row.fqdn_ascii) || await probe.tls(row.fqdn_ascii);
  if (!answersMatch(cf, desired) || !answersMatch(gg, desired) || !tlsOk) {
    await setState(ctx, row.id, "shedding");
    await again(ctx, row.user_id, row.id, samples, tries + 1);
    return;
  }
  const next = samples + 1;
  if (next >= SAMPLES) { await setState(ctx, row.id, "spread"); return; }
  await setState(ctx, row.id, "pending");
  await again(ctx, row.user_id, row.id, next, tries);
}

const soft = async <T>(p: Promise<T[]>): Promise<T[]> => {
  try { return await p; } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "ENOTIMP") return [];
    throw e;
  }
};

async function lookup(server: string, fqdn: string, want: readonly VerifyAnswer[]): Promise<VerifyAnswer[]> {
  const ips = await soft(dns.resolve4(server));
  if (!ips[0]) return [];
  const r = new dns.Resolver({ timeout: 2000, tries: 1 });
  r.setServers([ips[0]]);
  const out: VerifyAnswer[] = [];
  for (const w of want) {
    const name = qname(fqdn, w.name);
    if (w.type === "A") for (const value of await soft(r.resolve4(name))) out.push({ type: "A", name: w.name, value });
    else if (w.type === "AAAA") for (const value of await soft(r.resolve6(name))) out.push({ type: "AAAA", name: w.name, value });
    else if (w.type === "CNAME") for (const value of await soft(r.resolveCname(name))) out.push({ type: "CNAME", name: w.name, value: value.replace(/\.$/, "") });
    else if (w.type === "MX") for (const mx of await soft(r.resolveMx(name))) out.push({ type: "MX", name: w.name, value: mx.exchange.replace(/\.$/, ""), priority: mx.priority });
    else if (w.type === "TXT") for (const chunks of await soft(r.resolveTxt(name))) out.push({ type: "TXT", name: w.name, value: chunks.join("") });
    else if (w.type === "NS") for (const value of await soft(r.resolveNs(name))) out.push({ type: "NS", name: w.name, value: value.replace(/\.$/, "") });
    else if (w.type === "CAA") for (const caa of await soft(r.resolveCaa(name))) {
      const tag = caa.issue !== undefined ? "issue" : caa.issuewild !== undefined ? "issuewild" : "iodef";
      const value = caa.issue ?? caa.issuewild ?? caa.iodef ?? "";
      out.push({ type: "CAA", name: w.name, value: `${caa.critical ?? 0} ${tag} "${value}"` });
    }
  }
  return out;
}

async function doh(base: string, fqdn: string, want: readonly VerifyAnswer[]): Promise<VerifyAnswer[]> {
  const out: VerifyAnswer[] = [];
  for (const w of want) {
    const type = TYPE_CODE[w.type];
    if (!type) continue;
    const url = base.includes("dns.google")
      ? `https://dns.google/resolve?name=${encodeURIComponent(qname(fqdn, w.name))}&type=${type}`
      : `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(qname(fqdn, w.name))}&type=${type}`;
    const res = await fetch(url, { headers: { accept: "application/dns-json" } });
    if (!res.ok) continue;
    const data = await res.json() as { Answer?: { type?: number; data?: string }[] };
    for (const a of data.Answer ?? []) {
      if (a.type !== type || !a.data) continue;
      if (w.type === "MX") {
        const m = /^(\d+)\s+(\S+)/.exec(a.data);
        if (m) out.push({ type: "MX", name: w.name, value: m[2]!.replace(/\.$/, ""), priority: Number(m[1]) });
      } else if (w.type === "TXT") out.push({ type: "TXT", name: w.name, value: a.data.replace(/^"|"$/g, "") });
      else out.push({ type: w.type, name: w.name, value: a.data.replace(/\.$/, "") });
    }
  }
  return out;
}

function certMatches(fqdn: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: fqdn, port: 443, servername: fqdn, timeout: 4000 }, () => {
      try {
        const cert = socket.getPeerCertificate();
        const name = fqdn.toLowerCase();
        const alt = String(cert.subjectaltname ?? "").toLowerCase();
        const cn = String((cert.subject as { CN?: string } | undefined)?.CN ?? "").toLowerCase();
        socket.end();
        resolve(alt.split(",").some((p) => p.trim() === `dns:${name}`) || cn === name);
      } catch { socket.destroy(); resolve(false); }
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
  });
}

/**
 * Authoritative reads go to each nameserver over UDP/53. Cloudflare and Google are asked only by `resolver`,
 * which the job calls after the authoritative read matches. Tests inject their own probe and never construct this.
 */
export function networkVerifyProbe(): ConnectVerifyProbe {
  return {
    authoritative: (fqdn, nameservers, desired) => Promise.all(nameservers.map((ns) => lookup(ns, fqdn, desired).catch(() => []))),
    resolver: (which, fqdn, desired) => doh(which === "google" ? "https://dns.google/resolve" : "https://cloudflare-dns.com/dns-query", fqdn, desired),
    tls: certMatches,
  };
}
