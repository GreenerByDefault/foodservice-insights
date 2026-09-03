import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { organizationHref } from '$lib/hrefs';
import OrganizationSwitcher from './organization-switcher.svelte';

type SwitcherOrganization = { id: string; name: string };

function anOrganization(name: string, id = name): SwitcherOrganization {
  return { id, name };
}

type Props = {
  current?: SwitcherOrganization;
  organizations: readonly SwitcherOrganization[];
};

/** Opens the disclosure and returns the screen. */
async function opened(props: Props) {
  const screen = await render(OrganizationSwitcher, props);
  // `<summary>` renders before the `<ul>`'s rows, so it's always the first match — even when its
  // text (the current organization's name) also appears as one of the rows below it.
  await screen
    .getByText(props.current?.name ?? 'Choose an organization')
    .first()
    .click();
  return screen;
}

describe('OrganizationSwitcher', () => {
  test('lists every organization passed in, in order, plus "New organization"', async () => {
    const current = anOrganization('Riverside Foods');
    const screen = await opened({
      current,
      organizations: [
        current,
        anOrganization('Acme Foodservice'),
        anOrganization('Northwind Catering'),
      ],
    });

    await expect.element(screen.getByRole('link', { name: 'Riverside Foods' })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Acme Foodservice' })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Northwind Catering' })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'New organization' })).toBeVisible();
  });

  test('no current organization: the summary reads "Choose an organization"', async () => {
    const screen = await opened({
      current: undefined,
      organizations: [anOrganization('Acme Foodservice')],
    });

    await expect.element(screen.getByText('Choose an organization')).toBeVisible();
  });

  test('each organization links to organizationHref(id)', async () => {
    const acme = anOrganization('Acme Foodservice', 'org-acme');
    const screen = await opened({ current: undefined, organizations: [acme] });

    await expect
      .element(screen.getByRole('link', { name: 'Acme Foodservice' }))
      .toHaveAttribute('href', organizationHref('org-acme'));
  });

  test('"New organization" links to /orgs/new', async () => {
    const screen = await opened({ current: undefined, organizations: [] });

    await expect
      .element(screen.getByRole('link', { name: 'New organization' }))
      .toHaveAttribute('href', '/orgs/new');
  });
});
