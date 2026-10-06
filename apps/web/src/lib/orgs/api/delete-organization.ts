import { apiCall } from '#lib/api/fetch.js';
import { organizationApiHref } from '#lib/hrefs.js';

export async function deleteOrganization(organizationSlug: string): Promise<void> {
  await apiCall(organizationApiHref(organizationSlug), { method: 'DELETE' });
}
