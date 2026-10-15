import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_ORIGIN } from "../testing/app.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { DAY } from "../bindings/tokens.ts";
import { bearer, callTool, clearCounters, createAgentToken, makeAgentKit, makeDomain, makeOwner, mcp, stepUp, web, type AgentKit, type Owner } from "../agents/testkit.ts";

let k: AgentKit; let owner: Owner; let domain: { id: string; fqdn: string }; let initialTime: Date;
beforeAll(async () => { k = await makeAgentKit(); initialTime = k.app.clock.now(); owner = await makeOwner(k, "grant-security"); domain = await makeDomain(k, owner, `grant-security-${Date.now().toString(36)}.com`); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { k.app.clock.set(initialTime); await clearCounters(k); });
const RESOURCE = `${TEST_ORIGIN}/mcp`;
const TOKEN = "/api/v1/oauth/mcp/token";
const read = () => `dns.read:${domain.fqdn}`;
const form = async (params: Record<string, string>) => {
  const r = await k.app.router!.dispatch(k.app.ctx, new Request(TEST_ORIGIN + TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "160.79.104.9" }, body: new URLSearchParams(params).toString() }));
  return { status: r.status, json: await r.json() as Record<string, any> };
};
async function grant() {
  const redirect = "https://grant-security.example/cb";
  const client = await k.app.call("POST", "/api/v1/oauth/register", { browser: false, body: { redirect_uris: [redirect] } });
  expect(client.status, client.text).toBe(201);
  const clientId = client.json.client_id as string;
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const auth = await k.app.call("GET", "/api/v1/oauth/authorize?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE }), { browser: false });
  const id = new URL(auth.headers.get("location")!).searchParams.get("oauth_request")!;
  expect((await web(k, owner, "GET", `/api/v1/oauth/requests/${id}`)).status).toBe(200);
  const s = await stepUp(k, owner, "agent.token.create", `oauth_${id}`, { name: "Security grant", scopes: [read()] });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  const approved = await web(k, owner, "POST", `/api/v1/oauth/requests/${id}/approve`, {}, { [ACTION_HEADER]: s.actionId });
  expect(approved.status, approved.text).toBe(200);
  const code = new URL(approved.json.redirect_to).searchParams.get("code")!;
  const exchanged = await form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect, resource: RESOURCE });
  expect(exchanged.status, JSON.stringify(exchanged.json)).toBe(200);
  const row = (await k.app.db.owner.query("select binding_id from oauth_authorizations where id = $1", [id])).rows[0];
  return { bindingId: row.binding_id as string, clientId, code, verifier, redirect, access: exchanged.json.access_token as string, refresh: exchanged.json.refresh_token as string };
}
const refresh = (g: Awaited<ReturnType<typeof grant>>, extra: Record<string, string> = {}) => form({ grant_type: "refresh_token", refresh_token: g.refresh, client_id: g.clientId, ...extra });
const binding = async (id: string) => (await k.app.db.owner.query("select * from bindings where id = $1", [id])).rows[0];

describe("ST-71 ST-84: OAuth grant lifetime and replay boundaries", () => {
  it("checks the refresh audience and refuses unapproved or narrowed scope requests without consuming the token", async () => {
    const g = await grant();
    const wrongResource = await refresh(g, { resource: "https://other.example/mcp" });
    expect(wrongResource).toMatchObject({ status: 400, json: { error: "invalid_target" } });
    for (const scope of [`${read()} dns.write:${domain.fqdn}`, ""]) expect(await refresh(g, { scope })).toMatchObject({ status: 400, json: { error: "invalid_scope" } });
    expect((await binding(g.bindingId)).scopes).toHaveLength(1);
    expect((await refresh(g, { resource: RESOURCE, scope: read() })).status).toBe(200);
  });

  it("a leaked redeemed code without the original PKCE verifier cannot revoke the owner's grant", async () => {
    const g = await grant();
    const bad = await form({ grant_type: "authorization_code", code: g.code, code_verifier: crypto.randomBytes(32).toString("base64url"), client_id: g.clientId, redirect_uri: g.redirect });
    expect(bad).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
    expect((await mcp(k, g.access, "tools/list")).status).toBe(200);
    const replay = await form({ grant_type: "authorization_code", code: g.code, code_verifier: g.verifier, client_id: g.clientId, redirect_uri: g.redirect });
    expect(replay.status).toBe(400);
    expect((await mcp(k, g.access, "tools/list")).status).toBe(401);
  });

  it("owner-approved expiry changes extend the OAuth grant while keeping its access token short-lived", async () => {
    const g = await grant();
    const before = await binding(g.bindingId);
    const s = await stepUp(k, owner, "agent.token.widen", g.bindingId, { scopes: [read()], expires_in_days: 60 });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const changed = await web(k, owner, "POST", `/api/v1/bindings/${g.bindingId}/widen`, {}, { [ACTION_HEADER]: s.actionId });
    expect(changed.status, changed.text).toBe(200);
    const after = await binding(g.bindingId);
    expect(new Date(after.expires_at).getTime()).toBe(new Date(before.expires_at).getTime());
    expect(new Date(after.family_expires_at).getTime()).toBe(k.app.clock.now().getTime() + 60 * DAY);
    expect((await web(k, owner, "POST", `/api/v1/bindings/${g.bindingId}/widen`, {}, { [ACTION_HEADER]: s.actionId })).status).toBe(403);
    k.app.clock.advance(61 * 60_000);
    expect((await mcp(k, g.access, "tools/list")).status).toBe(401);
    const fresh = await refresh(g);
    expect(fresh.status, JSON.stringify(fresh.json)).toBe(200);
    expect(fresh.json.expires_in).toBeLessThanOrEqual(3600);
  });

  it("a changed grant expiry invalidates an already approved widening even if the access token is unchanged", async () => {
    const g = await grant();
    const s = await stepUp(k, owner, "agent.token.widen", g.bindingId, { scopes: [read(), `domains.read:${domain.fqdn}`] });
    expect(s.status).toBe(200);
    const narrowed = await web(k, owner, "PATCH", `/api/v1/bindings/${g.bindingId}`, { expires_in_days: 1 });
    expect(narrowed.status, narrowed.text).toBe(200);
    const changed = await web(k, owner, "POST", `/api/v1/bindings/${g.bindingId}/widen`, {}, { [ACTION_HEADER]: s.actionId });
    expect(changed.status, changed.text).toBe(409);
    expect((await binding(g.bindingId)).scopes).toHaveLength(1);
  });

  it("an expired shortened grant cannot rotate its originally longer-lived refresh token", async () => {
    const g = await grant();
    expect((await web(k, owner, "PATCH", `/api/v1/bindings/${g.bindingId}`, { expires_in_days: 1 })).status).toBe(200);
    k.app.clock.advance(DAY + 1);
    expect(await refresh(g)).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
    expect((await mcp(k, g.access, "tools/list")).status).toBe(401);
    const tokens = (await k.app.db.owner.query("select rotated_at from oauth_refresh_tokens where binding_id = $1", [g.bindingId])).rows;
    expect(tokens).toHaveLength(1); expect(tokens[0].rotated_at).toBeNull();
  });
});

describe("ST-64 ST-83: explicit incremental consent and serial grant changes", () => {
  it("ST-64: an invalid wildcard nameserver grant cannot become valid through a free narrowing", async () => {
    const g = await createAgentToken(k, owner, [read()]);
    // Simulate malformed historical storage; owner APIs cannot create wildcard nameserver access.
    await k.app.db.owner.query("update bindings set scopes = scopes || $2::jsonb where id = $1", [g.id, JSON.stringify([{ capability: "nameservers.propose", domain_id: "*", env: null, label: "*" }])]);
    const wanted = `nameservers.propose:${domain.fqdn}`;
    const patched = await web(k, owner, "PATCH", `/api/v1/bindings/${g.id}`, { scopes: [read(), wanted] });
    expect(patched.status, patched.text).toBe(403);
    expect(patched.json.error.code).toBe("step_up_required");
    const request = await bearer(k, g.token, "POST", "/api/v1/agent/scope-requests", { scopes: [wanted] });
    expect(request.status, request.text).toBe(202);
    expect(request.json.status).toBe("pending_human_approval");
    expect((await binding(g.id)).scopes.some((s: { capability: string; domain_id: string }) => s.capability === "nameservers.propose" && s.domain_id === domain.id)).toBe(false);
  });

  it("OAuth scope refusals advertise exactly the optional domain write scope and leave the grant unchanged", async () => {
    const g = await grant();
    const response = await mcp(k, g.access, "tools/call", { name: "dns_upsert", arguments: { domain: domain.fqdn, records: [{ type: "A", name: "www", value: "192.0.2.10" }] } });
    expect(response.status, response.text).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(response.headers.get("www-authenticate")).toContain(`scope="dns.write:${domain.fqdn}"`);
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${TEST_ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect((await binding(g.bindingId)).scopes).toHaveLength(1);
    expect(response.text).not.toContain(g.access);
    expect(response.text).not.toContain(g.refresh);
  });

  it("request_scope is discoverable to read-only agents and repeated requests cannot silently grant write access", async () => {
    const g = await createAgentToken(k, owner, [read()]);
    const list = await mcp(k, g.token, "tools/list");
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toContain("request_scope");
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).not.toContain("dns_upsert");
    const wanted = { scopes: [`dns.write:${domain.fqdn}`] };
    const first = await callTool(k, g.token, "request_scope", wanted);
    const again = await callTool(k, g.token, "request_scope", wanted);
    expect(first.structuredContent.data.status).toBe("pending_human_approval");
    expect(again.structuredContent.data.approval_id).toBe(first.structuredContent.data.approval_id);
    const refusal = await bearer(k, g.token, "POST", `/api/v1/agent/domains/${domain.fqdn}/dns`, { records: [{ type: "A", name: "prod", value: "192.0.2.10" }] });
    expect(refusal.status).toBe(403);
    expect((await binding(g.id)).scopes).toHaveLength(1);
    const other = await createAgentToken(k, owner, [read()]);
    expect((await bearer(k, other.token, "GET", `/api/v1/approvals/${first.structuredContent.data.approval_id}`)).status).toBe(404);
    const cancel = await web(k, owner, "POST", `/api/v1/approvals/${first.structuredContent.data.approval_id}/decline`);
    expect(cancel.status, cancel.text).toBe(200);
    expect((await web(k, owner, "POST", `/api/v1/approvals/${first.structuredContent.data.approval_id}/decline`)).status).toBe(409);
    expect((await binding(g.id)).scopes).toHaveLength(1);
  });

  it("concurrent free narrowings cannot reintroduce a capability removed by the first update", async () => {
    const g = await createAgentToken(k, owner, [read(), `domains.read:${domain.fqdn}`]);
    const c = await k.app.db.owner.connect();
    let pending: Promise<unknown>[] = [];
    try {
      await c.query("begin");
      await c.query("select id from bindings where id = $1 for update", [g.id]);
      pending = [read(), `domains.read:${domain.fqdn}`].map((scope) => web(k, owner, "PATCH", `/api/v1/bindings/${g.id}`, { scopes: [scope] }));
      await vi.waitFor(async () => {
        const waiting = await k.app.db.owner.query("select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%bindings%'");
        expect(waiting.rows[0].n).toBeGreaterThanOrEqual(2);
      }, { timeout: 5000 });
      await c.query("commit");
      const result = await Promise.all(pending) as { status: number; text: string }[];
      expect(result.map((r) => r.status).sort()).toEqual([200, 403]);
    } finally { await c.query("rollback"); c.release(); await Promise.allSettled(pending); }
    expect((await binding(g.id)).scopes).toHaveLength(1);
  });
});
