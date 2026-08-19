import { describe, expect, test } from 'vitest';
import {
  formatMonth,
  groupByYear,
  missingMonthCount,
  reconcileDraft,
  serializeCounts,
} from './monthly-counts.ts';

describe('formatMonth', () => {
  test('renders the long month name and year', () => {
    expect(formatMonth('2026-01')).toBe('January 2026');
  });

  test('does not shift across a UTC day boundary', () => {
    // A `new Date('2026-12-01')` parse is UTC, but formatting in a timezone west of UTC would
    // read that back as November 30 — the reason `formatMonth` builds the date with `Date.UTC`.
    expect(formatMonth('2026-12')).toBe('December 2026');
  });
});

describe('reconcileDraft', () => {
  test('keeps a value for a month still present', () => {
    expect(reconcileDraft({ '2026-01': 100 }, ['2026-01'])).toEqual({ '2026-01': 100 });
  });

  test('drops a month no longer in the file', () => {
    expect(reconcileDraft({ '2026-01': 100, '2026-02': 200 }, ['2026-01'])).toEqual({
      '2026-01': 100,
    });
  });

  test('leaves a month new to the file empty', () => {
    expect(reconcileDraft({ '2026-01': 100 }, ['2026-01', '2026-02'])).toEqual({
      '2026-01': 100,
      '2026-02': undefined,
    });
  });
});

describe('serializeCounts', () => {
  test('serializes a count for every month', () => {
    expect(serializeCounts({ '2026-01': 100, '2026-02': 200 }, ['2026-01', '2026-02'])).toBe(
      JSON.stringify({ '2026-01': 100, '2026-02': 200 }),
    );
  });

  test('is null when a month has no count yet', () => {
    expect(serializeCounts({ '2026-01': 100 }, ['2026-01', '2026-02'])).toBe(null);
  });

  test('ignores a draft value for a month not in the file', () => {
    expect(serializeCounts({ '2026-01': 100, '2026-03': 300 }, ['2026-01'])).toBe(
      JSON.stringify({ '2026-01': 100 }),
    );
  });
});

describe('missingMonthCount', () => {
  test('is zero once every month has a count', () => {
    expect(missingMonthCount({ '2026-01': 100, '2026-02': 200 }, ['2026-01', '2026-02'])).toBe(0);
  });

  test('counts a month with no value yet', () => {
    expect(missingMonthCount({ '2026-01': 100 }, ['2026-01', '2026-02'])).toBe(1);
  });

  test('counts every month before any is filled in', () => {
    expect(missingMonthCount({}, ['2026-01', '2026-02', '2026-03'])).toBe(3);
  });
});

describe('groupByYear', () => {
  test('is one group for months within a single year', () => {
    expect(groupByYear(['2026-01', '2026-02', '2026-03'])).toEqual([
      { year: '2026', months: ['2026-01', '2026-02', '2026-03'] },
    ]);
  });

  test('splits at a year boundary', () => {
    expect(groupByYear(['2025-11', '2025-12', '2026-01', '2026-02'])).toEqual([
      { year: '2025', months: ['2025-11', '2025-12'] },
      { year: '2026', months: ['2026-01', '2026-02'] },
    ]);
  });
});
