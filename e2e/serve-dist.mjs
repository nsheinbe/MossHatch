// Serve apps/web/dist with the headers from vercel.json, to test the enforced CSP locally.
// Like Vercel with cleanUrls: /x serves x.html, a directory serves its index.html, and a miss serves 404.html with status 404.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const dist = path.resolve("apps/web/dist");
const cfg = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
const base = Object.fromEntries(cfg.headers[0].headers.map((h) => [h.key, h.value]));
// The path rules after the first (Cache-Control for /api/*, /boot.js, /assets/*, /fonts/*), matched like serve-cards.mjs does.
const pathRules = cfg.headers.slice(1).map((h) => [new RegExp("^" + h.source.replace(/\(\.\*\)/g, "(.*)") + "$"), h.headers, h.has ?? []]);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".svg": "image/svg+xml", ".png": "image/png" };
const file = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
let lastWaitlist = null;
function fakeWaitlist(q, r) {
  if (q.method === "GET") { r.writeHead(200, { "Content-Type": "application/json" }); return r.end(JSON.stringify(lastWaitlist)); }
  let body = "";
  q.on("data", (c) => { body += c; if (body.length > 4096) q.destroy(); });
  q.on("end", () => {
    const form = (q.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded");
    let o = {};
    try { o = form ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body); } catch { o = {}; }
    const code = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email ?? "") ? "invalid_email" : !(form ? o.consent === "yes" : o.consent === true) ? "consent_required" : null;
    if (code) { r.writeHead(400, { "Content-Type": "application/json" }); return r.end(JSON.stringify({ error: { code } })); }
    if (!o.website) lastWaitlist = { ...o, form };
    if (form) { r.writeHead(303, { Location: "/waitlist-sent" }); return r.end(); }
    r.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" }); r.end(JSON.stringify({ ok: true }));
  });
}
http.createServer((q, r) => {
  const qs = new URLSearchParams(q.url.split("?")[1] ?? "");
  for (const [re, hs, has] of pathRules) if (re.test(decodeURIComponent(q.url.split("?")[0])) && has.every((c) => c.type === "query" && qs.has(c.key))) for (const h of hs) r.setHeader(h.key, h.value);
  // A fake of the standalone waitlist endpoint (packages/api/src/waitlist), for the prod e2e: same shapes, no database.
  if (q.url.split("?")[0] === "/api/waitlist" || q.url.startsWith("/__e2e/waitlist")) return fakeWaitlist(q, r);
  let p = path.join(dist, decodeURIComponent(q.url.split("?")[0])); if (p.endsWith("/")) p += "index.html";
  if (!p.startsWith(dist)) { r.writeHead(404); return r.end(); }
  if (!file(p) && file(p + ".html")) p += ".html";
  if (!file(p) && file(path.join(p, "index.html"))) p = path.join(p, "index.html");
  // vercel.json rewrites to the app shell (/device, /checkout/return), as Vercel applies them after the filesystem.
  if (!file(p) && (cfg.rewrites ?? []).some((w) => w.destination === "/index.html" && w.source === decodeURIComponent(q.url.split("?")[0]))) p = path.join(dist, "index.html");
  if (!file(p)) { r.writeHead(404, { ...base, "Content-Type": "text/html" }); return fs.createReadStream(path.join(dist, "404.html")).on("error", () => r.end()).pipe(r); }
  r.writeHead(200, { ...base, "Content-Type": types[path.extname(p)] ?? "application/octet-stream" }); fs.createReadStream(p).pipe(r);
}).listen(+process.argv[2] || 4173, "127.0.0.1");
