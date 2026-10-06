import { withNoUser, withUser } from '@mosshatch/db';
import { HttpError, json, type Router } from '../http/router.ts';
import { hit } from '../ratelimit.ts';
import { z } from 'zod';
const campaignSchema = z.object({ utm_source: z.string().max(64).optional(), utm_medium: z.string().max(64).optional(), utm_campaign: z.string().max(64).optional() }).strict();
const dimensions = { device: z.enum(['mobile','desktop']), campaign: campaignSchema };
const eventBody = z.object({ ...dimensions, event: z.enum(['visit','search','available','selected','checkout']), mode: z.enum(['preview','live']) }).strict();
const orderBody = z.object({ ...dimensions, order_id: z.string().uuid() }).strict();
export function campaignLabels(c: Record<string,string | undefined>) {
 const label = (s: string | undefined, fallback: string) => s && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s) ? s.toLowerCase() : fallback;
 return [label(c.utm_source,'direct'),label(c.utm_medium,'none'),label(c.utm_campaign,'none')];
}
export function registerConversionRoutes(router: Router) {
 router.add({ method:'POST', path:'/api/v1/conversion/events', principals:['anonymous'], tag:'conversion', maxBodyBytes:1024,
  async handler(r) {
   if (r.request.headers.get('origin') !== r.ctx.config.origin) throw new HttpError(403,'origin_refused');
   const body = eventBody.safeParse(r.body); if (!body.success) throw new HttpError(400,'invalid_event');
   const b = body.data;
   await withNoUser(r.ctx.runtime, async c => {
    const perNet = await hit(r.ctx,c,`conversion:${r.ipPrefix}`,{ bucket:'conversion.net',max:100,windowSeconds:60 });
    if (!perNet.allowed) throw new HttpError(429,'rate_limited');
    const global = await hit(r.ctx,c,'conversion:all',{ bucket:'conversion.all',max:1000,windowSeconds:60 });
    if (!global.allowed) throw new HttpError(429,'rate_limited');
    await c.query(`insert into conversion_counts(day,event,mode,device,source,medium,campaign) values ($1,$2,$3,$4,$5,$6,$7) on conflict(day,event,mode,device,source,medium,campaign) do update set count=conversion_counts.count+1`,[r.ctx.clock.now().toISOString().slice(0,10),b.event,b.mode,b.device,...campaignLabels(b.campaign)]);
   });
   return json({ accepted:true },202);
  }
 }, { method:'POST',path:'/api/v1/conversion/orders',principals:['session'],tag:'conversion',maxBodyBytes:1024,
  async handler(r) {
   const body=orderBody.safeParse(r.body); if(!body.success) throw new HttpError(400,'invalid_attribution');
   const b=body.data, userId=r.principal.userId!;
   await withUser(r.ctx.runtime,userId,async c => {
    const order=await c.query('select id from orders where id=$1 and user_id=$2',[b.order_id,userId]);
    if(!order.rowCount) throw new HttpError(404,'not_found');
    await c.query('insert into conversion_orders(order_id,user_id,device,source,medium,campaign) values($1,$2,$3,$4,$5,$6) on conflict(order_id) do nothing',[b.order_id,userId,b.device,...campaignLabels(b.campaign)]);
   });
   return json({ accepted:true },202);
  }
 });
 return router;
}
