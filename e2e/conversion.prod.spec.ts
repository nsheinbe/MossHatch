import {test,expect} from '@playwright/test';
import {axe} from './axe';
test('conversion: phone ideas stay local and checked .com alternatives remain usable',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.addInitScript(()=>{
  const original=HTMLCanvasElement.prototype.getContext;
  // @ts-expect-error test-only renderer fallback
  HTMLCanvasElement.prototype.getContext=function(t:string,...args:unknown[]){return t==='webgl2'?null:original.call(this,t,...args);};
 });
 const lookups:string[]=[];page.on('request',r=>{if(r.url().includes('/api/lookup'))lookups.push(r.url());});
 await page.goto('/');
 await page.getByRole('button',{name:'Describe my idea',exact:true}).click();
 await page.getByLabel('What are you bringing to life?').fill('ceramic studio inspired by the coast');
 await page.getByRole('button',{name:'Find inspiration'}).click();
 await expect(page.locator('.idea-names button').first()).toBeVisible();
 expect(lookups).toEqual([]);
 await page.locator('.idea-names button').first().click();
 await expect(page.locator('.shop-results .chip').first()).toBeVisible();
 expect(lookups).toHaveLength(1);
 expect(lookups[0]).not.toContain('inspired');
 await page.fill('#name-input','google');
 await expect(page.locator('.chip.taken')).toHaveCount(6);
 await page.getByRole('button',{name:'Find similar .com names'}).click();
 const alternatives=page.getByRole('region',{name:'Alternative .com names'});
 await expect(alternatives.getByText(/Each suggestion was checked/)).toBeVisible();
 expect(await alternatives.locator('button.chip').count()).toBeGreaterThan(0);
 await expect(alternatives.locator('button.chip').first()).toContainText('Current renewal');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 expect((await axe(page).analyze()).violations.map(v=>v.id)).toEqual([]);
});
