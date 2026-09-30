// Build the published CLI: one ES module file with no dependencies, and its SHA-256 beside it (PLAN 4.5: one bundled
// file with a published SHA-256). `--ci-only` (the prepublishOnly hook) refuses to run outside a tagged GitHub Actions run.
import { build } from "rolldown";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv.includes("--ci-only") && !(process.env.GITHUB_ACTIONS === "true" && /^refs\/tags\/cli-v\d+\.\d+\.\d+$/.test(process.env.GITHUB_REF ?? ""))) {
  console.error("The CLI is published only from CI, from a cli-vX.Y.Z tag.");
  process.exit(1);
}
const outDir = process.env.MOSSHATCH_CLI_OUT ?? path.join(here, "dist");
const file = path.join(outDir, "mosshatch.mjs");
await build({
  input: path.join(here, "src/main.ts"),
  platform: "node",
  // The keychain module is optional and never bundled: it is loaded only when installed beside the CLI.
  external: ["@napi-rs/keyring", /^node:/],
  output: { file, format: "esm", codeSplitting: false, minify: false, sourcemap: false },
  logLevel: "warn",
});
let src = fs.readFileSync(file, "utf8");
// Keep exactly one shebang (the entry file has its own).
src = "#!/usr/bin/env node\n" + src.replace(/^(#!.*\n)+/gm, "");
fs.writeFileSync(file, src, { mode: 0o755 });
const sum = crypto.createHash("sha256").update(src).digest("hex");
fs.writeFileSync(file + ".sha256", `${sum}  mosshatch.mjs\n`);
console.log(`cli bundle written: ${path.relative(process.cwd(), file)} sha256 ${sum}`);
