import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { type FakeBrowserAuth, fakeBrowserAuth } from '#lib/auth/testing/fake.js';
import {
  expectFetched,
  jsonResponse,
  stubFetch,
  stubUnreachableFetch,
} from '#lib/testing/fetch.js';
import { resetNavigationMocks } from '#lib/testing/navigation.js';
import { resetToastMocks, toast } from '#lib/testing/toast.js';
import { goto } from '$app/navigation';
import DeleteAccount from './delete-account.svelte';

vi.mock('$app/navigation', () => import('#lib/testing/navigation.js'));
vi.mock('svelte-sonner', () => import('#lib/testing/toast.js'));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetNavigationMocks();
  resetToastMocks();
});

const EMAIL = 'sam.cook@example.test';

describe('DeleteAccount', () => {
  describe('as the only admin of some organizations', () => {
    test("names each one, linked to its members page, and can't be opened", async () => {
      const screen = await render(DeleteAccount, {
        auth: fakeBrowserAuth(),
        email: EMAIL,
        soleAdminOrganizations: [
          { slug: 'acme', name: 'Acme Foodservice' },
          { slug: 'ridgeview', name: 'Ridgeview Dining' },
        ],
      });

      await expect
        .element(screen.getByRole('link', { name: 'Acme Foodservice' }))
        .toHaveAttribute('href', '/orgs/acme/members');
      await expect
        .element(screen.getByRole('link', { name: 'Ridgeview Dining' }))
        .toHaveAttribute('href', '/orgs/ridgeview/members');
      await expect.element(screen.getByText(/only admin of the organizations below/)).toBeVisible();
      await expect.element(screen.getByRole('button', { name: 'Delete account' })).toBeDisabled();
    });

    test('one organization reads in the singular', async () => {
      const screen = await render(DeleteAccount, {
        auth: fakeBrowserAuth(),
        email: EMAIL,
        soleAdminOrganizations: [{ slug: 'acme', name: 'Acme Foodservice' }],
      });

      await expect
        .element(screen.getByText(/only admin of the organization below\./))
        .toBeVisible();
    });
  });

  describe('when nothing blocks it', () => {
    async function openDialog(auth: FakeBrowserAuth = fakeBrowserAuth()) {
      const screen = await render(DeleteAccount, {
        auth,
        email: EMAIL,
        soleAdminOrganizations: [],
      });
      await screen.getByRole('button', { name: 'Delete account' }).click();
      return screen;
    }

    test('confirm stays disabled until the email is typed exactly', async () => {
      const screen = await openDialog();
      const confirmButton = screen.getByRole('button', { name: 'Yes, delete my account' });

      await expect.element(confirmButton).toBeDisabled();
      await screen.getByLabelText(`Type "${EMAIL}" to confirm`).fill(EMAIL.slice(0, -1));
      await expect.element(confirmButton).toBeDisabled();
      await screen.getByLabelText(`Type "${EMAIL}" to confirm`).fill(EMAIL);
      await expect.element(confirmButton).toBeEnabled();
    });

    test('confirming DELETEs the account, signs this device out, goes to / and toasts', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 204 }));
      const auth = fakeBrowserAuth();
      const screen = await openDialog(auth);

      await screen.getByLabelText(`Type "${EMAIL}" to confirm`).fill(EMAIL);
      await screen.getByRole('button', { name: 'Yes, delete my account' }).click();

      await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
      expectFetched(fetchMock, { url: '/api/account', method: 'DELETE' });
      expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(auth.signOut.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(goto).mock.invocationCallOrder[0] ?? 0,
      );
      expect(goto).toHaveBeenCalledWith('/', { refreshAll: true });
      await expect.poll(() => toast.success.mock.calls).toEqual([['Deleted your account']]);
    });

    test('still goes to / when the auth client fails to load', async () => {
      stubFetch(new Response(null, { status: 204 }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const auth = fakeBrowserAuth();
      auth.signOut.mockRejectedValue(new Error('chunk failed to load'));
      const screen = await openDialog(auth);

      await screen.getByLabelText(`Type "${EMAIL}" to confirm`).fill(EMAIL);
      await screen.getByRole('button', { name: 'Yes, delete my account' }).click();

      await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
      expect(goto).toHaveBeenCalledWith('/', { refreshAll: true });
    });

    test('a last-admin 409 explains itself and neither signs out, navigates, nor toasts', async () => {
      stubFetch(jsonResponse({ message: 'Only admin', code: 'last-admin' }, 409));
      const auth = fakeBrowserAuth();
      const screen = await openDialog(auth);

      await screen.getByLabelText(`Type "${EMAIL}" to confirm`).fill(EMAIL);
      await screen.getByRole('button', { name: 'Yes, delete my account' }).click();

      await expect
        .element(screen.getByText(/can't be deleted while you're the only admin/))
        .toBeInTheDocument();
      expect(auth.signOut).not.toHaveBeenCalled();
      expect(goto).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });

    test('an unreachable server shows the generic error and neither signs out, navigates, nor toasts', async () => {
      stubUnreachableFetch();
      const auth = fakeBrowserAuth();
      const screen = await openDialog(auth);

      await screen.getByLabelText(`Type "${EMAIL}" to confirm`).fill(EMAIL);
      await screen.getByRole('button', { name: 'Yes, delete my account' }).click();

      await expect
        .element(screen.getByText('Could not delete your account. Please try again.'))
        .toBeInTheDocument();
      expect(auth.signOut).not.toHaveBeenCalled();
      expect(goto).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });
  });
});
