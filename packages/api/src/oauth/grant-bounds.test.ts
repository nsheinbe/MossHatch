import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_ORIGIN } from "../testing/app.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { mintToken } from "../util/token.ts";
import { bearer, clearCounters, createAgentToken, makeAgentKit, makeDomain, makeOwner, mcp, stepUp, web, type AgentKit, type Owner } from "../agents/testkit.ts";

/**
 * Review of what an OAuth consent can buy. An approved consent is redeemed only by its own route (never as a plain token at
 * POST /bindings), and the grant is bound to the resource it was minted for (RFC 8707): an access token issued for /mcp is refused
 * on every other bearer route, while command-line and Bindings-tab tokens keep working there.
 */

let k: AgentKit; let ada: Owner; let dom: { id: string; fqdn: string };
beforeAll(async () => {
  k = await makeAgentKit();
  ada = await makeOwner(k, "gb-ada");
  dom = await makeDomain(k, ada, `grant-bounds-${Date.now().toString(36)}.com`);
  const put = await web(k, ada, "PUT", `/api/v1/domains/${dom.fqdn}/secrets/dev/BOUNDS_SECRET`, { value: "bounds-value" });
  expect(put.status, put.text).toBeLessThan(300);
}, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await clearCounters(k); });

const RESOURCE = `${TEST_ORIGIN}/mcp`;
const NONEXISTENT = "018f0000-0000-7000-8000-000000000000";
const pkce = () => { const verifier = crypto.randomBytes(32).toString("base64url"); return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") }; };
const form = async (path: string, params: Record<string, string>) => {
  const res = await k.app.router!.dispatch(k.app.ctx, new Request(TEST_ORIGIN + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "160.79.104.9" }, body: new URLSearchParams(params).toString() }));
  return { status: res.status, json: JSON.parse((await res.text()) || "{}") };
};
async function register(redirect: string) {
  const r = await k.app.call("POST", "/api/v1/oauth/register", { browser: false, body: { redirect_uris: [redirect], client_name: "Bounds client" } });
  expect(r.status, r.text).toBe(201);
  return r.json.client_id as string;
}
/** Authorize and open the consent screen; returns the request id (claimed by `owner`). */
async function openConsent(owner: Owner, clientId: string, redirect: string, challenge: string) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st-b", resource: RESOURCE });
  const a = await k.app.call("GET", `/api/v1/oauth/authorize?${q}`, { browser: false });
  expect(a.status, a.text).toBe(302);
  const reqId = new URL(a.headers.get("location")!).searchParams.get("oauth_request")!;
  expect((await web(k, owner, "GET", `/api/v1/oauth/requests/${reqId}`)).status).toBe(200);
  return reqId;
}

describe("ST-84 review: an approved OAuth consent cannot be redeemed as a plain token at POST /bindings", () => {
  it("refuses the consent's agent.token.create action at /bindings, mints nothing, and leaves the consent approvable by its own route", async () => {
    const redirect = "https://bounds.example/cb";
    const cid = await register(redirect);
    const p = pkce();
    const reqId = await openConsent(ada, cid, redirect, p.challenge);
    const s = await stepUp(k, ada, "agent.token.create", `oauth_${reqId}`, { name: "Consent grant", scopes: [`domains.read:${dom.fqdn}`] });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const before = (await k.app.db.owner.query("select count(*)::int n from bindings where user_id = $1", [ada.user.userId])).rows[0].n as number;
    const hijack = await web(k, ada, "POST", "/api/v1/bindings", {}, { [ACTION_HEADER]: s.actionId });
    expect([403, 409], hijack.text).toContain(hijack.status);
    expect(hijack.text).not.toMatch(/mh_live_/);
    expect(hijack.json.token).toBeUndefined();
    expect((await k.app.db.owner.query("select count(*)::int n from bindings where user_id = $1", [ada.user.userId])).rows[0].n).toBe(before);
    expect((await k.app.db.owner.query("select count(*)::int n from bindings where created_by_action_id = $1", [s.actionId])).rows[0].n).toBe(0);
    // The action was not spent: the grant the person approved is issued through its own route, bound to its client and resource.
    const ok = await web(k, ada, "POST", `/api/v1/oauth/requests/${reqId}/approve`, {}, { [ACTION_HEADER]: s.actionId });
    expect(ok.status, ok.text).toBe(200);
    const code = new URL(ok.json.redirect_to).searchParams.get("code")!;
    const t = await form("/api/v1/oauth/mcp/token", { grant_type: "authorization_code", code, code_verifier: p.verifier, client_id: cid, redirect_uri: redirect, resource: RESOURCE });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    const b = (await k.app.db.owner.query("select audience, oauth_client_id from bindings where created_by_action_id = $1", [s.actionId])).rows;
    expect(b).toHaveLength(1);
    expect(b[0].audience).toBe(RESOURCE); expect(b[0].oauth_client_id).toBeTruthy();
    // A Bindings-tab action still creates a plain token there.
    const plain = await createAgentToken(k, ada, [`domains.read:${dom.fqdn}`], { name: "Plain token" });
    expect(plain.token).toMatch(/^mh_live_/);
  });
});

describe("ST-83 review (RFC 8707): a token minted for /mcp is refused on every other bearer route", () => {
  let oauthToken = "";
  beforeAll(async () => {
    const redirect = "https://audience.example/cb";
    const cid = await register(redirect);
    const p = pkce();
    const reqId = await openConsent(ada, cid, redirect, p.challenge);
    // Broad scopes on purpose: only the audience keeps this grant off the REST routes.
    const scopes = [`domains.read:${dom.fqdn}`, `dns.read:${dom.fqdn}`, `secrets.read:${dom.fqdn}:dev`, `nest.names:${dom.fqdn}:dev`, "register.propose:*", "transfer.status:*"];
    const s = await stepUp(k, ada, "agent.token.create", `oauth_${reqId}`, { name: "Audience grant", scopes, spend_cap_minor: 100_000 });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const ok = await web(k, ada, "POST", `/api/v1/oauth/requests/${reqId}/approve`, {}, { [ACTION_HEADER]: s.actionId });
    expect(ok.status, ok.text).toBe(200);
    const code = new URL(ok.json.redirect_to).searchParams.get("code")!;
    const t = await form("/api/v1/oauth/mcp/token", { grant_type: "authorization_code", code, code_verifier: p.verifier, client_id: cid, redirect_uri: redirect, resource: RESOURCE });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    oauthToken = t.json.access_token as string;
  });

  it("the grant works on /mcp, its own resource", async () => {
    expect((await mcp(k, oauthToken, "tools/list")).status).toBe(200);
  });

  it("the secrets read route refuses it, while a Bindings-tab token and a CLI token with the same scope still read", async () => {
    const viaOauth = await bearer(k, oauthToken, "POST", `/api/v1/domains/${dom.fqdn}/secrets/dev/read`, {});
    expect(viaOauth.status, viaOauth.text).toBe(401);
    expect(viaOauth.text).not.toContain("bounds-value");
    const agent = await createAgentToken(k, ada, [`secrets.read:${dom.fqdn}:dev`], { name: "Reader" });
    const viaAgent = await bearer(k, agent.token, "POST", `/api/v1/domains/${dom.fqdn}/secrets/dev/read`, {});
    expect(viaAgent.status, viaAgent.text).toBe(200);
    const cli = mintToken("cli");
    await k.app.db.owner.query("insert into bindings (user_id, kind, name, token_prefix, token_hash, scopes, expires_at) values ($1,'cli','CLI login',$2,$3,$4, now() + interval '1 hour')",
      [ada.user.userId, cli.prefix, cli.hash, JSON.stringify([{ capability: "secrets.read", domain_id: dom.id, env: "dev", label: dom.fqdn }])]);
    const viaCli = await bearer(k, cli.token, "POST", `/api/v1/domains/${dom.fqdn}/secrets/dev/read`, {});
    expect(viaCli.status, viaCli.text).toBe(200);
    expect((await bearer(k, cli.token, "GET", "/api/v1/whoami")).status).toBe(200);
  });

  it("route walk: every route but /mcp answers the /mcp grant with 401 or 403, and every bearer route with the audience refusal", async () => {
    const routes = k.app.router!.routes.filter((r) => r.path !== "/mcp");
    expect(routes.length).toBeGreaterThan(100);
    const bearerRoutes = routes.filter((r) => r.principals.includes("binding"));
    expect(bearerRoutes.length).toBeGreaterThan(15);
    const fill = (path: string) => path.replace(/:(\w+)/g, (_m, p: string) => (p === "fqdn" ? dom.fqdn : p === "env" ? "dev" : p === "name" ? "BOUNDS_SECRET" : NONEXISTENT));
    for (const r of routes) {
      await clearCounters(k);
      const res = await bearer(k, oauthToken, r.method, fill(r.path), r.method === "GET" || r.method === "HEAD" ? undefined : {});
      expect([401, 403], `${r.method} ${r.path}: ${res.status} ${res.text.slice(0, 120)}`).toContain(res.status);
      if (r.principals.includes("binding")) {
        expect(res.status, `${r.method} ${r.path}`).toBe(401);
        expect(res.json?.error?.code, `${r.method} ${r.path}`).toBe("invalid_token");
      }
    }
    // Still alive for its own resource after the walk.
    expect((await mcp(k, oauthToken, "tools/list")).status).toBe(200);
  });
});
