import { apiCall } from '$lib/api/fetch';
import { reportApiHref } from '$lib/hrefs';

export async function deleteReport(organizationSlug: string, reportId: string): Promise<void> {
  await apiCall(reportApiHref(organizationSlug, reportId), { method: 'DELETE' });
}
