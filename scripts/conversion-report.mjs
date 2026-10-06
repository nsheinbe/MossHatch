#!/usr/bin/env node
// Owner-only read model. The browser cannot report purchases; they come from orders/payments.
import pg from 'pg';
const url = process.env.DATABASE_URL_CRON ?? process.env.DATABASE_URL_OWNER;
if (!url) throw new Error('Set DATABASE_URL_CRON or DATABASE_URL_OWNER');
const days = Number(process.argv[2] ?? 30);
if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('Days must be between 1 and 366');
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
 const stages = (await pool.query(`select day,event,mode,device,source,medium,campaign,count::text from conversion_counts where day >= current_date - ($1::int - 1) order by day,mode,device,source,medium,campaign,event`,[days])).rows;
 const orders = (await pool.query(`select coalesce(a.source,'unattributed') as source,coalesce(a.medium,'none') as medium,coalesce(a.campaign,'none') as campaign,coalesce(a.device,'unknown') as device,
 count(*)::int as checkouts_created,
 count(*) filter(where o.authorized_at is not null)::int as authorized_orders,
 count(*) filter(where o.registered_at is not null)::int as confirmed_registrations,
 count(*) filter(where o.registered_at is not null and p.captured_minor>0)::int as paid_registrations,
 coalesce(sum(p.captured_minor),0)::text as captured_including_tax_minor,
 coalesce(sum(p.refunded_minor),0)::text as refunded_minor,
 coalesce(sum(case when o.registered_at is not null and p.captured_minor>0 and p.refunded_minor=0 then p.captured_minor-p.tax_minor-coalesce((o.quote->>'wholesale_minor')::bigint,0) else 0 end),0)::text as quoted_contribution_before_processing_fees_nonrefunded_minor
 from orders o left join conversion_orders a on a.order_id=o.id
 left join lateral(select coalesce(sum(amount_minor) filter(where captured_at is not null),0) as captured_minor,coalesce(sum(tax_minor) filter(where captured_at is not null),0) as tax_minor,coalesce(sum(refunded_minor),0) as refunded_minor from payments where order_id=o.id and livemode=true) p on true
 where o.livemode=true and o.kind='register' and o.created_at >= current_date-($1::int-1)
 group by 1,2,3,4 order by paid_registrations desc`,[days])).rows;
 console.log(JSON.stringify({days,stage_definition:'At most one stage per mode per page load; not unique people. Bots and blockers can affect counts. Preview and live are separate.',purchase_definition:'Live registration orders only; registration uses server registered_at and payment uses captured payments. Attribution first write wins.',contribution_definition:'Estimate using quoted wholesale for nonrefunded registered orders; excludes processing fees, chargebacks, overhead and refunded-order economics. Not net profit.',stages,orders},null,2));
} finally { await pool.end(); }
