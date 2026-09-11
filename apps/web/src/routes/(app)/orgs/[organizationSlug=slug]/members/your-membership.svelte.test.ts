import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { goto, invalidateAll } from '$app/navigation';
import { lastFetchCall, stubFetch } from '$lib/testing/fetch';
import { resetNavigationMocks } from '$lib/testing/navigation';
import YourMembership from './your-membership.svelte';

vi.mock('$app/navigation', () => import('$lib/testing/navigation'));

afterEach(() => {
  vi.unstubAllGlobals();
  resetNavigationMocks();
});

describe('YourMembership', () => {
  test('stepping down PATCHes the viewer with role member, then refreshes', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const screen = await render(YourMembership, {
      organizationSlug: 'org-1',
      viewerUserId: 'user-1',
      viewerRole: 'admin',
    });

    await screen.getByRole('button', { name: 'Step down as admin' }).click();
    await screen.getByRole('button', { name: 'Yes, step down' }).click();

    await expect.poll(() => vi.mocked(invalidateAll).mock.calls.length).toBe(1);
    const [url, options] = lastFetchCall(fetchMock);
    expect(url).toBe('/api/orgs/org-1/members/user-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ role: 'member' });
  });

  test('the sole admin is refused, and told how to proceed', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'Only admin', code: 'last-admin' }), {
        status: 409,
      }),
    );
    const screen = await render(YourMembership, {
      organizationSlug: 'org-1',
      viewerUserId: 'user-1',
      viewerRole: 'admin',
    });

    await screen.getByRole('button', { name: 'Step down as admin' }).click();
    await screen.getByRole('button', { name: 'Yes, step down' }).click();

    await expect
      .element(screen.getByText("You're the only admin. Make someone else an admin first."))
      .toBeVisible();
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  test('any other failure shows a generic message', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Nope' }), { status: 500 }));
    const screen = await render(YourMembership, {
      organizationSlug: 'org-1',
      viewerUserId: 'user-1',
      viewerRole: 'admin',
    });

    await screen.getByRole('button', { name: 'Step down as admin' }).click();
    await screen.getByRole('button', { name: 'Yes, step down' }).click();

    await expect
      .element(screen.getByText('Could not update your role. Please try again.'))
      .toBeVisible();
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  test('a member sees Leave alone, with no Step down', async () => {
    const screen = await render(YourMembership, {
      organizationSlug: 'org-1',
      viewerUserId: 'user-1',
      viewerRole: 'member',
    });

    await expect
      .element(screen.getByRole('button', { name: 'Step down as admin' }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole('button', { name: 'Leave organization' })).toBeVisible();
  });

  describe('Leave organization', () => {
    test('DELETEs the viewer, then navigates to /orgs', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 204 }));
      const screen = await render(YourMembership, {
        organizationSlug: 'org-1',
        viewerUserId: 'user-1',
        viewerRole: 'admin',
      });

      await screen.getByRole('button', { name: 'Leave organization' }).click();
      await screen.getByRole('button', { name: 'Yes, leave' }).click();

      await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
      expect(goto).toHaveBeenCalledWith('/orgs', { invalidateAll: true });
      const [url, options] = lastFetchCall(fetchMock);
      expect(url).toBe('/api/orgs/org-1/members/user-1');
      expect(options.method).toBe('DELETE');
    });

    test('the only admin leaving is refused, and told how to proceed', async () => {
      stubFetch(
        new Response(JSON.stringify({ message: 'Only admin', code: 'last-admin' }), {
          status: 409,
        }),
      );
      const screen = await render(YourMembership, {
        organizationSlug: 'org-1',
        viewerUserId: 'user-1',
        viewerRole: 'admin',
      });

      await screen.getByRole('button', { name: 'Leave organization' }).click();
      await screen.getByRole('button', { name: 'Yes, leave' }).click();

      await expect
        .element(screen.getByText("You're the only admin. Make someone else an admin first."))
        .toBeVisible();
      expect(goto).not.toHaveBeenCalled();
    });

    test('any other failure shows a generic message', async () => {
      stubFetch(new Response(JSON.stringify({ message: 'Nope' }), { status: 500 }));
      const screen = await render(YourMembership, {
        organizationSlug: 'org-1',
        viewerUserId: 'user-1',
        viewerRole: 'admin',
      });

      await screen.getByRole('button', { name: 'Leave organization' }).click();
      await screen.getByRole('button', { name: 'Yes, leave' }).click();

      await expect
        .element(screen.getByText('Could not leave this organization. Please try again.'))
        .toBeVisible();
      expect(goto).not.toHaveBeenCalled();
    });
  });
});
