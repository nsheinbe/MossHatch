import { describe, expect, it } from "vitest";
import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import { PRODUCTION_URL, type OpHttpRequest, type OpHttpTransport } from "@mosshatch/registrar/openprovider";
import { registrarRpcFromEnv, registrarServeReasons, spendCapped } from "./serve.ts";
import { RedisDailyCounter, redisRest } from "./shared-store.ts";
import { ACQUIRE_LOGIN, FINISH_LOGIN, INVALIDATE_LOGIN } from "./openprovider-login.ts";
import { RPC_HEADERS } from "./sign.ts";
import { registrarFromEnv, registrarRpcBootReason } from "../domains/boot-wiring.ts";
import { NotConfigured } from "../boot.ts";

/**
 * The `registrar` project (apps/registrar) end to end, offline: web's signed RPC client -> the registrar handler -> the Openprovider adapter
 * -> a fake Openprovider. No network. The live Openprovider endpoint has never been called; these tests prove which URL the live adapter
 * would call and that every boundary refuses what it should.
 */
const SECRET = "s".repeat(40);
const LIVE = {
  MH_SCOPE: "registrar", MH_MODE: "production", VERCEL_ENV: "production", MH_REGISTRAR_MODE: "live", MH_REGISTRAR_PROVIDER: "openprovider",
  OPENPROVIDER_ENV: "production", OPENPROVIDER_USERNAME: "reseller@example.test", OPENPROVIDER_PASSWORD: "pw-not-real", REGISTRAR_RPC_SECRET: SECRET,
  UPSTASH_REDIS_REST_URL: "https://redis.example.test", UPSTASH_REDIS_REST_TOKEN: "redis-token-not-real",
};

/** A fake Upstash Redis REST endpoint: SET NX PX, INCR and PEXPIRE over one in-memory map, shared by every instance given it. */
function fakeRedis(): typeof fetch & { data: Map<string, string>; down: boolean; seen: { auth: string | null; cmd: string[] }[] } {
  const data = new Map<string, string>(); const seen: { auth: string | null; cmd: string[] }[] = [];
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (f.down) throw new TypeError("fetch failed");
    const cmd = JSON.parse(String(init?.body)) as string[];
    seen.push({ auth: new Headers(init?.headers).get("authorization"), cmd });
    const reply = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });
    const [op, key] = [cmd[0]!.toUpperCase(), cmd[1]!];
    if (op === "SET") { if (cmd.includes("NX") && data.has(key)) return reply(null); data.set(key, cmd[2]!); return reply("OK"); }
    if (op === "INCR") { const n = Number(data.get(key) ?? "0") + 1; data.set(key, String(n)); return reply(n); }
    if (op === "EVAL" && key === ACQUIRE_LOGIN) {
      const [tokenKey, lockKey, spacingKey, cooldownKey] = cmd.slice(3, 7);
      if (data.has(cooldownKey!)) return reply([data.get(cooldownKey!), ""]);
      if (data.has(tokenKey!)) return reply(["token", data.get(tokenKey!)]);
      if (data.has(lockKey!) || data.has(spacingKey!)) return reply(["busy", ""]);
      data.set(lockKey!, cmd[7]!); data.set(spacingKey!, "1"); return reply(["owner", ""]);
    }
    if (op === "EVAL" && key === FINISH_LOGIN) {
      const [tokenKey, lockKey, spacingKey, cooldownKey] = cmd.slice(3, 7);
      if (data.get(lockKey!) !== cmd[7]) return reply(0);
      if (cmd[8] === "token") data.set(tokenKey!, cmd[9]!); else data.set(cooldownKey!, cmd[8]!);
      data.set(spacingKey!, "1"); data.delete(lockKey!); return reply(1);
    }
    if (op === "EVAL" && key === INVALIDATE_LOGIN) { const tokenKey = cmd[3]!; if (data.get(tokenKey) !== cmd[4]) return reply(0); data.delete(tokenKey); return reply(1); }
    if (op === "EVAL") { const lockKey = cmd[3]!, token = cmd[4]!; if (data.get(lockKey) !== token) return reply(0); data.delete(lockKey); return reply(1); }
    if (op === "PEXPIRE") return reply(data.has(key) ? 1 : 0);
    return new Response(JSON.stringify({ error: "ERR unknown command" }), { status: 400 });
  }) as typeof fetch & { data: Map<string, string>; down: boolean; seen: { auth: string | null; cmd: string[] }[] };
  f.data = data; f.down = false; f.seen = seen;
  return f;
}

/** A fake Openprovider: login, prices (.com non-member 11.98 / 16.98) and the reseller balance. Records every request. */
function fakeOpenprovider(): OpHttpTransport & { sent: OpHttpRequest[] } {
  const sent: OpHttpRequest[] = [];
  return {
    sent,
    async request(r) {
      sent.push(r);
      const u = new URL(r.url);
      const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ code: 0, desc: "", data }) });
      if (u.pathname.endsWith("/auth/login")) return ok({ token: "t".repeat(32), reseller_id: 1 });
      if (u.pathname.endsWith("/domains/prices")) {
        const op = u.searchParams.get("operation");
        return ok({ is_premium: false, price: { reseller: { price: op === "renew" ? 16.98 : 11.98, currency: "USD" } } });
      }
      if (u.pathname.endsWith("/resellers")) return ok({ balance: 20, reserved_balance: 0 });
      if (u.pathname.endsWith("/domains") && r.method === "GET") return ok({ results: [{ id: 7, domain: { name: "moonfern", extension: "com" }, status: "ACT" }], total: 1 });
      return { status: 404, body: JSON.stringify({ code: 999, desc: "unexpected" }) };
    },
  };
}

/** web's fetch, wired straight to the registrar project's handler. */
const fetchTo = (handler: (r: Request) => Promise<Response>): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
const WEB = { MH_MODE: "production", VERCEL_ENV: "production", REGISTRAR_RPC_URL: "https://registrar.mosshatch.com", REGISTRAR_RPC_SECRET: SECRET };

describe("registrar project configuration (reason codes)", () => {
  it("a complete live environment has no reasons", () => {
    expect(registrarServeReasons(LIVE)).toMatchObject({ reasons: [], live: true, mode: "production" });
  });
  it("names each missing or wrong piece", () => {
    const r = (over: Record<string, string | undefined>) => registrarServeReasons({ ...LIVE, ...over }).reasons;
    expect(r({ MH_SCOPE: undefined })).toContain("registrar_scope_missing");
    expect(r({ REGISTRAR_RPC_SECRET: "short" })).toContain("registrar_rpc_secret_missing");
    expect(r({ OPENPROVIDER_USERNAME: undefined })).toContain("openprovider_credentials_missing");
    expect(r({ OPENPROVIDER_PASSWORD: "" })).toContain("openprovider_credentials_missing");
    expect(r({ MH_REGISTRAR_PROVIDER: "opensrs" })).toContain("registrar_provider_unsupported");
    expect(r({ MH_REGISTRAR_MODE: "mock" })).toContain("registrar_mode_invalid");
    // Mode guard on this side: the live adapter only in a production deployment with VERCEL_ENV=production.
    expect(r({ VERCEL_ENV: "preview" })).toContain("live_outside_production");
    expect(r({ VERCEL_ENV: undefined })).toContain("live_outside_production");
    expect(r({ MH_MODE: "staging", VERCEL_ENV: "preview" })).toEqual(expect.arrayContaining(["live_outside_production", "openprovider_production_credentials_outside_production"]));
    // Sandbox credentials are refused in production, and production credentials need live mode.
    expect(r({ OPENPROVIDER_ENV: "sandbox" })).toEqual(expect.arrayContaining(["openprovider_sandbox_credentials_in_production"]));
    expect(r({ MH_REGISTRAR_MODE: "sandbox" })).toContain("openprovider_env_registrar_mode_mismatch");
  });
});

describe("web -> registrar project -> Openprovider live (fake)", () => {
  it("the live adapter calls the production endpoint and web gets live (not sample) prices through the signed RPC", async () => {
    const op = fakeOpenprovider();
    const logs: Record<string, unknown>[] = [];
    const reg = registrarRpcFromEnv(LIVE, { transport: op, redisFetch: fakeRedis(), log: (l) => logs.push(l) });
    expect(reg.reasons).toEqual([]);
    const port = await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(reg.handler));
    expect(port!.capabilities().mode).toBe("live");
    const q = await port!.quote("moonfern.com", 1, "register");
    expect(q.wholesale).toMatchObject({ minor: 1198n, currency: "usd", source: "live" });
    expect(q.renewalWholesale.minor).toBe(1698n);
    expect(PRODUCTION_URL).toBe("https://api.openprovider.eu/v1");
    expect(op.sent.length).toBeGreaterThan(0);
    for (const s of op.sent) expect(s.url.startsWith(`${PRODUCTION_URL}/`)).toBe(true);
    // The credentials go to Openprovider's login and nowhere else, and never into a log line.
    expect(op.sent.filter((s) => (s.body ?? "").includes("pw-not-real")).map((s) => new URL(s.url).pathname)).toEqual(["/v1/auth/login"]);
    expect(JSON.stringify(logs)).not.toContain("pw-not-real");
  });
  it("a registrar project without Openprovider credentials makes web's boot name it, after the signature is checked", async () => {
    const reg = registrarRpcFromEnv({ ...LIVE, OPENPROVIDER_PASSWORD: undefined }, { transport: fakeOpenprovider(), redisFetch: fakeRedis(), log: () => undefined });
    const e = await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(reg.handler)).catch((x) => x);
    expect(e).toBeInstanceOf(NotConfigured);
    expect((e as NotConfigured).reason).toBe("openprovider_credentials_missing");
    // An unsigned caller learns nothing about the configuration.
    const anon = await reg.handler(new Request("https://registrar.mosshatch.com/rpc/v1/capabilities", { method: "POST", body: "{}" }));
    expect(anon.status).toBe(401);
    expect(await anon.text()).not.toContain("openprovider");
  });
  it("secrets that differ between the projects, a project without its secret, and an unreachable project are told apart", async () => {
    const other = registrarRpcFromEnv({ ...LIVE, REGISTRAR_RPC_SECRET: "o".repeat(40) }, { transport: fakeOpenprovider(), redisFetch: fakeRedis(), log: () => undefined });
    expect(((await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(other.handler)).catch((x) => x)) as NotConfigured).reason).toBe("registrar_rpc_secret_mismatch");
    const none = registrarRpcFromEnv({ ...LIVE, REGISTRAR_RPC_SECRET: undefined }, { transport: fakeOpenprovider(), redisFetch: fakeRedis(), log: () => undefined });
    expect(((await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(none.handler)).catch((x) => x)) as NotConfigured).reason).toBe("registrar_project_secret_missing");
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(((await registrarFromEnv(WEB, { registrarMode: "live" }, down).catch((x) => x)) as NotConfigured).reason).toBe("registrar_rpc_unreachable");
    expect(registrarRpcBootReason(new RegistrarError("unavailable", "x", { retryable: false, outcomeUnknown: false, code: "<script>" }))).toBe("registrar_rpc_unreachable");
  });
  it("the kill switch in the registrar project refuses writes (fails closed on an unknown value)", async () => {
    for (const v of ["writes_paused", "nonsense"]) {
      const reg = registrarRpcFromEnv({ ...LIVE, MH_REGISTRAR_KILL_SWITCH: v }, { transport: fakeOpenprovider(), redisFetch: fakeRedis(), log: () => undefined });
      const port = await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(reg.handler));
      await expect(port!.setLock("moonfern.com", false)).rejects.toMatchObject({ code: "kill_switch" });
    }
  });
});

describe("the registrar project's daily spend cap", () => {
  it("refuses paid operations past the cap and leaves reads alone", async () => {
    let calls = 0;
    const port = { register: async () => { calls++; return { ok: true }; }, getBalance: async () => "balance" } as unknown as RegistrarPort;
    let now = new Date("2026-10-01T10:00:00Z");
    let trips = 0;
    const capped = spendCapped(port, 2, { now: () => now }, () => { trips++; });
    await capped.register({} as never); await capped.register({} as never);
    await expect(capped.register({} as never)).rejects.toMatchObject({ code: "registrar_daily_spend_cap", kind: "rate_limited", outcomeUnknown: false });
    expect(await capped.getBalance()).toBe("balance");
    expect([calls, trips]).toEqual([2, 1]);
    now = new Date("2026-10-02T00:00:01Z");
    await capped.register({} as never);
    expect(calls).toBe(3);
  });
  it("MH_REGISTRAR_DAILY_SPEND_OPS=0 stops every paid operation", async () => {
    const reg = registrarRpcFromEnv({ ...LIVE, MH_REGISTRAR_DAILY_SPEND_OPS: "0" }, { transport: fakeOpenprovider(), redisFetch: fakeRedis(), log: () => undefined });
    const port = await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(reg.handler));
    await expect(port!.renew("moonfern.com", 1, 2027)).rejects.toMatchObject({ code: "registrar_daily_spend_cap" });
  });
  it("commercial policy reaches the provider beyond the old five-operation cap and still uses shared anti-replay nonces", async () => {
    const transport = fakeOpenprovider(), redis = fakeRedis();
    const reg = registrarRpcFromEnv({ ...LIVE, MH_REGISTRATION_POLICY: "commercial" }, { transport, redisFetch: redis, log: () => undefined });
    expect(reg.reasons).toEqual([]);
    const port = await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(reg.handler));
    // The fake does not implement renew. Every call must reach that provider refusal, never a hidden count fuse.
    for (let i = 0; i < 7; i++) await expect(port!.renew("moonfern.com", 1, 2027)).rejects.not.toMatchObject({ code: "registrar_daily_spend_cap" });
    expect(transport.sent.filter((r) => r.method === "GET" && new URL(r.url).pathname.endsWith("/domains/7"))).toHaveLength(7);
    expect(redis.seen.some((r) => r.cmd[0] === "SET")).toBe(true);
    expect(redis.seen.some((r) => r.cmd[0] === "INCR")).toBe(false);
  });
  it("commercial policy preserves an explicit registrar zero stop", async () => {
    const reg = registrarRpcFromEnv({ ...LIVE, MH_REGISTRATION_POLICY: "commercial", MH_REGISTRAR_DAILY_SPEND_OPS: "0" }, { transport: fakeOpenprovider(), redisFetch: fakeRedis(), log: () => undefined });
    const port = await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(reg.handler));
    await expect(port!.renew("moonfern.com", 1, 2027)).rejects.toMatchObject({ code: "registrar_daily_spend_cap" });
  });
});

describe("the registrar project's shared store (Upstash Redis REST)", () => {
  it("is required when live", () => {
    expect(registrarServeReasons({ ...LIVE, UPSTASH_REDIS_REST_URL: undefined }).reasons).toContain("registrar_shared_store_missing");
    expect(registrarServeReasons({ ...LIVE, UPSTASH_REDIS_REST_URL: "http://redis.example.test" }).reasons).toContain("registrar_shared_store_missing");
    // The Vercel Marketplace names work too.
    const { UPSTASH_REDIS_REST_URL: _u, UPSTASH_REDIS_REST_TOKEN: _t, ...rest } = LIVE;
    expect(registrarServeReasons({ ...rest, KV_REST_API_URL: "https://kv.example.test", KV_REST_API_TOKEN: "t" }).reasons).toEqual([]);
  });

  it("a live project without it refuses every signed call with the reason, so web's boot names it", async () => {
    const reg = registrarRpcFromEnv({ ...LIVE, UPSTASH_REDIS_REST_TOKEN: undefined }, { transport: fakeOpenprovider(), log: () => undefined });
    expect(((await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(reg.handler)).catch((x) => x)) as NotConfigured).reason).toBe("registrar_shared_store_missing");
  });

  it("sends each command as a JSON array with the token as a Bearer header", async () => {
    const redis = fakeRedis();
    expect(await redisRest({ url: "https://redis.example.test", token: "tok" }, redis)(["INCR", "k"])).toBe(1);
    expect(redis.seen[0]).toEqual({ auth: "Bearer tok", cmd: ["INCR", "k"] });
  });

  it("a request replayed to another instance is refused: the nonce is shared", async () => {
    const redis = fakeRedis(); const op = fakeOpenprovider();
    const a = registrarRpcFromEnv(LIVE, { transport: op, redisFetch: redis, log: () => undefined });
    const bLogs: Record<string, unknown>[] = [];
    const b = registrarRpcFromEnv(LIVE, { transport: op, redisFetch: redis, log: (l) => bLogs.push(l) });
    let captured: Request | undefined;
    const port = await registrarFromEnv(WEB, { registrarMode: "live" }, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input, init); if (r.url.endsWith("/getBalance")) captured = r.clone(); return a.handler(r);
    }) as typeof fetch);
    await port!.getBalance();
    expect(captured?.headers.get(RPC_HEADERS.nonce)).toBeTruthy();
    const replay = await b.handler(captured!);
    expect(replay.status).toBe(401);
    expect(bLogs).toContainEqual({ event: "registrar_rpc_reject", reason: "replayed_nonce" });
  });

  it("the daily cap counts across instances", async () => {
    const redis = fakeRedis(); const now = { now: () => new Date("2026-10-02T10:00:00Z") };
    let calls = 0;
    const port = { register: async () => { calls++; return { ok: true }; } } as unknown as RegistrarPort;
    const counter = () => new RedisDailyCounter(redisRest({ url: "https://redis.example.test", token: "t" }, redis));
    const one = spendCapped(port, 2, now, () => undefined, counter()), two = spendCapped(port, 2, now, () => undefined, counter());
    await one.register({} as never); await two.register({} as never);
    await expect(one.register({} as never)).rejects.toMatchObject({ code: "registrar_daily_spend_cap" });
    await expect(two.register({} as never)).rejects.toMatchObject({ code: "registrar_daily_spend_cap" });
    expect(calls).toBe(2);
    // The day's key expires on its own.
    expect(redis.seen.filter((s) => s.cmd[0] === "PEXPIRE")).toHaveLength(1);
  });

  it("fails closed: with Redis unreachable no call reaches Openprovider and nothing is unknown about the outcome", async () => {
    const redis = fakeRedis(); const op = fakeOpenprovider();
    const reg = registrarRpcFromEnv(LIVE, { transport: op, redisFetch: redis, log: () => undefined });
    const port = await registrarFromEnv(WEB, { registrarMode: "live" }, fetchTo(reg.handler));
    const before = op.sent.length;
    redis.down = true;
    await expect(port!.getBalance()).rejects.toMatchObject({ code: "registrar_shared_store_unavailable", outcomeUnknown: false });
    expect(op.sent.length).toBe(before);
    // A paid operation refuses before the registrar too.
    const capped = spendCapped({ renew: async () => { throw new Error("must not run"); } } as unknown as RegistrarPort, 5, { now: () => new Date() }, () => undefined,
      new RedisDailyCounter(redisRest({ url: "https://redis.example.test", token: "t" }, redis)));
    await expect(capped.renew("moonfern.com", 1, 2027)).rejects.toMatchObject({ code: "registrar_shared_store_unavailable" });
  });
});
