#!/usr/bin/env node
// Owner-only waitlist numbers: sign-ups per day, confirmed rate, invited and accepted, top requested names and extensions, answers.
// Prints counts and hatched names only, never an email address. No public dashboard exists.
//   DATABASE_URL=postgres://... node scripts/waitlist-stats.mjs     (DATABASE_URL_CRON is used instead when set: the cron role reads the list)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// The library is TypeScript with parameter properties; Node needs the transform flag to load it.
if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}
const url = process.env.DATABASE_URL_CRON ?? process.env.DATABASE_URL;
if (!url) { console.error("Set DATABASE_URL (owner or cron role)."); process.exit(2); }
const { connect } = await import("../packages/db/src/index.ts");
const { waitlistStats, formatStats } = await import("../packages/api/src/waitlist/owner.ts");
const pool = connect(url, { max: 2 });
try { console.log(formatStats(await waitlistStats(pool))); }
finally { await pool.end(); }
