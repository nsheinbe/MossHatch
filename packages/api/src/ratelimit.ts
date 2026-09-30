import type { PoolClient } from "@mosshatch/db";
import type { AppContext } from "./ports.ts";

export interface Limit { bucket: string; max: number; windowSeconds: number }

/**
 * Fixed-window counters in Postgres (in-memory limits are useless on Vercel functions). The key is an HMAC of the
 * subject, never the address or text itself. Returns whether the request is allowed; callers decide whether a block
 * or only an alarm is right (a block never touches a cancel, revoke or freeze path).
 */
export async function hit(ctx: Pick<AppContext, "kms" | "clock">, c: PoolClient, subject: string, limit: Limit): Promise<{ allowed: boolean; count: number; retryAfterSeconds: number }> {
  const key = await ctx.kms.hmac("rate", Buffer.from(subject));
  const now = ctx.clock.now();
  const start = new Date(Math.floor(now.getTime() / (limit.windowSeconds * 1000)) * limit.windowSeconds * 1000);
  const r = await c.query(
    `insert into rate_counters (key_hash, bucket, window_start, count) values ($1,$2,$3,1)
     on conflict (key_hash, bucket, window_start) do update set count = rate_counters.count + 1 returning count`,
    [key, limit.bucket, start],
  );
  const count = r.rows[0].count as number;
  const retry = Math.max(1, Math.ceil((start.getTime() + limit.windowSeconds * 1000 - now.getTime()) / 1000));
  return { allowed: count <= limit.max, count, retryAfterSeconds: retry };
}

/** Read without incrementing (used by "never block redeem or cancel" paths that only want to alarm). */
export async function peek(ctx: Pick<AppContext, "kms" | "clock">, c: PoolClient, subject: string, limit: Limit): Promise<number> {
  const key = await ctx.kms.hmac("rate", Buffer.from(subject));
  const now = ctx.clock.now();
  const start = new Date(Math.floor(now.getTime() / (limit.windowSeconds * 1000)) * limit.windowSeconds * 1000);
  const r = await c.query("select count from rate_counters where key_hash = $1 and bucket = $2 and window_start = $3", [key, limit.bucket, start]);
  return r.rows[0]?.count ?? 0;
}

/** Delete expired counters (24 h TTL). Run by the cron role. */
export async function sweep(c: PoolClient, now: Date): Promise<number> {
  const r = await c.query("delete from rate_counters where window_start < $1", [new Date(now.getTime() - 24 * 3600 * 1000)]);
  return r.rowCount ?? 0;
}
