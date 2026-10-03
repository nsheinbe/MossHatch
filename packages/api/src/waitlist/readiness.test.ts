import {it,expect} from 'vitest';
import {handleWaitlist,waitlistSenderConfigured} from './http.ts';
const url='https://mosshatch.test/api/waitlist';
it('never writes a signup without a configured sender, even when a database URL exists',async()=>{
  const r=await handleWaitlist(new Request(url,{method:'POST',body:'{}'}),{DATABASE_URL:'postgres://unused.invalid/test'});
  expect(r!.status).toBe(503);
  expect(await r!.json()).toEqual({error:{code:'not_configured',reason:'email_not_configured'}});
});
it('reports configuration readiness without database access or email sends',async()=>{
  for(const env of [{},{DATABASE_URL:'postgres://unused.invalid/test'},{DATABASE_URL:'postgres://unused.invalid/test',RESEND_API_KEY:'fixture'}, {DATABASE_URL:'postgres://unused.invalid/test',RESEND_API_KEY:'fixture',WAITLIST_FROM:'Mosshatch <support@mosshatch.com>'}]){
    const r=await handleWaitlist(new Request(url+'/status'),env);
    expect(r!.status).toBe(200);
    expect((await r!.json()).joiningAvailable).toBe(Boolean(env.DATABASE_URL&&waitlistSenderConfigured(env)));
  }
});

it('gives the no-JavaScript form an actionable delivery setup failure',async()=>{
 const r=await handleWaitlist(new Request(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'email=fixture%40example.com'}),{DATABASE_URL:'postgres://unused.invalid/test'});
 expect(r!.status).toBe(503);expect(r!.headers.get('content-type')).toContain('text/html');expect(await r!.text()).toContain('No signup was saved');
});

it('fails before connecting for absent, malformed or multiline explicit sender settings',async()=>{
 for(const from of [undefined,'a,b@example.com','a@-example.com','a@example..com','.a@example.com','invalid','support@mosshatch.com>','Mosshatch <invalid>','Mosshatch <support@mosshatch.com>\r\nBcc: attacker@example.com']){
  const env={DATABASE_URL:'postgres://unused.invalid/test',RESEND_API_KEY:'fixture',WAITLIST_FROM:from};
  expect(waitlistSenderConfigured(env)).toBe(false);
  const r=await handleWaitlist(new Request(url,{method:'POST',body:'{}'}),env);
  expect(r!.status).toBe(503);expect((await r!.json()).error.reason).toBe('email_not_configured');
 }
 expect(waitlistSenderConfigured({RESEND_API_KEY:'fixture',WAITLIST_FROM:'support@mosshatch.com'})).toBe(true);
});
