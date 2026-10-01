#!/usr/bin/env node
// Owner step (docs/GO-LIVE.md): create the four Stripe Products (register, renew, transfer, restore; packages/api/src/stripe/catalog.ts)
// in the mode of the key given. Idempotent: an existing Product is read back. Checkout refuses a Session that names a missing Product.
//   STRIPE_SECRET_KEY=rk_live_... node scripts/stripe-catalog.mjs
// The key needs Products write. It is read from the environment only and never printed. Prints product ids and whether each was new.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}
const key = process.env.STRIPE_SECRET_KEY ?? "";
const live = /^(sk|rk)_live_/.test(key), test = /^(sk|rk)_test_/.test(key);
if (!live && !test) { console.error("Set STRIPE_SECRET_KEY to a sk_/rk_ live or test key."); process.exit(2); }
const { StripeReal } = await import("../packages/api/src/stripe/real.ts");
const { ensureCatalog } = await import("../packages/api/src/stripe/catalog.ts");
// The mode guard wants the process to match the key: a live key is used as the production process would use it.
const stripe = new StripeReal(live
  ? { apiKey: key, mode: "production", registrarMode: "live", vercelEnv: "production" }
  : { apiKey: key, mode: "local", registrarMode: "mock" });
const out = await ensureCatalog(stripe);
for (const p of out) console.log(`${live ? "live" : "test"} ${p.id} ${p.created ? "created" : "already there"}`);
