// Serve apps/web/dist with the headers from vercel.json, to test the enforced CSP locally.
// Like Vercel with cleanUrls: /x serves x.html, a directory serves its index.html, and a miss serves 404.html with status 404.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const dist = path.resolve("apps/web/dist");
const cfg = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
const base = Object.fromEntries(cfg.headers[0].headers.map((h) => [h.key, h.value]));
// The path rules after the first (Cache-Control for /api/*, /boot.js, /assets/*, /fonts/*), matched like serve-cards.mjs does.
const pathRules = cfg.headers.slice(1).map((h) => [new RegExp("^" + h.source.replace(/\(\.\*\)/g, "(.*)") + "$"), h.headers]);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".svg": "image/svg+xml", ".png": "image/png" };
const file = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
http.createServer((q, r) => {
  for (const [re, hs] of pathRules) if (re.test(decodeURIComponent(q.url.split("?")[0]))) for (const h of hs) r.setHeader(h.key, h.value);
  let p = path.join(dist, decodeURIComponent(q.url.split("?")[0])); if (p.endsWith("/")) p += "index.html";
  if (!p.startsWith(dist)) { r.writeHead(404); return r.end(); }
  if (!file(p) && file(p + ".html")) p += ".html";
  if (!file(p) && file(path.join(p, "index.html"))) p = path.join(p, "index.html");
  // vercel.json rewrites to the app shell (/device, /checkout/return), as Vercel applies them after the filesystem.
  if (!file(p) && (cfg.rewrites ?? []).some((w) => w.destination === "/index.html" && w.source === decodeURIComponent(q.url.split("?")[0]))) p = path.join(dist, "index.html");
  if (!file(p)) { r.writeHead(404, { ...base, "Content-Type": "text/html" }); return fs.createReadStream(path.join(dist, "404.html")).on("error", () => r.end()).pipe(r); }
  r.writeHead(200, { ...base, "Content-Type": types[path.extname(p)] ?? "application/octet-stream" }); fs.createReadStream(p).pipe(r);
}).listen(+process.argv[2] || 4173, "127.0.0.1");
