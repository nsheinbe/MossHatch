#!/usr/bin/env node
// Owner-only launcher credits (docs/LAUNCHER.md "Money"): grant credits to an account, or show its balance. 1 credit = 1 US cent.
// Until Stripe credit packs exist (next work), this is how invited accounts get credits for builds.
//   DATABASE_URL=... node scripts/launcher-credits.mjs --email person@example.com --grant 1000 [--note "dogfood"]
//   DATABASE_URL=... node scripts/launcher-credits.mjs --email person@example.com
// Optional: DATABASE_URL_CRON (used instead of DATABASE_URL). A grant is 1..100000 cents and is a new ledger row (never an edit).
// Turn the launcher on or off: --enable / --disable (the `launcher_enabled` flag). Prints counts and cents only.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (k) => process.argv.includes(k);
const email = arg("--email")?.trim().toLowerCase(), amount = arg("--grant"), note = arg("--note");
const toggle = has("--enable") ? true : has("--disable") ? false : null;
if ((!email && toggle === null) || (amount !== undefined && !/^\d+$/.test(amount))) {
  console.error("Usage: launcher-credits.mjs --email address [--grant cents] [--note text] | --enable | --disable"); process.exit(2);
}
const url = process.env.DATABASE_URL_CRON ?? process.env.DATABASE_URL;
if (!url) { console.error("Set DATABASE_URL (owner or cron role)."); process.exit(2); }
const { connect, withNoUser } = await import("../packages/db/src/index.ts");
const { balance, grant } = await import("../packages/api/src/launcher/credits.ts");
const pool = connect(url, { max: 2 });
try {
  if (toggle !== null) {
    await pool.query("update flags set value = $1::jsonb, updated_by = 'owner', updated_at = now() where name = 'launcher_enabled'", [JSON.stringify(toggle)]);
    console.log(`launcher_enabled = ${toggle}`);
  }
  if (email) {
    const u = (await pool.query("select id from users where lower(email) = $1", [email])).rows[0];
    if (!u) { console.error("No account with that address."); process.exitCode = 1; }
    else {
      await withNoUser(pool, async (c) => {
        if (amount !== undefined) await grant(c, u.id, Number(amount), "owner-script", note);
        console.log(`${amount !== undefined ? `granted ${amount}, ` : ""}balance ${await balance(c, u.id)} credits`);
      });
    }
  }
} finally { await pool.end(); }
