// Serve apps/cards/dist the way apps/cards/vercel.json describes it: every header rule whose source matches, the /<name> rewrite to
// /<name>/index.html, and 404.html with status 404 for anything else. Used by the `cards` Playwright project.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const dist = path.resolve("apps/cards/dist");
const cfg = JSON.parse(fs.readFileSync("apps/cards/vercel.json", "utf8"));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".svg": "image/svg+xml", ".png": "image/png" };
const toRe = (src) => new RegExp("^" + src.replace(/\(\.\*\)/g, "(.*)") + "$");
const headersFor = (url) => Object.assign({}, ...cfg.headers.filter((h) => toRe(h.source).test(url)).map((h) => Object.fromEntries(h.headers.map((x) => [x.key, x.value]))));
const file = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
const SLUG = /^\/((?:[a-z0-9-]+\.)+[a-z0-9-]+)$/;
http.createServer((q, r) => {
  const url = decodeURIComponent(q.url.split("?")[0]);
  let p = path.join(dist, url); if (p.endsWith("/")) p += "index.html";
  if (!file(p) && SLUG.test(url)) p = path.join(dist, url, "index.html");
  const h = headersFor(url);
  if (!p.startsWith(dist) || !file(p)) { r.writeHead(404, { ...h, "Content-Type": types[".html"] }); return fs.createReadStream(path.join(dist, "404.html")).pipe(r); }
  r.writeHead(200, { ...h, "Content-Type": types[path.extname(p)] ?? "application/octet-stream" }); fs.createReadStream(p).pipe(r);
}).listen(+process.argv[2] || 4175, "127.0.0.1");
