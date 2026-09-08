import { apiCall } from '$lib/api/fetch';
import { organizationApiHref } from '$lib/hrefs';
import { classifyNameWriteFailure } from './failure.ts';

export type RenameOrganizationOutcome =
  | { kind: 'renamed' }
  | { kind: 'name-taken' }
  | { kind: 'unknown' };

export async function renameOrganization(
  organizationSlug: string,
  name: string,
): Promise<RenameOrganizationOutcome> {
  try {
    await apiCall(organizationApiHref(organizationSlug), {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    return { kind: 'renamed' };
  } catch (error) {
    return classifyNameWriteFailure(error);
  }
}
