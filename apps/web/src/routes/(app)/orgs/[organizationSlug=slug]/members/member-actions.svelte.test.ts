import type { UserId } from '@gbd/db';
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { lastFetchCall, stubFetch } from '$lib/testing/fetch';
import type { MemberRow } from './+page.server.ts';
import MemberActions from './member-actions.svelte';

function aMember(overrides: Partial<MemberRow> = {}): MemberRow {
  return {
    userId: crypto.randomUUID() as UserId,
    displayName: 'Ana Ruiz',
    email: 'ana@example.test',
    role: 'member',
    isYou: false,
    ...overrides,
  };
}

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

  test('the last admin’s own row offers Make member live, for the trigger to refuse', async () => {
    const screen = await opened({
      organizationSlug: 'org-1',
      member: aMember({ role: 'admin', isYou: true }),
      onDone: vi.fn(),
    });

    await expect.element(screen.getByRole('menuitem', { name: 'Make member' })).toBeEnabled();
  });

  test('promoting PATCHes the member with role admin, then calls onDone', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const onDone = vi.fn().mockResolvedValue(undefined);
    const member = aMember({ role: 'member', userId: 'user-1' as UserId });
    const screen = await opened({
      organizationSlug: 'org-1',
      member,
      onDone,
    });

    await screen.getByRole('menuitem', { name: 'Make admin' }).click();

    await expect.poll(() => onDone.mock.calls.length).toBe(1);
    const [url, options] = lastFetchCall(fetchMock);
    expect(url).toBe('/api/orgs/org-1/members/user-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ role: 'admin' });
  });

  test('a 409 shows the last-admin message and does not call onDone', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'Only admin', code: 'last-admin' }), {
        status: 409,
      }),
    );
    const onDone = vi.fn().mockResolvedValue(undefined);
    const screen = await opened({
      organizationSlug: 'org-1',
      member: aMember({ role: 'admin' }),
      onDone,
    });

    await screen.getByRole('menuitem', { name: 'Make member' }).click();

    await expect
      .element(screen.getByText("You're the only admin. Make someone else an admin first."))
      .toBeVisible();
    expect(onDone).not.toHaveBeenCalled();
  });

  test('any other failure shows a generic message', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Nope' }), { status: 500 }));
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
