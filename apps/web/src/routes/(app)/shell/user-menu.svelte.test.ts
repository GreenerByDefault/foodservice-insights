import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { goto } from '$app/navigation';
import { authError, fakeBrowserAuth } from '$lib/auth/testing/fake';
import { resetNavigationMocks } from '$lib/testing/navigation';
import UserMenu from './user-menu.svelte';

const auth = vi.hoisted(() => ({ current: null as ReturnType<typeof fakeBrowserAuth> | null }));
vi.mock('$lib/auth/browser', () => ({ browserAuth: () => auth.current }));
vi.mock('$app/navigation', () => import('$lib/testing/navigation'));

beforeEach(() => {
  auth.current = fakeBrowserAuth();
  resetNavigationMocks();
});

/** Opens the menu and returns the screen — the content is portalled, so it only exists once open. */
async function opened(props: { email: string; displayName: string | null; canSignOut?: boolean }) {
  const screen = await render(UserMenu, { canSignOut: true, ...props });
  await screen.getByRole('button', { name: 'Account menu' }).click();
  return screen;
}

describe('UserMenu', () => {
  test('the trigger shows the monogram for a display name', async () => {
    const screen = await render(UserMenu, {
      email: 'ana@example.test',
      displayName: 'Ana Ruiz',
      canSignOut: true,
    });

    await expect
      .element(screen.getByRole('button', { name: 'Account menu' }))
      .toHaveTextContent('AR');
  });

  test('the trigger falls back to an icon when there is no display name', async () => {
    const screen = await render(UserMenu, {
      email: 'ana@example.test',
      displayName: null,
      canSignOut: true,
    });

    const trigger = screen.getByRole('button', { name: 'Account menu' });
    await expect.poll(() => trigger.element().querySelector('svg')).not.toBeNull();
  });

  test('the open menu shows the display name and email', async () => {
    const screen = await opened({ email: 'ana@example.test', displayName: 'Ana Ruiz' });

    await expect.element(screen.getByText('Ana Ruiz')).toBeVisible();
    await expect.element(screen.getByText('ana@example.test')).toBeVisible();
  });

  test('the open menu shows only the email when there is no display name', async () => {
    const screen = await opened({ email: 'ana@example.test', displayName: null });

    await expect.element(screen.getByText('ana@example.test')).toBeVisible();
  });

  test('the open menu links Account to /account', async () => {
    const screen = await opened({ email: 'ana@example.test', displayName: 'Ana Ruiz' });

    await expect
      .element(screen.getByRole('menuitem', { name: 'Account' }))
      .toHaveAttribute('href', '/account');
  });

  test('the open menu links Invitations to /invites', async () => {
    const screen = await opened({ email: 'ana@example.test', displayName: 'Ana Ruiz' });

    await expect
      .element(screen.getByRole('menuitem', { name: 'Invitations' }))
      .toHaveAttribute('href', '/invites');
  });

  test('the open menu hides sign out when there is no session to end', async () => {
    const screen = await opened({
      email: 'ana@example.test',
      displayName: 'Ana Ruiz',
      canSignOut: false,
    });

    await expect.element(screen.getByRole('menuitem', { name: 'Invitations' })).toBeVisible();
    await expect
      .element(screen.getByRole('menuitem', { name: 'Sign out' }))
      .not.toBeInTheDocument();
  });

  describe('signing out', () => {
    async function clickSignOut() {
      const screen = await opened({ email: 'ana@example.test', displayName: 'Ana Ruiz' });
      await screen.getByRole('menuitem', { name: 'Sign out' }).click();
    }

    test("ends this device's session, then goes to / with fresh data", async () => {
      await clickSignOut();

      await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
      expect(auth.current?.signOut.mock.calls).toEqual([[{ scope: 'local' }]]);
      expect(goto).toHaveBeenCalledWith('/', { invalidateAll: true });
      expect(auth.current?.signOut).toHaveBeenCalledBefore(vi.mocked(goto));
    });

    test('goes to / even when GoTrue refuses to revoke the session', async () => {
      auth.current?.signOut.mockResolvedValue({ error: authError('unexpected_failure') });

      await clickSignOut();

      await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
      expect(goto).toHaveBeenCalledWith('/', { invalidateAll: true });
    });

    test('stays put when the client itself could not load', async () => {
      const cause = new Error('chunk failed to load');
      auth.current?.signOut.mockRejectedValue(cause);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await clickSignOut();

      await expect.poll(() => consoleError.mock.calls).toEqual([['Could not sign out', cause]]);
      expect(goto).not.toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });
});
