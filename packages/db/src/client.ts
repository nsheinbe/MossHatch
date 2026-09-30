import pg from "pg";
import type { Pool, PoolClient } from "pg";

export type { Pool, PoolClient };

// bigint columns arrive as strings by default; money helpers parse them explicitly with BigInt().
export function connect(connectionString: string, opts: { max?: number } = {}): Pool {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  // An idle client dropped by the server (failover, forced drop in tests) must not crash the process; the next query reconnects.
  pool.on("error", () => undefined);
  return pool;
}

/**
 * Run `fn` in a transaction as one tenant. The setting is transaction-local, so it cannot leak to the next
 * request on a pooled connection; with it unset every RLS policy returns no rows (fail closed).
 */
export async function withUser<T>(pool: Pool, userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("withUser: user id must be a uuid");
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.user_id', $1, true)", [userId]);
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** A transaction with no tenant set: only pre-auth definer functions and non-tenant tables are reachable. */
export async function withNoUser<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.user_id', '', true)");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Plain transaction for the cron/system role, which bypasses RLS by attribute. */
export async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
