import type { Handle, HandleServerError, RequestEvent, ServerInit } from '@sveltejs/kit';
import { UNEXPECTED_ERROR_MESSAGE } from '$lib/errors/messages';
import { loadAuthorization } from '$lib/server/auth/authorization';
import { identifyUser } from '$lib/server/auth/identify';
import type { AuthContext } from '$lib/server/auth/types';
import { closeDatabase, database, withDbErrorHandling } from '$lib/server/db';
import { closeBlobStore } from '$lib/server/storage';

/** The liveness probe reports on the database, so it must be able to answer without one. */
const HEALTH_PATH = '/health';

function applySecurityHeaders(response: Response): Response {
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}

/** Identify the caller, then look up what they may do, once per request. */
async function resolveAuth(event: RequestEvent): Promise<AuthContext | null> {
  if (event.url.pathname === HEALTH_PATH) return null;

  const userId = await identifyUser(event);
  if (!userId) return null;

  const auth = await withDbErrorHandling(() => loadAuthorization(database(), userId), {
    action: 'load authorization',
    context: { userId },
    status: 503,
    body: { message: 'The service is temporarily unavailable', code: 'service_unavailable' },
  });

  if (!auth) {
    // Temporary: with the placeholder `identifyUser`, a missing row only means an unseeded
    // database, so we throw loudly. Once it reads a real JWT, a missing row is a deleted user's
    // still-valid token — a normal case — so replace this throw with `error(401, ...)`.
    throw new Error(
      `Identified user ${userId} has no row in the database. ` +
        'If this is the phase-one placeholder, run `pnpm seed` (or `TEST_DB=1 pnpm seed`).',
    );
  }
  return auth;
}

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.auth = await resolveAuth(event);
  const response = await resolve(event);
  return applySecurityHeaders(response);
};

/** The last resort for a failure no route anticipated. */
export const handleError: HandleServerError = ({ error: cause, event, status, message }) => {
  // 404s come through here too. A missing page is not a failure of ours, and logging every crawler
  // that guesses a URL would bury the failures that are.
  if (status === 404) return { message, code: 'not_found' };

  // Enough of a fingerprint to find this line again from a user saying "it broke around 2pm".
  console.error('Unhandled server error', {
    status,
    method: event.request.method,
    path: event.url.pathname,
    routeId: event.route.id,
    userId: event.locals.auth?.user.id,
    error: cause,
  });
  // SvelteKit skips this hook for an expected `error()`, so `cause` is always a bug or an outage,
  // whose message and stack may say more about the system than a stranger should learn. None of it
  // crosses back to the client; it stays in the log line above.
  return { message: UNEXPECTED_ERROR_MESSAGE };
};

/** Release the connection pool and blob store sockets on shutdown, so a redeploy leaks neither.
 *
 * https://svelte.dev/docs/kit/adapter-node#Graceful-shutdown
 */
export const init: ServerInit = () => {
  process.on('sveltekit:shutdown', async (reason) => {
    console.log('Shutting down:', reason);
    // allSettled, so one failing cleanup cannot strand the others.
    const outcomes = await Promise.allSettled([closeDatabase(), closeBlobStore()]);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') console.error('Cleanup failed:', outcome.reason);
    }
  });
};
