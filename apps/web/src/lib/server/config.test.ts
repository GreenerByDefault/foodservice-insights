import { afterEach, describe, expect, test, vi } from 'vitest';

// Mutable copies of the real environments, which `afterEach` puts back.
const { privateEnv, publicEnv, originals } = vi.hoisted(() => ({
  privateEnv: {} as Record<string, string | undefined>,
  publicEnv: {} as Record<string, string | undefined>,
  originals: { private: {}, public: {} } as Record<'private' | 'public', object>,
}));
vi.mock('$app/env/private', async (importOriginal) => {
  originals.private = { ...(await importOriginal<object>()) };
  return Object.assign(privateEnv, originals.private);
});
vi.mock('$app/env/public', async (importOriginal) => {
  originals.public = { ...(await importOriginal<object>()) };
  return Object.assign(publicEnv, originals.public);
});

/** A fresh copy of every handle module: each caches what it built, and a cached handle would never
 * read the variable a test just unset. */
async function freshAssertConfigured(): Promise<() => void> {
  vi.resetModules();
  const { assertConfigured } = await import('./config.ts');
  return assertConfigured;
}

afterEach(() => {
  Object.assign(privateEnv, originals.private);
  Object.assign(publicEnv, originals.public);
});

describe('assertConfigured', () => {
  test.each(['placeholder', 'supabase'])(
    'passes with every variable set in %s mode',
    async (mode) => {
      const assertConfigured = await freshAssertConfigured();
      publicEnv.PUBLIC_AUTH_MODE = mode;

      expect(assertConfigured).not.toThrow();
    },
  );

  test.each(['DB_CONNECTION_STRING', 'S3_BUCKET', 'EMAIL_FROM_ADDRESS'])(
    'throws without %s',
    async (name) => {
      const assertConfigured = await freshAssertConfigured();
      publicEnv.PUBLIC_AUTH_MODE = 'placeholder';
      privateEnv[name] = undefined;

      expect(assertConfigured).toThrow(`Must set the env var '${name}'`);
    },
  );

  // Every page's Content-Security-Policy names it, sign-in or not.
  test.each(['placeholder', 'supabase'])(
    'throws without the Supabase project in %s mode',
    async (mode) => {
      const assertConfigured = await freshAssertConfigured();
      publicEnv.PUBLIC_AUTH_MODE = mode;
      publicEnv.PUBLIC_SUPABASE_URL = undefined;

      expect(assertConfigured).toThrow("Must set the env var 'PUBLIC_SUPABASE_URL'");
    },
  );

  test('throws without SITE_PASSWORD in placeholder mode', async () => {
    const assertConfigured = await freshAssertConfigured();
    publicEnv.PUBLIC_AUTH_MODE = 'placeholder';
    privateEnv.SITE_PASSWORD = undefined;

    expect(assertConfigured).toThrow("Must set the env var 'SITE_PASSWORD'");
  });

  test('passes without SITE_PASSWORD in supabase mode', async () => {
    const assertConfigured = await freshAssertConfigured();
    publicEnv.PUBLIC_AUTH_MODE = 'supabase';
    privateEnv.SITE_PASSWORD = undefined;

    expect(assertConfigured).not.toThrow();
  });

  test('throws on an unset PUBLIC_AUTH_MODE', async () => {
    const assertConfigured = await freshAssertConfigured();
    publicEnv.PUBLIC_AUTH_MODE = undefined;

    expect(assertConfigured).toThrow('PUBLIC_AUTH_MODE is not set');
  });
});
