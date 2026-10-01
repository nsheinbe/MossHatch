import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { axe } from "./axe";

/**
 * The public demo build (no accounts): after a practice hatch, "Talk to ..." opens the launcher's teaser. It never calls the model
 * or any launcher route, says it comes with launch, labels its example as an example, and is axe clean under the enforced CSP.
 */
test("demo visitors get the teaser, with no request to the launcher or the model", async ({ page }) => {
  test.setTimeout(180_000);
  const calls: string[] = [];
  const violations: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/v1/")) calls.push(u.pathname); });
  page.on("console", (m) => { if (/Content.Security.Policy|Trusted Type/i.test(m.text())) violations.push(m.text()); });
  await page.goto("/");
  await page.waitForSelector("html[data-booted='1']");
  await page.keyboard.press("Escape");
  await page.fill("#name-input", "emberwick");
  await expect(page.locator("button.chip").first()).toBeVisible({ timeout: 15000 });
  await page.locator("button.chip").first().press("Enter");
  const sheet = page.getByRole("region", { name: /^Hatch / });
  const domain = (await sheet.getByRole("heading", { level: 2 }).textContent())!.trim();
  await sheet.getByRole("button", { name: "Hatch", exact: true }).press("Enter");
  const card = page.getByRole("region", { name: `${domain} has hatched` });
  await expect(card).toBeVisible({ timeout: 120_000 });
  await card.getByRole("button", { name: /^Talk to / }).press("Enter");
  const panel = page.getByRole("region", { name: /^Talk to / });
  await expect(panel.getByRole("heading", { name: "Talk to your creature" })).toBeVisible();
  await expect(panel.getByText("Coming with launch")).toBeVisible();
  await expect(panel.getByRole("figure", { name: "Example conversation (not live)" })).toBeVisible();
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Join the waitlist" })).toBeVisible();
  expect((await axe(page).include(".lx").analyze()).violations.map((v) => v.id)).toEqual([]);
  if (process.env.LAUNCHER_SHOTS) { fs.mkdirSync(process.env.LAUNCHER_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.LAUNCHER_SHOTS, "0-teaser-demo.png") }); }
  await panel.getByRole("button", { name: "Back to the grove" }).click();
  await expect(panel).toBeHidden();
  expect(calls).toEqual([]);
  expect(violations).toEqual([]);
});
