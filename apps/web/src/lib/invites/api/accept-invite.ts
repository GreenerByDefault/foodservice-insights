import { ApiError, ApiUnreachableError, apiCall } from '$lib/api/fetch';
import { acceptInviteApiHref } from '$lib/hrefs';

export type AcceptInviteOutcome =
  | { kind: 'accepted'; organizationSlug: string }
  | { kind: 'expired' }
  | { kind: 'no-longer-valid' }
  | { kind: 'unknown' };

/** Accept `inviteId` as the signed-in user, joining the organization it names. */
export async function acceptInvite(inviteId: string): Promise<AcceptInviteOutcome> {
  try {
    const response = await apiCall(acceptInviteApiHref(inviteId), { method: 'POST' });
    const { organizationSlug } = await response.json();
    return { kind: 'accepted', organizationSlug };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 409) return { kind: 'no-longer-valid' };
      if (error.status === 410) return { kind: 'expired' };
    }
    if (error instanceof ApiError || error instanceof ApiUnreachableError)
      return { kind: 'unknown' };
    throw error;
  }
}
