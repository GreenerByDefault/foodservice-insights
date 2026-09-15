import type { OrganizationRole } from '@gbd/db';
import { ApiError, ApiUnreachableError, apiCall } from '$lib/api/fetch';
import { organizationInvitesApiHref } from '$lib/hrefs';

export type CreateInviteOutcome =
  | { kind: 'created'; inviteId: string; emailSent: boolean }
  | { kind: 'already-member' }
  | { kind: 'rate-limited' }
  | { kind: 'unknown' };

/** Invite `email` into `organizationSlug` as `role` — or re-invite it, if it already has a
 * pending invite outstanding. */
export async function createInvite(
  organizationSlug: string,
  email: string,
  role: OrganizationRole,
): Promise<CreateInviteOutcome> {
  try {
    const response = await apiCall(organizationInvitesApiHref(organizationSlug), {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
    const { inviteId, emailSent } = await response.json();
    return { kind: 'created', inviteId, emailSent };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 409) return { kind: 'already-member' };
      if (error.status === 429) return { kind: 'rate-limited' };
    }
    if (error instanceof ApiError || error instanceof ApiUnreachableError)
      return { kind: 'unknown' };
    throw error;
  }
}
