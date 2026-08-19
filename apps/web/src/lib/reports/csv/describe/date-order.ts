/** A column-wide date-order failure, which is prose rather than a row problem.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import type { DateOrderFinding } from '../findings.ts';
import type { DateReading, ResolvedDate } from '../rules/index.ts';
import { bothDateOrderReadings } from '../rules/index.ts';
import { quote } from './text.ts';

export function describeDateOrderFinding(finding: DateOrderFinding): string {
  const { fault, examples } = finding;
  const advice = 'Re-save the date column as YYYY-MM-DD and upload again.';

  if (fault === 'contradictory') {
    // The column holds values proving both readings, so both are shown as evidence.
    const dayFirst = examples.get('day-first');
    const monthFirst = examples.get('month-first');
    return `Your dates are written both ways: row ${dayFirst?.line} has ${quote(dayFirst?.raw ?? '')}, which can only be day first, and row ${monthFirst?.line} has ${quote(monthFirst?.raw ?? '')}, which can only be month first. ${advice}`;
  }

  // `unresolvable`: every value works either way, so the one ambiguous example shows both
  // readings of the same value.
  const ambiguous = examples.get('ambiguous');
  const readings =
    ambiguous?.reading.kind === 'numeric' ? describeBothReadings(ambiguous.reading) : 'either date';
  return `Every date in that file could be read two ways — row ${ambiguous?.line}'s ${quote(ambiguous?.raw ?? '')} is ${readings}. ${advice}`;
}

function describeBothReadings(ambiguousReading: Extract<DateReading, { kind: 'numeric' }>): string {
  const { dayFirst, monthFirst } = bothDateOrderReadings(ambiguousReading);
  return `${isoDateOfAmbiguousReading(dayFirst)} or ${isoDateOfAmbiguousReading(monthFirst)}`;
}

function isoDateOfAmbiguousReading(resolved: ResolvedDate): string {
  if (!resolved.ok) {
    throw new Error(`unreachable: ambiguous date resolved to ${resolved.fault}`);
  }
  return resolved.isoDate;
}
