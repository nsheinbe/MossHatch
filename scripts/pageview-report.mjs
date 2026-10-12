#!/usr/bin/env node
// Read-only aggregate export for the owner/Fleet. Never fetches identities or individual events.
import pg from 'pg';
import { pathToFileURL } from 'node:url';

export function pageviewWindow(days, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('Days must be between 1 and 366');
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const start = new Date(end.getTime() - days * 86400000);
  return { start_inclusive: start.toISOString(), end_exclusive: end.toISOString(), as_of: now.toISOString() };
}

export async function pageviewReport(pool, days, now = new Date()) {
  const window = pageviewWindow(days, now);
  const { rows } = await pool.query(`select day::text,page,count::text from pageview_counts
    where day >= $1::date and day < $2::date order by day,page`, [window.start_inclusive.slice(0, 10), window.end_exclusive.slice(0, 10)]);
  return { source: 'MossHatch first-party pageview_counts', days, timezone: 'UTC', ...window,
    definition: 'Homepage document loads, including reloads; not unique visitors or sessions. Today is partial. Static pages, app-only routes, unknown query parameters, in-page navigation and bfcache restores are excluded. Opt-outs, blockers and failed requests undercount; bots and QA can inflate counts.',
    total: rows.reduce((sum, row) => sum + BigInt(row.count), 0n).toString(), daily: rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const days = Number(process.argv[2] ?? 30);
  pageviewWindow(days);
  const url = process.env.DATABASE_URL_CRON ?? process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('Set DATABASE_URL_CRON or DATABASE_URL_OWNER in the existing secure environment');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try { console.log(JSON.stringify(await pageviewReport(pool, days), null, 2)); }
  finally { await pool.end(); }
}
