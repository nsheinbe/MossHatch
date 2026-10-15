import { afterEach, beforeEach, expect, it } from 'vitest';
import { Router } from '../http/router.ts';
import { createTestApp, type TestApp } from '../testing/app.ts';
import { registerPageviews } from './pageviews.ts';
let app: TestApp;
beforeEach(async () => { const router = new Router(); registerPageviews(router); app = await createTestApp(router); });
afterEach(async () => { await app?.drop(); });
const post = (body: unknown = { page: 'home' }, headers = {}) => app.call('POST', '/api/v1/pageviews', { body, headers });

it('aggregates concurrent loads by server UTC day with no individual records', async () => {
  const responses = await Promise.all(Array.from({ length: 10 }, () => post()));
  expect(responses.every(r => r.status === 202)).toBe(true);
  const { rows } = await app.db.owner.query('select day::text,page,count::text from pageview_counts');
  expect(rows).toEqual([{ day: app.clock.now().toISOString().slice(0, 10), page: 'home', count: '10' }]);
  const columns = (await app.db.owner.query("select column_name from information_schema.columns where table_name='pageview_counts' order by column_name")).rows;
  expect(columns.map(r => r.column_name)).toEqual(['count', 'day', 'page']);
  expect((await app.db.cron.query('select count from pageview_counts')).rowCount).toBe(1);
});
it('rejects sensitive paths and arbitrary properties, without echoing them', async () => {
  for (const body of [{ page: '/invite?token=secret' }, { page: 'home', email: 'secret@example.org' }, { page: 'home', url: 'secret' }, { page: 'home', user_id: 'secret' }, { page: 'home', campaign: {} }]) {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.json)).not.toContain('secret');
  }
  expect((await app.db.owner.query('select * from pageview_counts')).rowCount).toBe(0);
});
it('honors DNT/GPC on the server without adding rate or page counters', async () => {
  for (const headers of [{ dnt: '1' }, { 'sec-gpc': '1' }]) {
    expect((await post(undefined, headers)).json).toEqual({ accepted: false });
  }
  expect((await app.db.owner.query('select * from pageview_counts')).rowCount).toBe(0);
  expect((await app.db.owner.query("select * from rate_counters where bucket like 'pageviews.%'")).rowCount).toBe(0);
});
it('refuses foreign origins and oversized bodies', async () => {
  expect((await post(undefined, { origin: 'https://evil.test' })).status).toBe(403);
  expect((await post({ page: 'home', secret: 'x'.repeat(200) })).status).toBe(413);
});
it('bounds accepted counts under floods', async () => {
  for (let i = 0; i < 100; i++) expect((await post()).status).toBe(202);
  expect((await post()).status).toBe(429);
  expect((await app.db.owner.query('select count::text from pageview_counts')).rows).toEqual([{ count: '100' }]);
});
