/**
 * Provider ports for wire-it recipes (PLAN 4.3b; docs/research/tech-wire-it-recipes.md sections 2, 4 and 5). Every method
 * takes the decrypted credential as an argument: the ports hold no credentials, and only the vault's
 * `withConnectionCredential` (called by the `recipe.apply` and `connection.check` jobs) ever produces one. Provider record
 * values are data read from the provider, never constants: Vercel's recommended A and CNAME, Resend's per-domain DKIM key.
 *
 * Tests use the fakes in `fakes.ts`. The fetch adapters at the end of this file follow the documented endpoints and are
 * never called in this repository (no live credentials exist); every detail they rely on is listed as unverified.
 */

export type VercelTarget = "production" | "preview" | "development";
export interface VercelDomainConfig { recommendedIPv4: string[]; recommendedCNAME: string; misconfigured: boolean }

export interface VercelPort {
  /** `GET /v6/domains/{domain}/config?projectIdOrName=`: works before the domain is attached to the project. */
  domainConfig(credential: string, projectId: string, fqdn: string): Promise<VercelDomainConfig>;
  /** `POST /v10/projects/{id}/domains`; an existing attachment is success (idempotent here). */
  addProjectDomain(credential: string, projectId: string, name: string): Promise<{ verified: boolean }>;
  removeProjectDomain(credential: string, projectId: string, name: string): Promise<void>;
  /** `POST /v10/projects/{id}/env?upsert=true`. `sensitive` cannot target development. */
  upsertEnv(credential: string, projectId: string, v: { key: string; value: string; type: "encrypted" | "sensitive"; target: VercelTarget[] }): Promise<void>;
}

export interface NeonProject { id: string; branch: string; database: string; role: string; host: string; poolerHost: string }
export interface NeonPort {
  describeProject(credential: string, projectId: string): Promise<NeonProject>;
  /** `GET /projects/{id}/connection_uri?pooled=`: the value is a secret and goes only to the vault or the host. */
  connectionUri(credential: string, projectId: string, o: { pooled: boolean }): Promise<string>;
  /** `POST /projects`: billable, cost depends on the plan (unknown to us), so it always needs an approval. */
  createProject(credential: string, name: string): Promise<NeonProject>;
}

export interface ResendRecord { record: string; type: "TXT" | "MX" | "CNAME"; name: string; value: string; priority?: number }
export interface ResendDomain { id: string; name: string; region: string; records: ResendRecord[] }
export interface ResendPort {
  findDomain(credential: string, name: string): Promise<ResendDomain | null>;
  /** `POST /domains`: a free, reversible provider object whose records (DKIM key) exist only after creation. */
  createDomain(credential: string, name: string, region: string): Promise<ResendDomain>;
  /** `POST /api-keys` with `sending_access` restricted to one domain. The token is shown once. */
  createSendingKey(credential: string, domainId: string, name: string): Promise<{ id: string; token: string }>;
}

/** An HTTPS probe of a wired host, for dangling-record detection (ST-130). */
export interface TargetProbe { probe(host: string): Promise<{ status: number; headers: Record<string, string>; body: string }> }

export interface RecipeProviders { vercel: VercelPort; neon: NeonPort; resend: ResendPort; probe: TargetProbe }

export function providersOf(ctx: { services: Record<string, unknown> }): RecipeProviders {
  const p = (ctx.services as { recipes?: RecipeProviders }).recipes;
  if (!p) throw Object.assign(new Error("recipe providers not installed"), { code: "providers_unavailable" });
  return p;
}
export function installRecipeProviders(ctx: { services: Record<string, unknown> }, p: RecipeProviders): void {
  (ctx.services as Record<string, unknown>).recipes = p;
}

/** The provider's "nothing is deployed here" answer (Vercel documents the DEPLOYMENT_NOT_FOUND error code; unverified live). */
export function isProviderNotFound(r: { status: number; headers: Record<string, string>; body: string }): boolean {
  const h = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return r.status === 404 && (/DEPLOYMENT_NOT_FOUND|NOT_FOUND/.test(h["x-vercel-error"] ?? "") || /DEPLOYMENT_NOT_FOUND/.test(r.body));
}

// ---- fetch adapters (never called here; unverified against live APIs) ---------------------------------------------------

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
class ProviderError extends Error { constructor(public service: string, public status: number) { super(`${service}_${status}`); } }
async function call(f: Fetch, service: string, url: string, credential: string, init: RequestInit = {}): Promise<any> {
  const res = await f(url, { ...init, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new ProviderError(service, res.status);   // the body is never read into an error: it may echo a value
  return res.status === 204 ? null : res.json();
}

export function vercelAdapter(f: Fetch = fetch, base = "https://api.vercel.com"): VercelPort {
  return {
    async domainConfig(cred, project, fqdn) {
      const j = await call(f, "vercel", `${base}/v6/domains/${encodeURIComponent(fqdn)}/config?projectIdOrName=${encodeURIComponent(project)}`, cred);
      const pick = <T extends { rank: number }>(xs: T[] | undefined) => (xs ?? []).slice().sort((a, b) => a.rank - b.rank)[0];
      return { recommendedIPv4: pick(j.recommendedIPv4 as { rank: number; value: string[] }[])?.value ?? [], recommendedCNAME: String(pick(j.recommendedCNAME as { rank: number; value: string }[])?.value ?? "").replace(/\.$/, ""), misconfigured: !!j.misconfigured };
    },
    async addProjectDomain(cred, project, name) {
      try { const j = await call(f, "vercel", `${base}/v10/projects/${encodeURIComponent(project)}/domains`, cred, { method: "POST", body: JSON.stringify({ name }) }); return { verified: !!j.verified }; }
      catch (e) { if (e instanceof ProviderError && e.status === 400) return { verified: false }; throw e; }   // "already exists on the project"
    },
    async removeProjectDomain(cred, project, name) { await call(f, "vercel", `${base}/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(name)}`, cred, { method: "DELETE" }); },
    async upsertEnv(cred, project, v) { await call(f, "vercel", `${base}/v10/projects/${encodeURIComponent(project)}/env?upsert=true`, cred, { method: "POST", body: JSON.stringify(v) }); },
  };
}

export function neonAdapter(f: Fetch = fetch, base = "https://console.neon.tech/api/v2"): NeonPort {
  const shape = (j: any): NeonProject => {
    const ep = (j.endpoints ?? [])[0] ?? {};
    const host = String(ep.host ?? "");
    return { id: j.project?.id ?? j.id, branch: j.branch?.id ?? ep.branch_id ?? "", database: j.databases?.[0]?.name ?? "neondb", role: j.roles?.[0]?.name ?? "", host, poolerHost: host.replace(/^([^.]+)/, "$1-pooler") };
  };
  return {
    async describeProject(cred, id) {
      const p = await call(f, "neon", `${base}/projects/${encodeURIComponent(id)}`, cred);
      const eps = await call(f, "neon", `${base}/projects/${encodeURIComponent(id)}/endpoints`, cred);
      return shape({ ...p, endpoints: eps.endpoints });
    },
    async connectionUri(cred, id, o) {
      const p = await this.describeProject(cred, id);
      const j = await call(f, "neon", `${base}/projects/${encodeURIComponent(id)}/connection_uri?database_name=${encodeURIComponent(p.database)}&role_name=${encodeURIComponent(p.role)}&pooled=${o.pooled}`, cred);
      return String(j.uri);
    },
    async createProject(cred, name) { return shape(await call(f, "neon", `${base}/projects`, cred, { method: "POST", body: JSON.stringify({ project: { name } }) })); },
  };
}

export function resendAdapter(f: Fetch = fetch, base = "https://api.resend.com"): ResendPort {
  const shape = (j: any): ResendDomain => ({ id: j.id, name: j.name, region: j.region, records: (j.records ?? []).map((r: any) => ({ record: r.record, type: r.type, name: r.name, value: String(r.value), ...(r.priority !== undefined ? { priority: Number(r.priority) } : {}) })) });
  return {
    async findDomain(cred, name) {
      const list = await call(f, "resend", `${base}/domains`, cred);
      const hit = (list.data ?? []).find((d: any) => d.name === name);
      return hit ? shape(await call(f, "resend", `${base}/domains/${encodeURIComponent(hit.id)}`, cred)) : null;
    },
    async createDomain(cred, name, region) { return shape(await call(f, "resend", `${base}/domains`, cred, { method: "POST", body: JSON.stringify({ name, region }) })); },
    async createSendingKey(cred, domainId, name) {
      const j = await call(f, "resend", `${base}/api-keys`, cred, { method: "POST", body: JSON.stringify({ name, permission: "sending_access", domain_id: domainId }) });
      return { id: j.id, token: j.token };
    },
  };
}

export function httpsProbe(f: Fetch = fetch): TargetProbe {
  return {
    async probe(host) {
      const res = await f(`https://${host}/`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000) });
      const body = (await res.text()).slice(0, 2048);
      return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body };
    },
  };
}
