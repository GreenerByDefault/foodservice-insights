import { ApiError, ApiUnreachableError, apiCall } from '$lib/api/fetch';

export type RenameSelfOutcome = { kind: 'renamed' } | { kind: 'unknown' };

/** No failure has a meaning of its own: the form has already refused an invalid name, so anything
 * the server answers besides a 204 leaves us unsure whether the rename happened. */
export async function renameSelf(displayName: string): Promise<RenameSelfOutcome> {
  try {
    await apiCall('/api/account', { method: 'PATCH', body: JSON.stringify({ displayName }) });
    return { kind: 'renamed' };
  } catch (error) {
    if (error instanceof ApiError || error instanceof ApiUnreachableError)
      return { kind: 'unknown' };
    throw error;
  }
}
