import { describe, expect, test } from 'vitest';
import { toIsoDate } from './calendar.ts';

const BOUNDS = { earliest: '2000-01-01', latest: '2026-12-31' };

describe('toIsoDate', () => {
  test('reads a valid date', () => {
    expect(toIsoDate(2025, 3, 4, BOUNDS)).toEqual({ ok: true, isoDate: '2025-03-04' });
  });

  test('checks the calendar, which Date.UTC would otherwise roll past', () => {
    expect(toIsoDate(2025, 2, 30, BOUNDS)).toEqual({ ok: false, fault: 'not-a-real-date' });
  });

  test('rejects a month out of range', () => {
    expect(toIsoDate(2025, 13, 1, BOUNDS)).toEqual({ ok: false, fault: 'not-a-real-date' });
  });

  test('rejects a day out of range', () => {
    expect(toIsoDate(2025, 3, 32, BOUNDS)).toEqual({ ok: false, fault: 'not-a-real-date' });
  });

  test('rejects a date before the accepted range', () => {
    expect(toIsoDate(1999, 12, 31, BOUNDS)).toEqual({ ok: false, fault: 'too-old' });
  });

  test('rejects a date after the accepted range', () => {
    expect(toIsoDate(2027, 1, 1, BOUNDS)).toEqual({ ok: false, fault: 'too-far-ahead' });
  });
});
