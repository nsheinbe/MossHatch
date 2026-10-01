import type { PoolClient } from "@mosshatch/db";

/**
 * Launcher credits (docs/LAUNCHER.md "Money"): an append-only ledger in US cents. The balance is the sum of the account's rows; a
 * build is charged once and refunded at most once (unique index on build and kind), so retries and repeated polls cannot move money
 * twice. Every function runs inside the caller's transaction (`withUser` for the account's own rows; the cron role for grants).
 */

export async function balance(c: PoolClient, userId: string): Promise<number> {
  const r = await c.query("select coalesce(sum(delta_minor), 0)::bigint as b from launcher_credits where user_id = $1", [userId]);
  return Number(r.rows[0].b);
}

/** Serialise money moves for one account (and, for the global fuse, for everyone) until the transaction ends. */
export async function lockAccount(c: PoolClient, userId: string): Promise<void> {
  await c.query("select pg_advisory_xact_lock(hashtextextended('launcher:' || $1, 0))", [userId]);
}
export async function lockGlobal(c: PoolClient): Promise<void> {
  await c.query("select pg_advisory_xact_lock(hashtextextended('launcher:global', 0))");
}

/** Charge a confirmed build. Returns false when this build was already charged (an idempotent retry). */
export async function charge(c: PoolClient, userId: string, buildId: string, amountMinor: number): Promise<boolean> {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("charge must be a positive whole number of cents");
  const r = await c.query(
    "insert into launcher_credits (user_id, delta_minor, kind, build_id, created_by) values ($1, $2, 'charge', $3, 'system') on conflict (build_id, kind) where build_id is not null do nothing",
    [userId, -amountMinor, buildId]);
  return (r.rowCount ?? 0) === 1;
}

/**
 * Give back exactly what the build was charged, once. Returns the amount refunded (0 when there was no charge, or it was already
 * refunded).
 */
export async function refund(c: PoolClient, userId: string, buildId: string, note?: string): Promise<number> {
  // What the build still holds: its charge less any settlement already given back.
  const ch = (await c.query("select coalesce(-sum(delta_minor), 0)::bigint as amount from launcher_credits where build_id = $1 and kind in ('charge', 'adjust')", [buildId])).rows[0];
  const amount = Number(ch?.amount ?? 0);
  if (amount <= 0) return 0;
  const r = await c.query(
    "insert into launcher_credits (user_id, delta_minor, kind, build_id, created_by, note) values ($1, $2, 'refund', $3, 'system', $4) on conflict (build_id, kind) where build_id is not null do nothing",
    [userId, amount, buildId, note ?? null]);
  return (r.rowCount ?? 0) === 1 ? amount : 0;
}

/**
 * Slate charges at most its quote. When a ready build cost less, give the difference back (with the same markup), once. Returns the
 * credits returned.
 */
export async function settle(c: PoolClient, userId: string, buildId: string, chargedMinor: number, finalMinor: number): Promise<number> {
  const back = chargedMinor - finalMinor;
  if (!Number.isSafeInteger(back) || back <= 0) return 0;
  const r = await c.query(
    "insert into launcher_credits (user_id, delta_minor, kind, build_id, created_by, note) values ($1, $2, 'adjust', $3, 'system', 'builder charged less than quoted') on conflict (build_id, kind) where build_id is not null do nothing",
    [userId, back, buildId]);
  return (r.rowCount ?? 0) === 1 ? back : 0;
}

/** Owner-granted credits (scripts/launcher-credits.mjs, cron role). */
export async function grant(c: PoolClient, userId: string, amountMinor: number, by: string, note?: string): Promise<void> {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 100_000) throw new Error("grant must be 1..100000 cents");
  await c.query("insert into launcher_credits (user_id, delta_minor, kind, created_by, note) values ($1, $2, 'grant', $3, $4)", [userId, amountMinor, by, note ?? null]);
}

/** Charges net of refunds across every account for builds confirmed on this UTC day (the global spend fuse). */
export async function spendOn(c: PoolClient, day: Date): Promise<number> {
  return Number((await c.query("select launcher_spend_on($1::date) as s", [day.toISOString().slice(0, 10)])).rows[0].s);
}

/** Builds this account confirmed on this UTC day (refunded ones count: the cap bounds attempts, not results). */
export async function buildsOn(c: PoolClient, userId: string, day: Date): Promise<number> {
  const d = day.toISOString().slice(0, 10);
  return Number((await c.query("select count(*)::int as n from launcher_builds where user_id = $1 and confirmed_at >= $2::date and confirmed_at < $2::date + 1", [userId, d])).rows[0].n);
}
