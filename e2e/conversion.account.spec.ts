import { test, expect, type Page } from "@playwright/test";
import { axe } from "./axe";

/**
 * Sign up with a passkey, fill the registrant contact, accept the terms, pay on (fake) Checkout, and watch the name hatch.
 * Runs against the real API router on a local PostgreSQL with FakeStripe and a recording mailbox (see scripts/e2e-server.mjs).
 */
async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}

async function signUp(page: Page, request: import("@playwright/test").APIRequestContext, email: string) {
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("New here? Your email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByLabel("Eight-digit code")).toBeVisible();
  const mail = await (await request.get(`/__dev/mail?to=${encodeURIComponent(email)}`)).json();
  const code = /\b(\d{8})\b/.exec(mail.find((m: { kind: string }) => m.kind === "signup.code").text)![1]!;
  await page.getByLabel("Eight-digit code").fill(code);
  await page.getByRole("button", { name: "Create my passkey" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  await page.getByRole("button", { name: "I saved them" }).click();
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
}


test("conversion: no-WebGL checkout rejects unconfirmed and expired quotes, recovers, and reuses a lost-response attempt",async({page,request})=>{
 test.setTimeout(120000);
 await page.addInitScript(()=>{
  const original=HTMLCanvasElement.prototype.getContext;
  // @ts-expect-error test-only renderer fallback
  HTMLCanvasElement.prototype.getContext=function(t:string,...args:unknown[]){return t==='webgl2'?null:original.call(this,t,...args);};
 });
 await virtualAuthenticator(page);
 await page.goto('/');
 await signUp(page,request,`conversion${Date.now()}@example.org`);
 let quoteMode:'unknown'|'expired'|'ok'='unknown';
 await page.route('**/api/v1/quote',async route=>{
  const response=await route.fetch();const data=await response.json();
  if(quoteMode==='unknown')data.availability.kind='unknown';
  if(quoteMode==='expired')data.quote.expires_at=new Date(Date.now()-1000).toISOString();
  await route.fulfill({response,json:data});
 });
 await page.fill('#name-input','free-conversion-proof');
 await page.locator('button.chip',{hasText:'.com'}).click();
 const sheet=page.getByRole('region',{name:'Hatch free-conversion-proof.com'});
 const pay=sheet.getByRole('button',{name:/Buy domain & hatch/});
 await expect(sheet.getByText(/couldn't confirm this name and price/)).toBeVisible();
 await expect(pay).toBeDisabled();
 quoteMode='expired';
 await sheet.getByRole('button',{name:'Refresh checkout'}).click();
 await expect(sheet.getByText(/This quote expired/)).toBeVisible();
 await expect(pay).toBeDisabled();
 quoteMode='ok';
 await sheet.getByRole('button',{name:'Refresh checkout'}).click();
 for(const [label,value] of [['Full name','Ada Moss'],['Phone','+1.5555550100'],['Street address','1 Fern Lane'],['City','Portland'],['State or region','OR'],['Postal code','97201']] as const)await sheet.getByLabel(label).fill(value);
 await sheet.getByRole('button',{name:'Save contact'}).click();
 await expect(pay).toBeDisabled();
 await sheet.getByLabel(/I accept the/).check();
 await expect(pay).toBeEnabled();
 expect((await axe(page).include('.checkout-sheet').analyze()).violations.map(v=>v.id)).toEqual([]);
 const keys:string[]=[],ids:string[]=[];
 await page.route('**/api/v1/orders',async route=>{
  if(route.request().method()!=='POST')return route.continue();
  keys.push(route.request().headers()['idempotency-key']!);
  const response=await route.fetch();const body=await response.json();ids.push(body.order_id);
  if(keys.length===1)return route.fulfill({status:503,json:{error:{code:'unavailable'}}});
  await route.fulfill({response,json:body});
 });
 await page.route('https://checkout.stripe.test/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<h1>Checkout handoff</h1>'}));
 await pay.click();
 await expect(sheet.getByRole('alert').filter({hasText:'Retrying the same request'})).toBeVisible();
 await pay.click();
 await expect(page.getByRole('heading',{name:'Checkout handoff'})).toBeVisible();
 expect(keys).toHaveLength(2);expect(keys[0]).toBeTruthy();expect(keys[1]).toBe(keys[0]);
 expect(ids[0]).toBeTruthy();expect(ids[1]).toBe(ids[0]);
});
