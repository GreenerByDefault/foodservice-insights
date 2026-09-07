import { apiCall } from '$lib/api/fetch';
import { organizationApiHref } from '$lib/hrefs';

export async function deleteOrganization(organizationId: string): Promise<void> {
  await apiCall(organizationApiHref(organizationId), { method: 'DELETE' });
}
