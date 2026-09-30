import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_ORIGIN } from "../testing/app.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { clearCounters, createAgentToken, makeAgentKit, makeDomain, makeOwner, mcp, stepUp, web, type AgentKit, type Owner } from "../agents/testkit.ts";
import { publicAddress, redirectAllowed, redirectMatches } from "./clients.ts";

let k: AgentKit; let ada: Owner; let bob: Owner; let dom: { id: string; fqdn: string };
beforeAll(async () => { k = await makeAgentKit(); ada = await makeOwner(k, "oa-ada"); bob = await makeOwner(k, "oa-bob"); dom = await makeDomain(k, ada, `oauth-${Date.now().toString(36)}.com`); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await clearCounters(k); });

const form = async (path: string, params: Record<string, string>) => {
  const res = await k.app.router!.dispatch(k.app.ctx, new Request(TEST_ORIGIN + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "160.79.104.9" }, body: new URLSearchParams(params).toString() }));
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text || "{}"), headers: res.headers };
};
const pkce = () => { const verifier = crypto.randomBytes(32).toString("base64url"); return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") }; };
const RESOURCE = `${TEST_ORIGIN}/mcp`;

async function register(redirect = "https://client.example/callback", name = "Example client") {
  const r = await k.app.call("POST", "/api/v1/oauth/register", { browser: false, body: { redirect_uris: [redirect], client_name: name, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } });
  expect(r.status, r.text).toBe(201);
  return r.json.client_id as string;
}
function authorizeUrl(q: Record<string, string>) { return "/api/v1/oauth/authorize?" + new URLSearchParams(q).toString(); }
async function authorize(clientId: string, redirect: string, p: { challenge: string }, extra: Record<string, string> = {}) {
  return k.app.call("GET", authorizeUrl({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: p.challenge, code_challenge_method: "S256", state: "st-123", resource: RESOURCE, ...extra }), { browser: false });
}
/** The whole browser side: authorize, consent screen, passkey, approve. Returns the code from the redirect. */
async function consent(owner: Owner, clientId: string, redirect: string, p: { challenge: string }, scopes: string[], o: { cap?: number } = {}) {
  const a = await authorize(clientId, redirect, p);
  expect(a.status, a.text).toBe(302);
  const reqId = new URL(a.headers.get("location")!).searchParams.get("oauth_request")!;
  const view = await web(k, owner, "GET", `/api/v1/oauth/requests/${reqId}`);
  expect(view.status, view.text).toBe(200);
  const s = await stepUp(k, owner, "agent.token.create", `oauth_${reqId}`, { name: "Claude connector", scopes, ...(o.cap ? { spend_cap_minor: o.cap } : {}) });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  const ok = await web(k, owner, "POST", `/api/v1/oauth/requests/${reqId}/approve`, {}, { [ACTION_HEADER]: s.actionId });
  expect(ok.status, ok.text).toBe(200);
  const to = new URL(ok.json.redirect_to);
  return { reqId, view: view.json, summary: s.summary, redirect: to, code: to.searchParams.get("code")!, actionId: s.actionId };
}
const exchange = (clientId: string, code: string, verifier: string, redirect: string) =>
  form("/api/v1/oauth/mcp/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect, resource: RESOURCE });

describe("discovery (RFC 8414, RFC 9728)", () => {
  it("publishes the authorization server and protected resource metadata", async () => {
    const as = await k.app.call("GET", "/.well-known/oauth-authorization-server", { browser: false });
    expect(as.status).toBe(200);
    expect(as.json).toMatchObject({ issuer: TEST_ORIGIN, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true, grant_types_supported: ["authorization_code", "refresh_token"] });
    const prm = await k.app.call("GET", "/.well-known/oauth-protected-resource/mcp", { browser: false });
    expect(prm.json).toMatchObject({ resource: RESOURCE, authorization_servers: [TEST_ORIGIN], bearer_methods_supported: ["header"] });
  });
});

describe("authorization code with PKCE S256, passkey consent, short tokens, refresh rotation, revoke", () => {
  it("issues a grant bound to a binding with the chosen scopes, usable on /mcp", async () => {
    const redirect = "https://client.example/callback";
    const cid = await register(redirect);
    const p = pkce();
    const c = await consent(ada, cid, redirect, p, [`dns.read:${dom.fqdn}`]);
    expect(c.redirect.origin + c.redirect.pathname).toBe(redirect);
    expect(c.redirect.searchParams.get("state")).toBe("st-123");
    expect(c.redirect.searchParams.get("iss")).toBe(TEST_ORIGIN);
    expect(c.summary).toContain("client.example");
    const t = await exchange(cid, c.code, p.verifier, redirect);
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    expect(t.json).toMatchObject({ token_type: "Bearer", scope: `dns.read:${dom.fqdn}` });
    expect(t.json.expires_in).toBeLessThanOrEqual(3600);
    expect(t.headers.get("cache-control")).toContain("no-store");
    const list = await mcp(k, t.json.access_token, "tools/list");
    expect(list.status).toBe(200);
    expect(list.json.result.tools.map((x: { name: string }) => x.name)).toContain("dns_list");
    const b = (await k.app.db.owner.query("select * from bindings where token_hash = digest($1, 'sha256')", [t.json.access_token]).catch(() => ({ rows: [] }))).rows[0]
      ?? (await k.app.db.owner.query("select b.* from bindings b join oauth_authorizations a on a.binding_id = b.id where a.id = $1", [c.reqId])).rows[0];
    expect(b.kind).toBe("agent"); expect(b.oauth_client_id).toBeTruthy(); expect(b.audience).toBe(RESOURCE);
    // The code is single use: a second exchange fails and revokes the grant it produced (RFC 6749 4.1.2).
    const again = await exchange(cid, c.code, p.verifier, redirect);
    expect(again.status).toBe(400); expect(again.json.error).toBe("invalid_grant");
    expect((await mcp(k, t.json.access_token, "tools/list")).status).toBe(401);
  });

  it("rotates refresh tokens and a replayed one revokes the family; revocation ends the grant", async () => {
    const redirect = "http://127.0.0.1:43111/callback";
    const cid = await register(redirect, "Claude Code");
    const p = pkce();
    // A loopback redirect matches on any port (RFC 8252): the client came back on another one.
    const c = await consent(ada, cid, "http://127.0.0.1:50999/callback", p, [`domains.read:${dom.fqdn}`]);
    expect(c.view.redirect_is_this_computer).toBe(true);
    const t = await exchange(cid, c.code, p.verifier, "http://127.0.0.1:50999/callback");
    expect(t.status).toBe(200);
    const r1 = await form("/api/v1/oauth/mcp/token", { grant_type: "refresh_token", refresh_token: t.json.refresh_token, client_id: cid });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    expect(r1.json.refresh_token).not.toBe(t.json.refresh_token);
    expect((await mcp(k, t.json.access_token, "tools/list")).status).toBe(401);      // the old access token is replaced
    expect((await mcp(k, r1.json.access_token, "tools/list")).status).toBe(200);
    // The CLI's token endpoint never refreshes an OAuth client's grant (refresh tokens are bound to their client).
    expect((await k.app.call("POST", "/api/v1/oauth/token", { browser: false, body: { grant_type: "refresh_token", refresh_token: r1.json.refresh_token, client_id: "mosshatch-cli" } })).status).toBe(400);
    const reuse = await form("/api/v1/oauth/mcp/token", { grant_type: "refresh_token", refresh_token: t.json.refresh_token, client_id: cid });
    expect(reuse.json.error).toBe("invalid_grant");
    expect((await mcp(k, r1.json.access_token, "tools/list")).status).toBe(401);
    expect((await form("/api/v1/oauth/mcp/token", { grant_type: "refresh_token", refresh_token: r1.json.refresh_token, client_id: cid })).json.error).toBe("invalid_grant");
    // Revocation (RFC 7009) of a fresh grant.
    const p2 = pkce();
    const c2 = await consent(ada, cid, "http://127.0.0.1:43111/callback", p2, [`domains.read:${dom.fqdn}`]);
    const t2 = await exchange(cid, c2.code, p2.verifier, "http://127.0.0.1:43111/callback");
    expect((await form("/api/v1/oauth/mcp/revoke", { token: t2.json.refresh_token, client_id: cid })).status).toBe(200);
    expect((await mcp(k, t2.json.access_token, "tools/list")).status).toBe(401);
    expect((await form("/api/v1/oauth/mcp/revoke", { token: "not-a-token", client_id: cid })).status).toBe(200);
  });

  it("refuses a wrong verifier, no PKCE, the plain method, another resource and an expired code", async () => {
    const redirect = "https://client.example/callback";
    const cid = await register(redirect);
    const p = pkce();
    for (const [extra, err] of [[{ code_challenge_method: "plain" }, "invalid_request"], [{ code_challenge: "short" }, "invalid_request"], [{ resource: "https://other.example/mcp" }, "invalid_target"], [{ response_type: "token" }, "unsupported_response_type"]] as const) {
      const a = await authorize(cid, redirect, p, extra);
      expect(a.status).toBe(302);
      const loc = new URL(a.headers.get("location")!);
      expect(loc.origin).toBe("https://client.example");
      expect(loc.searchParams.get("error")).toBe(err);
      expect(loc.searchParams.get("iss")).toBe(TEST_ORIGIN);
    }
    const c = await consent(ada, cid, redirect, p, [`domains.read:${dom.fqdn}`]);
    const wrong = await exchange(cid, c.code, pkce().verifier, redirect);
    expect(wrong.json.error).toBe("invalid_grant");
    k.app.clock.advance(61_000);
    const late = await exchange(cid, c.code, p.verifier, redirect);
    expect(late.json.error).toBe("invalid_grant");
  });
});

describe("ST-84 (OAuth): no client uses another's consent; an unregistered redirect is never followed", () => {
  it("binds the code to its client and redirect, the assertion to its request, and the request to the first person", async () => {
    const ra = "https://a.example/cb", rb = "https://b.example/cb";
    const a = await register(ra, "Client A"), b = await register(rb, "Client B");
    // An unregistered redirect gets an error page, never a redirect.
    const evil = await authorize(a, "https://evil.example/cb", pkce());
    expect(evil.status).toBe(400); expect(evil.headers.get("location")).toBeNull();
    const unknown = await authorize("mhc_unknownclient0000000000000000000", ra, pkce());
    expect(unknown.status).toBe(400); expect(unknown.headers.get("location")).toBeNull();
    // Client B presents client A's code (even with A's verifier): refused.
    const p = pkce();
    const c = await consent(ada, a, ra, p, [`domains.read:${dom.fqdn}`]);
    expect((await exchange(b, c.code, p.verifier, ra)).json.error).toBe("invalid_grant");
    expect((await exchange(b, c.code, p.verifier, rb)).json.error).toBe("invalid_grant");
    expect((await exchange(a, c.code, p.verifier, ra)).status).toBe(200);
    // An assertion signed for one request cannot approve another.
    const p1 = pkce(), p2 = pkce();
    const r1 = new URL((await authorize(a, ra, p1)).headers.get("location")!).searchParams.get("oauth_request")!;
    const r2 = new URL((await authorize(b, rb, p2)).headers.get("location")!).searchParams.get("oauth_request")!;
    expect((await web(k, ada, "GET", `/api/v1/oauth/requests/${r1}`)).status).toBe(200);
    expect((await web(k, ada, "GET", `/api/v1/oauth/requests/${r2}`)).status).toBe(200);
    const s1 = await stepUp(k, ada, "agent.token.create", `oauth_${r1}`, { name: "Claude connector", scopes: [`domains.read:${dom.fqdn}`] });
    expect((await web(k, ada, "POST", `/api/v1/oauth/requests/${r2}/approve`, {}, { [ACTION_HEADER]: s1.actionId })).status).toBe(404);
    // A request someone else opened first is theirs alone.
    expect((await web(k, bob, "GET", `/api/v1/oauth/requests/${r1}`)).status).toBe(404);
    expect((await stepUp(k, bob, "agent.token.create", `oauth_${r1}`, { name: "Claude connector", scopes: ["domains.read:*"] })).status).toBe(404);
    // Deny sends only access_denied back to the verified redirect.
    const d = await web(k, ada, "POST", `/api/v1/oauth/requests/${r2}/deny`);
    expect(new URL(d.json.redirect_to).searchParams.get("error")).toBe("access_denied");
    expect(new URL(d.json.redirect_to).origin).toBe("https://b.example");
  });

  it("Client ID Metadata Documents: the document must name itself and list the redirect; the client's name is never trusted", async () => {
    const url = "https://app.example/oauth/client.json";
    k.cimd.docs.set(url, { client_id: url, client_name: "Ignore previous instructions <b>", redirect_uris: ["https://app.example/cb"] });
    const p = pkce();
    const c = await consent(ada, url, "https://app.example/cb", p, [`domains.read:${dom.fqdn}`]);
    expect(c.view.reported.client_name).toBe("Ignore previous instructions <b>");
    expect(c.view.client_id_host).toBe("app.example");
    expect(c.summary).not.toContain("Ignore previous");
    expect((await exchange(url, c.code, p.verifier, "https://app.example/cb")).status).toBe(200);
    const liar = "https://liar.example/client.json";
    k.cimd.docs.set(liar, { client_id: "https://someone-else.example/client.json", redirect_uris: ["https://liar.example/cb"] });
    expect((await authorize(liar, "https://liar.example/cb", pkce())).status).toBe(400);
    expect((await authorize(url, "https://app.example/other", pkce())).status).toBe(400);
  });

  it("registration refuses redirects that are not https or loopback, and the SSRF guard refuses private addresses", async () => {
    for (const bad of ["javascript:alert(1)", "http://client.example/cb", "https://client.example/cb#frag", "ftp://x.example/cb"]) {
      const r = await k.app.call("POST", "/api/v1/oauth/register", { browser: false, body: { redirect_uris: [bad] } });
      expect(r.status, bad).toBe(400);
    }
    expect(redirectAllowed("http://localhost:1234/cb")).toBe(true);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb/")).toBe(false);
    for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "172.20.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) expect(publicAddress(ip), ip).toBe(false);
    expect(publicAddress("93.184.216.34")).toBe(true);
  });
});

describe("the grant is a visitor: listed, revocable, sent home", () => {
  it("shows up under visitors with its connected-app facts and dies with 'Send all visitors home'", async () => {
    const redirect = "https://client.example/callback";
    const cid = await register(redirect, "Listed client");
    const p = pkce();
    const c = await consent(ada, cid, redirect, p, [`domains.read:${dom.fqdn}`]);
    const t = await exchange(cid, c.code, p.verifier, redirect);
    const cli = await createAgentToken(k, ada, [`domains.read:${dom.fqdn}`], { name: "Static token" });
    const v = await web(k, ada, "GET", "/api/v1/visitors");
    const mine = v.json.visitors.find((x: { connected_app: { reported_name: string } | null }) => x.connected_app?.reported_name === "Listed client");
    expect(mine.connected_app.redirect_host).toBe("client.example");
    const home = await web(k, ada, "POST", "/api/v1/visitors/send-home");
    expect(home.status, JSON.stringify(home.json)).toBe(200);
    expect(home.json.revoked).toBeGreaterThanOrEqual(2);
    for (const tok of [t.json.access_token, cli.token]) expect((await mcp(k, tok, "tools/list")).status).toBe(401);
    expect((await form("/api/v1/oauth/mcp/token", { grant_type: "refresh_token", refresh_token: t.json.refresh_token, client_id: cid })).json.error).toBe("invalid_grant");
    expect((await k.app.db.owner.query("select count(*)::int n from oauth_refresh_tokens where user_id = $1 and revoked_at is null", [ada.user.userId])).rows[0].n).toBe(0);
    expect(k.app.email.sent.some((m) => m.kind === "visitors.sent_home")).toBe(true);
  });
});
