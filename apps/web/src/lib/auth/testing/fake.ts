import type { AuthError } from '@supabase/supabase-js';
import { type Mock, vi } from 'vitest';
import type { BrowserAuth } from '$lib/auth/browser';

/** A `BrowserAuth` whose every method is a `vi.fn()`, so the sign-in form can be driven without a
 * Supabase client, a network, or an environment. Assignable to `BrowserAuth`, while still
 * exposing `.mock` to the test. */
export type FakeBrowserAuth = { [K in keyof BrowserAuth]: Mock<BrowserAuth[K]> };

/** Each method starts out returning the shape Supabase returns on success — the case most tests
 * want. A test about a failure overrides the one method it is about. */
export function fakeBrowserAuth(): FakeBrowserAuth {
  return {
    signInWithOtp: vi.fn<BrowserAuth['signInWithOtp']>().mockResolvedValue({
      data: { user: null, session: null, messageId: null },
      error: null,
    }),
    verifyOtp: vi
      .fn<BrowserAuth['verifyOtp']>()
      .mockResolvedValue({ data: { user: null, session: null }, error: null }),
    signOut: vi.fn<BrowserAuth['signOut']>().mockResolvedValue({ error: null }),
    onAuthStateChange: vi.fn<BrowserAuth['onAuthStateChange']>().mockResolvedValue({
      data: { subscription: { id: 'fake', callback: () => {}, unsubscribe: () => {} } },
    }),
  };
}

/** An `AuthError` carrying `code`, which is all `describeAuthError` and the form ever read.
 *
 * A literal behind a cast rather than `new AuthApiError(...)`: constructing the real class would
 * make this the only runtime import of `@supabase/supabase-js` in the component tier, which Vite
 * then has to pre-bundle mid-run and warns can reload a test out from under itself. The cast is
 * needed either way — `AuthError` guards itself with a protected `__isAuthError`.
 */
export function authError(code: string): AuthError {
  return {
    name: 'AuthApiError',
    message: `fake ${code}`,
    status: 400,
    code,
  } as unknown as AuthError;
}
