/** Deciding day-first or month-first for the whole column, never per value.
 *
 * Deciding per value is what lets `01/13/2025` and `13/01/2025` in one column silently become the
 * same date. Deciding for the column also means a single typo cannot quietly flip the reading of
 * every other row: it makes both readings provable, and that is a rejection.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import type { DateBounds, ResolvedDate } from './calendar.ts';
import { toIsoDate } from './calendar.ts';
import type { DateReading } from './dates.ts';

/** Which of the first two numbers in `03/04/2025` is the day. */
export type DateOrder = 'day-first' | 'month-first';

/** Which reading a value rules out, if any. `13/04/2025` can only be day-first. */
export function dateOrderProvenBy(reading: DateReading): DateOrder | undefined {
  if (reading.kind !== 'numeric') return undefined;
  if (reading.first > 12) return 'day-first';
  if (reading.second > 12) return 'month-first';
  return undefined;
}

/** Why a column's date order couldn't be decided.
 *
 * `contradictory`: one column holds values proving both readings — a typo, or two exports
 * concatenated. `unresolvable`: every value works either way, so there is nothing to infer from.
 */
export type DateOrderFault = 'contradictory' | 'unresolvable';

export type DateOrderDecision =
  | { ok: true; order: DateOrder }
  | { ok: false; fault: DateOrderFault };

export function decideDateOrder(readings: Iterable<DateReading>): DateOrderDecision {
  const proven = new Set<DateOrder>();
  let sawNumeric = false;

  for (const reading of readings) {
    if (reading.kind !== 'numeric') continue;
    sawNumeric = true;
    const order = dateOrderProvenBy(reading);
    if (order) proven.add(order);
  }

  if (proven.size === 2) return { ok: false, fault: 'contradictory' };
  const [order] = proven;
  if (order) return { ok: true, order };
  // With nothing numeric in the column the order is never consulted; either answer will do.
  return sawNumeric ? { ok: false, fault: 'unresolvable' } : { ok: true, order: 'month-first' };
}

export function applyDateOrder(
  reading: Extract<DateReading, { kind: 'numeric' }>,
  order: DateOrder,
  bounds: DateBounds,
): ResolvedDate {
  const [day, month] =
    order === 'day-first' ? [reading.first, reading.second] : [reading.second, reading.first];
  return toIsoDate(reading.year, month, day, bounds);
}

/** Both ways a value could be read, so a message can show the user the problem rather than
 * describe it.
 */
export function bothDateOrderReadings(reading: Extract<DateReading, { kind: 'numeric' }>): string {
  const describe = (resolved: ResolvedDate) => (resolved.ok ? resolved.isoDate : 'no real date');
  return [
    describe(applyDateOrder(reading, 'day-first', ANY_DATE)),
    describe(applyDateOrder(reading, 'month-first', ANY_DATE)),
  ].join(' or ');
}

const ANY_DATE: DateBounds = { earliest: '0000-01-01', latest: '9999-12-31' };
