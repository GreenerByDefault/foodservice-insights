import type { UserId } from '@gbd/db';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { expectFetched, jsonResponse, stubFetch } from '$lib/testing/fetch';
import type { MemberRow } from './+page.server.ts';
import MemberActions from './member-actions.svelte';
import { LAST_ADMIN_MESSAGE } from './member-write.ts';
import { aMember, lastAdminResponse } from './testing/fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Opens the menu and returns the screen — the content is portalled, so it only exists once open. */
async function opened(props: {
  organizationSlug: string;
  member: MemberRow;
  onDone: () => Promise<void>;
}) {
  const screen = await render(MemberActions, props);
  await screen.getByRole('button').click();
  return screen;
}

describe('MemberActions', () => {
  test('a member row offers Make admin only', async () => {
    const screen = await opened({
      organizationSlug: 'org-1',
      member: aMember({ role: 'member' }),
      onDone: vi.fn(),
    });

    await expect.element(screen.getByRole('menuitem', { name: 'Make admin' })).toBeInTheDocument();
    await expect
      .element(screen.getByRole('menuitem', { name: 'Make member' }))
      .not.toBeInTheDocument();
  });

  test('an admin row offers Make member only', async () => {
    const screen = await opened({
      organizationSlug: 'org-1',
      member: aMember({ role: 'admin' }),
      onDone: vi.fn(),
    });

    await expect.element(screen.getByRole('menuitem', { name: 'Make member' })).toBeInTheDocument();
    await expect
      .element(screen.getByRole('menuitem', { name: 'Make admin' }))
      .not.toBeInTheDocument();
  });

  describe('changing a role', () => {
    test('promoting PATCHes the member with role admin, then calls onDone', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 204 }));
      const onDone = vi.fn().mockResolvedValue(undefined);
      const member = aMember({ role: 'member', userId: 'user-1' as UserId });
      const screen = await opened({ organizationSlug: 'org-1', member, onDone });

      await screen.getByRole('menuitem', { name: 'Make admin' }).click();

      await expect.poll(() => onDone.mock.calls.length).toBe(1);
      expectFetched(fetchMock, {
        url: '/api/orgs/org-1/members/user-1',
        method: 'PATCH',
        body: { role: 'admin' },
      });
    });

    test('a 409 shows the last-admin message and does not call onDone', async () => {
      stubFetch(lastAdminResponse());
      const onDone = vi.fn().mockResolvedValue(undefined);
      const screen = await opened({
        organizationSlug: 'org-1',
        member: aMember({ role: 'admin' }),
        onDone,
      });

      await screen.getByRole('menuitem', { name: 'Make member' }).click();

      await expect.element(screen.getByText(LAST_ADMIN_MESSAGE)).toBeVisible();
      expect(onDone).not.toHaveBeenCalled();
    });

    // This is the one "any other failure" case worth keeping: `setRole` renders its own alert
    // rather than going through `ConfirmAction`, so nothing else covers its fallback message.
    test('any other failure shows a generic message', async () => {
      stubFetch(jsonResponse({ message: 'Nope' }, 500));
      const screen = await opened({
        organizationSlug: 'org-1',
        member: aMember({ role: 'member' }),
        onDone: vi.fn(),
      });

      await screen.getByRole('menuitem', { name: 'Make admin' }).click();

      await expect
        .element(screen.getByText('Could not update this member. Please try again.'))
        .toBeVisible();
    });
  });

  describe('removing another member', () => {
    test('confirming DELETEs the member, then calls onDone', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 204 }));
      const onDone = vi.fn().mockResolvedValue(undefined);
      const member = aMember({ userId: 'user-1' as UserId });
      const screen = await opened({ organizationSlug: 'org-1', member, onDone });

      await screen.getByRole('menuitem', { name: 'Remove from organization' }).click();
      await screen.getByRole('button', { name: 'Yes, remove' }).click();

      await expect.poll(() => onDone.mock.calls.length).toBe(1);
      expectFetched(fetchMock, { url: '/api/orgs/org-1/members/user-1', method: 'DELETE' });
    });

    test('a 409 shows the last-admin message and does not call onDone', async () => {
      stubFetch(lastAdminResponse());
      const onDone = vi.fn().mockResolvedValue(undefined);
      const screen = await opened({ organizationSlug: 'org-1', member: aMember(), onDone });

      await screen.getByRole('menuitem', { name: 'Remove from organization' }).click();
      await screen.getByRole('button', { name: 'Yes, remove' }).click();

      await expect.element(screen.getByText(LAST_ADMIN_MESSAGE)).toBeVisible();
      expect(onDone).not.toHaveBeenCalled();
    });
  });
});
