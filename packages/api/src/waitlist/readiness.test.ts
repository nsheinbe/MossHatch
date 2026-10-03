import {it,expect} from 'vitest';
import {handleWaitlist} from './http.ts';
const url='https://mosshatch.test/api/waitlist';
it('never writes a signup without a configured sender, even when a database URL exists',async()=>{
  const r=await handleWaitlist(new Request(url,{method:'POST',body:'{}'}),{DATABASE_URL:'postgres://unused.invalid/test'});
  expect(r!.status).toBe(503);
  expect(await r!.json()).toEqual({error:{code:'not_configured',reason:'email_not_configured'}});
});
it('reports configuration readiness without database access or email sends',async()=>{
  for(const env of [{},{DATABASE_URL:'postgres://unused.invalid/test'},{DATABASE_URL:'postgres://unused.invalid/test',RESEND_API_KEY:'fixture'}]){
    const r=await handleWaitlist(new Request(url+'/status'),env);
    expect(r!.status).toBe(200);
    expect((await r!.json()).joiningAvailable).toBe(Boolean(env.DATABASE_URL&&env.RESEND_API_KEY));
  }
});

it('gives the no-JavaScript form an actionable delivery setup failure',async()=>{
 const r=await handleWaitlist(new Request(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'email=fixture%40example.com'}),{DATABASE_URL:'postgres://unused.invalid/test'});
 expect(r!.status).toBe(503);expect(r!.headers.get('content-type')).toContain('text/html');expect(await r!.text()).toContain('No signup was saved');
});
