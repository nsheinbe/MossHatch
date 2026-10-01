// hatchkind.com build gate (ST-145, ST-21, budgets). Runs after `vite build` of apps/cards; any failure fails the build.
//   - no JavaScript at all: no .js file, no <script>, no inline event handler, and a CSP without script-src;
//   - links: only site-relative paths or the Mosshatch origin; images and styles from the site itself; nothing sets a cookie;
//   - search: a noindex card is in neither the gallery nor the sitemap; every card page has a report link;
//   - budgets (own targets): each page at most 6 kB gzip, the stylesheet at most 4 kB, fonts at most 60 kB;
//   - portraits: only computed SVGs under /img, never an uploaded raster image.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
const dist = path.resolve(process.argv[2] ?? "apps/cards/dist");
const webOrigin = (process.env.WEB_ORIGIN ?? "https://mosshatch.com").replace(/\/$/, "");
const cardsOrigin = (process.env.CARDS_ORIGIN ?? "https://hatchkind.com").replace(/\/$/, "");
const cfg = JSON.parse(fs.readFileSync(path.resolve("apps/cards/vercel.json"), "utf8"));
const fails = [];
const fail = (m) => fails.push(m);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(dist);
const rel = (f) => path.relative(dist, f);
const gz = (f) => zlib.gzipSync(fs.readFileSync(f), { level: 9 }).length;

for (const f of files) if (/\.(m?js|wasm)$/.test(f)) fail(`script file shipped: ${rel(f)}`);
const html = files.filter((f) => f.endsWith(".html"));
const sitemap = fs.readFileSync(path.join(dist, "sitemap.xml"), "utf8");
const gallery = fs.readFileSync(path.join(dist, "index.html"), "utf8");
for (const f of html) {
  const t = fs.readFileSync(f, "utf8");
  if (/<script\b/i.test(t)) fail(`${rel(f)}: <script>`);
  if (/\son[a-z]+\s*=/i.test(t)) fail(`${rel(f)}: inline event handler`);
  if (/javascript:/i.test(t)) fail(`${rel(f)}: javascript: URL`);
  // A canonical link names the page's own address; every other absolute link must go to the Mosshatch origin.
  for (const m of t.replace(/<link rel="canonical" href="[^"]*" \/>/g, (c) => (c.includes(`"${cardsOrigin}/`) ? "" : c)).matchAll(/\shref="([^"]*)"/g)) {
    const u = m[1];
    if (!(u.startsWith("/") && !u.startsWith("//")) && !u.startsWith("#") && !u.startsWith(webOrigin + "/")) fail(`${rel(f)}: outbound link ${u}`);
  }
  for (const m of t.matchAll(/\ssrc="([^"]*)"/g)) if (!m[1].startsWith("/") || m[1].startsWith("//")) fail(`${rel(f)}: foreign src ${m[1]}`);
  if (gz(f) > 6000) fail(`${rel(f)}: ${gz(f)} bytes gzip, budget 6000`);
  const slug = rel(f).split(path.sep)[0];
  const isCard = rel(f).endsWith(`${path.sep}index.html`) && slug !== "about" && slug.includes(".");
  if (isCard) {
    if (!t.includes(`href="${webOrigin}/report.html#cards"`)) fail(`${rel(f)}: no report link`);
    if (/<a [^>]*href="[^"]*\/\/[^"]*"[^>]*>[^<]*<span class="fqdn">/.test(t)) fail(`${rel(f)}: the name is a link`);
    const noindex = t.includes('<meta name="robots" content="noindex" />');
    if (noindex && sitemap.includes(`/${slug}/<`)) fail(`${slug}: noindex card in the sitemap`);
    if (noindex && gallery.includes(`href="/${slug}/"`)) fail(`${slug}: noindex card in the gallery`);
  }
}
for (const f of files.filter((f) => f.endsWith(".css"))) if (gz(f) > 4000) fail(`${rel(f)}: ${gz(f)} bytes gzip, budget 4000`);
// Portraits are computed from the name at build time (SVG); an uploaded image never ships (threat row 42, review fix).
for (const f of files.filter((f) => rel(f).startsWith(`img${path.sep}`))) if (!f.endsWith(".svg") || /<script|<foreignObject|<text|href=/i.test(fs.readFileSync(f, "utf8"))) fail(`${rel(f)}: a portrait must be a computed SVG with no script, text or link`);
const fonts = files.filter((f) => f.includes(`${path.sep}fonts${path.sep}`)).reduce((a, f) => a + fs.statSync(f).size, 0);
if (fonts > 60_000) fail(`fonts ${fonts} bytes, budget 60000`);
const headers = cfg.headers.flatMap((h) => h.headers);
const csp = headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
if (!csp.includes("default-src 'none'") || /script-src|unsafe-/.test(csp)) fail(`cards CSP must be default-src 'none' with no script-src: ${csp}`);
if (headers.some((h) => /set-cookie/i.test(h.key))) fail("a header sets a cookie");
if (!fs.existsSync(path.join(dist, ".well-known/security.txt"))) fail("no /.well-known/security.txt");
if (fails.length) { for (const m of fails) console.error(`cards: ${m}`); process.exit(1); }
console.log(`cards: ${html.length} pages, no script, links and budgets ok`);
