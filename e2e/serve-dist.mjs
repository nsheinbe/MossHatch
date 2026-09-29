// Serve apps/web/dist with the headers from vercel.json, to test the enforced CSP locally.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const dist = path.resolve("apps/web/dist");
const cfg = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
const base = Object.fromEntries(cfg.headers[0].headers.map((h) => [h.key, h.value]));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
http.createServer((q, r) => {
  let p = path.join(dist, q.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
  if (!p.startsWith(dist) || !fs.existsSync(p)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { ...base, "Content-Type": types[path.extname(p)] ?? "application/octet-stream" }); fs.createReadStream(p).pipe(r);
}).listen(+process.argv[2] || 4173, "127.0.0.1");
