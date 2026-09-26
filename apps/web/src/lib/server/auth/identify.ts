/** Who is making this request? Everything downstream — `loadAuthorization`, the guards — takes
 * the id this answers with and never asks how it was found.
 *
 * In `placeholder` mode every request is the seeded user from `pnpm seed:identity`. Keep the
 * `@gbd/db/seed` import confined to this file so it's easy to remove later.
 *
 * In `supabase` mode it is the session cookie, validated by `getUser()` — a round trip to Supabase
 * Auth on every request, never the unverified `getSession()`. That round trip is also what catches a
 * deleted or banned user whose token has not expired yet. Supabase is a token service here and
 * nothing more; see `ARCHITECTURE.md` § Supabase.
 */

import { AUTH_COOKIE_NAME } from '@gbd/core';
import type { UserId } from '@gbd/db';
import { PLACEHOLDER_USER_ID } from '@gbd/db/seed';
import { type CookieOptions, createServerClient } from '@supabase/ssr';
import {
  type AuthError,
  isAuthApiError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  type User,
} from '@supabase/supabase-js';
import { error, type RequestEvent } from '@sveltejs/kit';
import { authMode } from '$lib/auth/mode';
import { SERVICE_UNAVAILABLE_ERROR } from '$lib/errors/messages';
import { requirePublicVar } from '$lib/server/env';

export async function identifyUser(event: RequestEvent): Promise<UserId | null> {
  if (authMode() === 'placeholder') return PLACEHOLDER_USER_ID;
  return await identifyFromSession(event);
}

export type AuthResult =
  | { kind: 'signed-in'; userId: UserId }
  /** `clearCookie` stops the browser re-sending a session Supabase has already refused. */
  | { kind: 'signed-out'; clearCookie: boolean; log?: string }
  | { kind: 'unavailable' };

/** What a `getUser()` answer means for this request. */
export function classifyAuthResult(result: {
  user: User | null;
  error: AuthError | null;
}): AuthResult {
  const { user, error: cause } = result;
  if (cause === null) {
    return user === null
      ? { kind: 'signed-out', clearCookie: false }
      : { kind: 'signed-in', userId: user.id as UserId };
  }

  // No cookie at all: the ordinary signed-out visitor.
  if (isAuthSessionMissingError(cause)) return { kind: 'signed-out', clearCookie: false };

  // An outage is not "signed out" — answering with a sign-in form would ask someone already signed
  // in to sign in again, and fail. Mirrors `withDbErrorHandling`'s 503.
  if (isAuthRetryableFetchError(cause)) return { kind: 'unavailable' };

  // A deleted user's token is still well-formed until it expires. That is normal, not worth a log.
  if (isAuthApiError(cause) && cause.code === 'user_not_found') {
    return { kind: 'signed-out', clearCookie: true };
  }

  return {
    kind: 'signed-out',
    clearCookie: true,
    log: `Supabase Auth refused the session: ${cause.name} ${cause.status ?? ''} ${cause.code ?? ''} ${cause.message}`,
  };
}

async function identifyFromSession(event: RequestEvent): Promise<UserId | null> {
  const supabase = createServerClient(
    requirePublicVar('PUBLIC_SUPABASE_URL'),
    requirePublicVar('PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
    {
      // Pinned, because the default is derived from the Supabase URL's hostname, which differs
      // between a host process (`127.0.0.1`) and a container (`host.docker.internal`).
      cookieOptions: { name: AUTH_COOKIE_NAME },
      cookies: {
        getAll: () => event.cookies.getAll(),
        setAll: (cookies, headers) => writeSessionCookies(event, cookies, headers),
      },
      global: { fetch: event.fetch },
    },
  );

  const { data, error: cause } = await supabase.auth.getUser();
  const result = classifyAuthResult({ user: data.user, error: cause });

  switch (result.kind) {
    case 'signed-in':
      return result.userId;
    case 'unavailable':
      console.error('Could not reach Supabase Auth to validate a session', {
        path: event.url.pathname,
        error: cause,
      });
      error(503, SERVICE_UNAVAILABLE_ERROR);
      break;
    case 'signed-out':
      if (result.log) console.warn(result.log, { path: event.url.pathname });
      // `local` touches this cookie only, not the user's sessions on other devices.
      if (result.clearCookie) await supabase.auth.signOut({ scope: 'local' });
      return null;
  }
}

/** `getUser()` rotates an expired access token as a side effect, so this can run on any request. */
function writeSessionCookies(
  event: RequestEvent,
  cookies: { name: string; value: string; options: CookieOptions }[],
  headers: Record<string, string>,
): void {
  try {
    for (const { name, value, options } of cookies) {
      event.cookies.set(name, value, {
        ...options,
        path: '/',
        // Not SvelteKit's default of always-secure: the browser container reaches the app over
        // plain `http://host.docker.internal`, which is not a secure context, so a `Secure` cookie
        // would never come back.
        secure: event.url.protocol === 'https:',
      });
    }
    // `Cache-Control: no-store` and friends, so no shared cache ever hands one person's session
    // cookie to another. Only the first write carries them.
    event.setHeaders(headers);
  } catch (cause) {
    // A token can rotate after a streamed response has already sent its headers, and then there is
    // nowhere left to write the cookie. The browser keeps the old one, which the next request
    // refreshes again, so this is survivable.
    if (cause instanceof Error && cause.message.includes('after the response has been generated')) {
      console.warn('Could not write a refreshed session cookie: the response had already started');
      return;
    }
    throw cause;
  }
}
