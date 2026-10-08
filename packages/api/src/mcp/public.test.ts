import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearCounters, createAgentToken, makeAgentKit, makeOwner, makeDomain, type AgentKit, type Owner } from "../agents/testkit.ts";
import { createLookupService, setSharedLookup } from "../lookup/http.ts";
import { fakeRdapFetch } from "../lookup/fake.ts";
import { PUBLIC_MCP_PATH } from "./public.ts";

let k: AgentKit; let ada: Owner;
beforeAll(async () => { k = await makeAgentKit(); ada = await makeOwner(k, "pub-ada"); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await clearCounters(k); });

let rpcId = 0;
async function pub(method: string, params?: Record<string, unknown>, o: { token?: string; headers?: Record<string, string>; ip?: string } = {}) {
  return k.app.call("POST", PUBLIC_MCP_PATH, {
    authorization: o.token ? `Bearer ${o.token}` : undefined, browser: false,
    body: { jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) },
    headers: { "x-forwarded-for": o.ip ?? "203.0.113.44", accept: "application/json, text/event-stream", "content-type": "application/json", ...(o.headers ?? {}) },
  });
}
const call = async (name: string, args: Record<string, unknown>, o: { ip?: string } = {}) => {
  const r = await pub("tools/call", { name, arguments: args }, o);
  expect(r.status, r.text).toBe(200);
  return r.json.result as { isError: boolean; structuredContent: { data?: any; error?: { code: string } } };
};

describe("the public MCP search: no account, two read tools", () => {
  it("answers the handshake and lists exactly search_names and get_quote; refuses a token, a foreign page and other methods", async () => {
    expect((await k.app.call("GET", PUBLIC_MCP_PATH, { browser: false })).status).toBe(405);
    const init = await pub("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } });
    expect(init.status, init.text).toBe(200);
    expect(init.json.result.serverInfo.name).toBe("mosshatch-search");
    expect(init.json.result.instructions).toContain("https://mosshatch.com/mcp");
    const list = await pub("tools/list");
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toEqual(["search_names", "get_quote"]);
    expect(list.json.result.tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint)).toBe(true);
    const t = await createAgentToken(k, ada, ["domains.read:*"]);
    expect((await pub("tools/list", undefined, { token: t.token })).status).toBe(403);
    expect((await pub("tools/list", undefined, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await pub("resources/list")).json.error.code).toBe(-32601);
    const own = await pub("tools/call", { name: "list_domains", arguments: {} });
    expect(own.json.error.message).toBe("Unknown tool");
  });

  it("shop open: the registrar answers, a free name carries a price and a buy link in the fragment, a taken one does not", async () => {
    k.h.registrar.setKind("fernpublic.com", "available");
    k.h.registrar.setKind("fernpublic.dev", "taken");
    const r = await call("search_names", { name: "fernpublic", tlds: ["com", "dev"] });
    expect(r.isError).toBe(false);
    const d = r.structuredContent.data;
    expect(d.source).toBe("registrar");
    const com = d.results.find((x: { domain: string }) => x.domain === "fernpublic.com");
    const dev = d.results.find((x: { domain: string }) => x.domain === "fernpublic.dev");
    expect(com).toMatchObject({ status: "available", buy_url: `${k.app.ctx.config.origin}/#find=fernpublic.com` });
    expect(com.price.subtotal_minor).toMatch(/^\d+$/);
    expect(dev).toMatchObject({ status: "taken", price: null, buy_url: null });
    const q = await call("get_quote", { domain: "fernpublic.com" });
    expect(q.structuredContent.data).toMatchObject({ domain: "fernpublic.com", status: "available", years: 1, currency: "usd", buy_url: `${k.app.ctx.config.origin}/#find=fernpublic.com` });
    expect(BigInt(q.structuredContent.data.max_total_minor)).toBeGreaterThanOrEqual(BigInt(q.structuredContent.data.subtotal_minor));
    expect((await call("search_names", { name: "-bad-" })).structuredContent.error?.code).toBe("bad_name");
  });

  it("the anonymous search limits apply per address: the 31st search in ten minutes is refused with a retry time", async () => {
    k.h.registrar.setKind("limitpublic.com", "available");
    for (let i = 0; i < 30; i++) expect((await call("search_names", { name: "limitpublic", tlds: ["com"] }, { ip: "203.0.113.90" })).isError).toBe(false);
    const over = await call("search_names", { name: "limitpublic", tlds: ["com"] }, { ip: "203.0.113.90" });
    expect(over.isError).toBe(true);
    expect(over.structuredContent.error).toMatchObject({ code: "rate_limited" });
    expect((await call("search_names", { name: "limitpublic", tlds: ["com"] }, { ip: "203.0.113.91" })).isError).toBe(false);
  });

  describe("invite-only shop: the registrar is never asked for an anonymous caller", () => {
    let calls = 0;
    beforeEach(() => {
      (k.app.ctx.services as { liveGate?: boolean }).liveGate = true;
      setSharedLookup(createLookupService({ fetch: async (u, i) => { calls++; return fakeRdapFetch(u, i); }, perMinute: 3, perHour: 50 }));
    });
    afterEach(() => { (k.app.ctx.services as { liveGate?: boolean }).liveGate = false; setSharedLookup(undefined); });

    it("answers from the public registries with the published price, the note and the waitlist, under the page's network limits", async () => {
      const before = k.h.registrar.calls.checkAvailability;
      const r = await call("search_names", { name: "google", tlds: ["com"] });
      expect(r.structuredContent.data).toMatchObject({ source: "public_registry", waitlist_url: `${k.app.ctx.config.origin}/waitlist` });
      expect(r.structuredContent.data.note).toContain("a few at a time");
      expect(r.structuredContent.data.results[0]).toMatchObject({ domain: "google.com", status: "taken", unconfirmed: true, buy_url: null });
      const q = await call("get_quote", { domain: "moonfernpreview.com" });
      expect(q.structuredContent.data).toMatchObject({ domain: "moonfernpreview.com", unconfirmed: true, waitlist_url: `${k.app.ctx.config.origin}/waitlist` });
      expect(k.h.registrar.calls.checkAvailability).toBe(before);
      expect(calls).toBeGreaterThan(0);
      await call("search_names", { name: "third", tlds: ["com"] });
      const limited = await call("search_names", { name: "fourth", tlds: ["com"] });
      expect(limited.structuredContent.error).toMatchObject({ code: "rate_limited" });
    });
  });
});
