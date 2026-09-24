import { beforeEach, describe, expect, test, vi } from 'vitest';

const { mockEnv, createBrowserClient } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string>,
  createBrowserClient: vi.fn(),
}));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$env/dynamic/public', () => ({ env: mockEnv }));
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
  for (const name of Object.keys(mockEnv)) delete mockEnv[name];
  createBrowserClient.mockReset().mockReturnValue({ auth: { signOut } });
  signOut.mockClear();
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
});
