/** One cell into a calendar date, or the reason it is not one.
 *
 * Every pattern here is anchored with bounded quantifiers, and callers length-check a cell before
 * handing it over.
 *
 * Two constructors are banned here, and only `Date.UTC` is left:
 *
 * - **`Date.parse` and `new Date(string)`** guess at ambiguous input without saying so.
 *   `Date.parse('03/04/2025')` returns March 4 with no hint that April 3 was as good a reading.
 * - **`new Date(y, m, d)`** is timezone-dependent, so the browser and the server would disagree
 *   about the same file.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_FUTURE_DAYS } from '../limits.ts';

/** Which of the first two numbers in `03/04/2025` is the day. */
export type DateOrder = 'day-first' | 'month-first';

export type DateReading =
  /** Unambiguous, and already inside the accepted range. */
  | { kind: 'date'; iso: string }
  /** `first/second/year`, where only the whole column can say which is the day. */
  | { kind: 'numeric'; first: number; second: number; year: number }
  | { kind: 'invalid'; problem: string };

export type DateBounds = { earliest: string; latest: string };

export type ResolvedDate = { ok: true; iso: string } | { ok: false; problem: string };

const YEAR_FIRST = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/;
/** A timestamp a database export attached to what is really just a date. The time is dropped
 * outright rather than converted for a timezone: the calendar day is all the analysis keys on,
 * and shifting it for an offset would be a guess this area is built to refuse.
 */
const YEAR_FIRST_WITH_TIME =
  /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})[t ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(z|[+-]\d{2}:?\d{2})?$/;
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/;
const YEAR_LAST = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/;
const YEAR_MONTH = /^(\d{4})[/.-](\d{1,2})$/;
const MONTH_YEAR = /^(\d{1,2})[/.-](\d{4})$/;
const DAY_NAME_YEAR = /^(\d{1,2})[\s-]+([a-z]+)[\s-]+(\d{2,4})$/;
const NAME_DAY_YEAR = /^([a-z]+)[\s-]+(\d{1,2})[\s-]+(\d{2,4})$/;
const NAME_YEAR = /^([a-z]+)[\s-]+(\d{4})$/;
const DIGITS_ONLY = /^\d+$/;
/** A serial with a fractional day, which is the time of day on an Excel date-time cell that lost
 * its formatting.
 */
const DECIMAL_SERIAL = /^\d+\.\d+$/;

/** `sept` is in here because people write it and `strptime` takes it. */
const MONTH_NUMBERS = new Map<string, number>(
  [
    ['jan', 'january'],
    ['feb', 'february'],
    ['mar', 'march'],
    ['apr', 'april'],
    ['may'],
    ['jun', 'june'],
    ['jul', 'july'],
    ['aug', 'august'],
    ['sep', 'sept', 'september'],
    ['oct', 'october'],
    ['nov', 'november'],
    ['dec', 'december'],
  ].flatMap((names, index) => names.map((name): [string, number] => [name, index + 1])),
);

/** Two-digit years follow `strptime`'s pivot, which is what US exports are written against. */
const TWO_DIGIT_YEAR_PIVOT = 68;

const NOT_A_DATE = 'is not a real calendar date';

export function readDate(raw: string, bounds: DateBounds): DateReading {
  const cleaned = raw.trim().replace(/,/g, '').replace(/\s+/g, ' ').toLowerCase();
  if (cleaned === '') return { kind: 'invalid', problem: 'is empty' };

  const yearFirst =
    YEAR_FIRST.exec(cleaned) ?? YEAR_FIRST_WITH_TIME.exec(cleaned) ?? COMPACT.exec(cleaned);
  if (yearFirst) {
    const [, year, month, day] = yearFirst;
    return dated(Number(year), Number(month), Number(day), bounds);
  }

  const yearMonth = YEAR_MONTH.exec(cleaned);
  if (yearMonth) {
    const [, year, month] = yearMonth;
    return dated(Number(year), Number(month), FIRST_OF_THE_MONTH, bounds);
  }

  const monthYear = MONTH_YEAR.exec(cleaned);
  if (monthYear) {
    const [, month, year] = monthYear;
    return dated(Number(year), Number(month), FIRST_OF_THE_MONTH, bounds);
  }

  const dayNameYear = DAY_NAME_YEAR.exec(cleaned);
  if (dayNameYear) {
    const [, day, name, year] = dayNameYear;
    return named(expandYear(year), name, Number(day), bounds);
  }

  const nameDayYear = NAME_DAY_YEAR.exec(cleaned);
  if (nameDayYear) {
    const [, name, day, year] = nameDayYear;
    return named(expandYear(year), name, Number(day), bounds);
  }

  const nameYear = NAME_YEAR.exec(cleaned);
  if (nameYear) {
    const [, name, year] = nameYear;
    return named(expandYear(year), name, FIRST_OF_THE_MONTH, bounds);
  }

  const yearLast = YEAR_LAST.exec(cleaned);
  if (yearLast) {
    const [, first, second, year] = yearLast;
    return numeric(Number(first), Number(second), expandYear(year));
  }

  if (DIGITS_ONLY.test(cleaned) || DECIMAL_SERIAL.test(cleaned)) {
    return {
      kind: 'invalid',
      problem:
        'looks like an unconverted date serial; format the column as a date in your spreadsheet and save it again',
    };
  }

  return { kind: 'invalid', problem: 'is not a date we recognise; use YYYY-MM-DD' };
}

/** A month with no day is the whole month, and the report is keyed by month, so the day we put in
 * its place never reaches an answer.
 */
const FIRST_OF_THE_MONTH = 1;

/** Which reading a value rules out, if any. `13/04/2025` can only be day-first. */
export function orderProvenBy(reading: DateReading): DateOrder | undefined {
  if (reading.kind !== 'numeric') return undefined;
  if (reading.first > 12) return 'day-first';
  if (reading.second > 12) return 'month-first';
  return undefined;
}

export type OrderDecision =
  | { ok: true; order: DateOrder }
  /** One column holds values proving both readings — a typo, or two exports concatenated. */
  | { ok: false; problem: 'contradictory' }
  /** Every value works either way, so there is nothing to infer from. */
  | { ok: false; problem: 'unresolvable' };

/** Decide day-first or month-first for the whole column, never per value.
 *
 * Deciding per value is what lets `01/13/2025` and `13/01/2025` in one column silently become the
 * same date. Deciding for the column also means a single typo cannot quietly flip the reading of
 * every other row: it makes both readings provable, and that is a rejection.
 */
export function decideDateOrder(readings: Iterable<DateReading>): OrderDecision {
  const proven = new Set<DateOrder>();
  let sawNumeric = false;

  for (const reading of readings) {
    if (reading.kind !== 'numeric') continue;
    sawNumeric = true;
    const order = orderProvenBy(reading);
    if (order) proven.add(order);
  }

  if (proven.size === 2) return { ok: false, problem: 'contradictory' };
  const [order] = proven;
  if (order) return { ok: true, order };
  // With nothing numeric in the column the order is never consulted; either answer will do.
  return sawNumeric ? { ok: false, problem: 'unresolvable' } : { ok: true, order: 'month-first' };
}

export function applyOrder(
  reading: Extract<DateReading, { kind: 'numeric' }>,
  order: DateOrder,
  bounds: DateBounds,
): ResolvedDate {
  const [day, month] =
    order === 'day-first' ? [reading.first, reading.second] : [reading.second, reading.first];
  return toIso(reading.year, month, day, bounds);
}

/** Both ways a value could be read, so a message can show the user the problem rather than
 * describe it.
 */
export function bothReadings(reading: Extract<DateReading, { kind: 'numeric' }>): string {
  const describe = (resolved: ResolvedDate) => (resolved.ok ? resolved.iso : 'no real date');
  return [
    describe(applyOrder(reading, 'day-first', ANY_DATE)),
    describe(applyOrder(reading, 'month-first', ANY_DATE)),
  ].join(' or ');
}

const ANY_DATE: DateBounds = { earliest: '0000-01-01', latest: '9999-12-31' };

function numeric(first: number, second: number, year: number): DateReading {
  if (first > 12 && second > 12) return { kind: 'invalid', problem: NOT_A_DATE };
  return { kind: 'numeric', first, second, year };
}

function named(
  year: number,
  name: string | undefined,
  day: number,
  bounds: DateBounds,
): DateReading {
  const month = MONTH_NUMBERS.get(name ?? '');
  if (month === undefined) {
    return { kind: 'invalid', problem: 'has a month name we do not recognise' };
  }
  return dated(year, month, day, bounds);
}

function dated(year: number, month: number, day: number, bounds: DateBounds): DateReading {
  const resolved = toIso(year, month, day, bounds);
  return resolved.ok
    ? { kind: 'date', iso: resolved.iso }
    : { kind: 'invalid', problem: resolved.problem };
}

function expandYear(token: string | undefined): number {
  const year = Number(token);
  if (token?.length !== 2) return year;
  return year <= TWO_DIGIT_YEAR_PIVOT ? 2000 + year : 1900 + year;
}

function toIso(year: number, month: number, day: number, bounds: DateBounds): ResolvedDate {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, problem: NOT_A_DATE };
  }

  // `Date.UTC` rolls February 30 forward into March rather than complaining, so the only way to
  // know the date exists is to read the fields back out.
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return { ok: false, problem: NOT_A_DATE };
  }

  const iso = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
  if (iso < bounds.earliest) {
    return { ok: false, problem: `is before ${bounds.earliest}, too old to be procurement data` };
  }
  if (iso > bounds.latest) {
    return { ok: false, problem: `is more than ${MAX_FUTURE_DAYS} days from now` };
  }
  return { ok: true, iso };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
