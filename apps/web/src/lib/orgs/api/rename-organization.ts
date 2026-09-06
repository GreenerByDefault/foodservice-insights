/** The client-side call behind the settings page's rename form. */

import { ApiError, ApiUnreachableError, apiCall } from '$lib/api/fetch';
import { organizationApiHref } from '$lib/hrefs';

export type RenameOrganizationOutcome =
  | { kind: 'renamed' }
  | { kind: 'name-taken' }
  | { kind: 'unknown' };

export async function renameOrganization(
  organizationId: string,
  name: string,
): Promise<RenameOrganizationOutcome> {
  try {
    await apiCall(organizationApiHref(organizationId), {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    return { kind: 'renamed' };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return { kind: 'name-taken' };
    // Everything else — `ApiUnreachableError`, a 5xx, and a 400 we don't otherwise handle — is
    // answered the same way: we don't know whether the rename went through, so the safe advice is
    // to check the current name before trying again.
    if (error instanceof ApiError || error instanceof ApiUnreachableError)
      return { kind: 'unknown' };
    throw error;
  }
}
