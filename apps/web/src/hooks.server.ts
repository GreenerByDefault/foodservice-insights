import type { Handle, RequestEvent, ServerInit } from '@sveltejs/kit';
import { loadAuthorization } from '$lib/server/auth/authorization';
import { identifyUser } from '$lib/server/auth/identify';
import type { AuthContext } from '$lib/server/auth/types';
import { closeDatabase, database } from '$lib/server/db';
import { closeBlobStore } from '$lib/server/storage';

/** The liveness probe reports on the database, so it must be able to answer without one. */
const HEALTH_PATH = '/health';

function applySecurityHeaders(response: Response): Response {
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}

/** Identify the caller, then look up what they may do, once per request.
 *
 * Claims come from the database rather than the token, so they cannot go stale. Routes read the
 * result off `locals` through the guards in `$lib/server/auth/guards`.
 */
async function resolveAuth(event: RequestEvent): Promise<AuthContext | null> {
  if (event.url.pathname === HEALTH_PATH) return null;

  const userId = await identifyUser(event);
  if (!userId) return null;

  let auth: AuthContext | null;
  try {
    auth = await loadAuthorization(database(), userId);
  } catch (cause) {
    // An unreachable database should be a 401, not a 500 on every route at once.
    console.error('Could not load authorization; treating the request as signed out:', cause);
    return null;
  }

  if (!auth) {
    // Loud on purpose. Silently returning null here turns an unseeded database into unexplained
    // 401s everywhere. Drop the `pnpm seed` sentence when `identifyUser` starts reading a real JWT,
    // at which point this only means a token for a user who has since been deleted.
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
