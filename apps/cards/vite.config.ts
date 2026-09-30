import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./src/generate.ts";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.join(appDir, ".site/pages");
const publicDir = path.join(appDir, ".site/public");

/**
 * hatchkind.com: static pages generated from the published-cards export at build time. No JavaScript is shipped: the pages are
 * HTML entries with one stylesheet, which Vite hashes for immutable caching.
 */
export default defineConfig(async ({ command }) => {
  const { inputs } = command === "build" ? await generate({ siteDir, publicDir, appDir, env: process.env }) : { inputs: {} };
  return {
    root: siteDir,
    publicDir,
    appType: "mpa" as const,
    build: {
      outDir: path.join(appDir, "dist"),
      emptyOutDir: true,
      target: "es2022",
      modulePreload: false,
      sourcemap: false,
      rollupOptions: { input: inputs },
    },
  };
});
