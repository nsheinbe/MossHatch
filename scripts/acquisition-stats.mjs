#!/usr/bin/env node
// Owner/cron-only first-touch signup cohorts. Does not send mail or print personal data.
import pg from "pg";
const days = Number(process.argv[2] ?? 30);
if (!Number.isInteger(days) || days < 1 || days > 3660) throw new Error("Days must be an integer from 1 to 3660.");
const connectionString = process.env.DATABASE_URL_CRON ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL_CRON or DATABASE_URL with owner/cron read access.");
const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const { rows } = await pool.query(`
    select coalesce(nullif(attribution->>'utm_source',''),'unattributed') as source,
      coalesce(attribution->>'utm_medium','') as medium,
      coalesce(attribution->>'utm_campaign','') as campaign,
      count(*)::int as signups,
      count(*) filter (where confirmed_at is not null)::int as confirmed,
      count(*) filter (where confirmed_at is not null and unsubscribed_at is null)::int as active_confirmed,
      count(*) filter (where invited_at is not null)::int as invited,
      count(*) filter (where exists (
        select 1 from waitlist_invites i where i.waitlist_id = w.id and i.used_at is not null
      ))::int as accepted
    from waitlist w where created_at >= now() - $1 * interval '1 day'
    group by 1,2,3 order by signups desc,source,medium,campaign
  `, [days]);
  console.log(JSON.stringify({ cohort_days: days, generated_at: new Date().toISOString(), rows }, null, 2));
} finally { await pool.end(); }
