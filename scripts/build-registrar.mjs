// Bundle the `registrar` Vercel project's one function (apps/registrar/api/index.ts): the signed RPC over the Openprovider adapter
// (packages/api/src/registrar-rpc/serve.ts) and nothing else. Run by that project's build command (apps/registrar/vercel.json).
import { build } from "rolldown";
import { readFileSync } from "node:fs";

await build({
  input: "packages/api/src/registrar-rpc/serve.ts",
  platform: "node",
  external: ["pg-native"],
  output: { file: "apps/registrar/api/_bundle.mjs", format: "esm", codeSplitting: false, minify: false, sourcemap: false, banner: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warn",
});
// The registrar project must never carry web, vault, database or Stripe code: refuse the build if any of it was pulled in.
const out = readFileSync("apps/registrar/api/_bundle.mjs", "utf8");
for (const marker of ["bootFromEnv", "installVault", "StripeReal", "node_modules/pg/", "node_modules/stripe/", "env.DATABASE_URL", "env.STRIPE_"]) {
  if (out.includes(marker)) { console.error(`registrar bundle contains ${marker}: the registrar project must hold the adapter and the RPC only`); process.exit(1); }
}
console.log("registrar bundle written: apps/registrar/api/_bundle.mjs");
