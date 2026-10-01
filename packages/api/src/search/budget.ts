import type { PoolClient } from "@mosshatch/db";

/**
 * Global registrar lookup budget, shared by every function instance through Postgres (PLAN.md 4.3b "Availability search at scale").
 * Split 70% search and 30% checkout, renewals and agents, so searching can never starve the authoritative checkout check.
 * One row per pool per UTC day; no names, addresses or search text are stored. The daily total is a flag and its seeded value is a
 * PLACEHOLDER until the fee threshold is agreed in writing with OpenSRS (the plan sets the ceiling at 50% of that threshold).
 */
export type BudgetPool = "search" | "checkout";
export const SEARCH_SHARE_PCT = 70;
export const DEFAULT_DAILY_BUDGET = 20000;

export async function dailyBudget(c: PoolClient): Promise<number> {
  const v = (await c.query("select value from flags where name = 'limits.lookup_budget_daily'")).rows[0]?.value;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : DEFAULT_DAILY_BUDGET;
}
export function poolLimits(total: number): Record<BudgetPool, number> {
  const search = Math.floor((total * SEARCH_SHARE_PCT) / 100);
  return { search, checkout: total - search };
}

/** Atomically take `n` lookups from a pool. False (nothing taken) when the pool would go over its share. */
export async function reserveLookups(c: PoolClient, pool: BudgetPool, n: number, now: Date): Promise<boolean> {
  if (n <= 0) return true;
  const limit = poolLimits(await dailyBudget(c))[pool];
  if (n > limit) return false;
  const day = now.toISOString().slice(0, 10);
  const r = await c.query(
    `insert into lookup_budget (pool, day, used) values ($1, $2::date, $3)
     on conflict (pool, day) do update set used = lookup_budget.used + $3 where lookup_budget.used + $3 <= $4
     returning used`,
    [pool, day, n, limit],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function budgetUsed(c: PoolClient, now: Date): Promise<Record<BudgetPool, number>> {
  const r = await c.query("select pool, used from lookup_budget where day = $1::date", [now.toISOString().slice(0, 10)]);
  const out: Record<BudgetPool, number> = { search: 0, checkout: 0 };
  for (const row of r.rows) out[row.pool as BudgetPool] = row.used as number;
  return out;
}
