import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { MemberRow } from './+page.server.ts';
import MembersList from './members-list.svelte';

function aMember(overrides: Partial<MemberRow> = {}): MemberRow {
  return {
    displayName: 'Ana Ruiz',
    email: 'ana@example.test',
    role: 'member',
    isYou: false,
    ...overrides,
  };
}

describe('MembersList', () => {
  test('shows the name, the email beneath it, and the role', async () => {
    const screen = await render(MembersList, { members: [aMember()] });

    await expect.element(screen.getByText('Ana Ruiz')).toBeVisible();
    await expect.element(screen.getByText('ana@example.test')).toBeVisible();
    await expect.element(screen.getByText('Member')).toBeVisible();
  });

  test('shows only the email for a member with no display name', async () => {
    const screen = await render(MembersList, {
      members: [aMember({ displayName: null, email: 'no-name@example.test' })],
    });

    await expect.element(screen.getByText('no-name@example.test').first()).toBeVisible();
  });

  test('labels an admin', async () => {
    const screen = await render(MembersList, { members: [aMember({ role: 'admin' })] });

    await expect.element(screen.getByText('Admin')).toBeVisible();
  });

  test('marks the viewer’s own row', async () => {
    const screen = await render(MembersList, { members: [aMember({ isYou: true })] });

    await expect.element(screen.getByText('(You)')).toBeVisible();
  });
});
