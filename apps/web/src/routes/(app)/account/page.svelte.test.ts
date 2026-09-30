import type { UserId } from '@gbd/db';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { AuthMode } from '#lib/auth/mode.js';
import { fakeBrowserAuth } from '#lib/auth/testing/fake.js';
import Page from './+page.svelte';
import type { PageProps } from './$types';

const state = vi.hoisted(() => ({ mode: 'supabase' as AuthMode }));
vi.mock('#lib/auth/mode.js', () => ({ authMode: () => state.mode }));
vi.mock('#lib/auth/browser.js', () => ({ browserAuth: () => fakeBrowserAuth() }));
vi.mock('$app/navigation', () => import('#lib/testing/navigation.js'));

beforeEach(() => {
  state.mode = 'supabase';
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
  test('in supabase mode, offers to delete the account', async () => {
    const screen = await render(Page, props());

    await expect.element(screen.getByRole('button', { name: 'Delete account' })).toBeVisible();
  });

  test('in placeholder mode, has no delete section', async () => {
    state.mode = 'placeholder';

    const screen = await render(Page, props());

    await expect.element(screen.getByLabelText('Your name')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete account' }).query()).toBeNull();
  });
});
