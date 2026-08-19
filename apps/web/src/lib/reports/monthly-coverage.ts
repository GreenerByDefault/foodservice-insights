/** The months a file has orders in, against the counts the form gave for them.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import type { MonthlyCounts, MonthsFromFile } from './metadata.ts';
import type { RejectedUploadRecord } from './rejection.ts';

const monthListFormat = new Intl.ListFormat('en', { type: 'conjunction' });

export function monthsWithoutCounts(
  monthsFromFile: MonthsFromFile,
  monthlyCounts: MonthlyCounts,
): RejectedUploadRecord | undefined {
  const uncounted = monthsFromFile.filter((month) => !(month in monthlyCounts));
  if (uncounted.length === 0) return undefined;

  const those = uncounted.length === 1 ? 'that month' : 'those months';
  return {
    reason: 'invalid_metadata',
    summary: `Your file has orders in ${monthListFormat.format(uncounted)}, but you did not give a count for ${those}.`,
    rejectionDetail: `months in the file with no count: ${uncounted.join(', ')}`,
  };
}
