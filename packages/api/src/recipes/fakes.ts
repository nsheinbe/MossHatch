import crypto from "node:crypto";
import type { NeonPort, NeonProject, RecipeProviders, ResendDomain, ResendPort, TargetProbe, VercelPort, VercelTarget } from "./providers.ts";

/**
 * Faithful fakes of Vercel, Neon and Resend for tests (never the real services). Each checks the credential it is given
 * against the one registered for the account, keeps the provider-side objects a real call would create, and logs every
 * call without its values. Shapes follow the documented responses in tech-wire-it-recipes.md; behaviour we could not
 * verify (idempotent domain attach, the exact CNAME-variant records) is modelled on the documented text only.
 */

export class FakeProviderError extends Error { constructor(public service: string, public status: number) { super(`${service}_${status}`); } }

export interface CallLog { service: string; op: string; target?: string }

export class FakeVercel implements VercelPort {
  readonly calls: CallLog[] = [];
  readonly projects = new Map<string, { credential: string; domains: Set<string>; env: Map<string, { value: string; type: string; target: VercelTarget[] }>; ipv4: string; cname: string }>();
  addProject(id: string, credential: string, o: { ipv4?: string; cname?: string } = {}) {
    this.projects.set(id, { credential, domains: new Set(), env: new Map(), ipv4: o.ipv4 ?? "76.76.21.21", cname: o.cname ?? `${crypto.randomBytes(8).toString("hex")}.vercel-dns-017.com` });
  }
  private proj(cred: string, id: string) {
    const p = this.projects.get(id);
    if (!p) throw new FakeProviderError("vercel", 404);
    if (p.credential !== cred) throw new FakeProviderError("vercel", 403);
    return p;
  }
  async domainConfig(cred: string, id: string, fqdn: string) {
    this.calls.push({ service: "vercel", op: "domainConfig", target: fqdn });
    const p = this.proj(cred, id);
    return { recommendedIPv4: [p.ipv4], recommendedCNAME: p.cname, misconfigured: !p.domains.has(fqdn) };
  }
  async addProjectDomain(cred: string, id: string, name: string) {
    this.calls.push({ service: "vercel", op: "addProjectDomain", target: name });
    this.proj(cred, id).domains.add(name);
    return { verified: true };
  }
  async removeProjectDomain(cred: string, id: string, name: string) {
    this.calls.push({ service: "vercel", op: "removeProjectDomain", target: name });
    this.proj(cred, id).domains.delete(name);
  }
  async upsertEnv(cred: string, id: string, v: { key: string; value: string; type: "encrypted" | "sensitive"; target: VercelTarget[] }) {
    this.calls.push({ service: "vercel", op: "upsertEnv", target: v.key });
    if (v.type === "sensitive" && v.target.includes("development")) throw new FakeProviderError("vercel", 400);   // documented rule
    this.proj(cred, id).env.set(`${v.key}|${v.target.slice().sort().join(",")}`, { value: v.value, type: v.type, target: v.target });
  }
}

export class FakeNeon implements NeonPort {
  readonly calls: CallLog[] = [];
  readonly projects = new Map<string, { credential: string; project: NeonProject; password: string }>();
  readonly created: string[] = [];
  private orgCredential = "";
  setOrgCredential(c: string) { this.orgCredential = c; }
  addProject(id: string, credential: string) {
    const ep = `ep-${crypto.randomBytes(4).toString("hex")}`;
    this.projects.set(id, { credential, password: `npg_${crypto.randomBytes(12).toString("hex")}`, project: { id, branch: "br-main", database: "neondb", role: "neondb_owner", host: `${ep}.us-east-2.aws.neon.tech`, poolerHost: `${ep}-pooler.us-east-2.aws.neon.tech` } });
  }
  private get(cred: string, id: string) {
    const p = this.projects.get(id);
    if (!p) throw new FakeProviderError("neon", 404);
    if (p.credential !== cred) throw new FakeProviderError("neon", 403);
    return p;
  }
  async describeProject(cred: string, id: string) { this.calls.push({ service: "neon", op: "describeProject", target: id }); return this.get(cred, id).project; }
  async connectionUri(cred: string, id: string, o: { pooled: boolean }) {
    this.calls.push({ service: "neon", op: "connectionUri", target: id });
    const p = this.get(cred, id);
    // Built with URL setters, the way the documented connection_uri looks (and without a literal credential-shaped string).
    const u = new URL(`postgresql://${o.pooled ? p.project.poolerHost : p.project.host}/${p.project.database}`);
    u.username = p.project.role; u.password = p.password; u.search = "sslmode=require";
    return u.toString();
  }
  async createProject(cred: string, name: string) {
    this.calls.push({ service: "neon", op: "createProject", target: name });
    if (!this.orgCredential || cred !== this.orgCredential) throw new FakeProviderError("neon", 403);
    const id = `proj-${crypto.randomBytes(4).toString("hex")}`;
    this.addProject(id, cred);
    this.created.push(id);
    return this.projects.get(id)!.project;
  }
}

export class FakeResend implements ResendPort {
  readonly calls: CallLog[] = [];
  readonly domains = new Map<string, ResendDomain & { credential: string }>();
  readonly keys: { id: string; domainId: string; token: string }[] = [];
  credential = "";
  private check(cred: string) { if (!this.credential || cred !== this.credential) throw new FakeProviderError("resend", 401); }
  async findDomain(cred: string, name: string) {
    this.calls.push({ service: "resend", op: "findDomain", target: name });
    this.check(cred);
    const d = [...this.domains.values()].find((x) => x.name === name);
    return d ? { id: d.id, name: d.name, region: d.region, records: d.records } : null;
  }
  async createDomain(cred: string, name: string, region: string) {
    this.calls.push({ service: "resend", op: "createDomain", target: name });
    this.check(cred);
    const id = crypto.randomUUID();
    // Per-domain DKIM key: unknowable before creation (the documented reason Resend records are "pending" in a preview).
    const dkim = `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GN${crypto.randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "")}`;
    const d = { id, name, region, credential: cred, records: [
      { record: "DKIM", type: "TXT" as const, name: "resend._domainkey", value: dkim },
      { record: "SPF", type: "MX" as const, name: "send", value: `feedback-smtp.${region}.amazonses.com`, priority: 10 },
      { record: "SPF", type: "TXT" as const, name: "send", value: "\"v=spf1 include:amazonses.com ~all\"" },
    ] };
    this.domains.set(id, d);
    return { id, name, region, records: d.records };
  }
  async createSendingKey(cred: string, domainId: string, name: string) {
    this.calls.push({ service: "resend", op: "createSendingKey", target: name });
    this.check(cred);
    if (!this.domains.has(domainId)) throw new FakeProviderError("resend", 404);
    const k = { id: crypto.randomUUID(), domainId, token: `re_${crypto.randomBytes(16).toString("hex")}` };
    this.keys.push(k);
    return { id: k.id, token: k.token };
  }
}

/** Hosts answer 200 unless marked gone, in which case they answer like a Vercel project with nothing deployed. */
export class FakeProbe implements TargetProbe {
  readonly gone = new Set<string>();
  readonly probed: string[] = [];
  async probe(host: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    this.probed.push(host);
    if (this.gone.has(host)) return { status: 404, headers: { "x-vercel-error": "DEPLOYMENT_NOT_FOUND", "content-type": "text/plain" }, body: "The deployment could not be found on Vercel.\n\nDEPLOYMENT_NOT_FOUND" };
    return { status: 200, headers: { "content-type": "text/html" }, body: "<!doctype html><title>ok</title>" };
  }
}

export interface Fakes extends RecipeProviders { vercel: FakeVercel; neon: FakeNeon; resend: FakeResend; probe: FakeProbe }
export const makeFakes = (): Fakes => ({ vercel: new FakeVercel(), neon: new FakeNeon(), resend: new FakeResend(), probe: new FakeProbe() });
