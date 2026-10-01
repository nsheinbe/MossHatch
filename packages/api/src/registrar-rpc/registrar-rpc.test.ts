import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockRegistrarPort } from "@mosshatch/registrar/mock-port";
import { RegistrarError } from "@mosshatch/registrar/port";
import { loadConfig, ModeError } from "../config/modeguard.ts";
import { connectRegistrarRpc, createRegistrarRpc, MemoryNonceStore, RPC_COMMANDS, RPC_HEADERS, sign, encodeJson, registrarScopeReasons, type RpcRequest, type RpcResponse } from "./index.ts";

const SECRET = "s".repeat(40);
const REG = { name: "Test Person", email: "person@example.test", phone: "+1.5555550100", street: "1 Test St", city: "Portland", region: "OR", postalCode: "97201", country: "US" };
let n = 0;

function rig(over: { secrets?: string[]; windowSeconds?: number } = {}) {
  const mock = new MockRegistrarPort();
  const nonces = new MemoryNonceStore(); const rejects: string[] = [];
  const handler = createRegistrarRpc({ port: mock, secrets: over.secrets ?? [SECRET], clock: mock.clock, nonces, onReject: (r) => rejects.push(r), ...(over.windowSeconds ? { windowSeconds: over.windowSeconds } : {}) });
  /** Builds a correctly signed request by hand so tests can then tamper with one part. */
  const signed = (name: string, args: unknown[], o: { secret?: string; ts?: number; nonce?: string; method?: string } = {}) => {
    const p = `/rpc/v1/${name}`; const body = encodeJson({ args }); const method = o.method ?? "POST";
    const timestamp = String(o.ts ?? Math.floor(mock.clock.now().getTime() / 1000)); const nonce = o.nonce ?? `nonce-${++n}-abcdefghijkl`;
    const req: RpcRequest = { method, path: p, body, headers: { [RPC_HEADERS.timestamp]: timestamp, [RPC_HEADERS.nonce]: nonce, [RPC_HEADERS.signature]: sign(o.secret ?? SECRET, { method, path: p, body, timestamp, nonce }) } };
    return req;
  };
  return { mock, handler, nonces, rejects, signed };
}
const json = (r: RpcResponse) => JSON.parse(r.body);

describe("ST-118: signed web -> registrar calls", () => {
  it("a correctly signed call runs; bigint, Date and typed errors survive the round trip through the client", async () => {
    const { mock, handler } = rig();
    const port = await connectRegistrarRpc({ secret: SECRET, clock: mock.clock, send: (r) => handler(r) });
    expect(port.capabilities().mode).toBe("mock");
    const fqdn = "free-rpc1.com";
    expect((await port.checkAvailability(fqdn, { noCache: true })).kind).toBe("available");
    const q = await port.quote(fqdn, 1);
    expect(typeof q.wholesale.minor).toBe("bigint"); expect(q.quotedAt).toBeInstanceOf(Date);
    const reg = await port.register({ fqdn, years: 1, regUsername: "rpcuser01", regPassword: "0123456789abcdef", registrant: REG });
    expect(reg.status).toBe("registered");
    expect((await port.getDomain(fqdn))?.expiresAt).toBeInstanceOf(Date);
    expect(await port.getDomain("free-none.com")).toBeNull();
    expect((await port.issueAuthCode(fqdn)).code).toMatch(/^[A-Za-z0-9]{20}$/);
    await port.setLock(fqdn, false);
    expect((await port.getDomain(fqdn))?.locked).toBe(false);
    expect((await port.replaceZone(fqdn, [{ type: "A", name: "", value: "192.0.2.1" }])).records).toHaveLength(1);
    expect(await port.getTransfersAway({ since: new Date(0), statuses: ["pending_owner"] })).toEqual([]);
    const e = await port.register({ fqdn, years: 1, regUsername: "rpcuser02", regPassword: "0123456789abcdef", registrant: REG }).catch((x) => x);
    expect(e).toBeInstanceOf(RegistrarError);
    expect(e).toMatchObject({ kind: "rejected", code: "domain_taken", retryable: false, outcomeUnknown: false });
  });

  it("refuses a call with no signature, a wrong secret, or a malformed signature (uniform 401)", async () => {
    const { handler, signed, mock, rejects } = rig();
    const ok = signed("getBalance", []);
    const noSig = { ...ok, headers: { ...ok.headers, [RPC_HEADERS.signature]: "" } };
    const noHeaders = { ...ok, headers: {} };
    const wrong = signed("getBalance", [], { secret: "w".repeat(40) });
    const junk = { ...signed("getBalance", []), headers: { ...ok.headers, [RPC_HEADERS.signature]: "zz".repeat(32), [RPC_HEADERS.nonce]: "another-nonce-abcdefgh" } };
    const results = await Promise.all([noSig, noHeaders, wrong, junk].map((r) => handler(r)));
    for (const r of results) { expect(r.status).toBe(401); expect(r.body).toBe(results[0]!.body); }
    expect(rejects.sort()).toEqual(["bad_signature", "bad_signature", "missing_headers", "missing_headers"]);
    expect(mock.calls.getFundingStatus + mock.calls.getBalance).toBe(0);
    expect((await handler(ok)).status).toBe(200);
  });

  it("any change after signing (body, path, method, timestamp, nonce) invalidates the signature", async () => {
    const { handler, signed, mock } = rig();
    const base = signed("setLock", ["free-t.com", true]);
    const variants: RpcRequest[] = [
      { ...base, body: base.body.replace("true", "false") },
      { ...base, path: "/rpc/v1/setAutoRenew" },
      { ...base, headers: { ...base.headers, [RPC_HEADERS.timestamp]: String(Number(base.headers[RPC_HEADERS.timestamp]) + 1) } },
      { ...base, headers: { ...base.headers, [RPC_HEADERS.nonce]: "different-nonce-abcdef" } },
      { ...base, method: "PUT" },
    ];
    for (const v of variants) expect((await handler(v)).status, v.path + v.method).toBe(401);
    expect(mock.calls.setLock).toBe(0);
  });

  it("a replayed nonce is refused and the command does not run twice", async () => {
    const { handler, signed, mock, rejects } = rig();
    await mock.register({ fqdn: "free-replay.com", years: 1, regUsername: "replay001", regPassword: "0123456789abcdef", registrant: REG });
    const req = signed("setLock", ["free-replay.com", false]);
    expect((await handler(req)).status).toBe(200);
    const again = await handler(req);
    expect(again.status).toBe(401); expect(json(again)).toEqual({ error: { code: "unauthorized" } });
    expect(rejects).toContain("replayed_nonce");
    expect(mock.calls.setLock).toBe(1);
    // the same nonce with a different (validly signed) body is still a replay
    expect((await handler(signed("setLock", ["free-replay.com", true], { nonce: req.headers[RPC_HEADERS.nonce]! }))).status).toBe(401);
  });

  it("a forged request does not consume a nonce; the genuine one with that nonce still works", async () => {
    const { handler, signed } = rig();
    const nonce = "victim-nonce-abcdefghij";
    expect((await handler(signed("getBalance", [], { secret: "x".repeat(40), nonce }))).status).toBe(401);
    expect((await handler(signed("getBalance", [], { nonce }))).status).toBe(200);
  });

  it("enforces the time window: 59 s old and 59 s ahead pass, 61 s either way fails, and old nonces are pruned", async () => {
    const { handler, signed, mock, nonces } = rig();
    const now = Math.floor(mock.clock.now().getTime() / 1000);
    expect((await handler(signed("getBalance", [], { ts: now - 59 }))).status).toBe(200);
    expect((await handler(signed("getBalance", [], { ts: now + 59 }))).status).toBe(200);
    for (const ts of [now - 61, now + 61, now - 86_400, now + 3600]) expect((await handler(signed("getBalance", [], { ts }))).status, String(ts)).toBe(401);
    expect(nonces.size).toBe(2);
    mock.advance(5 * 60_000);
    await handler(signed("getBalance", []));
    expect(nonces.size).toBe(1);
    // a request captured earlier can no longer be replayed either way: outside the window
    expect((await handler(signed("getBalance", [], { ts: now }))).status).toBe(401);
  });

  it("only allow-listed commands run, even with a valid signature", async () => {
    const { handler, signed } = rig();
    const shielded = ["resumeExtension", "isExtensionPaused", "constructor", "__proto__", "toString", "hasOwnProperty", "call", "rawSetZone", "oob", "setBalance", "topUp", "registerAsOther", "sendAuthCode", "deleteDomain", "issueAuthCode/../x", ""];
    for (const c of shielded) {
      const r = await handler(signed(c, []));
      expect(r.status, c).toBe(404); expect(json(r)).toEqual({ error: { code: "command_not_allowed" } });
    }
    expect(Object.keys(RPC_COMMANDS)).not.toContain("resumeExtension");
    expect((await handler(signed("getBalance", []))).status).toBe(200);
  });

  it("validates arguments and never echoes them back", async () => {
    const { handler, signed } = rig();
    const bad = [
      signed("setLock", ["free-a.com"]), signed("setLock", [123, true]), signed("register", [{ fqdn: "free-a.com", years: 99, regUsername: "abc", regPassword: "x", registrant: REG }]),
      signed("register", [{ fqdn: "free-a.com", years: 1, regUsername: "abcdef", regPassword: "0123456789abcdef", registrant: REG, extra: "SECRET-CANARY" }]),
      signed("cancelPendingOrder", ["1; DROP TABLE"]), signed("replaceZone", ["free-a.com", [{ type: "CAA", name: "", value: "x" }]]),
    ];
    for (const b of bad) { const r = await handler(b); expect(r.status).toBe(400); expect(json(r)).toEqual({ error: { code: "bad_request" } }); }
    const big = createRegistrarRpc({ port: new MockRegistrarPort(), secrets: [SECRET], clock: new MockRegistrarPort().clock, nonces: new MemoryNonceStore(), maxBodyBytes: 100 });
    expect((await big(signed("getBalance", ["x".repeat(500)]))).status).toBe(413);
  });

  it("fails closed when no secret, or a short secret, is configured", async () => {
    for (const secrets of [[], ["short"], [SECRET, ""]]) {
      const { handler, signed, mock } = rig({ secrets });
      const r = await handler(signed("getBalance", []));
      expect(r.status).toBe(503); expect(mock.calls.getBalance).toBe(0);
    }
  });

  it("accepts the previous secret during rotation and refuses it once removed", async () => {
    const OLD = "o".repeat(40);
    const both = rig({ secrets: [SECRET, OLD] });
    expect((await both.handler(both.signed("getBalance", [], { secret: OLD }))).status).toBe(200);
    expect((await both.handler(both.signed("getBalance", []))).status).toBe(200);
    const after = rig({ secrets: [SECRET] });
    expect((await after.handler(after.signed("getBalance", [], { secret: OLD }))).status).toBe(401);
  });

  it("carries codes and flags across the boundary, never messages; internal errors are opaque; responses are not cacheable", async () => {
    const { mock, handler, signed } = rig();
    mock.faults.set("registryMaintenance");
    const r = await handler(signed("quote", ["free-a.com", 1]));
    expect(r.status).toBe(503); expect(json(r)).toEqual({ error: { code: "maintenance", kind: "maintenance", retryable: true, outcomeUnknown: false } });
    expect(r.headers["cache-control"]).toBe("no-store");
    mock.faults.clear();
    (mock as unknown as { getBalance: () => never }).getBalance = () => { throw new Error("db password=hunter2 leaked"); };
    const boom = await handler(signed("getBalance", []));
    expect(boom.status).toBe(500); expect(boom.body).not.toContain("hunter2"); expect(json(boom)).toEqual({ error: { code: "internal" } });
  });

  it("the client maps an RPC-level refusal to a definite (not unknown) outcome and a dropped response to an unknown one", async () => {
    const { mock, handler } = rig();
    const port = await connectRegistrarRpc({ secret: SECRET, clock: mock.clock, send: (r) => handler(r) });
    const badPort = await connectRegistrarRpc({ secret: SECRET, clock: mock.clock, send: (r) => handler(r) }).then(async () => {
      const t = await connectRegistrarRpc({ secret: SECRET, clock: mock.clock, send: async (r) => (r.path.endsWith("/capabilities") ? handler(r) : { status: 200, body: "<html>gateway</html>" }) });
      return t;
    });
    expect(port).toBeDefined();
    const e = await badPort.setLock("free-a.com", true).catch((x) => x);
    expect(e).toMatchObject({ kind: "unknown", outcomeUnknown: true, retryable: false });
    const wrong = await connectRegistrarRpc({ secret: SECRET, clock: mock.clock, send: async (r) => (r.path.endsWith("/capabilities") ? handler(r) : handler({ ...r, headers: { ...r.headers, [RPC_HEADERS.signature]: "0".repeat(64) } })) });
    expect(await wrong.setLock("free-a.com", true).catch((x) => x)).toMatchObject({ code: "unauthorized", outcomeUnknown: false });
  });
});

const BASE = { CRON_SECRET: "c".repeat(40), MH_ORIGIN: "https://mosshatch.com" };
const reasons = (env: Record<string, string>) => { try { loadConfig({ ...BASE, ...env }); return null; } catch (e) { if (e instanceof ModeError) return e.reasons; throw e; } };

describe("ST-117: the production registrar key is absent from Preview, Development and web", () => {
  const prodWeb = { MH_MODE: "production", VERCEL_ENV: "production", STRIPE_SECRET_KEY: "sk_live_abc", MH_REGISTRAR_MODE: "live" };
  it("refuses live registrar credentials in any scope but registrar", () => {
    for (const k of ["OPENSRS_LIVE_API_KEY", "OPENSRS_LIVE_USERNAME", "REGISTRAR_LIVE_API_KEY", "OPENSRS_PRODUCTION_API_KEY", "OPENSRS_API_KEY"]) {
      expect(reasons({ ...prodWeb, [k]: "the-key" }), k).toContain("registrar_key_outside_registrar_scope");
    }
    expect(reasons({ ...prodWeb, MH_SCOPE: "web", OPENSRS_LIVE_API_KEY: "k" })).toContain("registrar_key_outside_registrar_scope");
    expect(reasons({ ...prodWeb })).toBeNull(); // web in production is fine without it
  });
  it("Preview and Development never carry registrar credentials, live or Horizon, even in the registrar scope", () => {
    const preview = { MH_MODE: "preview", VERCEL_ENV: "preview", STRIPE_SECRET_KEY: "sk_test_abc" };
    expect(reasons({ ...preview, OPENSRS_LIVE_API_KEY: "k" })).toEqual(expect.arrayContaining(["registrar_key_outside_registrar_scope", "registrar_credentials_in_preview"]));
    expect(reasons({ ...preview, OPENSRS_HORIZON_API_KEY: "k" })).toContain("registrar_credentials_in_preview");
    expect(reasons({ ...preview, MH_SCOPE: "registrar", OPENSRS_HORIZON_API_KEY: "k" })).toEqual(["registrar_credentials_in_preview"]);
    expect(reasons({ MH_MODE: "local", STRIPE_SECRET_KEY: "sk_test_abc", OPENSRS_LIVE_API_KEY: "k" })).toContain("registrar_key_outside_registrar_scope");
    expect(reasons({ ...preview, MH_REGISTRAR_MODE: "live" })).toContain("live_outside_production"); // a preview cannot select the live registrar
  });
  it("live credentials in the registrar scope need production; Horizon credentials are fine in staging", () => {
    const staging = { MH_MODE: "staging", VERCEL_ENV: "preview", STRIPE_SECRET_KEY: "sk_test_abc", MH_SCOPE: "registrar", MH_REGISTRAR_MODE: "sandbox" };
    expect(reasons({ ...staging, OPENSRS_HORIZON_API_KEY: "k" })).toBeNull();
    expect(reasons({ ...staging, OPENSRS_LIVE_API_KEY: "k" })).toEqual(["live_registrar_key_outside_production"]);
    expect(reasons({ ...prodWeb, MH_SCOPE: "registrar", OPENSRS_LIVE_API_KEY: "k", OPENSRS_LIVE_USERNAME: "u" })).toBeNull();
  });
  it("the RPC secret is not a registrar key; the RPC target must match the environment", () => {
    expect(reasons({ ...prodWeb, REGISTRAR_RPC_SECRET: "s".repeat(40), REGISTRAR_RPC_URL: "https://registrar.mosshatch.com" })).toBeNull();
    expect(reasons({ ...prodWeb, REGISTRAR_RPC_URL: "https://registrar.staging.mosshatch.com" })).toContain("registrar_rpc_target_environment_mismatch");
    expect(reasons({ MH_MODE: "preview", VERCEL_ENV: "preview", STRIPE_SECRET_KEY: "sk_test_abc", REGISTRAR_RPC_URL: "https://registrar.prod.mosshatch.com" })).toContain("registrar_rpc_target_environment_mismatch");
    expect(reasons({ ...prodWeb, REGISTRAR_RPC_URL: "not a url" })).toContain("registrar_rpc_target_environment_mismatch");
  });
  it("errors carry reason codes only, never the key or its name", () => {
    let msg = "";
    try { loadConfig({ ...BASE, ...prodWeb, OPENSRS_LIVE_API_KEY: "super-secret-reseller-key" }); } catch (e) { msg = JSON.stringify({ m: (e as Error).message, r: (e as ModeError).reasons }); }
    expect(msg).not.toContain("super-secret-reseller-key"); expect(msg).not.toContain("OPENSRS");
  });
  it("empty values do not count; the pure check agrees", () => {
    expect(registrarScopeReasons({ OPENSRS_LIVE_API_KEY: "" }, "production")).toEqual([]);
    expect(registrarScopeReasons({ OPENSRS_LIVE_API_KEY: "k" }, "production")).toEqual(["registrar_key_outside_registrar_scope"]);
  });
  it("no web or api source outside the config guard and the registrar module reads a registrar credential variable", () => {
    const root = path.resolve(import.meta.dirname, "../../../..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        // apps/registrar is the registrar project itself (the one place the credentials belong); its bundle carries the adapter.
        if (["node_modules", "dist", ".next", ".vercel", "registrar-rpc", "config"].includes(ent.name) || (ent.name === "registrar" && dir.endsWith("apps"))) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs|json|html)$/.test(ent.name) && !/\.test\./.test(ent.name) && /OPENSRS_|REGISTRAR_LIVE_|REGISTRAR_PROD/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(root, p));
      }
    };
    walk(path.join(root, "apps")); walk(path.join(root, "packages/api/src"));
    expect(hits).toEqual([]);
  });
});
