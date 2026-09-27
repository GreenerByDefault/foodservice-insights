import { ApiError, ApiUnreachableError, apiCall } from '$lib/api/fetch';
import { declineInviteApiHref } from '$lib/hrefs';

/** `declined` covers dismissing an expired invite too: the endpoint answers both with a 204. */
export type DeclineInviteOutcome =
  | { kind: 'declined' }
  | { kind: 'no-longer-valid' }
  | { kind: 'unknown' };

/** Decline `inviteId` as the signed-in user — or, if it has already run out, dismiss it. */
export async function declineInvite(inviteId: string): Promise<DeclineInviteOutcome> {
  try {
    await apiCall(declineInviteApiHref(inviteId), { method: 'POST' });
    return { kind: 'declined' };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return { kind: 'no-longer-valid' };
    if (error instanceof ApiError || error instanceof ApiUnreachableError)
      return { kind: 'unknown' };
    throw error;
  }
}
