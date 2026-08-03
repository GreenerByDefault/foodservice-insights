import type { Handle } from '@sveltejs/kit';

/**
 * Baseline security headers on every response. CSP and HSTS come later, once
 * there is real content and a known deployment domain.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
};
