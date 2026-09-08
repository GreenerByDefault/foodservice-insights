import { ApiError, apiCall } from '$lib/api/fetch';
import { classifyNameWriteFailure } from './failure.ts';

export type CreateOrganizationOutcome =
  | { kind: 'created'; location: string }
  | { kind: 'name-taken' }
  | { kind: 'slug-taken' }
  | { kind: 'slug-reserved' }
  | { kind: 'slug-underivable' }
  | { kind: 'unknown' };

/** The three codes unique to create — a name that can't become an address, or one that becomes
 * an address that's reserved or already taken. Rename never hits these (its slug is fixed at
 * creation), so `classifyNameWriteFailure` stays two-case and this widens on top of it instead of
 * in the shared classifier. */
function slugFailureKind(
  error: ApiError,
): 'slug-taken' | 'slug-reserved' | 'slug-underivable' | undefined {
  const body = error.jsonBody;
  if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.code === 'string') {
    if (
      body.code === 'slug-taken' ||
      body.code === 'slug-reserved' ||
      body.code === 'slug-underivable'
    ) {
      return body.code;
    }
  }
  return undefined;
}

export async function createOrganization(name: string): Promise<CreateOrganizationOutcome> {
  try {
    const response = await apiCall('/api/orgs', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return { kind: 'created', location: response.headers.get('location') ?? '/orgs' };
  } catch (error) {
    if (error instanceof ApiError) {
      const slugFailure = slugFailureKind(error);
      if (slugFailure) return { kind: slugFailure };
    }
    return classifyNameWriteFailure(error);
  }
}
