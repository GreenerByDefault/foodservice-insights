/** Calendar fields into an ISO date inside the accepted range, or the reason they are not one.
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

export type DateBounds = { earliest: string; latest: string };

export type CalendarFault = 'not-a-real-date' | 'too-old' | 'too-far-ahead';

export type ResolvedDate = { ok: true; isoDate: string } | { ok: false; fault: CalendarFault };

export function toIsoDate(
  year: number,
  month: number,
  day: number,
  bounds: DateBounds,
): ResolvedDate {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, fault: 'not-a-real-date' };
  }

  // `Date.UTC` rolls February 30 forward into March rather than complaining, so the only way to
  // know the date exists is to read the fields back out.
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return { ok: false, fault: 'not-a-real-date' };
  }

  const isoDate = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
  if (isoDate < bounds.earliest) {
    return { ok: false, fault: 'too-old' };
  }
  if (isoDate > bounds.latest) {
    return { ok: false, fault: 'too-far-ahead' };
  }
  return { ok: true, isoDate };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
