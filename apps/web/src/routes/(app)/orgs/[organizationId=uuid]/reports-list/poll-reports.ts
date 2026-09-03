/** The client side of `./poll/+server.ts`: posts the ids currently on screen and turns the JSON
 * back into the same `ReportsPollData` shape `+page.server.ts` describes — see
 * `reports/[reportId=uuid]/polling/poll-report.ts`'s doc comment for why dates need reviving at
 * all.
 */

import type { ReportId } from '@gbd/db';
import { apiCall } from '$lib/api/fetch';
import type { ReportListRow, ReportsPollData } from '../+page.server.ts';

type WireReportListRow = Omit<ReportListRow, 'createdAt' | 'now'> & {
  createdAt: string;
  now: string;
};

type WireReportsPollData = Omit<ReportsPollData, 'reports'> & { reports: WireReportListRow[] };

/** Throws `ApiError` on a non-2xx response, `ApiUnreachableError` if none arrived — see
 * `$lib/api/fetch.ts`. */
export async function pollReports(pollHref: string, ids: ReportId[]): Promise<ReportsPollData> {
  const response = await apiCall(pollHref, { method: 'POST', body: JSON.stringify({ ids }) });
  const wire: WireReportsPollData = await response.json();
  return { reports: wire.reports.map(reviveRow) };
}

function reviveRow(row: WireReportListRow): ReportListRow {
  return { ...row, createdAt: new Date(row.createdAt), now: new Date(row.now) };
}
