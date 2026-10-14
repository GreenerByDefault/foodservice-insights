/** The browser's half of the site password, `placeholder` mode's sign-in. The server's half is
 * `/api/site-session`. */

import { ApiError, apiCall, isApiFailure } from '#lib/api/fetch.js';

export type SitePasswordOutcome =
  | { kind: 'signed-in' }
  | { kind: 'wrong-password' }
  | { kind: 'unknown' };

export async function signInWithSitePassword(password: string): Promise<SitePasswordOutcome> {
  try {
    await apiCall('/api/site-session', { method: 'POST', body: JSON.stringify({ password }) });
    return { kind: 'signed-in' };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { kind: 'wrong-password' };
    if (isApiFailure(error)) return { kind: 'unknown' };
    throw error;
  }
}

/** Rejects with whatever `apiCall` throws. */
export async function signOutOfSite(): Promise<void> {
  await apiCall('/api/site-session', { method: 'DELETE' });
}
