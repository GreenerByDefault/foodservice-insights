/** The client side of `./poll/+server.ts`: fetches it and turns the JSON back into the same
 * `ReportsPageData` shape `+page.server.ts` renders with — see `reports/[reportId=uuid]/polling/
 * poll-report.ts`'s doc comment for why dates need reviving at all.
 */

import { apiCall } from '$lib/api/fetch';
import type { ReportListRow, ReportsPageData } from './+page.server.ts';

type WireReportListRow = Omit<ReportListRow, 'createdAt' | 'now'> & {
  createdAt: string;
  now: string;
};

type WireReportsPageData = Omit<ReportsPageData, 'reports'> & { reports: WireReportListRow[] };

/** Throws `ApiError` on a non-2xx response, `ApiUnreachableError` if none arrived — see
 * `$lib/api/fetch.ts`. */
export async function pollReports(pollHref: string): Promise<ReportsPageData> {
  const response = await apiCall(pollHref);
  const wire: WireReportsPageData = await response.json();
  return { ...wire, reports: wire.reports.map(reviveRow) };
}

function reviveRow(row: WireReportListRow): ReportListRow {
  return { ...row, createdAt: new Date(row.createdAt), now: new Date(row.now) };
}
