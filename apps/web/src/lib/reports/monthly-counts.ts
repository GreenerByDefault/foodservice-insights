/** The count a user is typing in for each month, and what it takes to turn that into what the
 * form submits.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import type { MonthlyCounts, MonthsFromFile } from './metadata.ts';

/** One month's value while the user is still typing it. `undefined` because `bind:value` on
 * `<input type="number">` yields `undefined` for an empty or unparseable field — there is no
 * other way for a month to be "not answered yet".
 */
export type CountDraft = Record<string, number | undefined>;

const monthFormat = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** `'2026-01'` → `'January 2026'`. */
export function formatMonth(month: string): string {
  const [year = 0, monthNumber = 1] = month.split('-').map(Number);
  return monthFormat.format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

/** Carries a value forward for a month still in `months`, drops the rest, and leaves a month new
 * to this file empty — so replacing a file does not discard what the user already typed.
 */
export function reconcileDraft(previous: CountDraft, months: MonthsFromFile): CountDraft {
  return Object.fromEntries(months.map((month) => [month, previous[month]]));
}

/** The JSON the `monthly-counts` field carries — satisfying `MonthlyCountsSchema` — or `null`
 * when a month is still missing a count, the caller's cue not to submit.
 */
export function serializeCounts(draft: CountDraft, months: MonthsFromFile): string | null {
  const counts: MonthlyCounts = {};
  for (const month of months) {
    const value = draft[month];
    if (value === undefined) return null;
    counts[month] = value;
  }
  return JSON.stringify(counts);
}

export function missingMonthCount(draft: CountDraft, months: MonthsFromFile): number {
  return months.filter((month) => draft[month] === undefined).length;
}

/** `months`, split at each year boundary. A year subheading is only worth showing once a span
 * crosses one, which is exactly when this has more than one entry.
 */
export function groupByYear(months: MonthsFromFile): { year: string; months: string[] }[] {
  const groups: { year: string; months: string[] }[] = [];
  for (const month of months) {
    const year = month.slice(0, 4);
    const currentGroup = groups.at(-1);
    if (currentGroup?.year === year) currentGroup.months.push(month);
    else groups.push({ year, months: [month] });
  }
  return groups;
}
