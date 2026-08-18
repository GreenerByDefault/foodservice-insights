import { describe, expect, test } from 'vitest';
import {
  applyDateOrder,
  bothDateOrderReadings,
  dateOrderProvenBy,
  decideDateOrder,
} from './date-order.ts';
import type { DateReading } from './dates.ts';

const BOUNDS = { earliest: '2000-01-01', latest: '2026-12-31' };

const numeric = (first: number, second: number, year: number): DateReading => ({
  kind: 'numeric',
  first,
  second,
  year,
});

describe('dateOrderProvenBy', () => {
  test.for([
    [numeric(13, 4, 2025), 'day-first'],
    [numeric(4, 13, 2025), 'month-first'],
  ] as const)('%o can only be %s', ([reading, order]) => {
    expect(dateOrderProvenBy(reading)).toBe(order);
  });

  test('says nothing about a value that reads either way', () => {
    expect(dateOrderProvenBy(numeric(3, 4, 2025))).toBeUndefined();
  });

  test('says nothing about a date that was never ambiguous', () => {
    expect(dateOrderProvenBy({ kind: 'date', isoDate: '2025-03-04' })).toBeUndefined();
  });
});

describe('decideDateOrder', () => {
  test('takes the one reading the column proves', () => {
    expect(decideDateOrder([numeric(3, 4, 2025), numeric(13, 4, 2025)])).toEqual({
      ok: true,
      order: 'day-first',
    });
  });

  test('refuses a column that proves both, rather than letting one typo flip every row', () => {
    expect(decideDateOrder([numeric(13, 4, 2025), numeric(4, 13, 2025)])).toEqual({
      ok: false,
      fault: 'contradictory',
    });
  });

  test('refuses a column where every value reads both ways', () => {
    expect(decideDateOrder([numeric(3, 4, 2025), numeric(1, 2, 2025)])).toEqual({
      ok: false,
      fault: 'unresolvable',
    });
  });

  test('has nothing to decide when no value was ambiguous', () => {
    expect(decideDateOrder([{ kind: 'date', isoDate: '2025-03-04' }])).toMatchObject({ ok: true });
  });
});

describe('applyDateOrder', () => {
  test.for([
    ['day-first', '2025-04-03'],
    ['month-first', '2025-03-04'],
  ] as const)('reads 03/04/2025 %s as %s', ([order, isoDate]) => {
    expect(
      applyDateOrder({ kind: 'numeric', first: 3, second: 4, year: 2025 }, order, BOUNDS),
    ).toEqual({ ok: true, isoDate });
  });

  test('checks the calendar, which Date.UTC would otherwise roll past', () => {
    expect(
      applyDateOrder({ kind: 'numeric', first: 31, second: 2, year: 2025 }, 'day-first', BOUNDS),
    ).toEqual({ ok: false, fault: 'is not a real calendar date' });
  });

  test('applies the accepted range', () => {
    expect(
      applyDateOrder({ kind: 'numeric', first: 1, second: 2, year: 1969 }, 'day-first', BOUNDS),
    ).toMatchObject({ ok: false });
  });
});

describe('bothDateOrderReadings', () => {
  test('shows the user the two dates rather than describing the problem', () => {
    expect(bothDateOrderReadings({ kind: 'numeric', first: 3, second: 4, year: 2025 })).toBe(
      '2025-04-03 or 2025-03-04',
    );
  });
});
