import type { NonceStore } from "./server.ts";

/**
 * The registrar project's shared state: the RPC nonces and the daily count of paid operations, kept in Redis so every function instance
 * sees the same values (an in-memory store bounds one instance only). The project still has no database, Stripe key or vault; Redis
 * holds nonce markers, counters, leases and a short-lived Openprovider bearer cache. It must remain private to the registrar project:
 * provider bearer values are secrets, never logged or exposed through RPC. No domain/contact records or passwords are stored.
 *
 * Reached over the Upstash Redis REST API with fetch (no client library): one POST per command, the command as a JSON array, the token as
 * a Bearer header. Environment (Production scope, Sensitive, in the `registrar` project only): UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN, or the KV_REST_API_URL and KV_REST_API_TOKEN names that the Vercel Marketplace integration sets.
 * Required when the registrar is live (`registrar_shared_store_missing`); everything fails closed when Redis cannot be reached.
 */
export class SharedStoreError extends Error { override name = "SharedStoreError"; }

export type RedisCommand = (args: (string | number)[]) => Promise<unknown>;

export function redisConfigFromEnv(env: Record<string, string | undefined>): { url: string; token: string } | null {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL; const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try { if (new URL(url).protocol !== "https:") return null; } catch { return null; }
  return { url, token };
}

export function redisRest(cfg: { url: string; token: string }, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): RedisCommand {
  return async (args) => {
    let res: Response;
    try {
      res = await fetchImpl(cfg.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify(args.map(String)) });
    } catch { throw new SharedStoreError("shared store unreachable"); }
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
    if (!res.ok || !body || typeof body !== "object" || body.error !== undefined || !("result" in body)) throw new SharedStoreError(`shared store refused (HTTP ${res.status})`);
    return body.result;
  };
}

const NONCE_PREFIX = "mh:rpc:nonce:";
const SPEND_PREFIX = "mh:rpc:spend:";

/** SET NX with an expiry: the first claim of a nonce wins on every instance. A store error throws (the server refuses the call). */
export class RedisNonceStore implements NonceStore {
  constructor(private redis: RedisCommand) {}
  async claim(nonce: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    const ttl = Math.max(1_000, expiresAtMs - nowMs);
    return (await this.redis(["SET", NONCE_PREFIX + nonce, "1", "NX", "PX", ttl])) === "OK";
  }
}

/** Counts paid operations per UTC day. `take` returns the count after this operation; the caller refuses when it is over the cap. */
export interface DailyCounter { take(day: string): number | Promise<number> }

export class MemoryDailyCounter implements DailyCounter {
  private day = ""; private used = 0;
  take(day: string): number { if (day !== this.day) { this.day = day; this.used = 0; } return ++this.used; }
}

export class RedisDailyCounter implements DailyCounter {
  constructor(private redis: RedisCommand) {}
  async take(day: string): Promise<number> {
    const key = SPEND_PREFIX + day;
    const n = Number(await this.redis(["INCR", key]));
    if (!Number.isInteger(n) || n < 1) throw new SharedStoreError("shared store returned a bad count");
    // Kept two days, so a clock edge at midnight still reads the right day. Set on the first take only; a failure here leaves the key
    // without an expiry (one small key a day), never a wrong count.
    if (n === 1) { try { await this.redis(["PEXPIRE", key, 2 * 86_400_000]); } catch { /* the count stands */ } }
    return n;
  }
}
