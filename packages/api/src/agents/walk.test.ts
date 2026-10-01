import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { mintToken } from "../util/token.ts";
import { bearer, callTool, clearCounters, createAgentToken, makeAgentKit, makeDomain, makeOwner, mcp, web, type AgentKit, type Owner } from "./testkit.ts";

/**
 * Phase 5 exit criteria: the route walk over the MCP and agent routes, and the cross-tenant matrix over bindings, approvals and
 * transfers, both generated from the route table (the shared ST-91/ST-67 suite in security/ covers every route as well).
 */

let k: AgentKit; let ada: Owner; let bob: Owner;
const A: Record<string, string> = {};
let bobAll = "", adaOther = "";
const NONEXISTENT = "018f0000-0000-7000-8000-000000000000";
const MINE = (tag?: string) => tag === "agents" || tag === "mcp" || tag === "oauth";

beforeAll(async () => {
  k = await makeAgentKit();
  ada = await makeOwner(k, "walk-ada"); bob = await makeOwner(k, "walk-bob");
  const d = await makeDomain(k, ada, `walk-ada-${Date.now().toString(36)}.com`);
  A.fqdn = d.fqdn; A.domain = d.id;
  await makeDomain(k, bob, `walk-bob-${Date.now().toString(36)}.com`);
  await web(k, ada, "PUT", `/api/v1/domains/${A.fqdn}/secrets/dev/WALK_SECRET`, { value: "walk-value" });
  const t = await createAgentToken(k, ada, ["register.propose:*", `dns.read:${A.fqdn}`, "transfer.status:*"], { cap: 1_000_000, name: "Ada bot" });
  A.binding = t.id; A.token = t.token;
  const p = await bearer(k, t.token, "POST", "/api/v1/agent/proposals", { kind: "register", domain: `free-walk-${Date.now().toString(36)}.com` });
  expect(p.status, p.text).toBe(202);
  A.request = p.json.approval_id;
  const o = (await k.app.db.owner.query("insert into orders (user_id, kind, fqdn_ascii, years, state, idempotency_key, request_hash, quote, subtotal_minor, tax_ceiling_minor, total_minor, livemode) values ($1,'transfer_in','walk-transfer.com',1,'draft','walk-t','\\x00','{}',0,0,0,false) returning id", [ada.user.userId])).rows[0];
  A.transfer = (await k.app.db.owner.query("insert into transfers_in (user_id, order_id, fqdn_ascii, tld, years, idempotency_key, request_hash) values ($1,$2,'walk-transfer.com','com',1,'walk-t','\\x00') returning id", [ada.user.userId, o.id])).rows[0].id;
  bobAll = (await createAgentToken(k, bob, ["register.propose:*", "domains.read:*", "dns.read:*", "transfer.status:*", "nest.names:*:dev", "renew.propose:*"], { cap: 1_000_000, name: "Bob bot" })).token;
  adaOther = (await createAgentToken(k, ada, ["domains.read:*"], { name: "Ada other" })).token;
}, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await clearCounters(k); });

const fill = (path: string, v: Record<string, string>) => path.replace(/:(\w+)/g, (_m, p: string) => v[p] ?? NONEXISTENT);
const shape = (r: { status: number; json: unknown; headers: Headers }) => JSON.stringify([r.status, r.json, r.headers.get("content-type"), r.headers.get("cache-control")]);

describe("route walk over the MCP and agent routes", () => {
  it("every route declares principals; /api/v1/agent is bearer only; approvals decide by session and passkey only; /mcp is POST only", async () => {
    const routes = k.app.router!.routes.filter((r) => MINE(r.tag));
    expect(routes.length).toBeGreaterThan(25);
    for (const r of routes) {
      expect(r.principals.length, `${r.method} ${r.path}`).toBeGreaterThan(0);
      if (r.path.startsWith("/api/v1/agent/")) {
        expect(r.principals).toEqual(["binding"]);
        const path = fill(r.path, { fqdn: A.fqdn!, env: "dev", name: "WALK_SECRET" });
        const cookie = await web(k, ada, r.method, path, r.method === "GET" ? undefined : {});
        expect([401, 403], `${r.method} ${r.path} with a cookie`).toContain(cookie.status);
        const anon = await k.app.call(r.method, path, { browser: false, body: r.method === "GET" ? undefined : {} });
        expect(anon.status, `${r.method} ${r.path} anonymous`).toBe(401);
      }
      if (r.stepUp) {
        expect(r.principals).toEqual(["session"]);
        const res = await web(k, ada, r.method, fill(r.path, { id: A.request! }), {});
        expect(res.status, `${r.method} ${r.path} without an action`).toBe(403);
        expect(res.json.error.code).toBe("step_up_required");
        const viaBearer = await bearer(k, A.token!, r.method, fill(r.path, { id: A.request! }), {}, { [ACTION_HEADER]: NONEXISTENT });
        expect([401, 403]).toContain(viaBearer.status);
      }
      if (r.principals.includes("session") && !r.principals.includes("binding") && !r.principals.includes("anonymous")) {
        const res = await bearer(k, A.token!, r.method, fill(r.path, { id: A.request!, fqdn: A.fqdn!, env: "dev", name: "WALK_SECRET" }), r.method === "GET" ? undefined : {});
        expect([401, 403], `${r.method} ${r.path} bearer`).toContain(res.status);
      }
    }
    for (const m of ["GET", "PUT", "DELETE", "PATCH"]) expect((await k.app.call(m, "/mcp", { browser: false, authorization: `Bearer ${A.token}` })).status, m).toBe(405);
    // The cookie-plus-Authorization rule holds on /mcp and the agent routes too.
    expect((await k.app.call("POST", "/mcp", { cookie: ada.user.cookie, authorization: `Bearer ${A.token}`, body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status).toBe(400);
  });
});

describe("cross-tenant matrix over bindings, approvals and transfers", () => {
  it("Bob's session cannot reach Ada's approval, binding or secret, and not-yours looks exactly like not-there", async () => {
    const routes = k.app.router!.routes.filter((r) => r.path.includes(":") && r.principals.includes("session") && (r.path.includes("/approvals/") || r.path.includes("/bindings/") || r.path.includes("/oauth/requests/") || r.path.includes("/transfers/") || /\/secrets\/:env\/:name\/(versions|restore)$/.test(r.path)));
    expect(routes.length).toBeGreaterThan(10);
    for (const r of routes) {
      const own = { id: r.path.includes("/bindings/") ? A.binding! : r.path.includes("/transfers/") ? A.transfer! : A.request!, fqdn: A.fqdn!, env: "dev", name: "WALK_SECRET" };
      const miss = { id: NONEXISTENT, fqdn: "nothing-here-at-all.com", env: "dev", name: "WALK_SECRET" };
      const x = await web(k, bob, r.method === "HEAD" ? "GET" : r.method, fill(r.path, own), r.method === "GET" ? undefined : {});
      const y = await web(k, bob, r.method === "HEAD" ? "GET" : r.method, fill(r.path, miss), r.method === "GET" ? undefined : {});
      expect(x.status, `${r.method} ${r.path}`).toBeGreaterThanOrEqual(400);
      expect(shape(x), `${r.method} ${r.path}: not-yours and not-there must look the same`).toBe(shape(y));
    }
    expect((await k.app.db.owner.query("select state from agent_requests where id = $1", [A.request])).rows[0].state).toBe("pending");
  });

  it("Bob's token (every scope on *) reaches none of Ada's resources over REST or MCP; Ada's other token cannot read her first token's request", async () => {
    const pairs: [string, string, unknown?][] = [
      ["GET", `/api/v1/approvals/${A.request}`], ["GET", `/api/v1/agent/domains/${A.fqdn}`], ["GET", `/api/v1/agent/domains/${A.fqdn}/dns`],
      ["GET", `/api/v1/agent/domains/${A.fqdn}/nest/dev`], ["GET", "/api/v1/agent/domains/walk-transfer.com/transfer"],
      ["POST", "/api/v1/agent/proposals", { kind: "renew", domain: A.fqdn }],
    ];
    for (const [m, path, body] of pairs) {
      const x = await bearer(k, bobAll, m, path, body);
      expect(x.status, `${m} ${path}`).toBe(404);
    }
    const missing = await bearer(k, bobAll, "GET", `/api/v1/approvals/${NONEXISTENT}`);
    const foreign = await bearer(k, bobAll, "GET", `/api/v1/approvals/${A.request}`);
    expect(shape(foreign)).toBe(shape(missing));
    for (const [tool, args] of [["get_proposal", { approval_id: A.request }], ["dns_list", { domain: A.fqdn }], ["get_domain", { domain: A.fqdn }], ["transfer_status", { domain: "walk-transfer.com" }], ["nest_names", { domain: A.fqdn, env: "dev" }]] as const) {
      const r = await callTool(k, bobAll, tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.structuredContent.error!.code, tool).toBe("not_found");
    }
    const listed = await callTool(k, bobAll, "list_domains");
    expect(JSON.stringify(listed)).not.toContain(A.fqdn);
    // Ada's own transfer is visible to her token with transfer.status:*, never with a code.
    const mine = await callTool(k, A.token!, "transfer_status", { domain: "walk-transfer.com" });
    expect(mine.structuredContent.data.transfers[0].id).toBe(A.transfer);
    expect(JSON.stringify(mine)).not.toMatch(/auth_code|authcode/i);
    // A request is visible only to the binding that made it.
    expect((await bearer(k, adaOther, "GET", `/api/v1/approvals/${A.request}`)).status).toBe(404);
    expect((await bearer(k, A.token!, "GET", `/api/v1/approvals/${A.request}`)).status).toBe(200);
    // A token that is not ours at all.
    expect((await mcp(k, mintToken("live").token, "tools/list")).status).toBe(401);
  });
});

describe("C-23: a dispute lock is part of the domain state every agent client sees", () => {
  it("get_domain and list_domains carry the lock set on registrar instruction", async () => {
    const t = await createAgentToken(k, ada, [`domains.read:${A.fqdn}`], { name: "Dispute reader" });
    await k.app.db.owner.query("update domains set dispute_lock_state = 'udrp_locked' where id = $1", [A.domain]);
    try {
      expect((await callTool(k, t.token, "get_domain", { domain: A.fqdn })).structuredContent.data.dispute_lock).toBe("udrp_locked");
      expect((await bearer(k, t.token, "GET", "/api/v1/agent/domains")).json.domains[0].dispute_lock).toBe("udrp_locked");
    } finally { await k.app.db.owner.query("update domains set dispute_lock_state = null where id = $1", [A.domain]); }
  });
});
