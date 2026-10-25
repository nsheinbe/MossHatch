import { expect, it, vi } from 'vitest';
// @ts-expect-error operational script is plain JavaScript
import { pageviewReport, pageviewWindow } from './pageview-report.mjs';

it('defines UTC calendar windows including partial today across month/year boundaries', () => {
  expect(pageviewWindow(2, new Date('2026-01-01T18:00:00-05:00'))).toEqual({
    start_inclusive: '2025-12-31T00:00:00.000Z', end_exclusive: '2026-01-02T00:00:00.000Z', as_of: '2026-01-01T23:00:00.000Z',
  });
  for (const days of [0, 367, 1.5, NaN]) expect(() => pageviewWindow(days)).toThrow();
});
it('exports bounded read-only aggregates without losing bigint precision', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ day: '2026-10-12', page: 'home', count: '9007199254740993' }, { day: '2026-10-11', page: 'home', count: '2' }] });
  const report = await pageviewReport({ query }, 2, new Date('2026-10-12T12:00:00Z'));
  expect(report.total).toBe('9007199254740995');
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]![0]).toMatch(/^select /);
  expect(query.mock.calls[0]![1]).toEqual(['2026-10-11', '2026-10-13']);
});
