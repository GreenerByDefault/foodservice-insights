import type { UserId } from '@gbd/db';
import type { Session } from '@supabase/supabase-js';
import { createRawSnippet } from 'svelte';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { browserAuth } from '#lib/auth/browser.js';
import type { AuthMode } from '#lib/auth/mode.js';
import { type FakeBrowserAuth, fakeBrowserAuth } from '#lib/auth/testing/fake.js';
import { resetNavigationMocks } from '#lib/testing/navigation.js';
import { invalidateAll } from '$app/navigation';
import Layout from './+layout.svelte';

const state = vi.hoisted(() => ({
  auth: null as FakeBrowserAuth | null,
  mode: 'supabase' as AuthMode,
}));
vi.mock('#lib/auth/browser.js', () => ({ browserAuth: vi.fn(() => state.auth) }));
vi.mock('#lib/auth/mode.js', () => ({ authMode: () => state.mode }));
vi.mock('$app/navigation', () => import('#lib/testing/navigation.js'));

beforeEach(() => {
  state.auth = fakeBrowserAuth();
  state.mode = 'supabase';
  vi.mocked(browserAuth).mockClear();
  resetNavigationMocks();
});

const children = createRawSnippet(() => ({ render: () => '<div></div>' }));

function props(sessionUserId: string | null) {
  return { data: { sessionUserId: sessionUserId as UserId | null }, params: {}, children };
}

function sessionFor(userId: string): Session {
  return { user: { id: userId } } as Session;
}

describe('+layout.svelte', () => {
  test('in placeholder mode, never reaches for the auth client', async () => {
    state.mode = 'placeholder';

    await render(Layout, props(null));

    expect(browserAuth).not.toHaveBeenCalled();
  });

  describe('following the session', () => {
    async function subscribed(sessionUserId: string | null = 'ana') {
      const screen = await render(Layout, props(sessionUserId));
      await expect.poll(() => state.auth?.onAuthStateChange.mock.calls.length).toBe(1);
      const callback = state.auth?.onAuthStateChange.mock.calls[0]?.[0];
      if (!callback) throw new Error('onAuthStateChange was not given a callback');
      return { screen, callback };
    }

    test('re-runs the loads when the user changes, not when auth-js confirms the same one', async () => {
      const { callback } = await subscribed('ana');

      await callback('SIGNED_IN', sessionFor('ana'));
      await callback('INITIAL_SESSION', sessionFor('ana'));
      await callback('SIGNED_IN', sessionFor('ana'));
      expect(invalidateAll).not.toHaveBeenCalled();

      await callback('SIGNED_OUT', null);
      expect(invalidateAll).toHaveBeenCalledOnce();
    });

    test('re-runs the loads when the session ended before the client started', async () => {
      const { callback } = await subscribed('ana');

      await callback('INITIAL_SESSION', null);

      expect(invalidateAll).toHaveBeenCalledOnce();
    });

    test('unsubscribes on unmount', async () => {
      const unsubscribe = vi.fn();
      state.auth?.onAuthStateChange.mockResolvedValue({
        data: { subscription: { id: 'fake', callback: () => {}, unsubscribe } },
      });
      const { screen } = await subscribed();

      screen.unmount();

      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    test('unsubscribes a subscription that arrives after unmount', async () => {
      const unsubscribe = vi.fn();
      const { promise, resolve } =
        Promise.withResolvers<Awaited<ReturnType<FakeBrowserAuth['onAuthStateChange']>>>();
      state.auth?.onAuthStateChange.mockReturnValue(promise);
      const { screen } = await subscribed();

      screen.unmount();
      resolve({ data: { subscription: { id: 'fake', callback: () => {}, unsubscribe } } });

      await expect.poll(() => unsubscribe.mock.calls.length).toBe(1);
    });

    test('logs, rather than rejects, when the client could not load', async () => {
      const cause = new Error('chunk failed to load');
      state.auth?.onAuthStateChange.mockRejectedValue(cause);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await render(Layout, props('ana'));

      await expect
        .poll(() => consoleError.mock.calls)
        .toEqual([['Could not follow the session', cause]]);
      consoleError.mockRestore();
    });
  });
});
