import { AUTH_COOKIE_NAME } from '@gbd/core';
import type { UserId } from '@gbd/db';
import { PLACEHOLDER_USER_ID } from '@gbd/db/seed';
import {
  AuthApiError,
  type AuthError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
  type User,
} from '@supabase/supabase-js';
import { isHttpError, type RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as mode from '$lib/auth/mode';
import { classifyAuthResult, identifyUser } from './identify.ts';

const { createServerClient } = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient }));
vi.mock('$lib/auth/mode', () => ({ authMode: vi.fn() }));
vi.mock('$lib/server/env', () => ({ requirePublicVar: (name: string) => `<${name}>` }));

const A_USER_ID = crypto.randomUUID() as UserId;

function aUser(): User {
  return { id: A_USER_ID } as unknown as User;
}

describe('classifyAuthResult', () => {
  test('a user is signed in', () => {
    expect(classifyAuthResult({ user: aUser(), error: null })).toEqual({
      kind: 'signed-in',
      userId: A_USER_ID,
    });
  });

  test('no cookie, or a session GoTrue no longer has, is signed out with nothing to clear', () => {
    expect(classifyAuthResult({ user: null, error: new AuthSessionMissingError() })).toEqual({
      kind: 'signed-out',
      reason: 'no-session',
      action: { clearCookie: false },
    });
  });

  test("a deleted user's token is signed out and cleared, quietly", () => {
    const error = new AuthApiError(
      'User from sub claim in JWT does not exist',
      403,
      'user_not_found',
    );

    expect(classifyAuthResult({ user: null, error })).toEqual({
      kind: 'signed-out',
      reason: 'refused',
      action: { clearCookie: true },
    });
  });

  test('any other refusal is signed out and cleared, with a log', () => {
    const error = new AuthApiError(
      'Invalid Refresh Token: Already Used',
      400,
      'refresh_token_already_used',
    );

    expect(classifyAuthResult({ user: null, error })).toEqual({
      kind: 'signed-out',
      reason: 'refused',
      action: {
        clearCookie: true,
        log: 'Supabase Auth refused the session: AuthApiError 400 refresh_token_already_used Invalid Refresh Token: Already Used',
      },
    });
  });

  test('an unrecognized error is signed out and cleared, with a log', () => {
    const result = classifyAuthResult({
      user: null,
      error: new AuthUnknownError('bad JSON', new SyntaxError()),
    });

    expect(result).toEqual({
      kind: 'signed-out',
      reason: 'refused',
      action: { clearCookie: true, log: expect.any(String) },
    });
  });

  test('an unreachable Supabase Auth is unavailable, not signed out', () => {
    expect(
      classifyAuthResult({ user: null, error: new AuthRetryableFetchError('fetch failed', 0) }),
    ).toEqual({ kind: 'unavailable' });
  });
});

describe('identifyUser', () => {
  const getUser = vi.fn();
  const signOut = vi.fn();

  beforeEach(() => {
    vi.mocked(mode.authMode).mockReset().mockReturnValue('supabase');
    getUser.mockReset();
    signOut.mockReset().mockResolvedValue({ error: null });
    createServerClient.mockReset().mockReturnValue({ auth: { getUser, signOut } });
  });

  function anEvent(): RequestEvent {
    return {
      url: new URL('http://localhost/orgs'),
      cookies: { getAll: vi.fn(() => []), set: vi.fn() },
      setHeaders: vi.fn(),
      fetch: vi.fn(),
    } as unknown as RequestEvent;
  }

  function answer(user: User | null, error: AuthError | null) {
    getUser.mockResolvedValue({ data: { user }, error });
  }

  /** The `setAll` `identifyUser` handed the client, as `@supabase/ssr` would call it. */
  function setAllFromClient() {
    return createServerClient.mock.calls[0]?.[2].cookies.setAll;
  }

  test('in placeholder mode, is the placeholder, without asking Supabase', async () => {
    vi.mocked(mode.authMode).mockReturnValue('placeholder');

    expect(await identifyUser(anEvent())).toBe(PLACEHOLDER_USER_ID);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  test('is the session user, read through the pinned cookie name', async () => {
    answer(aUser(), null);
    const event = anEvent();

    expect(await identifyUser(event)).toBe(A_USER_ID);
    expect(createServerClient).toHaveBeenCalledWith(
      '<PUBLIC_SUPABASE_URL>',
      '<PUBLIC_SUPABASE_PUBLISHABLE_KEY>',
      {
        cookieOptions: { name: AUTH_COOKIE_NAME },
        cookies: { getAll: expect.any(Function), setAll: expect.any(Function) },
        global: { fetch: event.fetch },
      },
    );
    expect(signOut).not.toHaveBeenCalled();
  });

  test('clears a session Supabase refused', async () => {
    answer(null, new AuthApiError('gone', 403, 'user_not_found'));

    expect(await identifyUser(anEvent())).toBeNull();
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  test('leaves a visitor with no session alone', async () => {
    answer(null, new AuthSessionMissingError());

    expect(await identifyUser(anEvent())).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
  });

  test('503s when Supabase Auth is unreachable', async () => {
    answer(null, new AuthRetryableFetchError('fetch failed', 0));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await identifyUser(anEvent());
      expect.unreachable('identifyUser should have thrown');
    } catch (thrown) {
      if (!isHttpError(thrown)) throw thrown;
      expect(thrown.status).toBe(503);
      expect(thrown.body.code).toBe('service_unavailable');
    }
    logged.mockRestore();
  });

  describe('writing a refreshed session', () => {
    beforeEach(() => {
      answer(aUser(), null);
    });

    // Exactly what `@supabase/ssr` hands `setAll`: its own defaults, and no `secure`.
    const cookie = {
      name: `${AUTH_COOKIE_NAME}.0`,
      value: 'base64-abc',
      options: { path: '/', sameSite: 'lax', httpOnly: false, maxAge: 34_560_000 },
    };
    const headers = {
      'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
      Expires: '0',
      Pragma: 'no-cache',
    };

    test('writes the cookie as sent, `httpOnly: false` included, and the no-cache headers', async () => {
      const event = anEvent();
      await identifyUser(event);

      setAllFromClient()([cookie], headers);

      // Strict, so even `secure: undefined` fails: it would override SvelteKit's default. And
      // `httpOnly` has to stay `false`: SvelteKit's default of `true` would lock the browser client
      // out of the cookie it signs out with.
      expect(vi.mocked(event.cookies.set).mock.calls).toStrictEqual([
        [
          cookie.name,
          cookie.value,
          { path: '/', sameSite: 'lax', httpOnly: false, maxAge: 34_560_000 },
        ],
      ]);
      expect(event.setHeaders).toHaveBeenCalledWith(headers);
    });
  });
});
