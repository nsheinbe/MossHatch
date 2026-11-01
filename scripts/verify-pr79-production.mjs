import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
const origin = 'https://mosshatch.com';
await fs.mkdir('static-ui-evidence', {recursive:true});
const label = process.env.ACCEPT_LABEL ?? 'production';
const browser = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const evidence = [];
try {
  for (const width of [1280,390]) {
    const ctx = await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce',serviceWorkers:'block'});
    const sent = [], intercepted = [];
    await ctx.route('**/*', async route => {
      const req = route.request(), u = new URL(req.url());
      // Only source-verified static resources may reach the production origin. All API responses are local fixtures.
      if (u.origin === origin && u.pathname === '/api/lookup') {
        intercepted.push(u.pathname);
        return route.fulfill({json:{results:['com','dev','app','studio','ai','io'].map(tld=>({tld,status:'unknown'}))}});
      }
      if (u.pathname.startsWith('/api/')) {
        intercepted.push(u.pathname);
        return route.fulfill({json:{signedIn:false,results:[]}});
      }
      if (u.origin === origin && req.method() === 'GET' &&
          (u.pathname === '/' || u.pathname === '/boot.js' || /^\/(assets|fonts)\//.test(u.pathname) || /^\/favicon\./.test(u.pathname))) {
        sent.push(u.pathname); return route.continue();
      }
      intercepted.push(u.pathname); return route.abort();
    });
    const page = await ctx.newPage();
    const res = await page.goto(origin + '/');
    expect(res.status()).toBe(200);
    await page.waitForSelector("html[data-booted='1']");
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-help')).toBeVisible();
    await expect(page.locator('#search-help')).toContainText('Choose a match');
    await page.screenshot({path:`static-ui-evidence/${label}-opening-${width}.png`,fullPage:true});
    const input = page.getByRole('textbox',{name:'What will you name it?'});
    await input.fill('acceptance-fixture.com');
    await expect(page.locator('.search-status')).toContainText('No availability confirmed');
    await expect(input).toHaveValue('acceptance-fixture.com');
    await expect(page.getByRole('button',{name:'Try again',exact:true})).toBeVisible();
    await page.screenshot({path:`static-ui-evidence/${label}-recovery-${width}.png`,fullPage:true});
    await page.locator('.demo-banner-cta').click();
    const dialog=page.getByRole('dialog',{name:'Join the waitlist',exact:true});
    await dialog.getByLabel('Email',{exact:true}).fill('acceptance@example.test');
    await page.keyboard.press('Escape');
    await page.locator('.demo-banner-cta').click();
    await expect(dialog.getByLabel('Email',{exact:true})).toHaveValue('acceptance@example.test');
    await expect(dialog).toContainText('Reloading clears them');
    await page.screenshot({path:`static-ui-evidence/${label}-draft-${width}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    evidence.push({width,status:res.status(),expectedProductionSha:process.env.EXPECTED_PRODUCTION_SHA,sent,intercepted,apiScope:'browser fixtures only; no live backend verification'});
    await ctx.close();
  }
  await fs.writeFile(`static-ui-evidence/${label}-acceptance.json`,JSON.stringify(evidence,null,2));
  console.log('PASS: deployed static UI at desktop/mobile; all API and analytics requests intercepted');
} finally { await browser.close(); }
