import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PendingInvites from './pending-invites.svelte';
import { aPendingInvite } from './testing/fixtures.ts';

describe('PendingInvites', () => {
  test('shows each invite’s email', async () => {
    const screen = await render(PendingInvites, {
      invites: [aPendingInvite({ email: 'ana@example.test' })],
      organizationSlug: 'org-1',
    });

    await expect.element(screen.getByText('ana@example.test')).toBeVisible();
  });

  test('an empty list shows "No pending invitations."', async () => {
    const screen = await render(PendingInvites, { invites: [], organizationSlug: 'org-1' });

    await expect.element(screen.getByText('No pending invitations.')).toBeVisible();
  });
});
