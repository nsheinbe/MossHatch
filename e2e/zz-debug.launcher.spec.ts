import { test, expect, type Page } from "@playwright/test";
async function va(page: Page) { const cdp = await page.context().newCDPSession(page); await cdp.send("WebAuthn.enable"); await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }); }
test("dbg", async ({ page, request }) => {
  test.setTimeout(200_000);
  await va(page); await page.goto("/"); await page.waitForSelector("html[data-booted='1']"); await page.keyboard.press("Escape");
  const email = `dbg${Date.now()}@example.org`;
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("New here? Your email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const mail = await (await request.get(`/__dev/mail?to=${encodeURIComponent(email)}`)).json();
  const code = /\b(\d{8})\b/.exec(mail.find((m: { kind: string }) => m.kind === "signup.code").text)![1]!;
  await page.getByLabel("Eight-digit code").fill(code);
  await page.getByRole("button", { name: "Create my passkey" }).click();
  await page.getByRole("button", { name: "I saved them" }).click();
  await request.get(`/__dev/launcher-credits?email=${encodeURIComponent(email)}&cents=1000`);
  await page.reload(); await page.waitForSelector("html[data-booted='1']"); await page.keyboard.press("Escape");
  await page.fill("#name-input", "free-lantern");
  await page.locator("button.chip", { hasText: ".com" }).click();
  await page.getByRole("button", { name: "Practice hatch (nothing is bought)" }).click();
  await page.getByRole("button", { name: /^Talk to / }).click();
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => { const w = (window as any).__mh.world; const c = w.creatureById("free-lantern.com"); return { pos: c && [c.pos.x, c.pos.y, c.pos.z], grove: w.groveCreatures().map((g: any) => g.id), view: w.rig.view, bubble: (document.querySelector(".lx-bubble") as HTMLElement)?.style.transform, overlay: [...w.overlay.keys()] }; });
  console.log(JSON.stringify(info));
  await page.screenshot({ path: process.env.DBG + "/a.png" });
});
