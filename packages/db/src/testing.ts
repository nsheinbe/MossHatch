import crypto from "node:crypto";
import pg from "pg";
import { listMigrations, migrate } from "./migrate.ts";
import { connect, type Pool } from "./client.ts";

export interface TestDb {
  name: string;
  /** Superuser: owner, bypasses everything. For fixtures and assertions only. */
  owner: Pool;
  /** The runtime role (RLS applies). */
  runtime: Pool;
  /** The cron/system role (BYPASSRLS, no audit update/delete). */
  cron: Pool;
  urlFor(role: "owner" | "runtime" | "cron"): string;
  drop(): Promise<void>;
}

const ADMIN = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";
const PASS = "mh_test_pw";

function withDb(url: string, db: string, user?: string): string {
  const u = new URL(url);
  u.pathname = "/" + db;
  if (user) { u.username = user; u.password = PASS; }
  return u.toString();
}

async function ensureLoginRoles(admin: pg.Client) {
  for (const [login, group] of [["mh_runtime_login", "mh_runtime"], ["mh_cron_login", "mh_cron"]] as const) {
    try {
      await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${login}') then create role ${login} login ${login === 'mh_cron_login' ? 'bypassrls' : ''} password '${PASS}'; end if; end $$`);
    } catch { /* another worker created it first */ }
    try { await admin.query(`alter role ${login} ${login === 'mh_cron_login' ? 'bypassrls' : 'nobypassrls'}`); } catch { /* concurrent */ }
    try { await admin.query(`grant ${group} to ${login}`); } catch { /* group not created yet; migration creates it, we retry below */ }
  }
}

/**
 * A migrated, isolated database per call, cloned from a template keyed by the migration contents.
 * Requires a local PostgreSQL (scripts/pg-local.sh start) or TEST_DATABASE_URL.
 */
export async function createTestDb(): Promise<TestDb> {
  const hash = crypto.createHash("sha1").update(listMigrations().map((m) => m.name + m.sql).join("\n")).digest("hex").slice(0, 10);
  const template = `mh_tpl_${hash}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  try {
    await admin.query("select pg_advisory_lock(727002)");
    const exists = (await admin.query("select 1 from pg_database where datname = $1", [template])).rowCount;
    if (!exists) {
      await admin.query(`create database ${template}`);
      const p = connect(withDb(ADMIN, template), { max: 2 });
      try { await migrate(p); } finally { await p.end(); }
    }
    await ensureLoginRoles(admin);
    await admin.query("select pg_advisory_unlock(727002)");
    const name = `mh_t_${crypto.randomBytes(5).toString("hex")}`;
    await admin.query(`create database ${name} template ${template}`);
    const t: TestDb = {
      name,
      owner: connect(withDb(ADMIN, name), { max: 4 }),
      runtime: connect(withDb(ADMIN, name, "mh_runtime_login"), { max: 20 }),
      cron: connect(withDb(ADMIN, name, "mh_cron_login"), { max: 20 }),
      urlFor: (r) => withDb(ADMIN, name, r === "owner" ? undefined : r === "runtime" ? "mh_runtime_login" : "mh_cron_login"),
      async drop() {
        await Promise.all([t.owner.end(), t.runtime.end(), t.cron.end()]);
        const a = new pg.Client({ connectionString: ADMIN });
        await a.connect();
        try { await a.query(`drop database if exists ${name} with (force)`); } finally { await a.end(); }
      },
    };
    return t;
  } finally {
    await admin.end();
  }
}
