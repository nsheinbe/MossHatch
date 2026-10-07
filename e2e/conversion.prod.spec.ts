import {test,expect} from '@playwright/test';
import {axe} from './axe';
test('conversion: phone ideas are checked without sending the brief, the shortlist survives a reload, and checked .com alternatives remain usable',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.addInitScript(()=>{
  const original=HTMLCanvasElement.prototype.getContext;
  // @ts-expect-error test-only renderer fallback
  HTMLCanvasElement.prototype.getContext=function(t:string,...args:unknown[]){return t==='webgl2'?null:original.call(this,t,...args);};
 });
 const lookups:{url:string;body:string}[]=[];page.on('request',r=>{if(r.url().includes('/api/lookup'))lookups.push({url:r.url(),body:r.postData()??''});});
 await page.goto('/');
 await page.getByRole('button',{name:'Describe my idea',exact:true}).click();
 await page.getByLabel('What are you bringing to life?').fill("A memorable, friendly name for a children's art studio.");
 await page.getByRole('button',{name:'Find names'}).click();
 const ideas=page.getByRole('region',{name:'Name ideas'});
 await expect(ideas.getByText(/Each name was checked just now/)).toBeVisible({timeout:20_000});
 // AUD-D1: names are made on the page from what the brief is about; only those names travel, in request bodies, one lookup each.
 expect(lookups.length).toBeGreaterThan(0);expect(lookups.length).toBeLessThanOrEqual(6);
 for(const l of lookups){expect(l.url).not.toContain('name=');const name=JSON.parse(l.body).name as string;expect(name).toMatch(/^[a-z]{3,20}$/);expect(name).not.toMatch(/memorable|friendly|children|name/);}
 const idea=ideas.locator('button.chip').first();
 await expect(idea).toContainText('Current renewal');
 const ideaName=(await idea.getAttribute('aria-label'))!.split(',')[0]!;
 // AUD-D3: shortlist it; the list is kept in this tab through a reload, with today's price checked again on demand.
 await ideas.getByRole('button',{name:`Shortlist ${ideaName}`}).click();
 await expect(ideas.getByRole('button',{name:`Shortlist ${ideaName}`})).toHaveAttribute('aria-pressed','true');
 const shortlist=page.getByRole('region',{name:/^Your shortlist/});
 await expect(shortlist).toContainText(ideaName);
 await page.reload();
 await expect(shortlist).toContainText(ideaName);
 await expect(shortlist).toContainText("Check for today's price");
 await shortlist.getByRole('button',{name:`Check ${ideaName} now`}).click();
 await expect(shortlist.getByRole('button',{name:`Preview ${ideaName}`})).toBeVisible({timeout:15_000});
 // AUD-D2: a taken .com gets close variations, each checked, with a plain trademark reminder.
 await page.fill('#name-input','google');
 await expect(page.locator('.chip.taken')).toHaveCount(6);
 await page.getByRole('button',{name:'Find similar .com names'}).click();
 const alternatives=page.getByRole('region',{name:'Alternative .com names'});
 await expect(alternatives.getByText(/Each suggestion was checked/)).toBeVisible();
 expect(await alternatives.locator('button.chip').count()).toBeGreaterThan(0);
 await expect(alternatives.locator('button.chip').first()).toContainText('Current renewal');
 await expect(alternatives.getByText(/trademark/)).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 expect((await axe(page).analyze()).violations.map(v=>v.id)).toEqual([]);
});
