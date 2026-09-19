/** The browser's half of Supabase Auth: a lazily loaded, deliberately narrow view of
 * `supabase.auth`.
 *
 * Narrow for two reasons. It keeps supabase-js out of the root chunk — the module is only fetched
 * once a visitor actually submits the sign-in form — and it makes the seam a component test has to
 * fake four functions wide instead of a whole client (`testing/fake.ts`).
 *
 * Supabase is a token service here and nothing else: no `locals.supabase`, no callback route, no
 * RLS. See `ARCHITECTURE.md` § Supabase.
 */

import { AUTH_COOKIE_NAME } from '@gbd/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

type SupabaseAuth = SupabaseClient['auth'];

/** The four calls the app makes, picked from the real client so their signatures cannot drift. */
export type BrowserAuth = Pick<SupabaseAuth, 'signInWithOtp' | 'verifyOtp' | 'signOut'> & {
  /** Promise-returning where the real client's is synchronous: the client is behind a dynamic
   * import, so the subscription cannot exist until that import has resolved. */
  onAuthStateChange: (
    ...args: Parameters<SupabaseAuth['onAuthStateChange']>
  ) => Promise<ReturnType<SupabaseAuth['onAuthStateChange']>>;
};

let authPromise: Promise<SupabaseAuth> | null = null;

async function loadAuth(): Promise<SupabaseAuth> {
  if (!browser) throw new Error('Supabase auth is only reachable from the browser.');

  authPromise ??= import('@supabase/ssr').then(({ createBrowserClient }) => {
    const url = env.PUBLIC_SUPABASE_URL;
    const key = env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) {
      throw new Error(
        'PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_PUBLISHABLE_KEY must both be set to sign in.',
      );
    }

    return createBrowserClient(url, key, {
      cookieOptions: { name: AUTH_COOKIE_NAME },
      // The server hook refreshes the token on every request, through its own `getUser()`. Left
      // on, the two race for the single-use refresh token and whichever loses is signed out —
      // supabase/ssr#68.
      auth: { autoRefreshToken: false },
    }).auth;
  });
  return authPromise;
}

/** The auth client for this browser.
 *
 * Safe to call during SSR — nothing happens until one of its methods is called, and that only
 * happens in response to a user interaction — so a page can pass it to a component it also
 * server-renders.
 */
export function browserAuth(): BrowserAuth {
  return {
    async signInWithOtp(...args) {
      return (await loadAuth()).signInWithOtp(...args);
    },
    async verifyOtp(...args) {
      return (await loadAuth()).verifyOtp(...args);
    },
    async signOut(...args) {
      return (await loadAuth()).signOut(...args);
    },
    async onAuthStateChange(...args) {
      return (await loadAuth()).onAuthStateChange(...args);
    },
  };
}
