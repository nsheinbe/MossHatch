#!/usr/bin/env node
// Owner step (docs/GO-LIVE.md step 8a): the read-only live preflight. Run it after steps 1 to 7 and before the first purchase. It buys,
// changes and charges nothing: the registrar is asked for its health, its balance and a price per extension (through the same signed RPC
// and the same price guard the shop uses), and the Stripe key is probed on ids that cannot exist. Prints codes and numbers only.
//   DATABASE_URL=... REGISTRAR_RPC_URL=https://mosshatch-registrar.vercel.app REGISTRAR_RPC_SECRET=... STRIPE_SECRET_KEY=rk_live_... \
//     node scripts/live-preflight.mjs
// The values are the production ones from the `mosshatch` Vercel project (`vercel env pull --environment=production .env.preflight`,
// then `set -a; . ./.env.preflight; set +a`; delete the file afterwards). A part whose variables are missing is skipped and named.
// Exit code 0 only when every check passed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}
const env = process.env;
const { formatPreflight, registrarPreflight, stripeHttp, stripePreflight } = await import("../packages/api/src/golive/preflight.ts");
const checks = []; const skipped = [];

const dbUrl = env.DATABASE_URL_OWNER ?? env.DATABASE_URL;
if (!dbUrl || !env.REGISTRAR_RPC_URL || !env.REGISTRAR_RPC_SECRET) skipped.push("registrar and prices (set DATABASE_URL, REGISTRAR_RPC_URL and REGISTRAR_RPC_SECRET)");
else {
  const { connect } = await import("../packages/db/src/index.ts");
  const { configurePriceTables } = await import("../packages/api/src/pricing/registrar.ts");
  const { registrarFromEnv } = await import("../packages/api/src/domains/boot-wiring.ts");
  configurePriceTables({ MH_REGISTRAR_MODE: "live", MH_REGISTRAR_PROVIDER: "openprovider" });
  const pool = connect(dbUrl, { max: 1 });
  try {
    let registrar;
    try { registrar = await registrarFromEnv(env, { registrarMode: "live" }); }
    catch (e) { checks.push({ area: "registrar", name: "rpc", ok: false, detail: e?.reason ?? e?.name ?? "error" }); }
    if (registrar) {
      const c = await pool.connect();
      try { checks.push(...await registrarPreflight(c, registrar, new Date())); } finally { c.release(); }
    }
  } finally { await pool.end(); }
}

const key = env.STRIPE_SECRET_KEY ?? "";
if (!key) skipped.push("stripe (set STRIPE_SECRET_KEY)");
else checks.push(...await stripePreflight(stripeHttp(key), key));

const { text, ok } = formatPreflight(checks);
console.log(text);
for (const s of skipped) console.log(`skipped: ${s}`);
process.exit(ok && skipped.length === 0 ? 0 : 1);
