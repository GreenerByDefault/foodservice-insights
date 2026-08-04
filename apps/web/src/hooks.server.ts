import { shutdownDatabase } from '@gbd/db';
import type { Handle, ServerInit } from '@sveltejs/kit';
import { DATABASE } from '$lib/server/db';

function applySecurityHeaders(response: Response): Response {
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  return applySecurityHeaders(response);
};

/** Release the connection pool on shutdown, so a redeploy does not leak connections.
 *
 * https://svelte.dev/docs/kit/adapter-node#Graceful-shutdown
 */
export const init: ServerInit = () => {
  process.on('sveltekit:shutdown', async (reason) => {
    console.log('Shutting down:', reason);
    // When there is more than one cleanup task, run them with Promise.allSettled so one
    // failure cannot strand the others.
    await shutdownDatabase(DATABASE);
  });
};
