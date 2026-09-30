// Writes sitemap.xml and robots.txt for mosshatch.com into apps/web/dist. The sitemap lists the pre-rendered public pages that are
// indexable (no robots noindex), under their clean URLs (vercel.json cleanUrls). D-035: the Find page and the public pages only.
import fs from "node:fs"; import path from "node:path";
const dist = path.resolve(process.argv[2] ?? "apps/web/dist");
const origin = (process.env.WEB_ORIGIN ?? "https://mosshatch.com").replace(/\/$/, "");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const clean = (rel) => "/" + rel.split(path.sep).join("/").replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "");
const pages = walk(dist).filter((f) => f.endsWith(".html"))
  .filter((f) => !/(^|\/)(404|500|debug)\.html$/.test(f))
  .filter((f) => !/<meta name="robots" content="[^"]*noindex/.test(fs.readFileSync(f, "utf8")))
  .map((f) => clean(path.relative(dist, f))).sort();
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `<url><loc>${origin}${p}</loc></url>`).join("\n")}\n</urlset>\n`;
fs.writeFileSync(path.join(dist, "sitemap.xml"), xml);
fs.writeFileSync(path.join(dist, "robots.txt"), `User-agent: *\nDisallow: /api/\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
console.log(`sitemap: ${pages.length} pages`);
