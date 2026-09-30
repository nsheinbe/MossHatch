import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

export function listMigrations(dir = MIGRATIONS_DIR): { name: string; sql: string }[] {
  return fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), "utf8") }));
}

/** Apply pending migrations in order, each in its own transaction, serialised by an advisory lock. */
export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query("select pg_advisory_lock(727001)");
    await c.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await c.query("select name from schema_migrations")).rows.map((r) => r.name as string));
    for (const m of listMigrations(dir)) {
      if (done.has(m.name)) continue;
      await c.query("begin");
      try {
        await c.query(m.sql);
        await c.query("insert into schema_migrations (name) values ($1) on conflict do nothing", [m.name]);
        await c.query("commit");
        applied.push(m.name);
      } catch (e) {
        await c.query("rollback");
        throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.query("select pg_advisory_unlock(727001)").catch(() => undefined);
    c.release();
  }
  return applied;
}
