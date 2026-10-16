import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRouter } from "../routes.ts";
import type { Route } from "../http/types.ts";
import { makeBinding, putSecret, type Person } from "../vault/testkit.ts";
import { bearer, connect, makePerson, makeRecipeKit, plan, type RecipeKit } from "../recipes/testkit.ts";
import { lintScopes } from "./scopes.ts";
import { sha256 } from "../util/bytes.ts";

/**
 * ST-65: the scope matrix (token x route x env), generated from the route table: every route that accepts a bearer must
 * have an entry here, or the test fails. Plus the bearer half of the cross-tenant matrix: user B's widest valid token on
 * user A's names and ids gets the same answer as a nonexistent one.
 */

type Env = "dev" | "preview" | "prod";
interface Entry {
  /** Capability the route needs, or null when any live binding may call it. */
  cap: string | null;
  /** Env-bound routes are tried in every env. */
  env: boolean;
  /** Status a missing scope gets (403 everywhere except where the route deliberately hides existence). */
  denied?: number;
  call(p: Person, env: Env, token: string): Promise<{ status: number; text: string }>;
}

let k: RecipeKit;
let a: Person, b: Person, other: { id: string; fqdn: string };
const router = buildRouter();
const bearerRoutes = router.routes.filter((r) => r.principals.includes("binding"));
const key = (r: Route) => `${r.method} ${r.path}`;

const ENTRIES: Record<string, Entry> = {
  "POST /api/v1/domains/:fqdn/secrets/:env/read": { cap: "secrets.read", env: true, call: (p, env, t) => bearer(k, t, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/${env}/read`, {}) },
  "GET /api/v1/domains/:fqdn/nest/:env/names": { cap: "nest.names", env: true, call: (p, env, t) => bearer(k, t, "GET", `/api/v1/domains/${p.domain.fqdn}/nest/${env}/names`) },
  "POST /api/v1/domains/:fqdn/secrets/:env/write": { cap: "secrets.write", env: true, call: (p, env, t) => bearer(k, t, "POST", `/api/v1/domains/${p.domain.fqdn}/secrets/${env}/write`, { secrets: { MATRIX_VALUE: "v" } }) },
  "POST /api/v1/domains/:fqdn/recipes/:recipe/plan": { cap: "recipes.plan", env: false, call: (p, _e, t) => bearer(k, t, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/plan`, { input: {} }) },
  "GET /api/v1/recipe-applications/:id": {
    cap: "recipes.plan", env: false,
    call: async (p, _e, t) => { const r = await plan(k, p, "postgres-neon"); return bearer(k, t, "GET", `/api/v1/recipe-applications/${r.json.application_id}`); },
  },
  "POST /api/v1/domains/:fqdn/recipes/:recipe/apply": {
    // The touched set of a Neon plan for one env: recipes.apply and secrets.write on that env (checked in full in recipes.test.ts).
    cap: "recipes.apply", env: true,
    call: async (p, env, t) => { const r = await plan(k, p, "postgres-neon", { envs: [env] }); return bearer(k, t, "POST", `/api/v1/domains/${p.domain.fqdn}/recipes/postgres-neon/apply`, { application_id: r.json.application_id, plan_hash: r.json.plan.plan_hash }); },
  },
  "DELETE /api/v1/domains/:id/auto-renew": { cap: "mandate.off", env: false, denied: 404, call: (p, _e, t) => bearer(k, t, "DELETE", `/api/v1/domains/${p.domain.id}/auto-renew`) },
  "GET /api/v1/whoami": { cap: null, env: false, call: (_p, _e, t) => bearer(k, t, "GET", "/api/v1/whoami") },
  "GET /api/v1/vault/reserved-names": { cap: null, env: false, call: (_p, _e, t) => bearer(k, t, "GET", "/api/v1/vault/reserved-names") },
  "GET /api/v1/recipes": { cap: null, env: false, call: (_p, _e, t) => bearer(k, t, "GET", "/api/v1/recipes") },
  "GET /api/v1/search": { cap: null, env: false, call: (_p, _e, t) => bearer(k, t, "GET", "/api/v1/search?name=mossmatrix") },
  "GET /api/v1/quote": { cap: null, env: false, call: (_p, _e, t) => bearer(k, t, "GET", "/api/v1/quote?domain=mossmatrix.com&years=1") },
  "POST /api/v1/oauth/revoke": { cap: null, env: false, call: (_p, _e, t) => bearer(k, t, "POST", "/api/v1/oauth/revoke", { token: "mh_cli_not_a_token" }) },
  // Agent surface (Phase 5): the REST equivalents of the MCP tools, the MCP endpoint, and the approval state for the binding that asked.
  "GET /api/v1/approvals/:id": { cap: null, env: false, call: (_p, _e, t) => bearer(k, t, "GET", "/api/v1/approvals/018f0000-0000-7000-8000-000000000000") },
  "POST /mcp": { cap: null, env: false, call: (_p, _e, t) => k.app.call("POST", "/mcp", { authorization: `Bearer ${t}`, browser: false, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } }) },
  // A client's GET stream is refused with 405 for every token: never 401 or 403, which would read as an access problem.
  "GET /mcp": { cap: null, env: false, call: (_p, _e, t) => k.app.call("GET", "/mcp", { authorization: `Bearer ${t}`, browser: false, headers: { accept: "text/event-stream" } }) },
  "POST /api/v1/agent/scope-requests": { cap: null, env: false, call: (p, _e, t) => bearer(k, t, "POST", "/api/v1/agent/scope-requests", { scopes: [`dns.read:${p.domain.fqdn}`] }) },
  // A list answers for A's domain only when a scope covers it: "not listed" is the list's form of a refusal.
  "GET /api/v1/agent/domains": { cap: "domains.read", env: false, call: async (p, _e, t) => { const r = await bearer(k, t, "GET", "/api/v1/agent/domains"); return r.status === 200 && !r.text.includes(`"${p.domain.fqdn}"`) ? { status: 403, text: "not listed" } : r; } },
  "GET /api/v1/agent/domains/:fqdn": { cap: "domains.read", env: false, call: (p, _e, t) => bearer(k, t, "GET", `/api/v1/agent/domains/${p.domain.fqdn}`) },
  "GET /api/v1/agent/domains/:fqdn/dns": { cap: "dns.read", env: false, call: (p, _e, t) => bearer(k, t, "GET", `/api/v1/agent/domains/${p.domain.fqdn}/dns`) },
  "POST /api/v1/agent/domains/:fqdn/dns": { cap: "dns.write", env: false, call: (p, _e, t) => bearer(k, t, "POST", `/api/v1/agent/domains/${p.domain.fqdn}/dns`, { records: [{ type: "A", name: "matrix", value: "203.0.113.7" }] }) },
  "GET /api/v1/agent/domains/:fqdn/nest/:env": { cap: "nest.names", env: true, call: (p, env, t) => bearer(k, t, "GET", `/api/v1/agent/domains/${p.domain.fqdn}/nest/${env}`) },
  "POST /api/v1/agent/domains/:fqdn/secrets/:env/:name/read": { cap: "secrets.read", env: true, call: (p, env, t) => bearer(k, t, "POST", `/api/v1/agent/domains/${p.domain.fqdn}/secrets/${env}/MATRIX_SEED/read`, {}) },
  "PUT /api/v1/agent/domains/:fqdn/secrets/:env/:name": { cap: "secrets.write", env: true, call: (p, env, t) => bearer(k, t, "PUT", `/api/v1/agent/domains/${p.domain.fqdn}/secrets/${env}/MATRIX_AGENT`, { value: "v" }) },
  "GET /api/v1/agent/domains/:fqdn/transfer": { cap: "transfer.status", env: false, call: (p, _e, t) => bearer(k, t, "GET", `/api/v1/agent/domains/${p.domain.fqdn}/transfer`) },
  "POST /api/v1/agent/proposals": {
    // A renewal proposal needs room under the token's cap; the matrix tokens are made with none, so the call gives it some.
    cap: "renew.propose", env: false,
    call: async (p, _e, t) => { await k.app.db.owner.query("update bindings set spend_cap_minor = 10000000 where token_hash = $1", [sha256(t)]); return bearer(k, t, "POST", "/api/v1/agent/proposals", { kind: "renew", domain: p.domain.fqdn }); },
  },
};

beforeAll(async () => {
  k = await makeRecipeKit();
  a = await makePerson(k, "sma"); b = await makePerson(k, "smb");
  const o = await makePerson(k, "smo");
  // A second domain of A, for "right capability, wrong domain".
  other = (await k.app.db.owner.query("insert into domains (user_id, fqdn_ascii, tld, registrar, state, locked, nameservers, livemode) values ($1,'sma-other-matrix.com','com','mock','registered',true,'{ns1.systemdns.com}',false) returning id, fqdn_ascii as fqdn", [a.user.userId])).rows[0];
  void o;
  for (const env of ["dev", "preview", "prod"] as const) await putSecret(k, a, env, "MATRIX_SEED", `seed-${env}`);
  k.fakes.neon.addProject("proj-matrix-a", "napi_matrix_a");
  await connect(k, a, "neon", "napi_matrix_a", "proj-matrix-a");
}, 120_000);
afterAll(async () => { await k?.drop(); });

interface S { capability: string; domain_id: string; env: string | null }
function variants(cap: string, dom: string, env: Env | null): { name: string; scopes: S[] }[] {
  const envOf = (e: string | null) => (cap === "mandate.off" || cap === "recipes.plan" ? null : e);
  const extra = (s: S[]) => (cap === "recipes.apply" ? [...s, ...s.map((x) => ({ ...x, capability: "secrets.write", env: x.env }))] : s);
  const others: Env[] = (["dev", "preview", "prod"] as const).filter((e) => e !== env);
  const vs = [
    { name: "none", scopes: [] as S[] },
    { name: "exact", scopes: extra([{ capability: cap, domain_id: dom, env: envOf(env) }]) },
    { name: "star domain", scopes: extra([{ capability: cap, domain_id: "*", env: envOf(env) }]) },
    { name: "star env", scopes: extra([{ capability: cap, domain_id: dom, env: envOf("*") }]) },
    { name: "other domain", scopes: extra([{ capability: cap, domain_id: other.id, env: envOf(env) }]) },
    { name: "wrong capability", scopes: [{ capability: cap === "dns.read" ? "domains.read" : "dns.read", domain_id: dom, env: null }] },
    ...(env ? [{ name: "other env", scopes: extra([{ capability: cap, domain_id: dom, env: others[0]! }, { capability: cap, domain_id: dom, env: others[1]! }]) }] : []),
    ...(cap === "recipes.apply" ? [{ name: "apply without secrets.write", scopes: [{ capability: cap, domain_id: dom, env: envOf(env) }] }] : []),
  ];
  // Only grants a person could actually create: the lint refuses secrets.read on * for prod.
  return vs.filter((v) => !lintScopes(v.scopes.map((s) => ({ capability: s.capability as never, domain_id: s.domain_id, env: s.env as never }))));
}
/** Reference semantics, written independently of the code under test. */
function expected(scopes: S[], cap: string, dom: string, env: Env | null): boolean {
  const cov = (c: string, e: Env | null) => scopes.some((s) => s.capability === c && (s.domain_id === dom || s.domain_id === "*") && (e === null || s.env === e || (s.env === "*" && e !== "prod")));
  if (cap === "recipes.apply") return cov("recipes.apply", env) && cov("secrets.write", env);
  if (cap === "recipes.plan") return cov("recipes.plan", null) || cov("recipes.apply", null);
  return cov(cap, env);
}

describe("ST-65: scope matrix (token x route x env), generated from the route table", () => {
  it("every route that accepts a bearer has a matrix entry", () => {
    expect(bearerRoutes.length).toBeGreaterThan(8);
    for (const r of bearerRoutes) expect(ENTRIES[key(r)], `bearer route ${key(r)} has no scope-matrix entry`).toBeDefined();
  });

  it("each route answers exactly as the scopes say, in every env, including secrets.read on :prod", async () => {
    let checked = 0;
    for (const r of bearerRoutes) {
      const e = ENTRIES[key(r)]!;
      await k.app.db.owner.query("delete from rate_counters");
      if (e.cap === null) {
        const t = await makeBinding(k, a, [], "cli");
        const res = await e.call(a, "dev", t.token);
        expect([401, 403], `${key(r)} with a scope-less token -> ${res.status}`).not.toContain(res.status);
        checked++; continue;
      }
      for (const env of e.env ? (["dev", "preview", "prod"] as const) : [null]) {
        for (const v of variants(e.cap, e.cap === "mandate.off" ? a.domain.id : a.domain.id, env)) {
          await k.app.db.owner.query("delete from rate_counters");
          const t = await makeBinding(k, a, v.scopes, "cli");
          const res = await e.call(a, env ?? "dev", t.token);
          const want = expected(v.scopes, e.cap, a.domain.id, env);
          const label = `${key(r)} env=${env} scopes=${v.name}: ${res.status} ${res.text.slice(0, 80)}`;
          if (want) { expect(res.status, label).toBeGreaterThanOrEqual(200); expect(res.status, label).toBeLessThan(300); }
          else expect(res.status, label).toBe(e.denied ?? 403);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it("a prod read needs an explicit :prod: star env never covers it, and a dev or preview CLI grant never reaches it", async () => {
    await k.app.db.owner.query("delete from rate_counters");
    const star = await makeBinding(k, a, [{ capability: "secrets.read", domain_id: a.domain.id, env: "*" }], "cli");
    expect((await ENTRIES["POST /api/v1/domains/:fqdn/secrets/:env/read"]!.call(a, "prod", star.token)).status).toBe(403);
    const explicit = await makeBinding(k, a, [{ capability: "secrets.read", domain_id: a.domain.id, env: "prod" }], "cli");
    const ok = await ENTRIES["POST /api/v1/domains/:fqdn/secrets/:env/read"]!.call(a, "prod", explicit.token);
    expect(ok.status).toBe(200); expect(ok.text).toContain("seed-prod");
  });
});

describe("ST-91 (bearer half): user B's widest token never reaches user A's resources", () => {
  it("every bearer route with a tenant parameter answers A's resource exactly like a nonexistent one", async () => {
    const wide: S[] = [
      { capability: "secrets.read", domain_id: "*", env: "dev" }, { capability: "secrets.write", domain_id: "*", env: "*" }, { capability: "nest.names", domain_id: "*", env: "*" },
      { capability: "recipes.plan", domain_id: "*", env: null }, { capability: "recipes.apply", domain_id: "*", env: "*" }, { capability: "mandate.off", domain_id: "*", env: null },
    ];
    const t = await makeBinding(k, b, wide, "cli");
    const aPlan = await plan(k, a, "postgres-neon");
    const aBinding = await makeBinding(k, a, [{ capability: "register.propose", domain_id: "*", env: null }], "agent");
    const aRequest = (await k.app.db.owner.query("insert into agent_requests (user_id, binding_id, kind, request_hash, params, created_at, expires_at) values ($1,$2,'scope',$3,'{}', now(), now() + interval '1 hour') returning id", [a.user.userId, aBinding.id, sha256("matrix-a-request")])).rows[0].id as string;
    const shape = (x: { status: number; text: string }) => JSON.stringify([x.status, x.text]);
    const probes: [string, string, string, unknown?][] = [
      ["POST", `/api/v1/domains/${a.domain.fqdn}/secrets/dev/read`, `/api/v1/domains/nobody-here-matrix.com/secrets/dev/read`, {}],
      ["GET", `/api/v1/domains/${a.domain.fqdn}/nest/dev/names`, `/api/v1/domains/nobody-here-matrix.com/nest/dev/names`],
      ["POST", `/api/v1/domains/${a.domain.fqdn}/secrets/dev/write`, `/api/v1/domains/nobody-here-matrix.com/secrets/dev/write`, { secrets: { X: "y" } }],
      ["POST", `/api/v1/domains/${a.domain.fqdn}/recipes/postgres-neon/plan`, `/api/v1/domains/nobody-here-matrix.com/recipes/postgres-neon/plan`, { input: {} }],
      ["POST", `/api/v1/domains/${a.domain.fqdn}/recipes/postgres-neon/apply`, `/api/v1/domains/nobody-here-matrix.com/recipes/postgres-neon/apply`, { application_id: aPlan.json.application_id, plan_hash: aPlan.json.plan.plan_hash }],
      ["GET", `/api/v1/recipe-applications/${aPlan.json.application_id}`, `/api/v1/recipe-applications/018f0000-0000-7000-8000-000000000000`],
      ["DELETE", `/api/v1/domains/${a.domain.id}/auto-renew`, `/api/v1/domains/018f0000-0000-7000-8000-000000000000/auto-renew`],
      ["GET", `/api/v1/approvals/${aRequest}`, "/api/v1/approvals/018f0000-0000-7000-8000-000000000000"],
      ["GET", `/api/v1/agent/domains/${a.domain.fqdn}`, "/api/v1/agent/domains/nobody-here-matrix.com"],
      ["GET", `/api/v1/agent/domains/${a.domain.fqdn}/dns`, "/api/v1/agent/domains/nobody-here-matrix.com/dns"],
      ["POST", `/api/v1/agent/domains/${a.domain.fqdn}/dns`, "/api/v1/agent/domains/nobody-here-matrix.com/dns", { records: [{ type: "A", name: "x", value: "203.0.113.8" }] }],
      ["GET", `/api/v1/agent/domains/${a.domain.fqdn}/nest/dev`, "/api/v1/agent/domains/nobody-here-matrix.com/nest/dev"],
      ["POST", `/api/v1/agent/domains/${a.domain.fqdn}/secrets/dev/MATRIX_SEED/read`, "/api/v1/agent/domains/nobody-here-matrix.com/secrets/dev/MATRIX_SEED/read", {}],
      ["PUT", `/api/v1/agent/domains/${a.domain.fqdn}/secrets/dev/MATRIX_SEED`, "/api/v1/agent/domains/nobody-here-matrix.com/secrets/dev/MATRIX_SEED", { value: "x" }],
      ["GET", `/api/v1/agent/domains/${a.domain.fqdn}/transfer`, "/api/v1/agent/domains/nobody-here-matrix.com/transfer"],
    ];
    const covered = new Set(probes.map(([m, p]) => `${m} ${p}`));
    for (const r of bearerRoutes.filter((x) => x.path.includes(":"))) {
      const hit = [...covered].some((c) => { const [m, p] = c.split(" "); return m === r.method && new RegExp("^" + r.path.replace(/:\w+/g, "[^/]+") + "$").test(p!); });
      expect(hit, `bearer route ${key(r)} has no cross-tenant probe`).toBe(true);
    }
    for (const [m, owned, missing, body] of probes) {
      await k.app.db.owner.query("delete from rate_counters");
      const x = await bearer(k, t.token, m, owned, body);
      const y = await bearer(k, t.token, m, missing, body);
      expect(x.status, `${m} ${owned}`).toBe(404);
      expect(shape(x), `${m} ${owned}`).toBe(shape(y));
      expect(x.text).not.toContain("seed-");
    }
    expect((await k.app.db.owner.query("select state from recipe_applications where id = $1", [aPlan.json.application_id])).rows[0].state).toBe("planned");
  });
});
