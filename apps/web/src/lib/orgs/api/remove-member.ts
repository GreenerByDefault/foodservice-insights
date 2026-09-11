import { ApiError, ApiUnreachableError, apiCall } from '$lib/api/fetch';
import { organizationMemberApiHref } from '$lib/hrefs';

export type RemoveMemberOutcome =
  | { kind: 'removed' }
  | { kind: 'last-admin' }
  | { kind: 'unknown' };

/** Remove `userId` from the organization, or leave it — the same request with your own id. */
export async function removeMember(
  organizationSlug: string,
  userId: string,
): Promise<RemoveMemberOutcome> {
  try {
    await apiCall(organizationMemberApiHref(organizationSlug, userId), { method: 'DELETE' });
    return { kind: 'removed' };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return { kind: 'last-admin' };
    if (error instanceof ApiError || error instanceof ApiUnreachableError)
      return { kind: 'unknown' };
    throw error;
  }
}
