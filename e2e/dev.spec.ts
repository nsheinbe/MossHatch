import { test, expect } from "@playwright/test";
import { axe } from "./axe";
import path from "node:path";
import { deriveTraits } from "../packages/core/src/index.ts";

const CORE = path.resolve(process.cwd(), "packages/core/src/index.ts");

declare global { interface Window { __mh: { world: { stats(): { calls: number; creatures: number; dpr: number } }; pause(): void; step(s: number, dt?: number): void } } }

const DOMAINS = ["moonfern.com", "lanternwick.ai", "tinkerdeep.dev", "marrowbrook.io", "hollowmint.app", "stillwater.studio", "MoonFern.com", "a-b.com"];

test("golden: the same domain hatches the same creature in the browser and in Node", async ({ page }) => {
  await page.goto("/");
  const inBrowser = await page.evaluate(async ({ ds, core }) => {
    const m = await import(/* @vite-ignore */ "/@fs" + core);
    return ds.map((d: string) => m.deriveTraits(d));
  }, { ds: DOMAINS, core: CORE });
  expect(inBrowser).toEqual(DOMAINS.map((d) => deriveTraits(d)));
});

test("hatch flow: sheet, sequence, card; axe clean at each step; grove receives the creature", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__mh);
  await page.evaluate(() => window.__mh.pause());
  await page.keyboard.press("Escape");
  await page.fill("#name-input", "emberwick");
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__mh.step(3));
  await page.locator("button.chip").first().click();
  const sheet = page.getByRole("region", { name: /^Hatch / });
  await expect(sheet).toBeVisible();
  expect((await axe(page).analyze()).violations.map((v) => v.id)).toEqual([]);
  await sheet.getByRole("button", { name: "Hatch", exact: true }).click();
  for (const s of [2.5, 0.8, 1.5, 3]) await page.evaluate((x) => window.__mh.step(x), s);
  const card = page.getByRole("region", { name: /has hatched$/ });
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card.getByRole("img")).toHaveAttribute("src", /^data:image\/png/);
  expect((await axe(page).analyze()).violations.map((v) => v.id)).toEqual([]);
  await card.getByRole("button", { name: "Hatch another" }).click();
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => window.__mh.world.stats().creatures)).toBeGreaterThanOrEqual(1);
});

for (const family of ["fox", "moth", "beetle", "koi", "app", "studio"]) {
  test(`draw calls stay within 60 on the debug page (${family})`, async ({ page }) => {
    await page.goto(`/debug.html?debug=states&family=${family}`);
    await page.waitForFunction(() => (window as any).__mh);
    await page.evaluate(() => window.__mh.pause());
    await page.evaluate(() => window.__mh.step(2));
    const s = await page.evaluate(() => window.__mh.world.stats());
    console.log(family, JSON.stringify(s));
    expect(s.creatures).toBeLessThanOrEqual(24);
    expect(s.calls).toBeLessThanOrEqual(60);
  });
}

test("DPR steps down when frames are slow", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__mh);
  await page.evaluate(() => window.__mh.pause());
  const before = await page.evaluate(() => window.__mh.world.stats().dpr);
  // 60 frames reported at 40 ms each
  await page.evaluate(() => { const w = (window as any).__mh.world; for (let i = 0; i < 60; i++) w.frame(0.016, 40); });
  const after = await page.evaluate(() => window.__mh.world.stats().dpr);
  expect(after).toBeLessThan(before);
});
