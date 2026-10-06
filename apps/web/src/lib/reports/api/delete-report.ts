import { apiCall } from '#lib/api/fetch.js';
import { reportApiHref } from '#lib/hrefs.js';

export async function deleteReport(organizationSlug: string, reportId: string): Promise<void> {
  await apiCall(reportApiHref(organizationSlug, reportId), { method: 'DELETE' });
}
