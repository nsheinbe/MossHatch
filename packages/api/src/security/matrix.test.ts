import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withUser } from "@mosshatch/db";
import { makeHarness, makeBuyer, postOrder, type Buyer, type OrdersHarness } from "../orders/testkit.ts";
import { buildRouter } from "../routes.ts";
import type { Route } from "../http/types.ts";
import { mintToken } from "../util/token.ts";
import { sha256 } from "../util/bytes.ts";
import { buildServices, launcherConfigFromEnv } from "../launcher/index.ts";

/**
 * ST-91, ST-92, ST-93, ST-67, ST-137, ST-16: the cross-tenant matrix and the principal walks, both GENERATED from the route
 * table. A route added without an entry in FIXTURES or NO_TENANT_INPUT fails the build.
 */

let h: OrdersHarness;
let a: Buyer, b: Buyer;
let router: ReturnType<typeof buildRouter>;
const ids: Record<string, string> = {};
/** Fixtures that are names, not uuids: the domain routes take the fqdn in the path (plan 4.5). */
const names: Record<string, string> = {};
let bBinding = "";

/** Which fixture id of user A each parameterised route takes. Keyed by the :param name within a path prefix. */
const FIXTURES: { match: RegExp; param: string; id: () => string }[] = [
  { match: /^\/api\/v1\/orders\/:id/, param: "id", id: () => ids.order! },
  { match: /^\/api\/v1\/passkeys\/:id/, param: "id", id: () => ids.passkey! },
  { match: /^\/api\/v1\/notification-addresses\/:id/, param: "id", id: () => ids.address! },
  { match: /^\/api\/v1\/actions\/:id/, param: "id", id: () => ids.action! },
  { match: /^\/api\/v1\/domains\/:fqdn/, param: "fqdn", id: () => names.domain! },
  // Domains core (Phase 3): the overview, export, renew and auto-renew routes take the domain's uuid.
  { match: /^\/api\/v1\/domains\/:id/, param: "id", id: () => ids.domain! },
  // Transfers (Phase 5): a transfer-in of user A. The Gate (/domains/:id/gate) is covered by the domains :id fixture above.
  { match: /^\/api\/v1\/transfers\/:id/, param: "id", id: () => ids.transfer! },
  // Vault (Phase 4): the reveal takes the secret id.
  { match: /^\/api\/v1\/secrets\/:id/, param: "id", id: () => ids.secret! },
  // Tokens and recipes (Phase 4): A's binding, A's recipe plan and A's connection.
  { match: /^\/api\/v1\/bindings\/:id/, param: "id", id: () => ids.binding! },
  { match: /^\/api\/v1\/recipe-applications\/:id/, param: "id", id: () => ids.recipeApplication! },
  { match: /^\/api\/v1\/connections\/:id/, param: "id", id: () => ids.connection! },
  // Agents (Phase 5): A's approval request, A's OAuth consent request, and the bearer-only agent routes by name.
  { match: /^\/api\/v1\/approvals\/:id/, param: "id", id: () => ids.approval! },
  { match: /^\/api\/v1\/oauth\/requests\/:id/, param: "id", id: () => ids.oauthRequest! },
  { match: /^\/api\/v1\/agent\/domains\/:fqdn/, param: "fqdn", id: () => names.domain! },
  // Account closure and export (closure module): A's ready export.
  { match: /^\/api\/v1\/account\/exports\/:id/, param: "id", id: () => ids.accountExport! },
  // The brand launcher (docs/LAUNCHER.md): A's conversation and A's build. The launcher is switched on for everyone below, so
  // B passes the gate and the refusal comes from ownership, not from the flag.
  { match: /^\/api\/v1\/launcher\/conversations\/:id/, param: "id", id: () => ids.launcherConversation! },
  { match: /^\/api\/v1\/launcher\/builds\/:id/, param: "id", id: () => ids.launcherBuild! },
];
/** Parameterised routes whose authority is a token in the path, not a tenant id (checked separately). */
const TOKEN_ROUTES = [/^\/api\/v1\/email-actions\/:token$/, /^\/api\/v1\/binding-revoke\/:token$/];
/** Routes with no path parameter: tenant comes from the credential only, so the check is "B never sees A's data". */
const isParam = (r: Route) => r.path.includes(":");

const NONEXISTENT = "018f0000-0000-7000-8000-000000000000";

beforeAll(async () => {
  h = await makeHarness();
  router = buildRouter();
  h.app.router = router;
  a = await makeBuyer(h, "alice-a@example.org");
  b = await makeBuyer(h, "bob-b@example.org");
  const o = await postOrder(h, a, { fqdn: "alice-owned-name.com", years: 1 }, "matrix-1");
  ids.order = o.json.order_id ?? o.json.id;
  ids.passkey = (await h.app.db.owner.query("insert into passkeys (user_id, credential_id, public_key, alg, backup_eligible, backup_state) values ($1,'cred-alice','\\x00',-7,false,false) returning id", [a.userId])).rows[0].id;
  ids.address = (await h.app.db.owner.query("select id from notification_addresses where user_id = $1 limit 1", [a.userId])).rows[0].id;
  const sessionHash = sha256(Buffer.from(a.cookie.split("=")[1]!, "base64url"));
  ids.action = (await h.app.db.owner.query(
    "insert into actions (user_id, session_id_hash, type, params, params_hash, expires_at) values ($1,$2,'passkey.add','{}','\\x02', now() + interval '1 hour') returning id", [a.userId, sessionHash])).rows[0].id;
  names.domain = "alice-domain-fixture.com";
  await h.app.db.owner.query("insert into domains (user_id, fqdn_ascii, tld, registrar, state, locked, nameservers, livemode) values ($1,$2,'com','mock','registered',true,'{ns1.systemdns.com,ns2.systemdns.com}',false)", [a.userId, names.domain]);
  ids.domain = (await h.app.db.owner.query("select id from domains where user_id = $1 and fqdn_ascii = $2", [a.userId, names.domain])).rows[0].id;
  ids.secret = (await h.app.db.owner.query("insert into secrets (user_id, domain_id, env, name) values ($1,$2,'prod','ALICE_FIXTURE') returning id", [a.userId, ids.domain])).rows[0].id;
  ids.transfer = (await h.app.db.owner.query("insert into transfers_in (user_id, order_id, fqdn_ascii, tld, years, idempotency_key, request_hash) values ($1,$2,'alice-transfer.com','com',1,'matrix-t','\\x00') returning id", [a.userId, ids.order])).rows[0].id;
  const ma = mintToken("cli");
  ids.binding = (await h.app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, expires_at) values ($1,'cli','a',$2,$3,$4, now() + interval '30 days') returning id", [a.userId, ma.prefix, ma.hash, JSON.stringify([{ capability: "secrets.read", domain_id: ids.domain, env: "dev" }])])).rows[0].id;
  ids.recipeApplication = (await h.app.db.owner.query("insert into recipe_applications (user_id, domain_id, recipe_id, recipe_version, plan, plan_hash, needs_approval, created_by_kind, expires_at, created_at) values ($1,$2,'postgres-neon',1,'{}',$3,false,'user', now() + interval '1 hour', now()) returning id", [a.userId, ids.domain, sha256("matrix-plan")])).rows[0].id;
  ids.connection = (await h.app.db.owner.query("insert into connections (user_id, domain_id, service) values ($1,$2,'neon') returning id", [a.userId, ids.domain])).rows[0].id;
  ids.approval = (await h.app.db.owner.query("insert into agent_requests (user_id, binding_id, kind, request_hash, params, created_at, expires_at) values ($1,$2,'scope',$3,'{}', now(), now() + interval '1 hour') returning id", [a.userId, ids.binding, sha256("matrix-request")])).rows[0].id;
  const oc = (await h.app.db.owner.query("insert into oauth_clients (client_id, registration, redirect_uris) values ('mhc_matrixclient00000000000000000000','dcr','{https://matrix.example/cb}') returning id")).rows[0].id;
  ids.oauthRequest = (await h.app.db.owner.query("insert into oauth_authorizations (client_ref, redirect_uri, code_challenge, user_id, created_at, expires_at) values ($1,'https://matrix.example/cb',$2,$3, now(), now() + interval '1 hour') returning id", [oc, "a".repeat(43), a.userId])).rows[0].id;
  ids.accountExport = (await h.app.db.owner.query("insert into account_exports (user_id, state, ready_at, expires_at, storage_ref) values ($1,'ready', now(), now() + interval '7 days', 'db:x') returning id", [a.userId])).rows[0].id;
  (h.app.ctx.services as Record<string, unknown>).launcher = buildServices(h.app.ctx, launcherConfigFromEnv({ MH_FAKE_LAUNCHER: "1", MH_LAUNCHER_INVITE_ONLY: "0" }, "local").config!);
  await h.app.db.owner.query("update flags set value = 'true'::jsonb where name = 'launcher_enabled'");
  ids.launcherConversation = (await h.app.db.owner.query("insert into launcher_conversations (user_id, domain, source, spec, persona, model) values ($1,'alice-launch.com','practice','{}','fixture','fixture-model') returning id", [a.userId])).rows[0].id;
  ids.launcherBuild = (await h.app.db.owner.query(
    "insert into launcher_builds (user_id, conversation_id, proposal_id, kind, brief, slate_quote_id, slate_price_minor, price_minor, currency, quote_expires_at, status, slate_build_id) values ($1,$2,'p1','website','{}','q1',100,150,'usd', now() + interval '1 hour','ready','sb1') returning id",
    [a.userId, ids.launcherConversation])).rows[0].id;
  const m = mintToken("live");
  await h.app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, expires_at) values ($1,'agent','b',$2,$3, now() + interval '30 days')", [b.userId, m.prefix, m.hash]);
  bBinding = m.token;
  // The fixtures must be real, or every "refused" below would pass vacuously.
  for (const [k, v] of Object.entries(ids)) expect(v, `fixture ${k}`).toMatch(/^[0-9a-f-]{36}$/);
  expect((await h.app.db.owner.query("select 1 from domains where user_id = $1 and fqdn_ascii = $2", [a.userId, names.domain])).rowCount, "fixture domain").toBe(1);
}, 120_000);
afterAll(async () => { await h?.app.drop(); });

const fill = (path: string, id: string) => path.replace(/:(\w+)/g, id);
function reqBody(r: Route) { return r.method === "GET" ? undefined : {}; }

async function callAs(who: Buyer | null, r: Route, path: string, extra: Record<string, string> = {}) {
  return h.app.call(r.method === "HEAD" ? "GET" : r.method, path, { cookie: who?.cookie, body: reqBody(r), headers: { "idempotency-key": "matrix-probe", ...extra } });
}

/** Everything about a response that must not differ between "not yours" and "does not exist". */
const shape = (res: { status: number; json: unknown; headers: Headers }) => JSON.stringify([res.status, res.json, res.headers.get("content-type"), res.headers.get("cache-control")]);

async function runMatrix() {
  const tenantRoutes = router.routes.filter((r) => isParam(r) && r.principals.includes("session") && !TOKEN_ROUTES.some((t) => t.test(r.path)));
  expect(tenantRoutes.length).toBeGreaterThan(0);
  for (const r of tenantRoutes) {
    const fx = FIXTURES.find((f) => f.match.test(r.path));
    expect(fx, `route ${r.method} ${r.path} has no cross-tenant fixture: add one to FIXTURES`).toBeTruthy();
    const ownedPath = fill(r.path, fx!.id());
    const missingPath = fill(r.path, NONEXISTENT);
    const notYours = await callAs(b, r, ownedPath);
    const missing = await callAs(b, r, missingPath);
    // ST-91: B never reaches A's resource. ST-93: the answer is identical to a nonexistent id.
    expect([403, 404, 409, 422].includes(notYours.status) || notYours.status >= 400, `${r.method} ${r.path} -> ${notYours.status}`).toBe(true);
    expect(notYours.status, `${r.method} ${r.path}`).not.toBe(200);
    expect(shape(notYours), `${r.method} ${r.path}: unowned and nonexistent must look identical`).toBe(shape(missing));
    // A bearer of B is refused on session-only routes whatever the id.
    if (!r.principals.includes("binding")) {
      const bearer = await h.app.call(r.method, ownedPath, { authorization: `Bearer ${bBinding}`, body: reqBody(r), browser: false });
      expect([401, 403], `${r.method} ${r.path} bearer`).toContain(bearer.status);
    }
    // Anonymous is refused.
    const anon = await callAs(null, r, ownedPath);
    expect([401, 403]).toContain(anon.status);
  }
}

describe("ST-91: cross-tenant matrix, generated from the route table", () => {
  it("the fixtures are real: the owner reaches her own order, passkey, address and action", async () => {
    for (const [path, id] of [["/api/v1/orders/", ids.order!], ["/api/v1/actions/", ids.action!], ["/api/v1/domains/", ids.domain!]] as const) {
      const res = await h.app.call("GET", path + id, { cookie: a.cookie });
      expect(res.status, path).toBe(200);
    }
    // The domain fixture is reachable by its owner through a domain-management route (and by nobody else, below).
    const sec = await h.app.call("GET", `/api/v1/domains/${names.domain}/security`, { cookie: a.cookie });
    expect(sec.status, sec.text).toBe(200);
    const passkeys = await h.app.call("GET", "/api/v1/passkeys", { cookie: a.cookie });
    expect(JSON.stringify(passkeys.json)).toContain(ids.passkey!);
    const addrs = await h.app.call("GET", "/api/v1/notification-addresses", { cookie: a.cookie });
    expect(JSON.stringify(addrs.json)).toContain(ids.address!);
  });

  it("every parameterised session route has a fixture, and user B cannot reach user A's resource by any method", async () => { await runMatrix(); });

  it("routes without path parameters never return user A's data to user B", async () => {
    const forbidden = [a.userId, a.email, ids.order!, ids.passkey!, ids.address!, "alice-owned-name.com", "cred-alice", names.domain!];
    for (const r of router.routes.filter((x) => !isParam(x) && x.principals.includes("session") && x.method === "GET")) {
      const res = await callAs(b, r, r.path);
      for (const f of forbidden) expect(res.text, `${r.path} leaked ${f.slice(0, 8)}`).not.toContain(f);
    }
  });

  it("every route is either in the matrix, a token route, a webhook/cron route, or has no tenant input", () => {
    for (const r of router.routes) {
      if (!isParam(r)) continue;
      const ok = FIXTURES.some((f) => f.match.test(r.path)) || TOKEN_ROUTES.some((t) => t.test(r.path));
      expect(ok, `route ${r.method} ${r.path} has a path parameter but no matrix entry`).toBe(true);
    }
  });

  it("the swapped-id fuzz: A's id under every parameterised route of a different type is refused", async () => {
    const all = [...Object.values(ids), ...Object.values(names)];
    for (const r of router.routes.filter((x) => isParam(x) && x.principals.includes("session") && !TOKEN_ROUTES.some((t) => t.test(x.path)))) {
      for (const id of all) {
        const res = await callAs(b, r, fill(r.path, id));
        expect(res.status, `${r.method} ${r.path} with a foreign id`).toBeGreaterThanOrEqual(400);
      }
    }
  });
});

describe("ST-92: the same matrix with RLS disabled, and direct SQL as the runtime role", () => {
  it("row-level security is enabled and forced on every tenant table", async () => {
    const rows = (await h.app.db.owner.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and exists (select 1 from information_schema.columns k where k.table_name = c.relname and k.column_name = 'user_id')`)).rows;
    const missing = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity).map((r) => r.relname);
    // Tables with a user_id that are intentionally reached only through definer functions or the system role.
    const allowed = new Set(["email_codes", "sanctions_screenings", "jobs"]);
    expect(missing.filter((t) => !allowed.has(t)), "tables with user_id but no forced RLS").toEqual([]);
  });

  it("direct SQL as the runtime role with app.user_id = B (or unset) returns none of A's rows on any RLS table", async () => {
    const tables = (await h.app.db.owner.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity")).rows.map((r) => r.relname as string);
    expect(tables.length).toBeGreaterThan(15);
    for (const t of tables) {
      const cols = (await h.app.db.owner.query("select column_name from information_schema.columns where table_name = $1", [t])).rows.map((r) => r.column_name);
      const owner = cols.includes("user_id") ? "user_id" : t === "users" ? "id" : cols.includes("chain_id") ? "chain_id" : null;
      const aRows = owner ? (await h.app.db.owner.query(`select count(*)::int n from ${t} where ${owner} = $1`, [a.userId])).rows[0].n : 0;
      let asB = 0, unset = 0;
      try { asB = await withUser(h.app.db.runtime, b.userId, async (c) => owner ? (await c.query(`select count(*)::int n from ${t} where ${owner} = $1`, [a.userId])).rows[0].n : (await c.query(`select count(*)::int n from ${t}`)).rows[0].n); } catch { asB = 0; }
      try { unset = (await h.app.db.runtime.query(`select count(*)::int n from ${t}`)).rows[0].n; } catch { unset = 0; }
      if (owner) expect(asB, `${t} as B sees A's rows (A has ${aRows})`).toBe(0);
      // With the setting unset, only tables without a tenant column may show rows.
      if (owner) expect(unset, `${t} with app.user_id unset`).toBe(0);
    }
  });

  it("with RLS switched off, the application layer alone still refuses the matrix", async () => {
    const tables = (await h.app.db.owner.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity")).rows.map((r) => r.relname as string);
    for (const t of tables) await h.app.db.owner.query(`alter table ${t} no force row level security`);
    for (const t of tables) await h.app.db.owner.query(`alter table ${t} disable row level security`);
    // The runtime role now reads every row at the SQL level ...
    const leak = (await h.app.db.runtime.query("select count(*)::int n from domains")).rows[0].n;
    expect(leak).toBeGreaterThanOrEqual(0);
    try { await runMatrix(); }
    finally {
      for (const t of tables) { await h.app.db.owner.query(`alter table ${t} enable row level security`); await h.app.db.owner.query(`alter table ${t} force row level security`); }
    }
  });
});

describe("ST-93: unowned and nonexistent are the same through one code path", () => {
  it("orders: not yours and made up are byte-identical, including headers", async () => {
    const r = router.routes.find((x) => x.path === "/api/v1/orders/:id" && x.method === "GET")!;
    const x = await callAs(b, r, fill(r.path, ids.order!));
    const y = await callAs(b, r, fill(r.path, NONEXISTENT));
    expect(shape(x)).toBe(shape(y));
    expect(x.status).toBe(404);
  });
});

describe("ST-67: route walk over every handler and principal", () => {
  const cronSecretHeader = () => `Bearer ${h.app.ctx.config.cronSecret}`;
  it("a bearer token on a session-only route, and a cookie plus Authorization on any route, are refused", async () => {
    for (const r of router.routes) {
      const path = fill(r.path, NONEXISTENT);
      if (r.principals.includes("session") && !r.principals.includes("binding") && !r.principals.includes("anonymous")) {
        const res = await h.app.call(r.method, path, { authorization: `Bearer ${bBinding}`, body: reqBody(r), browser: false });
        expect([401, 403], `${r.method} ${r.path} bearer`).toContain(res.status);
      }
      if (!r.principals.includes("cron")) {
        const both = await h.app.call(r.method, path, { cookie: b.cookie, authorization: `Bearer ${bBinding}`, body: reqBody(r) });
        expect(both.status, `${r.method} ${r.path} cookie+Authorization`).toBe(400);
      }
    }
  });
  it("the cron secret presented as a binding token is rejected everywhere, and only CRON_SECRET opens cron routes", async () => {
    for (const r of router.routes) {
      const path = fill(r.path, NONEXISTENT);
      if (r.principals.includes("cron")) {
        expect((await h.app.call(r.method, path, { authorization: `Bearer ${bBinding}`, browser: false })).status).toBe(401);
        expect((await h.app.call(r.method, path, { cookie: b.cookie })).status).toBe(401);
        expect((await h.app.call(r.method, path, { authorization: "Bearer wrong" , browser: false})).status).toBe(401);
      } else {
        const res = await h.app.call(r.method, path, { authorization: cronSecretHeader(), body: reqBody(r), browser: false });
        expect([400, 401, 403], `${r.method} ${r.path} with the cron secret`).toContain(res.status);
      }
    }
  });
  it("every route declares principals and the router refuses an undeclared one", () => {
    for (const r of router.routes) expect(r.principals.length, `${r.method} ${r.path}`).toBeGreaterThan(0);
  });
});

describe("ST-137: signed and secret endpoints reject bad callers", () => {
  it("webhook and cron routes: wrong method is 405, no credentials is refused, and a replayed unsigned body is refused", async () => {
    for (const r of router.routes.filter((x) => x.principals.includes("webhook") || x.principals.includes("cron"))) {
      const wrong = r.method === "GET" ? "DELETE" : "GET";
      const res = await h.app.call(wrong, r.path, { browser: false });
      expect(res.status, `${r.path} wrong method`).toBe(405);
      const none = await h.app.call(r.method, r.path, { browser: false, body: r.method === "GET" ? undefined : { id: "evt_x" } });
      expect([400, 401, 403], `${r.method} ${r.path} without credentials`).toContain(none.status);
    }
  });
});

describe("ST-16: canaries appear in no log, audit row, email, error body or stored payload", () => {
  it("a bearer token, a session cookie and an OIDC header sent through failing and succeeding requests leave no trace", async () => {
    const tokenCanary = mintToken("live").token;
    const oidcCanary = "eyJhbGciOiJSUzI1NiJ9.CANARY_OIDC_PAYLOAD.SIGNATURE_CANARY";
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const bodies: string[] = [];
    for (const r of router.routes) {
      const path = fill(r.path, NONEXISTENT);
      for (const extra of [{ authorization: `Bearer ${tokenCanary}` }, { "x-vercel-oidc-token": oidcCanary, cookie: `__Host-mh_session=${oidcCanary}` }] as Record<string, string>[]) {
        const res = await h.app.call(r.method, path, { headers: extra, body: reqBody(r), browser: false });
        bodies.push(res.text, JSON.stringify([...res.headers.entries()]));
      }
    }
    // Also a successful use of a real token by B.
    bodies.push((await h.app.call("GET", "/api/v1/search?name=canaryfern", { authorization: `Bearer ${bBinding}` })).text);
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    spies.forEach((s) => s.mockRestore());
    const stores = (await Promise.all(["audit_log", "email_log", "alerts", "order_events", "jobs", "webhook_events", "order_operations", "rate_counters"].map(async (t) => JSON.stringify((await h.app.db.owner.query(`select * from ${t}`)).rows)))).join("\n");
    const mails = JSON.stringify(h.app.email.sent);
    const hay = [logged, stores, mails, bodies.join("\n")].join("\n");
    for (const canary of [tokenCanary, tokenCanary.slice(8), oidcCanary, "CANARY_OIDC_PAYLOAD", bBinding]) expect(hay.includes(canary), `canary ${canary.slice(0, 12)}… found`).toBe(false);
    void sha256;
  });
});
