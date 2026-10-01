import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callTool, clearCounters, createAgentToken, makeAgentKit, makeDomain, makeOwner, mcp, web, type AgentKit, type Owner } from "../agents/testkit.ts";

/** Independent review of the MCP endpoint: each case failed on the code as first written. */

let k: AgentKit; let ada: Owner; let dom: { id: string; fqdn: string };
beforeAll(async () => { k = await makeAgentKit(); ada = await makeOwner(k, "mcpr-ada"); dom = await makeDomain(k, ada, `mcp-review-${Date.now().toString(36)}.com`); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await clearCounters(k); });

const raw = (token: string, body: unknown) => k.app.call("POST", "/mcp", { authorization: `Bearer ${token}`, browser: false, body, headers: { "x-forwarded-for": "160.79.104.20" } });
const toolCalls = async () => (await k.app.db.owner.query("select count(*)::int n from audit_log where action = 'mcp.tool_call'")).rows[0].n as number;

describe("ST-84 review: a JSON-RPC notification never runs a request method", () => {
  it("tools/call without an id, or with a null id, runs nothing and is refused", async () => {
    const t = await createAgentToken(k, ada, ["register.propose:*"], { cap: 100_000, name: "Notifier" });
    const before = await toolCalls();
    const call = { name: "propose_registration", arguments: { domain: "notif-run-review.com" } };
    const noId = await raw(t.token, { jsonrpc: "2.0", method: "tools/call", params: call });
    expect(noId.status).toBe(400);
    const nullId = await raw(t.token, { jsonrpc: "2.0", id: null, method: "tools/call", params: call });
    expect(nullId.status).toBe(400);
    expect(nullId.json.error.code).toBe(-32600);
    expect(await toolCalls()).toBe(before);
    expect((await k.app.db.owner.query("select count(*)::int n from agent_requests where fqdn_ascii = 'notif-run-review.com'")).rows[0].n).toBe(0);
    // Real notifications are still accepted with 202 and no body.
    const n = await raw(t.token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(n.status).toBe(202);
  });
});

describe("ST-34 review: secrets_get returns the stored value exactly", () => {
  it("a value with CR, zero-width, bidi and decomposed characters round-trips unchanged", async () => {
    const value = "line1\r\nline2\u200d\u202e tail e\u0301 \u0085end";
    const put = await web(k, ada, "PUT", `/api/v1/domains/${dom.fqdn}/secrets/dev/EXACT_VALUE`, { value });
    expect(put.status, put.text).toBeLessThan(300);
    const r = await createAgentToken(k, ada, [`secrets.read:${dom.fqdn}:dev`], { name: "Exact reader" });
    const got = await callTool(k, r.token, "secrets_get", { domain: dom.fqdn, env: "dev", name: "EXACT_VALUE" });
    expect(got.isError, JSON.stringify(got)).toBe(false);
    expect(got.structuredContent.data.value).toBe(value);
    expect(JSON.parse(got.content[0]!.text.slice(got.content[0]!.text.indexOf("\n") + 1)).data.value).toBe(value);
    // Other strings in the same result are still cleaned (ST-81).
    expect(got.structuredContent.data.name).toBe("EXACT_VALUE");
  });
});

describe("ST-136 review: a burst of bad non-Mosshatch bearer tokens raises the alarm too", () => {
  it("40 JWT-shaped tokens from one range open one bearer.failure_burst alert and a valid token still works", async () => {
    const t = await createAgentToken(k, ada, [`domains.read:${dom.fqdn}`], { name: "Valid" });
    await k.app.db.owner.query("delete from alerts where kind = 'bearer.failure_burst'");
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";
    const burst = await Promise.all(Array.from({ length: 40 }, () => mcp(k, jwt, "tools/list", undefined, { "x-forwarded-for": "160.79.104.88" })));
    expect(burst.every((r) => r.status === 401)).toBe(true);
    expect((await k.app.db.owner.query("select count(*)::int n from alerts where kind = 'bearer.failure_burst'")).rows[0].n).toBe(1);
    expect((await mcp(k, t.token, "tools/list", undefined, { "x-forwarded-for": "160.79.104.88" })).status).toBe(200);
  });
});
