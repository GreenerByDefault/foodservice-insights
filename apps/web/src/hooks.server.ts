import type { Handle, HandleServerError, RequestEvent, ServerInit } from '@sveltejs/kit';
import { authMode } from '$lib/auth/mode';
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
  });

  if (auth) return auth;

  // A setup error in either mode, never a signed-out visitor: in `supabase` mode,
  // `on_auth_user_created` writes the row in the same transaction as the GoTrue user.
  throw new Error(
    `The identified user ${userId} has no app_user row. ` +
      (authMode() === 'placeholder'
        ? 'Run `pnpm seed:identity` (or `TEST_DB=1 pnpm seed:identity`).'
        : 'Is DATABASE_URL the database Supabase Auth writes to, with migrations applied?'),
  );
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
  // `vite dev` builds a fresh `Server` per request and calls `init` on each one — unlike
  // production's single long-lived instance — so without this guard every request in a dev
  // session would add another listener and eventually trip MaxListenersExceededWarning.
  if (process.listenerCount('sveltekit:shutdown') > 0) return;

  // Stops the server on an unset or unknown value, rather than on its first request.
  if (authMode() === 'placeholder') {
    console.warn(
      'PUBLIC_AUTH_MODE=placeholder: every request is the one seeded user, with no sign-in.',
    );
  }

  process.on('sveltekit:shutdown', async (reason) => {
    console.log('Shutting down:', reason);
    // allSettled, so one failing cleanup cannot strand the others.
    const outcomes = await Promise.allSettled([closeDatabase(), closeBlobStore()]);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') console.error('Cleanup failed:', outcome.reason);
    }
  });
};
