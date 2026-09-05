/** The client-side call behind the new-organization form. */

import { ApiError, ApiUnreachableError, apiCall } from '$lib/api/fetch';

export type CreateOrganizationOutcome =
  | { kind: 'created'; location: string }
  | { kind: 'name-taken' }
  | { kind: 'unknown' };

export async function createOrganization(name: string): Promise<CreateOrganizationOutcome> {
  try {
    const response = await apiCall('/api/orgs', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return { kind: 'created', location: response.headers.get('location') ?? '/orgs' };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return { kind: 'name-taken' };
    // Everything else — `ApiUnreachableError`, a 5xx, and a 400 we don't otherwise handle — is
    // answered the same way: we don't know whether the organization was created, so the safe
    // advice is to go check the organization list.
    if (error instanceof ApiError || error instanceof ApiUnreachableError)
      return { kind: 'unknown' };
    throw error;
  }
}
