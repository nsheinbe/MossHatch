import { test, expect } from "@playwright/test";
import { axe } from "./axe";

// Only browser-local responses: no email, database, registrar or payment calls.
for (const width of [1280, 390]) {
  test(`waitlist draft survives dismissal and a failed submission at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const external: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
        external.push(url.origin); return route.abort();
      }
      if (url.pathname === "/api/waitlist") {
        bodies.push(route.request().postDataJSON());
        return route.fulfill(bodies.length === 1
          ? { status: 503, json: { error: { code: "delivery_unavailable" } } }
          : { status: 202, json: { accepted: true } });
      }
      if (url.pathname.startsWith("/api/")) {
        return route.fulfill({ status: 200, json: { results: [], signedIn: false } });
      }
      return route.continue();
    });
    await page.goto("/");
    await page.waitForSelector("html[data-booted='1']");
    await page.keyboard.press("Escape");
    const opener = page.locator('.demo-banner-cta');
    const dialog = page.getByRole("dialog", { name: "Join the waitlist", exact: true });
    await opener.click();
    await dialog.getByLabel("Email", { exact: true }).fill("draft@example.test");
    await dialog.getByLabel("The name you hatched (optional)").fill("moonfern.com");
    await dialog.getByText("One optional question", { exact: true }).click();
    await dialog.getByRole("radio", { name: "Maybe", exact: true }).check();
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Join the waitlist", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("We could not deliver your confirmation email");
    await page.screenshot({ path: test.info().outputPath(`error-${width}.png`), fullPage: true });
    for (const close of ["Escape", "Not now"]) {
      if (close === "Escape") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: close, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      await opener.click();
      await expect(dialog).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`reopened-${close}-${width}.png`), fullPage: true });
      await expect(dialog.getByLabel("Email", { exact: true })).toHaveValue("draft@example.test");
      await expect(dialog.getByLabel("The name you hatched (optional)")).toHaveValue("moonfern.com");
      await expect(dialog.getByRole("checkbox")).toBeChecked();
      await dialog.getByText("One optional question", { exact: true }).click();
      await expect(dialog.getByRole("radio", { name: "Maybe", exact: true })).toBeChecked();
    }
    expect((await axe(page).include("dialog").analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.getByRole("button", { name: "Join the waitlist", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Check your email", exact: true })).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await opener.click();
    await expect(dialog.getByLabel("Email", { exact: true })).toHaveValue("");
    await expect(dialog.getByRole("checkbox")).not.toBeChecked();
    // Reload clears unfinished personal details too: no browser persistence.
    await dialog.getByLabel("Email", { exact: true }).fill("unsent@example.test");
    await page.keyboard.press("Escape");
    await page.reload();
    await page.waitForSelector("html[data-booted='1']");
    await page.keyboard.press("Escape");
    await opener.click();
    await expect(dialog.getByLabel("Email", { exact: true })).toHaveValue("");
    expect(external).toEqual([]);
  });
}
