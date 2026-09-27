import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import InviteOffers from './invite-offers.svelte';
import { anInviteOffer } from './testing/fixtures.ts';

describe('InviteOffers', () => {
  test('lists one card per invite', async () => {
    const screen = await render(InviteOffers, {
      invites: [
        anInviteOffer({ organizationName: 'Northgate Provisions' }),
        anInviteOffer({ organizationName: 'Riverside Foods', isExpired: true }),
      ],
    });

    await expect.poll(() => screen.getByRole('listitem').elements()).toHaveLength(2);
    await expect.element(screen.getByRole('heading', { name: 'Riverside Foods' })).toBeVisible();
  });

  test('no invites shows the empty state, linking to /orgs', async () => {
    const screen = await render(InviteOffers, { invites: [] });

    await expect.element(screen.getByText('No invitations waiting.')).toBeVisible();
    await expect
      .element(screen.getByRole('link', { name: 'Go to your organizations' }))
      .toHaveAttribute('href', '/orgs');
  });
});
