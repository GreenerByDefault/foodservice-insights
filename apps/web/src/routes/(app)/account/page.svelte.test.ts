import type { UserId } from '@gbd/db';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { fakeBrowserAuth } from '#lib/auth/testing/fake.js';
import { stubFetch } from '#lib/testing/fetch.js';
import { refreshAll, resetNavigationMocks } from '#lib/testing/navigation.js';
import { resetToastMocks, toast } from '#lib/testing/toast.js';
import Page from './+page.svelte';
import type { PageProps } from './$types';

vi.mock('#lib/auth/browser.js', () => ({ browserAuth: () => fakeBrowserAuth() }));
vi.mock('$app/navigation', () => import('#lib/testing/navigation.js'));
vi.mock('svelte-sonner', () => import('#lib/testing/toast.js'));

beforeEach(() => {
  resetNavigationMocks();
  resetToastMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function props(): PageProps {
  return {
    data: {
      sessionUserId: 'user-1' as UserId,
      user: { email: 'sam.cook@example.test', displayName: 'Sam Cook' },
      organizations: [],
      hasMoreOrganizations: false,
      soleAdminOrganizations: [],
    },
    params: {},
    form: undefined,
  };
}

describe('+page.svelte', () => {
  test('offers to change the email and delete the account', async () => {
    const screen = await render(Page, props());

    await expect.element(screen.getByLabelText('Email')).toHaveValue('sam.cook@example.test');
    await expect.element(screen.getByRole('button', { name: 'Change email' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Delete account' })).toBeVisible();
  });

  test('saving a name refreshes the shell, then says so', async () => {
    stubFetch(new Response(null, { status: 204 }));
    const screen = await render(Page, props());

    await screen.getByLabelText('Your name').fill('Alex Baker');
    await screen.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => toast.success.mock.calls).toEqual([['Name updated to Alex Baker']]);
    expect(refreshAll).toHaveBeenCalledBefore(toast.success);
  });
});
