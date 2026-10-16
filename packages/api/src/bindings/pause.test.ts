import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, callTool, clearCounters, createAgentToken, makeAgentKit, makeDomain, makeOwner, stepUp, web, type AgentKit, type Owner } from "../agents/testkit.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";

let k: AgentKit; let ada: Owner; let bob: Owner; let dom: { id: string; fqdn: string };
beforeAll(async () => { k = await makeAgentKit(); ada = await makeOwner(k, "pause-ada"); bob = await makeOwner(k, "pause-bob"); dom = await makeDomain(k, ada, `pause-${Date.now().toString(36)}.com`); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await clearCounters(k); });

describe("pause and resume a token", () => {
  it("pause stops it at once with one click; resume needs the passkey and its summary says Resume; activity names the domain and the tool", async () => {
    const scopes = [`domains.read:${dom.fqdn}`];
    const t = await createAgentToken(k, ada, scopes, { name: "Claude" });
    expect((await bearer(k, t.token, "GET", "/api/v1/agent/domains")).status).toBe(200);
    expect((await callTool(k, t.token, "get_domain", { domain: dom.fqdn })).isError).toBe(false);

    expect((await web(k, bob, "POST", `/api/v1/bindings/${t.id}/pause`)).status).toBe(404);
    const p = await web(k, ada, "POST", `/api/v1/bindings/${t.id}/pause`);
    expect(p.status, p.text).toBe(200);
    expect(p.json.binding.paused).toBe(true);
    const refused = await bearer(k, t.token, "GET", "/api/v1/agent/domains");
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("binding_paused");
    expect((await web(k, ada, "POST", `/api/v1/bindings/${t.id}/pause`)).status).toBe(200);   // pausing twice is harmless

    const s = await stepUp(k, ada, "agent.token.widen", t.id, { scopes });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.summary).toBe(`Resume the token "Claude". It can again: domains.read:${dom.fqdn}.`);
    const r = await web(k, ada, "POST", `/api/v1/bindings/${t.id}/widen`, {}, { [ACTION_HEADER]: s.actionId });
    expect(r.status, r.text).toBe(200);
    expect(r.json.binding.paused).toBe(false);
    expect((await bearer(k, t.token, "GET", "/api/v1/agent/domains")).status).toBe(200);

    // A change that is more than a resume still reads as a change.
    const more = await stepUp(k, ada, "agent.token.widen", t.id, { scopes: [...scopes, `dns.read:${dom.fqdn}`] });
    expect(more.summary).toMatch(/^Change the token "Claude"/);

    const act = await web(k, ada, "GET", `/api/v1/bindings/${t.id}/activity`);
    expect(act.status, act.text).toBe(200);
    const rows = act.json.activity as { action: string; domain: string | null; op: string | null; outcome: string | null }[];
    expect(rows.some((a) => a.action === "binding.paused")).toBe(true);
    expect(rows.some((a) => a.action === "mcp.tool_call" && a.op === "get_domain" && a.outcome === "ok")).toBe(true);
    expect(rows.some((a) => a.action === "agent.call" && a.op === "list_domains")).toBe(true);
  });
});
