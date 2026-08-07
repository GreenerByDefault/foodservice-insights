import { PLACEHOLDER_USER_ID } from '@gbd/db/seed';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { closeDatabase, database } from '$lib/server/db';
import { loadSession } from '$lib/server/session';
import { closeBlobStore } from '$lib/server/storage';

function applySecurityHeaders(response: Response): Response {
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.session = await loadPlaceholderSession();
  const response = await resolve(event);
  return applySecurityHeaders(response);
};

/** The phase-1 stand-in for authentication.
 *
 * Phase 2 replaces this function's body only: validate the Supabase JWT on the request and pass
 * its `sub` to `loadSession`. The shape of `locals.session` does not change.
 *
 * A database failure has to come back as `null` rather than throw. `/health` is what Playwright
 * waits on before running anything, and a hook that throws would fail it as a 500 rather than
 * letting the route report a degraded database.
 */
async function loadPlaceholderSession() {
  try {
    return await loadSession(database(), PLACEHOLDER_USER_ID);
  } catch (error) {
    console.error('Could not load the placeholder session — has `pnpm seed` been run?', error);
    return null;
  }
}

/** Unexpected failures, shaped like every deliberate one.
 *
 * `error()` responses never reach here; this is for what nothing caught, so the message is
 * always generic and the detail only goes to the logs.
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
  // A request for a route that does not exist arrives here too, and is not worth logging.
  if (status === 404) return { message, code: 'not_found' as const };

  console.error(`Unhandled error on ${event.route.id ?? event.url.pathname}:`, error);
  return { message: 'Something went wrong', code: 'internal' as const };
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
