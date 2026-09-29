import { chromium } from "@playwright/test";
const [prefix, w = "1280", h = "720"] = process.argv.slice(2);
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
p.on("console", (m) => { if (m.type() !== "debug" && !m.text().includes("DevTools")) logs.push(`[${m.type()}] ${m.text()}`); });
p.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await p.goto("http://127.0.0.1:5173/");
await p.waitForFunction(() => window.__mh);
await p.evaluate(() => window.__mh.pause());
await p.keyboard.press("Escape"); // cancels the demo
await p.fill("#name-input", "emberwick");
await p.waitForTimeout(600);
await p.evaluate(() => window.__mh.step(3));
await p.screenshot({ path: `${prefix}-a-eggs.png` });
await p.click("button.chip >> nth=0");
await p.screenshot({ path: `${prefix}-b-sheet.png` });
await p.getByRole("button", { name: "Hatch", exact: true }).click();
for (const [name, secs] of [["c-wobble", 2.2], ["d-burst", 0.35], ["e-birth", 0.5], ["f-hop", 0.7], ["g-land", 1.5], ["h-card", 2.5]]) {
  await p.evaluate((s) => window.__mh.step(s), secs);
  await p.waitForTimeout(150);
  await p.screenshot({ path: `${prefix}-${name}.png` });
}
console.log(logs.join("\n") || "no console output");
await b.close();
