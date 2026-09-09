import type { OrganizationRole } from '@gbd/db';
import { ApiError, ApiUnreachableError, apiCall } from '$lib/api/fetch';
import { organizationMemberApiHref } from '$lib/hrefs';

export type ChangeMemberRoleOutcome =
  | { kind: 'changed' }
  | { kind: 'last-admin' }
  | { kind: 'unknown' };

export async function changeMemberRole(
  organizationSlug: string,
  userId: string,
  role: OrganizationRole,
): Promise<ChangeMemberRoleOutcome> {
  try {
    await apiCall(organizationMemberApiHref(organizationSlug, userId), {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    return { kind: 'changed' };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return { kind: 'last-admin' };
    if (error instanceof ApiError || error instanceof ApiUnreachableError)
      return { kind: 'unknown' };
    throw error;
  }
}
