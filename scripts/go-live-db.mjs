#!/usr/bin/env node
// Owner step (docs/GO-LIVE.md step 4): bring the production database up to date for the invite-only live shop, then print what the
// shop will see. Idempotent; run again any time.
//   DATABASE_URL_OWNER=postgres://<owner role>@<neon host>/<db> node scripts/go-live-db.mjs [--sell-gate-floor 500] [--status]
// 1. applies pending migrations (packages/db/migrations; 1120 adds the Openprovider price table and the live-access check);
// 2. publishes the legal documents in force (terms, registration agreement, ...) from apps/web/public/legal, so checkout can record acceptance;
// 3. with --sell-gate-floor N (cents), sets `sell_gate.min_funds_minor`: the default USD 250 floor refuses every order while the
//    Openprovider balance is USD 20 (dogfood: 500 = USD 5 keeps one .com, 11.98, inside a USD 20 balance);
// 4. prints migrations, price rows, documents, open tax regions and the money flags. Prints names and numbers only, never a secret.
// --status skips 1 to 3. Needs the owner (migrator) role: the runtime role cannot create tables or functions.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const statusOnly = process.argv.includes("--status");
const floor = arg("--sell-gate-floor");
if (floor !== undefined && !/^\d{1,7}$/.test(floor)) { console.error("--sell-gate-floor takes whole cents, for example 500"); process.exit(2); }
const url = process.env.DATABASE_URL_OWNER;
if (!url) { console.error("Set DATABASE_URL_OWNER to the owner (migrator) connection string."); process.exit(2); }
const { connect, migrate } = await import("../packages/db/src/index.ts");
const { syncDocuments } = await import("../packages/api/src/account/documents.ts");
const pool = connect(url, { max: 2 });
try {
  if (!statusOnly) {
    const applied = await migrate(pool);
    console.log(`migrations applied now: ${applied.length ? applied.join(", ") : "none (already current)"}`);
    const docs = await syncDocuments(pool, fileURLToPath(new URL("../apps/web/public/legal/", import.meta.url)));
    console.log(`documents in force: ${docs.map((d) => `${d.kind}${d.changed ? " (new version)" : ""}`).join(", ")}`);
    if (floor !== undefined) {
      await pool.query("insert into flags (name, value, updated_by, updated_at) values ('sell_gate.min_funds_minor', to_jsonb($1::int), 'go-live-db', now()) on conflict (name) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", [Number(floor)]);
      console.log(`sell_gate.min_funds_minor set to ${floor} cents`);
    }
  }
  const last = (await pool.query("select name from schema_migrations order by name desc limit 1")).rows[0]?.name ?? "none";
  console.log(`latest migration: ${last}`);
  const prices = (await pool.query("select tld, kind, amount_minor from wholesale_prices where registrar = 'openprovider' and effective_from <= now()::date order by tld, kind")).rows;
  console.log(`openprovider price rows: ${prices.length ? prices.map((p) => `${p.tld}/${p.kind} ${(Number(p.amount_minor) / 100).toFixed(2)}`).join(", ") : "NONE (migration 1120 missing)"}`);
  const docs = (await pool.query("select kind from document_versions where retired_at is null and effective_at <= now() order by kind")).rows.map((r) => r.kind);
  console.log(`documents in force: ${docs.length ? docs.join(", ") : "NONE (checkout answers documents_unavailable)"}`);
  console.log(`tax regions open: ${(await pool.query("select count(*)::int n from tax_regions where enabled")).rows[0].n}`);
  const flags = (await pool.query("select name, value from flags where name = any($1) order by name", [["orders_paused", "registrar_writes_paused", "limits.daily_registrations", "limits.total_live_registrations", "sell_gate.min_funds_minor"]])).rows;
  for (const f of flags) console.log(`flag ${f.name} = ${JSON.stringify(f.value)}`);
} finally { await pool.end(); }
