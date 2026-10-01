// Ad-hoc screenshot helper: node e2e/shot.mjs <url> <out.png> [w h] [actions]
import { chromium } from "@playwright/test";
const [url, out, w = "1280", h = "720", script = ""] = process.argv.slice(2);
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
p.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
p.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await p.goto(url);
await p.waitForTimeout(3500);
if (script) await eval(`(async()=>{${script}})()`.replace("(async()=>{", "(async()=>{const page=p;"));
await p.screenshot({ path: out });
console.log(logs.join("\n") || "no console output");
await b.close();
