import { apiCall, isApiFailure } from '#lib/api/fetch.js';

export type RenameSelfOutcome = { kind: 'renamed' } | { kind: 'unknown' };

/** No failure has a meaning of its own: the form has already refused an invalid name, so anything
 * the server answers besides a 204 leaves us unsure whether the rename happened.
 *
 * It sends the browser's time zone too, which the server keeps only as a country. Onboarding asks
 * every account its name, so this is how every account gets one. Rejected: a request of its own
 * each session, which would keep the country current for someone who moves, at the cost of an
 * endpoint and client state. */
export async function renameSelf(displayName: string): Promise<RenameSelfOutcome> {
  const { timeZone } = Intl.DateTimeFormat().resolvedOptions();
  try {
    await apiCall('/api/account', {
      method: 'PATCH',
      body: JSON.stringify({ displayName, timeZone }),
    });
    return { kind: 'renamed' };
  } catch (error) {
    if (isApiFailure(error)) return { kind: 'unknown' };
    throw error;
  }
}
