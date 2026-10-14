import { type Cookies, isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthMode } from '#lib/auth/mode.js';
import {
  readSiteSession,
  SITE_SESSION_COOKIE_NAME,
  SITE_SESSION_LIFETIME_SECONDS,
} from '#lib/server/auth/site-password.js';
import { SERVER_LOGS } from '#lib/server/testing/logs.js';
import { _signIn, _signOut } from './+server.ts';

const PASSWORD = 'correct-horse-battery';

const state = vi.hoisted(() => ({ mode: 'placeholder' as AuthMode }));
vi.mock('#lib/auth/mode.js', () => ({ authMode: () => state.mode }));
vi.mock('#lib/server/env.js', () => ({ requirePrivateVar: () => 'correct-horse-battery' }));

beforeEach(() => {
  state.mode = 'placeholder';
});

function aJar() {
  return { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
}

function expectNotFound(act: () => unknown) {
  try {
    act();
    expect.unreachable('should have thrown');
  } catch (thrown) {
    if (!isHttpError(thrown)) throw thrown;
    expect(thrown.status).toBe(404);
    expect(thrown.body.code).toBe('not_found');
  }
}

describe('_signIn', () => {
  test('the site password starts a session', () => {
    const cookies = aJar();

    const response = _signIn(cookies as unknown as Cookies, { password: PASSWORD });

    expect(response.status).toBe(204);
    expect(cookies.set).toHaveBeenCalledExactlyOnceWith(
      SITE_SESSION_COOKIE_NAME,
      expect.any(String),
      {
        path: '/',
        maxAge: SITE_SESSION_LIFETIME_SECONDS,
      },
    );
    const value = cookies.set.mock.calls[0]?.[1];
    expect(readSiteSession(PASSWORD, value, Math.floor(Date.now() / 1000))).not.toBeNull();
  });

  test('any other password is a 401, and a warning', async () => {
    const cookies = aJar();

    const response = _signIn(cookies as unknown as Cookies, { password: 'correct-horse-staple' });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: 'Wrong password' });
    expect(cookies.set).not.toHaveBeenCalled();
    expect(SERVER_LOGS.records).toEqual([{ level: 'warn', msg: 'Wrong site password' }]);
  });

  test.each([{}, { password: 1234 }, null])('a malformed body %j is a 400', (body) => {
    const cookies = aJar();

    expect(_signIn(cookies as unknown as Cookies, body).status).toBe(400);
    expect(cookies.set).not.toHaveBeenCalled();
  });

  test('is not found in supabase mode', () => {
    state.mode = 'supabase';

    expectNotFound(() => _signIn(aJar() as unknown as Cookies, { password: PASSWORD }));
  });
});

describe('_signOut', () => {
  test('clears the session', () => {
    const cookies = aJar();

    expect(_signOut(cookies as unknown as Cookies).status).toBe(204);
    expect(cookies.delete).toHaveBeenCalledExactlyOnceWith(SITE_SESSION_COOKIE_NAME, { path: '/' });
  });

  test('is not found in supabase mode', () => {
    state.mode = 'supabase';

    expectNotFound(() => _signOut(aJar() as unknown as Cookies));
  });
});
