import type { RequestEvent } from '@sveltejs/kit';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { authMode } from '#lib/auth/mode.js';
import { UNEXPECTED_ERROR_MESSAGE } from '#lib/errors/messages.js';
import { loadAuthorization } from '#lib/server/auth/authorization.js';
import { identifyUser } from '#lib/server/auth/identify.js';
import type { AuthContext } from '#lib/server/auth/types.js';
import { closeDatabase, database, withDbErrorHandling } from '#lib/server/db.js';
import { logger } from '#lib/server/log.js';
import { closeBlobStore } from '#lib/server/storage.js';

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
export const handleError: HandleServerError = ({ kind, error: cause, event }) => {
  // Our own `error()` already carries the body we chose, and whoever threw it logged it if it
  // deserved logging. Returning nothing keeps that body, `code` included.
  if (kind === 'app') return;

  // SvelteKit's own errors — a 404 for an unknown route, a 405 — are not failures of ours, and
  // logging every crawler that guesses a URL would bury the failures that are.
  if (kind !== 'unknown') return cause.status === 404 ? { code: 'not_found' } : undefined;

  // Enough of a fingerprint to find this line again from a user saying "it broke around 2pm".
  logger().error(
    {
      method: event.request.method,
      path: event.url.pathname,
      routeId: event.route.id,
      userId: event.locals.auth?.user.id,
      err: cause,
    },
    'Unhandled server error',
  );
  // `cause` is a bug or an outage, whose message and stack may say more about the system than a
  // stranger should learn. None of it crosses back to the client; it stays in the log line above.
  return { message: UNEXPECTED_ERROR_MESSAGE };
};

/** Log a crash as one record, and release the connection pool and blob store sockets on
 * shutdown, so a redeploy leaks neither.
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
    logger().warn(
      'PUBLIC_AUTH_MODE=placeholder: every request is the one seeded user, with no sign-in.',
    );
  }

  // Without these, Node writes its own multi-line trace to stderr, which a host ingests as one
  // entry per line. The destination is synchronous, so the record is written before the exit.
  process.on('uncaughtException', (cause) => {
    logger().fatal({ err: cause }, 'Uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger().fatal({ err: reason }, 'Unhandled rejection');
    process.exit(1);
  });

  process.on('sveltekit:shutdown', async (reason) => {
    logger().info({ reason }, 'Shutting down');
    // allSettled, so one failing cleanup cannot strand the others.
    const outcomes = await Promise.allSettled([closeDatabase(), closeBlobStore()]);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') logger().error({ err: outcome.reason }, 'Cleanup failed');
    }
  });
};
