import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { ApiError, ApiUnreachableError } from '#lib/api/fetch.js';
import type { AuthMode } from '#lib/auth/mode.js';
import { authError, fakeBrowserAuth } from '#lib/auth/testing/fake.js';
import {
  expectFetched,
  jsonResponse,
  stubFetch,
  stubUnreachableFetch,
} from '#lib/testing/fetch.js';
import { resetNavigationMocks } from '#lib/testing/navigation.js';
import { resetToastMocks, toast } from '#lib/testing/toast.js';
import { goto } from '$app/navigation';
import UserMenu from './user-menu.svelte';

const auth = vi.hoisted(() => ({ current: null as ReturnType<typeof fakeBrowserAuth> | null }));
vi.mock('#lib/auth/browser.js', () => ({ browserAuth: () => auth.current }));
vi.mock('$app/navigation', () => import('#lib/testing/navigation.js'));
vi.mock('svelte-sonner', () => import('#lib/testing/toast.js'));

beforeEach(() => {
  auth.current = fakeBrowserAuth();
  resetNavigationMocks();
  resetToastMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Opens the menu and returns the screen — the content is portalled, so it only exists once open. */
async function opened(props: { email: string; displayName: string; mode?: AuthMode }) {
  const screen = await render(UserMenu, { mode: 'supabase', ...props });
  await screen.getByRole('button', { name: 'Account menu' }).click();
  return screen;
}

async function clickSignOut(mode: AuthMode) {
  const screen = await opened({ email: 'ana@example.test', displayName: 'Ana Ruiz', mode });
  await screen.getByRole('menuitem', { name: 'Sign out' }).click();
}

describe('UserMenu', () => {
  test('the trigger shows the monogram for a display name', async () => {
    const screen = await render(UserMenu, {
      email: 'ana@example.test',
      displayName: 'Ana Ruiz',
      mode: 'supabase',
    });

    await expect
      .element(screen.getByRole('button', { name: 'Account menu' }))
      .toHaveTextContent('AR');
  });

  test('the trigger falls back to an icon when the name has no visible character', async () => {
    const screen = await render(UserMenu, {
      email: 'ana@example.test',
      // A zero-width space: the database's trim leaves it, so it is a name `initials` must refuse.
      displayName: String.fromCharCode(0x200b),
      mode: 'supabase',
    });

    const trigger = screen.getByRole('button', { name: 'Account menu' });
    await expect.poll(() => trigger.element().querySelector('svg')).not.toBeNull();
  });

  test('the open menu shows the display name and email', async () => {
    const screen = await opened({ email: 'ana@example.test', displayName: 'Ana Ruiz' });

    await expect.element(screen.getByText('Ana Ruiz')).toBeVisible();
    await expect.element(screen.getByText('ana@example.test')).toBeVisible();
  });

  test('the open menu links Account to /account', async () => {
    const screen = await opened({ email: 'ana@example.test', displayName: 'Ana Ruiz' });

    await expect
      .element(screen.getByRole('menuitem', { name: 'Your account' }))
      .toHaveAttribute('href', '/account');
  });

  test('the open menu links Invitations to /invites', async () => {
    const screen = await opened({ email: 'ana@example.test', displayName: 'Ana Ruiz' });

    await expect
      .element(screen.getByRole('menuitem', { name: 'Your invitations' }))
      .toHaveAttribute('href', '/invites');
  });

  describe('signing out in supabase mode', () => {
    test("ends this device's session, then goes to / with fresh data", async () => {
      await clickSignOut('supabase');

      await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
      expect(auth.current?.signOut.mock.calls).toEqual([[{ scope: 'local' }]]);
      expect(goto).toHaveBeenCalledWith('/', { refreshAll: true });
      expect(auth.current?.signOut).toHaveBeenCalledBefore(vi.mocked(goto));
      expect(toast.error).not.toHaveBeenCalled();
    });

    test('goes to / even when GoTrue refuses to revoke the session', async () => {
      auth.current?.signOut.mockResolvedValue({ error: authError('unexpected_failure') });

      await clickSignOut('supabase');

      await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
      expect(goto).toHaveBeenCalledWith('/', { refreshAll: true });
    });

    test('stays put, and says so, when the client itself could not load', async () => {
      const cause = new Error('chunk failed to load');
      auth.current?.signOut.mockRejectedValue(cause);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await clickSignOut('supabase');

      await expect.poll(() => consoleError.mock.calls).toEqual([['Could not sign out', cause]]);
      expect(goto).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledExactlyOnceWith("Couldn't sign out. Try again.");
      consoleError.mockRestore();
    });
  });

  describe('signing out in placeholder mode', () => {
    test('ends the site session, then goes to / with fresh data', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 204 }));

      await clickSignOut('placeholder');

      await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
      expectFetched(fetchMock, { url: '/api/site-session', method: 'DELETE' });
      expect(goto).toHaveBeenCalledWith('/', { refreshAll: true });
      expect(fetchMock).toHaveBeenCalledBefore(vi.mocked(goto));
      expect(auth.current?.signOut).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    test('stays put, and says so, when the server refuses', async () => {
      stubFetch(jsonResponse({ message: 'Internal Error' }, 500));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await clickSignOut('placeholder');

      await expect
        .poll(() => consoleError.mock.calls)
        .toEqual([['Could not sign out', expect.any(ApiError)]]);
      expect(goto).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledExactlyOnceWith("Couldn't sign out. Try again.");
      consoleError.mockRestore();
    });

    test('stays put, and says so, when the server could not be reached', async () => {
      stubUnreachableFetch();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await clickSignOut('placeholder');

      await expect
        .poll(() => consoleError.mock.calls)
        .toEqual([['Could not sign out', expect.any(ApiUnreachableError)]]);
      expect(goto).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledExactlyOnceWith("Couldn't sign out. Try again.");
      consoleError.mockRestore();
    });
  });
});
