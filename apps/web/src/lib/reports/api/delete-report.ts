import { apiCall } from '$lib/api/fetch';
import { reportApiHref } from '$lib/hrefs';

export async function deleteReport(organizationId: string, reportId: string): Promise<void> {
  await apiCall(reportApiHref(organizationId, reportId), { method: 'DELETE' });
}
