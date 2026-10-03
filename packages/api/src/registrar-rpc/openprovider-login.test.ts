import { describe, expect, it } from "vitest";
import { RegistrarError } from "@mosshatch/registrar/port";
import { OpenproviderAdapter, MemoryOpenproviderCredentials, PRODUCTION_URL, SANDBOX_URL, type OpHttpTransport } from "@mosshatch/registrar/openprovider";
import { MemoryKillSwitch } from "@mosshatch/registrar/opensrs";
import { ACQUIRE_LOGIN, FINISH_LOGIN, INVALIDATE_LOGIN, AUTH_COOLDOWN_MS, TOKEN_TTL_MS, RedisOpenproviderLoginCache } from "./openprovider-login.ts";
import type { RedisCommand } from "./shared-store.ts";

function sharedRedis() {
  let time = 0;
  const rows = new Map<string, { value: string; expires: number }>();
  const read = (key: string) => { const row = rows.get(key); if (row && row.expires <= time) rows.delete(key); return rows.get(key)?.value; };
  const put = (key: string, value: string, ttl: number) => rows.set(key, { value, expires: time + ttl });
  const command: RedisCommand = async (args) => {
    const script = args[1], count = Number(args[2]), keys = args.slice(3, 3 + count).map(String), argv = args.slice(3 + count).map(String);
    if (script === ACQUIRE_LOGIN) {
      const cooldown = read(keys[3]!); if (cooldown) return [cooldown, ""];
      const token = read(keys[0]!); if (token) return ["token", token];
      if (read(keys[1]!) || read(keys[2]!)) return ["busy", ""];
      put(keys[1]!, argv[0]!, Number(argv[1])); put(keys[2]!, "1", Number(argv[2])); return ["owner", ""];
    }
    if (script === FINISH_LOGIN) {
      if (read(keys[1]!) !== argv[0]) return 0;
      if (argv[1] === "token") put(keys[0]!, argv[2]!, Number(argv[3]));
      else put(keys[3]!, argv[1]!, Number(argv[3]));
      put(keys[2]!, "1", Number(argv[4]));
      rows.delete(keys[1]!); return 1;
    }
    if (script === INVALIDATE_LOGIN) { if (read(keys[0]!) !== argv[0]) return 0; rows.delete(keys[0]!); return 1; }
    throw new Error("unsupported test command");
  };
  return { command, rows, advance: (ms: number) => { time += ms; }, now: () => time };
}
const input = { host: PRODUCTION_URL, username: "reseller@example.test", password: "password-canary", ttlMs: TOKEN_TTL_MS };
function adapter(redis: RedisCommand, transport: OpHttpTransport, logs: unknown[]) {
  return new OpenproviderAdapter({ mode: "live", deployment: "production", credentials: new MemoryOpenproviderCredentials(input), transport,
    killSwitch: new MemoryKillSwitch(), loginCache: new RedisOpenproviderLoginCache(redis), log: (e) => logs.push(e) });
}

describe("shared Openprovider authentication", () => {
  it("malformed HTTP200 bearer responses never enter the shared cache or authorize a provider read", async () => {
    for (const token of ["invalid bearer", "control\u0000bearer", "x".repeat(16_385)]) {
      const redis = sharedRedis(), logs: unknown[] = []; let calls = 0;
      const transport: OpHttpTransport = { request: async (r) => {
        calls++; expect(r.url.endsWith("/auth/login")).toBe(true);
        return { status: 200, body: JSON.stringify({ code: 0, data: { token } }) };
      } };
      await expect(adapter(redis.command, transport, logs).getBalance()).rejects.toMatchObject({ code: "openprovider_login_invalid_response", outcomeUnknown: false });
      expect([...redis.rows.keys()].some((key) => key.includes(":token:"))).toBe(false);
      await expect(adapter(redis.command, transport, logs).getBalance()).rejects.toMatchObject({ code: "openprovider_login_backoff" });
      expect(calls).toBe(1); expect(JSON.stringify(logs)).not.toContain(token);
    }
  });
  it("1000 cold independent adapters fill one shared token; cache reads never send credentials or extend token expiry", async () => {
    const redis = sharedRedis(), logs: unknown[] = []; let logins = 0, reads = 0;
    const transport: OpHttpTransport = { request: async (r) => {
      if (r.url.endsWith("/auth/login")) { logins++; return { status: 200, body: JSON.stringify({ code: 0, data: { token: "bearer-canary" } }) }; }
      reads++; expect(r.headers.Authorization).toBe("Bearer bearer-canary");
      return { status: 200, body: JSON.stringify({ code: 0, data: { balance: 100, reserved_balance: 0 } }) };
    } };
    const results = await Promise.all(Array.from({ length: 1000 }, () => adapter(redis.command, transport, logs).getBalance()));
    expect(results.every((r) => r.available.minor === 10_000n)).toBe(true); expect(logins).toBe(1); expect(reads).toBe(1000);
    const expiry = [...redis.rows.values()].find((r) => r.value === "bearer-canary")!.expires;
    redis.advance(TOKEN_TTL_MS - 1);
    await adapter(redis.command, transport, logs).getBalance(); expect(logins).toBe(1);
    expect([...redis.rows.values()].find((r) => r.value === "bearer-canary")!.expires).toBe(expiry);
    redis.advance(2); await adapter(redis.command, transport, logs).getBalance(); expect(logins).toBe(2);
    expect(JSON.stringify(logs)).not.toContain("bearer-canary"); expect(JSON.stringify(logs)).not.toContain(input.password);
    expect([...redis.rows.keys()].join(" ")).not.toContain(input.username); expect([...redis.rows.keys()].join(" ")).not.toContain(input.password);
  });
  it("login HTTP500/code196 and HTTP401 publish a shared 20-minute cooldown rather than 1000 failed probes", async () => {
    for (const [status, code] of [[500, 196], [401, 0]]) {
      const redis = sharedRedis(), logs: unknown[] = []; let calls = 0;
      const transport: OpHttpTransport = { request: async () => { calls++; return { status: status!, body: JSON.stringify({ code, desc: input.password }) }; } };
      const errors = await Promise.all(Array.from({ length: 1000 }, () => adapter(redis.command, transport, logs).getBalance().catch((e) => e)));
      expect(calls).toBe(1); expect(errors.every((e) => ["auth_failed", "openprovider_auth_cooldown"].includes(e.code))).toBe(true);
      redis.advance(AUTH_COOLDOWN_MS - 1);
      await expect(adapter(redis.command, transport, logs).getBalance()).rejects.toMatchObject({ code: "openprovider_auth_cooldown", outcomeUnknown: false });
      expect(calls).toBe(1);
      redis.advance(2); await adapter(redis.command, transport, logs).getBalance().catch(() => undefined); expect(calls).toBe(2);
      expect(JSON.stringify([errors, logs])).not.toContain(input.password);
    }
  });
  it("a generic 500 uses short retry backoff and a 429 uses one-minute backoff, without flagging credentials", async () => {
    for (const [status, wait] of [[500, 5000], [429, 60_000]]) {
      const redis = sharedRedis(), logs: unknown[] = []; let calls = 0;
      const transport: OpHttpTransport = { request: async () => { calls++; return { status: status!, body: JSON.stringify({ code: 199 }) }; } };
      await adapter(redis.command, transport, logs).getBalance().catch(() => undefined);
      await expect(adapter(redis.command, transport, logs).getBalance()).rejects.toMatchObject({ code: "openprovider_login_backoff" });
      expect(calls).toBe(1); redis.advance(wait! + 1); await adapter(redis.command, transport, logs).getBalance().catch(() => undefined); expect(calls).toBe(2);
    }
  });
  it("a late 401 cannot invalidate a replacement token, and expired owners cannot publish over a new owner", async () => {
    const redis = sharedRedis(), cache = new RedisOpenproviderLoginCache(redis.command);
    let finish: (token: string) => void = () => undefined;
    const first = cache.get(input, () => new Promise<string>((resolve) => { finish = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 0)); redis.advance(46_000);
    expect(await cache.get(input, async () => "replacement-token")).toBe("replacement-token");
    finish("late-token"); await expect(first).rejects.toMatchObject({ code: "openprovider_login_busy" });
    await cache.invalidate(input, "late-token");
    expect(await cache.get(input, async () => { throw new Error("must not login"); })).toBe("replacement-token");
  });
  it("provider host and contact isolate tokens; password rotation does not reuse a previous credential's bearer", async () => {
    const redis = sharedRedis(), cache = new RedisOpenproviderLoginCache(redis.command, async (ms) => redis.advance(ms));
    expect(await cache.get(input, async () => "production-token")).toBe("production-token");
    expect(await cache.get({ ...input, host: SANDBOX_URL }, async () => "sandbox-token")).toBe("sandbox-token");
    expect(await cache.get({ ...input, username: "different-contact" }, async () => "contact-token")).toBe("contact-token");
    expect(await cache.get({ ...input, password: "rotated-password" }, async () => "rotated-token")).toBe("rotated-token");
  });
  it("forced refreshes cannot exceed 29 provider-login starts in a rolling minute", async () => {
    const redis = sharedRedis(), cache = new RedisOpenproviderLoginCache(redis.command, async (ms) => redis.advance(ms));
    const starts: number[] = [];
    for (let i = 0; i < 40; i++) {
      const token = await cache.get(input, async () => { starts.push(redis.now()); return "token-" + i; });
      await cache.invalidate(input, token);
    }
    for (const start of starts) expect(starts.filter((t) => t >= start && t < start + 60_000).length).toBeLessThanOrEqual(29);
  });
  it("a delayed Redis admission reply cannot compress actual provider-login starts", async () => {
    const redis = sharedRedis(); let delayed = false;
    const command: RedisCommand = async (args) => {
      const result = await redis.command(args);
      if (!delayed && args[1] === ACQUIRE_LOGIN && Array.isArray(result) && result[0] === "owner") { delayed = true; redis.advance(4900); }
      return result;
    };
    const cache = new RedisOpenproviderLoginCache(command, async (ms) => redis.advance(ms)), starts: number[] = [];
    for (let i = 0; i < 2; i++) {
      const token = await cache.get(input, async () => { starts.push(redis.now()); redis.advance(20); return "token-" + i; });
      await cache.invalidate(input, token);
    }
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(2100);
  });
  it("unreachable Redis fails closed before any provider request", async () => {
    let calls = 0;
    const a = adapter(async () => { throw new Error("Redis secret-canary"); }, { request: async () => { calls++; throw new Error("must not call"); } }, []);
    const error = await a.getBalance().catch((e) => e);
    expect(error).toBeInstanceOf(RegistrarError); expect(error).toMatchObject({ code: "registrar_shared_store_unavailable", outcomeUnknown: false });
    expect(String(error)).not.toContain("secret-canary"); expect(calls).toBe(0);
  });
});
