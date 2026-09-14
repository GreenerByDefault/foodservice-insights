import type { OrganizationRole } from '@gbd/db';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { goto, invalidateAll } from '$app/navigation';
import { expectFetched, stubFetch } from '$lib/testing/fetch';
import { resetNavigationMocks } from '$lib/testing/navigation';
import { LAST_ADMIN_MESSAGE } from './member-write.ts';
import { lastAdminResponse } from './testing/fixtures.ts';
import YourMembership from './your-membership.svelte';

vi.mock('$app/navigation', () => import('$lib/testing/navigation'));

afterEach(() => {
  vi.unstubAllGlobals();
  resetNavigationMocks();
});

function renderAs(viewerRole: OrganizationRole) {
  return render(YourMembership, { organizationSlug: 'org-1', viewerUserId: 'user-1', viewerRole });
}

describe('YourMembership', () => {
  test('a member sees Leave alone, with no Step down', async () => {
    const screen = await renderAs('member');

    await expect
      .element(screen.getByRole('button', { name: 'Step down as admin' }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole('button', { name: 'Leave organization' })).toBeVisible();
  });

  describe('stepping down', () => {
    test('PATCHes the viewer with role member, then refreshes', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 204 }));
      const screen = await renderAs('admin');

      await screen.getByRole('button', { name: 'Step down as admin' }).click();
      await screen.getByRole('button', { name: 'Yes, step down' }).click();

      await expect.poll(() => vi.mocked(invalidateAll).mock.calls.length).toBe(1);
      expectFetched(fetchMock, {
        url: '/api/orgs/org-1/members/user-1',
        method: 'PATCH',
        body: { role: 'member' },
      });
    });

    test('the sole admin is refused, and told how to proceed', async () => {
      stubFetch(lastAdminResponse());
      const screen = await renderAs('admin');

      await screen.getByRole('button', { name: 'Step down as admin' }).click();
      await screen.getByRole('button', { name: 'Yes, step down' }).click();

      await expect.element(screen.getByText(LAST_ADMIN_MESSAGE)).toBeVisible();
      expect(invalidateAll).not.toHaveBeenCalled();
    });
  });

  describe('leaving', () => {
    test('DELETEs the viewer, then navigates to /orgs', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 204 }));
      const screen = await renderAs('admin');

      await screen.getByRole('button', { name: 'Leave organization' }).click();
      await screen.getByRole('button', { name: 'Yes, leave' }).click();

      await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
      expect(goto).toHaveBeenCalledWith('/orgs', { invalidateAll: true });
      expectFetched(fetchMock, { url: '/api/orgs/org-1/members/user-1', method: 'DELETE' });
    });

    test('the only admin leaving is refused, and told how to proceed', async () => {
      stubFetch(lastAdminResponse());
      const screen = await renderAs('admin');

      await screen.getByRole('button', { name: 'Leave organization' }).click();
      await screen.getByRole('button', { name: 'Yes, leave' }).click();

      await expect.element(screen.getByText(LAST_ADMIN_MESSAGE)).toBeVisible();
      expect(goto).not.toHaveBeenCalled();
    });
  });
});
