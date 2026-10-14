import { type Cookies, error } from '@sveltejs/kit';
import * as v from 'valibot';
import { authMode } from '#lib/auth/mode.js';
import {
  endSiteSession,
  isSitePassword,
  startSiteSession,
} from '#lib/server/auth/site-password.js';
import { parseBody } from '#lib/server/body.js';
import { logger } from '#lib/server/log.js';
import type { RequestHandler } from './$types';

/** Sign in with the site password, in `placeholder` mode. 401 for the wrong one, 204 on success. */
export const POST: RequestHandler = async ({ cookies, request }) =>
  _signIn(cookies, await request.json());

/** Sign out, in `placeholder` mode. 204 whether or not there was a session to end. */
export const DELETE: RequestHandler = ({ cookies }) => _signOut(cookies);

export function _signIn(cookies: Cookies, body: unknown): Response {
  requirePlaceholderMode();
  const parsed = parseBody(v.object({ password: v.string() }), body);
  if (!parsed.ok) return parsed.response;

  if (!isSitePassword(parsed.value.password)) {
    // At `warn`, so someone working through guesses stands out in the log.
    logger().warn('Wrong site password');
    return Response.json({ message: 'Wrong password' }, { status: 401 });
  }

  startSiteSession(cookies);
  return new Response(null, { status: 204 });
}

export function _signOut(cookies: Cookies): Response {
  requirePlaceholderMode();
  endSiteSession(cookies);
  return new Response(null, { status: 204 });
}

function requirePlaceholderMode(): void {
  if (authMode() !== 'placeholder') error(404, 'Not found', { code: 'not_found' });
}
