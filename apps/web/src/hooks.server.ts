import type { Handle, ServerInit } from '@sveltejs/kit';
import { closeDatabase } from '$lib/server/db';
import { closeBlobStore } from '$lib/server/storage';

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
