import { apiCall } from '$lib/api/fetch';
import { organizationApiHref } from '$lib/hrefs';

export async function deleteOrganization(organizationSlug: string): Promise<void> {
  await apiCall(organizationApiHref(organizationSlug), { method: 'DELETE' });
}
