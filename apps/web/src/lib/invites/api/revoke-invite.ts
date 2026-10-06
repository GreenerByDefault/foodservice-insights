import { apiCall } from '#lib/api/fetch.js';
import { organizationInviteApiHref } from '#lib/hrefs.js';

/** Revoke a pending invite. Throws (`ApiError`/`ApiUnreachableError`) on any failure — there is
 * no per-outcome branching to do with a revoke the way there is with a create, so the caller
 * just catches. */
export async function revokeInvite(organizationSlug: string, inviteId: string): Promise<void> {
  await apiCall(organizationInviteApiHref(organizationSlug, inviteId), { method: 'DELETE' });
}
