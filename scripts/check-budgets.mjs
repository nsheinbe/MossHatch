// Bundle-size budgets on the production dist (gzip level 9). Plan 4.10: initial JS target 110 kB (hard 130), lazy scene chunk hard 150.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
const dist = path.resolve(process.argv[2] ?? "apps/web/dist");
const kb = (n) => n / 1000;
const gz = (f) => zlib.gzipSync(fs.readFileSync(f), { level: 9 }).length;
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const all = fs.readdirSync(path.join(dist, "assets")).map((f) => "assets/" + f);
let fail = false;
const check = (label, bytes, target, hard) => {
  const ok = kb(bytes) <= hard;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${kb(bytes).toFixed(1)} kB gzip (target ${target ?? "-"}, hard ${hard})`);
  if (!ok) fail = true;
};
const initJs = initial.filter((f) => f.endsWith(".js")).reduce((a, f) => a + gz(path.join(dist, f)), 0);
check("initial JS", initJs, 110, 130);
const lazy = all.filter((f) => f.endsWith(".js") && !initial.includes(f));
for (const f of lazy) check(`lazy chunk ${f.replace(/-[\w-]+\.js$/, "")}`, gz(path.join(dist, f)), null, 150);
const fonts = fs.readdirSync(path.join(dist, "fonts")).reduce((a, f) => a + fs.statSync(path.join(dist, "fonts", f)).size, 0);
check("fonts", fonts, 40, 60);
process.exit(fail ? 1 : 0);
