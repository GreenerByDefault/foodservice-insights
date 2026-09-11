import type { UserId } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { MemberRow } from './+page.server.ts';
import MembersList from './members-list.svelte';

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

describe('MembersList', () => {
  test('shows the name, the email beneath it, and the role', async () => {
    const screen = await render(MembersList, {
      members: [aMember()],
      organizationSlug: 'org-1',
      viewerRole: 'member',
    });

    await expect.element(screen.getByText('Ana Ruiz')).toBeVisible();
    await expect.element(screen.getByText('ana@example.test')).toBeVisible();
    await expect.element(screen.getByText('Member')).toBeVisible();
  });

  test('shows only the email for a member with no display name', async () => {
    const screen = await render(MembersList, {
      members: [aMember({ displayName: null, email: 'no-name@example.test' })],
      organizationSlug: 'org-1',
      viewerRole: 'member',
    });

    await expect.element(screen.getByText('no-name@example.test')).toBeVisible();
  });

  test('labels an admin', async () => {
    const screen = await render(MembersList, {
      members: [aMember({ role: 'admin' })],
      organizationSlug: 'org-1',
      viewerRole: 'member',
    });

    await expect.element(screen.getByText('Admin')).toBeVisible();
  });

  test('marks the viewer’s own row', async () => {
    const screen = await render(MembersList, {
      members: [aMember({ isYou: true })],
      organizationSlug: 'org-1',
      viewerRole: 'member',
    });

    await expect.element(screen.getByText('(You)')).toBeVisible();
  });

  test('a member viewer sees no per-row menu', async () => {
    const screen = await render(MembersList, {
      members: [aMember({ isYou: true }), aMember({ role: 'admin' })],
      organizationSlug: 'org-1',
      viewerRole: 'member',
    });

    await expect.element(screen.getByRole('button')).not.toBeInTheDocument();
  });

  test('an admin viewer sees a per-row menu for every other member', async () => {
    const screen = await render(MembersList, {
      members: [aMember({ isYou: true, role: 'admin' }), aMember({ displayName: null })],
      organizationSlug: 'org-1',
      viewerRole: 'admin',
    });

    expect(screen.getByRole('button').elements()).toHaveLength(1);
  });

  test('an admin viewer sees no menu on their own row — that’s “Your membership”’s job', async () => {
    const screen = await render(MembersList, {
      members: [aMember({ isYou: true, role: 'admin' })],
      organizationSlug: 'org-1',
      viewerRole: 'admin',
    });

    await expect.element(screen.getByRole('button')).not.toBeInTheDocument();
  });
});
