import { AUTH_COOKIE_NAME } from '@gbd/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { mockEnv, createBrowserClient } = vi.hoisted(() => ({
  mockEnv: {
    PUBLIC_SUPABASE_URL: undefined as string | undefined,
    PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined as string | undefined,
  },
  createBrowserClient: vi.fn(),
}));
vi.mock('$app/env', () => ({ browser: true }));
vi.mock('$app/env/public', () => mockEnv);
vi.mock('@supabase/ssr', () => ({ createBrowserClient }));

const signOut = vi.fn().mockResolvedValue({ error: null });

function setEnv() {
  mockEnv.PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  mockEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
}

/** A fresh copy of the module each time: the loaded client is module state, and every test here is
 * about what happens to it. */
async function freshBrowserAuth() {
  vi.resetModules();
  const { browserAuth } = await import('./browser.ts');
  return browserAuth();
}

beforeEach(() => {
  mockEnv.PUBLIC_SUPABASE_URL = undefined;
  mockEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY = undefined;
  createBrowserClient.mockReset().mockReturnValue({ auth: { signOut } });
  signOut.mockClear();
  vi.stubGlobal('location', { protocol: 'https:' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserAuth', () => {
  test('loads nothing until a method is called', async () => {
    setEnv();
    await freshBrowserAuth();

    expect(createBrowserClient).not.toHaveBeenCalled();
  });

  test('creates the client once and reuses it across calls', async () => {
    setEnv();
    const auth = await freshBrowserAuth();

    await auth.signOut({ scope: 'local' });
    await auth.signOut({ scope: 'local' });

    expect(createBrowserClient).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  test('a failed load is not cached, so the next call tries again', async () => {
    const auth = await freshBrowserAuth();

    await expect(auth.signOut({ scope: 'local' })).rejects.toThrow(
      'PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_PUBLISHABLE_KEY must both be set to sign in.',
    );

    setEnv();
    await expect(auth.signOut({ scope: 'local' })).resolves.toEqual({ error: null });
    expect(createBrowserClient).toHaveBeenCalledTimes(1);
  });

  describe('the session cookie', () => {
    async function cookieOptionsFor(protocol: string) {
      vi.stubGlobal('location', { protocol });
      setEnv();
      await (await freshBrowserAuth()).signOut({ scope: 'local' });
      return createBrowserClient.mock.calls[0]?.[2].cookieOptions;
    }

    test('is Secure on an https page', async () => {
      expect(await cookieOptionsFor('https:')).toEqual({ name: AUTH_COOKIE_NAME, secure: true });
    });

    test('is not Secure on an http page, which could not set it otherwise', async () => {
      expect(await cookieOptionsFor('http:')).toEqual({ name: AUTH_COOKIE_NAME, secure: false });
    });
  });
});
