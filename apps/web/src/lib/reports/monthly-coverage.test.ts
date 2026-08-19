import { describe, expect, test } from 'vitest';
import { monthsWithoutCounts } from './monthly-coverage.ts';

describe('monthsWithoutCounts', () => {
  test('accepts a file every month of which has a count', () => {
    expect(monthsWithoutCounts(['2026-01', '2026-02'], { '2026-01': 120, '2026-02': 135 })).toBe(
      undefined,
    );
  });

  test('accepts a form carrying counts for months the file has no orders in', () => {
    expect(monthsWithoutCounts(['2026-01'], { '2026-01': 120, '2026-02': 135 })).toBe(undefined);
  });

  test('rejects one uncounted month', () => {
    expect(monthsWithoutCounts(['2026-01', '2026-02'], { '2026-01': 120 })).toEqual({
      reason: 'invalid_metadata',
      summary: 'Your file has orders in 2026-02, but you did not give a count for that month.',
      rejectionDetail: 'months in the file with no count: 2026-02',
    });
  });

  test('rejects several uncounted months', () => {
    expect(monthsWithoutCounts(['2026-01', '2026-02'], { '2026-03': 120 })).toMatchObject({
      summary:
        'Your file has orders in 2026-01, 2026-02, but you did not give a count for those months.',
      rejectionDetail: 'months in the file with no count: 2026-01, 2026-02',
    });
  });
});
