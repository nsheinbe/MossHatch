import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import dns from "node:dns";
import dnsP from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_ORIGIN } from "../testing/app.ts";
import { ACTION_HEADER } from "../stepup/gate.ts";
import { mintToken } from "../util/token.ts";
import { clearCounters, makeAgentKit, makeDomain, makeOwner, mcp, stepUp, web, type AgentKit, type Owner } from "../agents/testkit.ts";
import { publicAddress, SafeMetadataFetcher } from "./clients.ts";

/** Independent review of the OAuth authorization server: each case failed on the code as first written. */

let k: AgentKit; let ada: Owner; let dom: { id: string; fqdn: string };
beforeAll(async () => { k = await makeAgentKit(); ada = await makeOwner(k, "oar-ada"); dom = await makeDomain(k, ada, `oauth-review-${Date.now().toString(36)}.com`); }, 120_000);
afterAll(async () => { await k?.drop(); });
beforeEach(async () => { await clearCounters(k); });
afterEach(() => { vi.restoreAllMocks(); });

const form = async (path: string, params: Record<string, string>, ip = "160.79.104.9") => {
  const res = await k.app.router!.dispatch(k.app.ctx, new Request(TEST_ORIGIN + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body: new URLSearchParams(params).toString() }));
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text || "{}"), headers: res.headers };
};
const pkce = () => { const verifier = crypto.randomBytes(32).toString("base64url"); return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") }; };
const RESOURCE = `${TEST_ORIGIN}/mcp`;
const TOKEN = "/api/v1/oauth/mcp/token";

async function register(redirect: string, name = "Review client") {
  const r = await k.app.call("POST", "/api/v1/oauth/register", { browser: false, body: { redirect_uris: [redirect], client_name: name } });
  expect(r.status, r.text).toBe(201);
  return r.json.client_id as string;
}
const authorizeUrl = (q: Record<string, string>) => "/api/v1/oauth/authorize?" + new URLSearchParams(q).toString();
const authorize = (clientId: string, redirect: string, p: { challenge: string }, ip = "198.51.100.7") =>
  k.app.call("GET", authorizeUrl({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: p.challenge, code_challenge_method: "S256", state: "st-1", resource: RESOURCE }), { browser: false, headers: { "x-forwarded-for": ip } });
async function consent(clientId: string, redirect: string, p: { challenge: string }, scopes: string[]) {
  const a = await authorize(clientId, redirect, p);
  expect(a.status, a.text).toBe(302);
  const reqId = new URL(a.headers.get("location")!).searchParams.get("oauth_request")!;
  const view = await web(k, ada, "GET", `/api/v1/oauth/requests/${reqId}`);
  expect(view.status, view.text).toBe(200);
  const s = await stepUp(k, ada, "agent.token.create", `oauth_${reqId}`, { name: "Review connector", scopes });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  const ok = await web(k, ada, "POST", `/api/v1/oauth/requests/${reqId}/approve`, {}, { [ACTION_HEADER]: s.actionId });
  expect(ok.status, ok.text).toBe(200);
  return { reqId, view: view.json, code: new URL(ok.json.redirect_to).searchParams.get("code")! };
}
const exchange = (clientId: string, code: string, verifier: string, redirect: string, ip?: string) =>
  form(TOKEN, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect, resource: RESOURCE }, ip);

describe("ST-84 review: an authorization code is single use even when presented concurrently", () => {
  it("one exchange wins, and the grant it produced is revoked because the code was used more than once", async () => {
    const redirect = "https://race.example/cb";
    const cid = await register(redirect);
    for (let round = 0; round < 3; round++) {
      const p = pkce();
      const c = await consent(cid, redirect, p, [`domains.read:${dom.fqdn}`]);
      const all = await Promise.all(Array.from({ length: 6 }, () => exchange(cid, c.code, p.verifier, redirect)));
      const won = all.filter((r) => r.status === 200);
      expect(won.length).toBe(1);
      for (const r of all) if (r.status !== 200) expect(r.json.error).toBe("invalid_grant");
      // RFC 6749 4.1.2: a code used more than once revokes what it issued, whichever request lost the race.
      expect((await mcp(k, won[0]!.json.access_token, "tools/list")).status).toBe(401);
      expect((await form(TOKEN, { grant_type: "refresh_token", refresh_token: won[0]!.json.refresh_token, client_id: cid })).json.error).toBe("invalid_grant");
    }
  });
});

describe("review: Client ID Metadata Document fetching is bounded", () => {
  it("anonymous authorize requests from many addresses cannot make the server fetch one host without limit", async () => {
    const before = k.cimd.fetched.length;
    for (let i = 0; i < 45; i++) {
      const r = await authorize(`https://victim.example/clients/c${i}.json`, "https://victim.example/cb", pkce(), `203.0.${i}.9`);
      expect(r.status).toBe(400);
      expect(r.headers.get("location")).toBeNull();
    }
    const perHost = k.cimd.fetched.length - before;
    expect(perHost).toBeGreaterThan(0);
    expect(perHost).toBeLessThanOrEqual(30);
    // The same missing document asked for again and again is fetched a few times, not every time.
    const b2 = k.cimd.fetched.length;
    for (let i = 0; i < 12; i++) await authorize("https://other-victim.example/client.json", "https://other-victim.example/cb", pkce(), `192.0.2.${i}`);
    expect(k.cimd.fetched.length - b2).toBeLessThanOrEqual(3);
  });

  it("the revocation endpoint (anonymous, never rate limited) never fetches a metadata document", async () => {
    const before = k.cimd.fetched.length;
    for (let i = 0; i < 5; i++) {
      const r = await form("/api/v1/oauth/mcp/revoke", { token: mintToken("live").token, client_id: `https://revoke-victim.example/c${i}.json` });
      expect(r.status).toBe(200);
    }
    expect(k.cimd.fetched.length).toBe(before);
  });

  it("anonymous authorize requests cannot create unbounded rows", async () => {
    const redirect = "https://flood.example/cb";
    const cid = await register(redirect);
    const count = async () => (await k.app.db.owner.query("select count(*)::int n from oauth_authorizations a join oauth_clients c on c.id = a.client_ref where c.client_id = $1", [cid])).rows[0].n as number;
    let limited = 0;
    for (let i = 0; i < 80; i++) { const r = await authorize(cid, redirect, pkce(), "198.51.100.44"); if (r.status === 429) limited++; else expect(r.status).toBe(302); }
    expect(limited).toBeGreaterThan(0);
    expect(await count()).toBeLessThanOrEqual(60);
    // Another address is unaffected.
    expect((await authorize(cid, redirect, pkce(), "198.51.200.1")).status).toBe(302);
  });
});

describe("review: the metadata fetcher's SSRF guard", () => {
  const CHUNK = 64 * 1024;
  function hugeBody(total: number) {
    const s = { sent: 0 };
    const web = new ReadableStream<Uint8Array>({ pull(c) { if (s.sent >= total) return c.close(); s.sent += CHUNK; c.enqueue(new Uint8Array(CHUNK).fill(32)); } });
    const node = new Readable({ read() { if (s.sent >= total) { this.push(null); return; } s.sent += CHUNK; this.push(Buffer.alloc(CHUNK, 32)); } });
    return { s, web, node };
  }
  /** The network boundary, whichever transport the fetcher uses: `fetch`, or `https.request`. */
  function serve(body: ReturnType<typeof hugeBody>, headers: Record<string, string> = {}) {
    vi.spyOn(dnsP, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body.web, { status: 200, headers }));
    vi.spyOn(https, "request").mockImplementation(((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === "function") as ((res: unknown) => void) | undefined;
      const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
      req.end = () => { setImmediate(() => { const res = Object.assign(body.node, { statusCode: 200, headers }); if (cb) cb(res); else req.emit("response", res); }); return req; };
      req.destroy = (e?: Error) => { body.node.destroy(); if (e) req.emit("error", e); return req; };
      req.setTimeout = () => req;
      return req;
    }) as never);
  }

  it("stops reading a metadata document at the size limit instead of buffering all of it", async () => {
    const body = hugeBody(4 * 1024 * 1024);
    serve(body);
    await expect(new SafeMetadataFetcher().fetch("https://big.example/client.json")).rejects.toThrow("too_large");
    expect(body.s.sent).toBeLessThanOrEqual(4 * CHUNK);   // a few chunks in flight, never the whole 4 MiB
  });

  it("checks the address it actually connects to (a DNS answer that changes after the check is refused)", async () => {
    const hits: number[] = [];
    const srv = net.createServer((s) => { hits.push(1); s.destroy(); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      // The pre-flight answer is public; the answer the connection gets is loopback (a rebinding name).
      vi.spyOn(dnsP, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
      vi.spyOn(dns, "lookup").mockImplementation(((_h: string, o: unknown, cb?: unknown) => {
        const done = (typeof o === "function" ? o : cb) as (...a: unknown[]) => void;
        const all = typeof o === "object" && o !== null && (o as { all?: boolean }).all;
        setImmediate(() => (all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4)));
      }) as never);
      await expect(new SafeMetadataFetcher().fetch(`https://rebind.example:${port}/client.json`)).rejects.toThrow("private_address");
      expect(hits.length).toBe(0);
    } finally { srv.close(); }
  });

  it("regression for the new transport: IP literals are checked, a redirect is a failure, a stalled body times out", async () => {
    const f = new SafeMetadataFetcher(150);
    for (const u of ["https://127.0.0.1/c.json", "https://[::1]/c.json", "https://[::ffff:7f00:1]/c.json", "https://169.254.169.254/latest", "https://[fe80::1]/c.json"]) await expect(f.fetch(u), u).rejects.toThrow("private_address");
    const fake = (res: Readable & { statusCode: number; headers: Record<string, string> }) => vi.spyOn(https, "request").mockImplementation(((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === "function") as (r: unknown) => void;
      const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
      req.end = () => { setImmediate(() => cb(res)); return req; };
      req.destroy = () => { res.destroy(); return req; };
      return req;
    }) as never);
    fake(Object.assign(new Readable({ read() { this.push(null); } }), { statusCode: 302, headers: { location: "https://127.0.0.1/" } }));
    await expect(f.fetch("https://moved.example/client.json")).rejects.toThrow("fetch_failed");
    vi.restoreAllMocks();
    fake(Object.assign(new Readable({ read() { /* never sends */ } }), { statusCode: 200, headers: {} }));
    const t0 = Date.now();
    await expect(f.fetch("https://slow.example/client.json")).rejects.toThrow("timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("refuses link-local, site-local and NAT64 IPv6 answers", () => {
    for (const ip of ["fe90::1", "febf::1234", "fec0::1", "64:ff9b::a9fe:a9fe", "64:ff9b::7f00:1"]) expect(publicAddress(ip), ip).toBe(false);
    for (const ip of ["2606:4700::6810:84e5", "93.184.216.34"]) expect(publicAddress(ip), ip).toBe(true);
  });
});

describe("ST-136 review: the token endpoint does not throttle every client in a shared address range", () => {
  it("a burst of bad refresh tokens from the connector range leaves another client's refresh working", async () => {
    const redirect = "https://connector.example/cb";
    const cid = await register(redirect);
    const p = pkce();
    const c = await consent(cid, redirect, p, [`domains.read:${dom.fqdn}`]);
    const t = await exchange(cid, c.code, p.verifier, redirect, "160.79.104.20");
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    for (let i = 0; i < 130; i += 10) {
      const burst = await Promise.all(Array.from({ length: 10 }, () => form(TOKEN, { grant_type: "refresh_token", refresh_token: mintToken("clr").token, client_id: "https://attacker.example/client.json" }, "160.79.104.77")));
      for (const r of burst) expect([400, 429]).toContain(r.status);
    }
    const r = await form(TOKEN, { grant_type: "refresh_token", refresh_token: t.json.refresh_token, client_id: cid }, "160.79.104.21");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });
});

describe("ST-78 review: the consent screen shows the client's reported name without text-direction tricks", () => {
  it("strips bidi overrides, isolates and zero-width characters from a client-reported name", async () => {
    const redirect = "https://bidi.example/cb";
    const cid = await register(redirect, "Claude \u202emoc.elgoog\u202c\u200b\u2066x\u2069\u061c");
    const a = await authorize(cid, redirect, pkce());
    const reqId = new URL(a.headers.get("location")!).searchParams.get("oauth_request")!;
    const view = await web(k, ada, "GET", `/api/v1/oauth/requests/${reqId}`);
    expect(view.status).toBe(200);
    const name = view.json.reported.client_name as string;
    expect(name).not.toMatch(/[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
    expect(name).toContain("moc.elgoog");
  });
});
