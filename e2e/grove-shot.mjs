import { chromium } from "@playwright/test";
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: +(process.argv[3] ?? 1280), height: +(process.argv[4] ?? 720) } });
await p.goto("http://127.0.0.1:5173/"); await p.waitForFunction(() => window.__mh); await p.evaluate(() => window.__mh.pause());
await p.keyboard.press("Escape"); await p.getByRole("button", { name: "My grove" }).click();
await p.getByRole("button", { name: "Preview a sample grove" }).click();
await p.evaluate(() => window.__mh.step(8)); await p.waitForTimeout(300);
await p.screenshot({ path: process.argv[2] }); await b.close();
