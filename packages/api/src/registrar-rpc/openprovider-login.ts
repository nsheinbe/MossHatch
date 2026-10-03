import { createHash, randomUUID } from "node:crypto";
import { RegistrarError } from "@mosshatch/registrar/port";
import type { OpenproviderLoginCache } from "@mosshatch/registrar/openprovider";
import type { RedisCommand } from "./shared-store.ts";

export const LOGIN_LEASE_MS = 45_000; // default provider timeout 30s plus bounded Redis publication
export const LOGIN_SPACING_MS = 2_100; // at most 29 starts in any 60-second interval, below the provider's 30/min
export const AUTH_COOLDOWN_MS = 20 * 60_000;
export const LOGIN_RETRY_MS = 5_000;
export const TOKEN_TTL_MS = 12 * 3_600_000; // official token lifetime 48h; never refreshed on a cache read

export const ACQUIRE_LOGIN = `-- openprovider-login-acquire-v1
local cooldown = redis.call('GET', KEYS[4])
if cooldown then return {cooldown, ''} end
local cached = redis.call('GET', KEYS[1])
if cached then return {'token', cached} end
if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then return {'busy', ''} end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[3], '1', 'PX', ARGV[3])
return {'owner', ''}`;

export const FINISH_LOGIN = `-- openprovider-login-finish-v1
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
if ARGV[2] == 'token' then
  redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
else
  redis.call('SET', KEYS[4], ARGV[2], 'PX', ARGV[4])
end
redis.call('DEL', KEYS[2])
return 1`;

export const INVALIDATE_LOGIN = `-- openprovider-login-invalidate-v1
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

const failure = (code: string) => new RegistrarError("unavailable", "registrar login unavailable", { code, retryable: true, outcomeUnknown: false });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type LoginInput = { host: string; username: string; password: string; ttlMs?: number };

/** Trusted server Redis only. Keys contain digests; bearer values/passwords never enter an error or log. */
export class RedisOpenproviderLoginCache implements OpenproviderLoginCache {
  constructor(private redis: RedisCommand, private pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {}
  private keys(input: LoginInput): string[] {
    // Provider host separates sandbox/production. Exact username matches the provider's case-sensitive contact identity.
    const prefix = "mh:rpc:openprovider:{" + hash(JSON.stringify([input.host, input.username])) + "}:";
    // Rotation cannot reuse an old credential's bearer. Password itself is never stored; all keys share a Redis hash slot.
    return [prefix + "token:" + hash(input.password), prefix + "login", prefix + "spacing", prefix + "cooldown"];
  }
  private async command(args: (string | number)[]): Promise<unknown> {
    try { return await this.redis(args); } catch { throw failure("registrar_shared_store_unavailable"); }
  }
  async get(input: LoginInput & { ttlMs: number }, login: () => Promise<string>): Promise<string> {
    const keys = this.keys(input), owner = randomUUID();
    // Followers wait at most 2.5s, then return retryable busy work instead of holding a request through a slow login.
    for (let poll = 0; poll <= 5; poll++) {
      const result = await this.command(["EVAL", ACQUIRE_LOGIN, 4, ...keys, owner, LOGIN_LEASE_MS, LOGIN_SPACING_MS]);
      if (!Array.isArray(result) || result.length !== 2) throw failure("registrar_shared_store_unavailable");
      const [state, token] = result;
      if (state === "token") {
        if (typeof token !== "string" || !token || token.length > 16_384 || /[\x00-\x20\x7f]/.test(token)) throw failure("registrar_shared_store_unavailable");
        return token;
      }
      if (state === "auth") throw failure("openprovider_auth_cooldown");
      if (state === "retry" || state === "rate") throw failure("openprovider_login_backoff");
      if (state === "owner") {
        let token: string;
        try { token = await login(); }
        catch (error) {
          const code = error instanceof RegistrarError ? error.code : undefined;
          const auth = code === "auth_failed";
          const rate = code === "http_429";
          await this.command(["EVAL", FINISH_LOGIN, 4, ...keys, owner, auth ? "auth" : rate ? "rate" : "retry", "", auth ? AUTH_COOLDOWN_MS : rate ? 60_000 : LOGIN_RETRY_MS]);
          throw error;
        }
        const ttl = Number.isSafeInteger(input.ttlMs) && input.ttlMs > 0 ? Math.min(input.ttlMs, TOKEN_TTL_MS) : TOKEN_TTL_MS;
        if (await this.command(["EVAL", FINISH_LOGIN, 4, ...keys, owner, "token", token, ttl]) !== 1) throw failure("openprovider_login_busy");
        return token;
      }
      if (state !== "busy") throw failure("registrar_shared_store_unavailable");
      if (poll < 5) await this.pause(100 + poll * 200);
    }
    throw failure("openprovider_login_busy");
  }
  async invalidate(input: LoginInput, rejectedToken: string): Promise<void> {
    await this.command(["EVAL", INVALIDATE_LOGIN, 1, this.keys(input)[0]!, rejectedToken]);
  }
}
