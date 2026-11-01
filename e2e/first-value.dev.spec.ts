import { test, expect } from "@playwright/test";
import { axe } from "./axe";

for (const width of [1280, 390]) {
  test(`search explains the first useful action and recovers without losing the name at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const external: string[] = [], shopCalls: string[] = [];
    const lookups: unknown[] = [];
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
        external.push(url.origin); return route.abort();
      }
      if (url.pathname === "/api/lookup") {
        lookups.push(route.request().postDataJSON());
        if (lookups.length === 1) await pending;
        return route.fulfill({ json: { results: ["com", "dev", "app", "studio", "ai", "io"].map(tld => ({ tld,
          status: lookups.length === 1 ? "unknown" : tld === "com" ? "unregistered" : "registered" })) } });
      }
      if (url.pathname.startsWith("/api/")) {
        shopCalls.push(url.pathname);
        return route.fulfill({ json: { signedIn: false } });
      }
      return route.continue();
    });
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "What will you name it?" });
    await expect(input).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`opening-${width}.png`), fullPage: true });
    // Collect the entire baseline journey before checking the new guidance.
    const guidanceVisible = await page.locator(".shop-intro > p").isVisible();
    const openingText = await page.locator(".shop-intro > p").innerText();
    await input.fill("firstfern.com");
    await expect(page.locator(".search-status")).toHaveText("Checking availability…");
    await expect.poll(() => lookups.length).toBe(1);
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath(`pending-${width}.png`), fullPage: true });
    release();
    await expect(page.getByRole("alert")).toContainText("We couldn't check these names");
    const errorStatus = await page.locator(".search-status").innerText();
    await page.screenshot({ path: test.info().outputPath(`error-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    const match = page.getByRole("button", { name: /^firstfern.com, / });
    await expect(match).toBeVisible();
    await expect(input).toHaveValue("firstfern.com");
    await expect(match).toContainText("reference price from 8 Oct 2026");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "Shortlist firstfern.com", exact: true }).click();
    await expect(page.locator(".shortlist")).toContainText("firstfern.com");
    await page.screenshot({ path: test.info().outputPath(`result-${width}.png`), fullPage: true });
    const resultStatus = await page.locator(".search-status").innerText();
    expect((await axe(page).include(".shop-find").analyze()).violations).toEqual([]);
    await match.click();
    const sheet = page.getByRole("region", { name: "Hatch firstfern.com" });
    await expect(sheet).toContainText("A practice hatch does not purchase or reserve this name");
    await expect(sheet.getByRole("button", { name: "Preview creature", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /Buy domain/ })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Keep exploring", exact: true }).click();
    await expect(input).toHaveValue("firstfern.com");
    expect(lookups).toEqual([{ name: "firstfern" }, { name: "firstfern" }]);
    expect(shopCalls.filter(p => /\/(search|quote|orders)/.test(p))).toEqual([]);
    expect(external).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect.soft(guidanceVisible, "first-action guidance is visible on every viewport").toBe(true);
    expect.soft(openingText).toContain("Choose a match");
    expect.soft(errorStatus).not.toContain("0 potential matches found");
    expect.soft(resultStatus).toContain("Choose a match");
  });
}
