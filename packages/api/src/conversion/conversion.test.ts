import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { Router } from '../http/router.ts';
import { createTestApp,type TestApp } from '../testing/app.ts';
import { campaignLabels,registerConversionRoutes } from './routes.ts';
let app:TestApp;
beforeAll(async()=>{app=await createTestApp(registerConversionRoutes(new Router()));},60000);
afterAll(async()=>{await app?.drop();});
const event={event:'visit',mode:'live',device:'mobile',campaign:{utm_source:'RallyGlow',utm_medium:'social',utm_campaign:'launch'}};
describe('conversion measurement',()=>{
 it('accepts only bounded labels and no search content',()=>{expect(campaignLabels({utm_source:'RallyGlow',utm_medium:'https://example.com?secret=x',utm_campaign:'mail@example.com'})).toEqual(['rallyglow','none','none']);});
 it('aggregates rather than storing identifiers or individual events',async()=>{
  expect((await app.call('POST','/api/v1/conversion/events',{body:event})).status).toBe(202);
  expect((await app.call('POST','/api/v1/conversion/events',{body:event})).status).toBe(202);
  const rows=(await app.db.owner.query('select * from conversion_counts')).rows;
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({count:'2',source:'rallyglow',device:'mobile',mode:'live'});
  expect(Object.keys(rows[0]).sort()).toEqual(['campaign','count','day','device','event','medium','mode','source']);
 });
 it('rejects raw searches, arbitrary events and cross-origin requests',async()=>{
  for(const body of [{...event,query:'secret-domain'}, {...event,event:'purchased'}, {...event,campaign:{utm_source:'x'.repeat(100)}}]) expect((await app.call('POST','/api/v1/conversion/events',{body})).status).toBe(400);
  expect((await app.call('POST','/api/v1/conversion/events',{body:event,headers:{origin:'https://evil.test'}})).status).toBe(403);
 });
 it('requires an authenticated owner to associate an order',async()=>{expect((await app.call('POST','/api/v1/conversion/orders',{body:{order_id:crypto.randomUUID(),device:'mobile',campaign:{}}})).status).toBe(401);});
 it('bounds analytics ingestion under floods',async()=>{
  for(let n=0;n<105;n++)await app.call('POST','/api/v1/conversion/events',{body:event});
  expect((await app.call('POST','/api/v1/conversion/events',{body:event})).status).toBe(429);
 });
});

describe('verified order attribution',()=>{
 it('only the buyer can attribute an order, first write wins and cross-origin writes fail',async()=>{
  const {makeHarness,makeBuyer,postOrder}=await import('../orders/testkit.ts');
  const h=await makeHarness();
  registerConversionRoutes(h.app.router!);
  try{
   const owner=await makeBuyer(h,'conversion-owner@example.org');
   const other=await makeBuyer(h,'conversion-other@example.org');
   const placed=await postOrder(h,owner,{fqdn:'free-conversion.com',years:1});
   expect(placed.status).toBe(201);
   const body={order_id:placed.json.order_id,device:'desktop',campaign:{utm_source:'launch'}};
   expect((await h.app.call('POST','/api/v1/conversion/orders',{cookie:other.cookie,body})).status).toBe(404);
   expect((await h.app.call('POST','/api/v1/conversion/orders',{cookie:owner.cookie,body,headers:{origin:'https://evil.test'}})).status).toBe(403);
   expect((await h.app.call('POST','/api/v1/conversion/orders',{cookie:owner.cookie,body})).status).toBe(202);
   expect((await h.app.call('POST','/api/v1/conversion/orders',{cookie:owner.cookie,body:{...body,campaign:{utm_source:'changed'}}})).status).toBe(202);
   const rows=(await h.app.db.owner.query('select user_id,source from conversion_orders')).rows;
   expect(rows).toEqual([{user_id:owner.userId,source:'launch'}]);
  }finally{await h.app.drop();}
 },60000);
});
