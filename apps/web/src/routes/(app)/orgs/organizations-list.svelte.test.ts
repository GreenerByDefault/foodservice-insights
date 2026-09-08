import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { OrganizationListRow } from './+page.server.ts';
import OrganizationsList from './organizations-list.svelte';

function anOrganization(overrides: Partial<OrganizationListRow> = {}): OrganizationListRow {
  return {
    id: 'a4f8e2b0-1111-4a11-8111-000000000001' as OrganizationListRow['id'],
    slug: 'acme-foodservice',
    name: 'Acme Foodservice',
    ...overrides,
  };
}

describe('OrganizationsList', () => {
  test('renders one linked row per organization, each pointed at its own href', async () => {
    const screen = await render(OrganizationsList, {
      organizations: [
        anOrganization({
          id: 'a4f8e2b0-1111-4a11-8111-000000000001' as OrganizationListRow['id'],
          slug: 'acme-foodservice',
          name: 'Acme Foodservice',
        }),
        anOrganization({
          id: 'a4f8e2b0-1111-4a11-8111-000000000002' as OrganizationListRow['id'],
          slug: 'bakers-row',
          name: 'Bakers Row',
        }),
      ],
    });

    await expect.element(screen.getByRole('list')).toBeVisible();
    const acme = screen.getByRole('link', { name: 'Acme Foodservice' });
    const bakers = screen.getByRole('link', { name: 'Bakers Row' });
    await expect.element(acme).toBeVisible();
    await expect.element(bakers).toBeVisible();
    await expect.element(acme).toHaveAttribute('href', '/orgs/acme-foodservice');
    await expect.element(bakers).toHaveAttribute('href', '/orgs/bakers-row');
  });

  test('shows an empty-state sentence when there are no organizations', async () => {
    const screen = await render(OrganizationsList, { organizations: [] });

    await expect.element(screen.getByText('No organizations yet.')).toBeVisible();
    await expect.element(screen.getByRole('list')).not.toBeInTheDocument();
  });
});
