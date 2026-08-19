/** One cell into a calendar date, or the reason it is not one.
 *
 * Every pattern here is anchored with bounded quantifiers, and callers length-check a cell before
 * handing it over.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { type CalendarFault, type DateBounds, toIsoDate } from './calendar.ts';

// Everything readDate can produce, which includes the calendar's.
export type DateFault =
  | CalendarFault
  | 'empty'
  | 'unknown-month-name'
  | 'date-serial'
  | 'unrecognized';

export type DateReading =
  /** Unambiguous, and already inside the accepted range. */
  | { kind: 'date'; isoDate: string }
  /** `first/second/year`, where only the whole column can say which is the day. */
  | { kind: 'numeric'; first: number; second: number; year: number }
  | { kind: 'invalid'; fault: DateFault };

// ------------------------------------------------------------------
// Recognizing a cell
// ------------------------------------------------------------------

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

export function readDate(raw: string, bounds: DateBounds): DateReading {
  const cleaned = raw
    .trim()
    .replace(/,|\s+/g, (match) => (match === ',' ? '' : ' '))
    .toLowerCase();
  if (cleaned === '') return { kind: 'invalid', fault: 'empty' };

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
    return { kind: 'invalid', fault: 'date-serial' };
  }

  return { kind: 'invalid', fault: 'unrecognized' };
}

/** A month with no day is the whole month, and the report is keyed by month, so the day we put in
 * its place never reaches an answer.
 */
const FIRST_OF_THE_MONTH = 1;

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function numeric(first: number, second: number, year: number): DateReading {
  if (first > 12 && second > 12) return { kind: 'invalid', fault: 'not-a-real-date' };
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
    return { kind: 'invalid', fault: 'unknown-month-name' };
  }
  return dated(year, month, day, bounds);
}

function dated(year: number, month: number, day: number, bounds: DateBounds): DateReading {
  const resolved = toIsoDate(year, month, day, bounds);
  return resolved.ok
    ? { kind: 'date', isoDate: resolved.isoDate }
    : { kind: 'invalid', fault: resolved.fault };
}

/** A two-digit year is always a 21st-century one; nothing this tool ingests predates 2000. */
function expandYear(token: string | undefined): number {
  const year = Number(token);
  if (token?.length !== 2) return year;
  return 2000 + year;
}
