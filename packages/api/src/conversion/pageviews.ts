import { withNoUser } from '@mosshatch/db';
import { z } from 'zod';
import { HttpError, json, type Router } from '../http/router.ts';
import { hit } from '../ratelimit.ts';

const pageview = z.object({ page: z.literal('home') }).strict();
export function registerPageviews(router: Router) {
  router.add({ method: 'POST', path: '/api/v1/pageviews', principals: ['anonymous'], tag: 'conversion', maxBodyBytes: 128,
    async handler(r) {
      if (r.request.headers.get('origin') !== r.ctx.config.origin) throw new HttpError(403, 'origin_refused');
      const body = pageview.safeParse(r.body);
      if (!body.success) throw new HttpError(400, 'invalid_pageview');
      if (r.request.headers.get('dnt') === '1' || r.request.headers.get('sec-gpc') === '1') return json({ accepted: false }, 202);
      await withNoUser(r.ctx.runtime, async c => {
        const net = await hit(r.ctx, c, `pageviews:${r.ipPrefix}`, { bucket: 'pageviews.net', max: 100, windowSeconds: 60 });
        if (!net.allowed) throw new HttpError(429, 'rate_limited');
        const all = await hit(r.ctx, c, 'pageviews:all', { bucket: 'pageviews.all', max: 1000, windowSeconds: 60 });
        if (!all.allowed) throw new HttpError(429, 'rate_limited');
        await c.query(`insert into pageview_counts(day,page) values ($1,$2)
          on conflict(day,page) do update set count=pageview_counts.count+1`,
          [r.ctx.clock.now().toISOString().slice(0, 10), body.data.page]);
      });
      return json({ accepted: true }, 202);
    },
  });
}
