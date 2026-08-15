import { describe, expect, test } from 'vitest';
import { MAX_FUTURE_DAYS } from '../limits.ts';
import {
  applyOrder,
  bothReadings,
  type DateReading,
  decideDateOrder,
  orderProvenBy,
  readDate,
} from './dates.ts';

const BOUNDS = { earliest: '2000-01-01', latest: '2026-12-31' };
/** For the cases that are about a year rather than about the accepted range. */
const ANY_YEAR = { earliest: '1000-01-01', latest: '2999-12-31' };

const numeric = (first: number, second: number, year: number): DateReading => ({
  kind: 'numeric',
  first,
  second,
  year,
});

describe('readDate', () => {
  test.for([
    ['2025-03-04', '2025-03-04'],
    ['2025/03/04', '2025-03-04'],
    ['2025.03.04', '2025-03-04'],
    ['2025-3-4', '2025-03-04'],
    ['20250304', '2025-03-04'],
    ['4 Mar 2025', '2025-03-04'],
    ['Mar 4 2025', '2025-03-04'],
    ['Mar 4, 2025', '2025-03-04'],
    ['4-March-2025', '2025-03-04'],
    ['4 sept 2025', '2025-09-04'],
    ['  4   March   2025 ', '2025-03-04'],
    ['2024-02-29', '2024-02-29'],
  ] as const)('reads "%s" as %s', ([raw, isoDate]) => {
    expect(readDate(raw, BOUNDS)).toEqual({ kind: 'date', isoDate });
  });

  test.for([
    ['2025-03-04 10:30:00', '2025-03-04'],
    ['2025-03-04T10:30:00', '2025-03-04'],
    ['2025-03-04T10:30:00Z', '2025-03-04'],
    ['2025-03-04T10:30:00.123Z', '2025-03-04'],
    ['2025-03-04T10:30:00+05:30', '2025-03-04'],
  ] as const)('drops the time a database export attached to "%s"', ([raw, isoDate]) => {
    expect(readDate(raw, BOUNDS)).toEqual({ kind: 'date', isoDate });
  });

  test.for([
    ['Jun 2024', '2024-06-01'],
    ['2024-06', '2024-06-01'],
    ['06/2024', '2024-06-01'],
  ] as const)('reads the month-only "%s" as %s', ([raw, isoDate]) => {
    expect(readDate(raw, BOUNDS)).toEqual({ kind: 'date', isoDate });
  });

  test.for([
    ['03/04/2025', numeric(3, 4, 2025)],
    ['03-04-2025', numeric(3, 4, 2025)],
    ['03/04/25', numeric(3, 4, 2025)],
    ['13/04/2025', numeric(13, 4, 2025)],
    ['04/13/2025', numeric(4, 13, 2025)],
  ] as const)('leaves "%s" for the column to resolve', ([raw, reading]) => {
    expect(readDate(raw, BOUNDS)).toEqual(reading);
  });

  test.for([
    ['00', 2000],
    ['68', 2068],
    ['69', 2069],
    ['99', 2099],
  ] as const)('expands the two-digit year %s to %i', ([suffix, year]) => {
    expect(readDate(`01/02/${suffix}`, ANY_YEAR)).toMatchObject({ kind: 'numeric', year });
  });

  describe('rejects', () => {
    test.for([
      ['', 'is empty'],
      ['45000', 'unconverted date serial'],
      ['1735689600', 'unconverted date serial'],
      ['45292.542', 'unconverted date serial'],
      ['01/02', 'not a date we recognise'],
      ['next tuesday', 'not a date we recognise'],
      ['4th March 2025', 'not a date we recognise'],
      ['Foo 2025', 'month name we do not recognise'],
      ['2025-02-30', 'not a real calendar date'],
      ['2025-02-29', 'not a real calendar date'],
      ['2025-13-01', 'not a real calendar date'],
      ['Mar 32 2025', 'not a real calendar date'],
      ['13/13/2025', 'not a real calendar date'],
      ['1999-12-31', 'is before 2000-01-01'],
      ['2027-01-01', `more than ${MAX_FUTURE_DAYS} days from now`],
    ] as const)('"%s", saying it %s', ([raw, problem]) => {
      const reading = readDate(raw, BOUNDS);

      expect(reading).toMatchObject({ kind: 'invalid' });
      expect(reading.kind === 'invalid' ? reading.problem : '').toContain(problem);
    });
  });
});

describe('orderProvenBy', () => {
  test.for([
    [numeric(13, 4, 2025), 'day-first'],
    [numeric(4, 13, 2025), 'month-first'],
  ] as const)('%o can only be %s', ([reading, order]) => {
    expect(orderProvenBy(reading)).toBe(order);
  });

  test('says nothing about a value that reads either way', () => {
    expect(orderProvenBy(numeric(3, 4, 2025))).toBeUndefined();
  });

  test('says nothing about a date that was never ambiguous', () => {
    expect(orderProvenBy({ kind: 'date', isoDate: '2025-03-04' })).toBeUndefined();
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
      problem: 'contradictory',
    });
  });

  test('refuses a column where every value reads both ways', () => {
    expect(decideDateOrder([numeric(3, 4, 2025), numeric(1, 2, 2025)])).toEqual({
      ok: false,
      problem: 'unresolvable',
    });
  });

  test('has nothing to decide when no value was ambiguous', () => {
    expect(decideDateOrder([{ kind: 'date', isoDate: '2025-03-04' }])).toMatchObject({ ok: true });
  });
});

describe('applyOrder', () => {
  test.for([
    ['day-first', '2025-04-03'],
    ['month-first', '2025-03-04'],
  ] as const)('reads 03/04/2025 %s as %s', ([order, isoDate]) => {
    expect(applyOrder({ kind: 'numeric', first: 3, second: 4, year: 2025 }, order, BOUNDS)).toEqual(
      { ok: true, isoDate },
    );
  });

  test('checks the calendar, which Date.UTC would otherwise roll past', () => {
    expect(
      applyOrder({ kind: 'numeric', first: 31, second: 2, year: 2025 }, 'day-first', BOUNDS),
    ).toEqual({ ok: false, problem: 'is not a real calendar date' });
  });

  test('applies the accepted range', () => {
    expect(
      applyOrder({ kind: 'numeric', first: 1, second: 2, year: 1969 }, 'day-first', BOUNDS),
    ).toMatchObject({ ok: false });
  });
});

describe('bothReadings', () => {
  test('shows the user the two dates rather than describing the problem', () => {
    expect(bothReadings({ kind: 'numeric', first: 3, second: 4, year: 2025 })).toBe(
      '2025-04-03 or 2025-03-04',
    );
  });
});
