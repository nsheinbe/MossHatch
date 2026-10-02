// Runs in the build after Vite (before the sitemap): share tags on every indexable page in dist, and in demo mode the permanent
// preview banner on every page, so the static pages (legal, fees, waitlist, errors) say the site is a preview too.
// index.html is already handled by the Vite config (the same helpers, so dev and build match). Usage: node scripts/site-pages.mjs apps/web/dist
import fs from "node:fs"; import path from "node:path";
import { bannerKind, siteMode, transformPage } from "./site-mode.mjs";
const dist = path.resolve(process.argv[2] ?? "apps/web/dist");
const mode = siteMode();
const kind = bannerKind();
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
let n = 0;
for (const f of walk(dist).filter((f) => f.endsWith(".html"))) {
  const rel = path.relative(dist, f);
  if (rel === "index.html" || rel === "debug.html") continue;
  const html = fs.readFileSync(f, "utf8");
  const out = transformPage(html, mode, rel.split(path.sep).join("/"), kind);
  if (out !== html) { fs.writeFileSync(f, out); n++; }
}
console.log(`site pages: ${mode} mode, ${kind} banner, ${n} pages updated`);
