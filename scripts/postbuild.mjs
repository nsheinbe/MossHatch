// Runs inside the build command: secret/debug scan, then size budgets. A failure here fails the deployment.
import { spawnSync } from "node:child_process";
const debugEntry = process.env.MOSSHATCH_DEBUG_ENTRY === "1";
const run = (args) => { const r = spawnSync("node", args, { stdio: "inherit" }); if (r.status !== 0) process.exit(r.status ?? 1); };
run(["scripts/scan-client-bundle.mjs", "apps/web/dist", "api/_bundle.mjs", ...(debugEntry ? [] : ["--forbid=debug=states,__mh"]), ...(process.env.SCAN_REQUIRE_ENV ? [`--require-env=${process.env.SCAN_REQUIRE_ENV}`] : [])]);
run(["scripts/check-budgets.mjs", "apps/web/dist"]);
// hatchkind.com (ST-21 covers apps/cards/dist too): the same secret scan, then its own gate (no script, links, budgets).
run(["scripts/scan-client-bundle.mjs", "apps/cards/dist", "--forbid=debug=states,__mh"]);
run(["scripts/check-cards.mjs", "apps/cards/dist"]);
if (debugEntry) console.log("note: debug entry included (preview build only)");
