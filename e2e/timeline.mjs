// node e2e/timeline.mjs <url> <outprefix> <w> <h> t1,t2,...   (seconds since load)
import { chromium } from "@playwright/test";
const [url, prefix, w = "1280", h = "720", times = "5,8,10,12"] = process.argv.slice(2);
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
p.on("console", (m) => { if (m.type() !== "debug" && !m.text().includes("DevTools")) logs.push(`[${m.type()}] ${m.text()}`); });
p.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await p.goto(url);
const t0 = Date.now();
for (const t of times.split(",").map(Number)) {
  const wait = t * 1000 - (Date.now() - t0);
  if (wait > 0) await p.waitForTimeout(wait);
  await p.screenshot({ path: `${prefix}-${t}.png` });
}
console.log(logs.join("\n") || "no console output");
await b.close();
