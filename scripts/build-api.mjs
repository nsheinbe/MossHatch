// Bundle the API (workspace TypeScript packages and all dependencies) into one ES module for the Vercel function.
// Vercel transpiles api/index.ts but does not follow imports into workspace source, so the function imports this bundle instead.
import { build } from "rolldown";

await build({
  input: "packages/api/src/boot.ts",
  platform: "node",
  external: ["pg-native"],
  output: { file: "api/_bundle.mjs", format: "esm", minify: false, sourcemap: false, banner: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warn",
});
console.log("api bundle written: api/_bundle.mjs");
