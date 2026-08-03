import type { Handle } from '@sveltejs/kit';

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
