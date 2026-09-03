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
  hasMore: boolean;
};

/** Opens the menu and returns the screen — the content is portalled, so it only exists once open. */
async function opened(props: Props) {
  const screen = await render(OrganizationSwitcher, props);
  await screen.getByRole('button').click();
  return screen;
}

const NON_ORGANIZATION_HREFS = new Set(['/orgs/new', '/orgs']);

/** The organization rows, in menu order — everything but "New organization" and "View all
 * organizations", the two rows that don't point at an organization. */
function organizationRows(screen: Awaited<ReturnType<typeof opened>>) {
  return screen
    .getByRole('menuitem')
    .elements()
    .filter((element) => {
      const href = element.getAttribute('href');
      return href !== null && !NON_ORGANIZATION_HREFS.has(href);
    });
}

function isChecked(row: Element): boolean {
  return !row.querySelector('svg')?.classList.contains('invisible');
}

describe('OrganizationSwitcher', () => {
  test('under the cap, every organization is listed with no "View all" row', async () => {
    const current = anOrganization('Riverside Foods');
    const screen = await opened({
      current,
      organizations: [
        current,
        anOrganization('Acme Foodservice'),
        anOrganization('Northwind Catering'),
      ],
      hasMore: false,
    });

    expect(organizationRows(screen).map((row) => row.textContent?.trim())).toEqual([
      'Riverside Foods',
      'Acme Foodservice',
      'Northwind Catering',
    ]);
    await expect
      .element(screen.getByRole('menuitem', { name: 'View all organizations' }))
      .not.toBeInTheDocument();
  });

  test('over the cap, exactly eight organizations show, current first and checked', async () => {
    const current = anOrganization('Riverside Foods');
    const eightAlphabeticallyFirst = Array.from({ length: 8 }, (_, i) =>
      anOrganization(`Org ${String(i).padStart(2, '0')}`),
    );
    const screen = await opened({
      current,
      organizations: [current, ...eightAlphabeticallyFirst],
      hasMore: true,
    });

    const [firstRow, ...otherRows] = organizationRows(screen);
    expect(organizationRows(screen)).toHaveLength(8);
    expect(firstRow?.textContent?.trim()).toBe('Riverside Foods');
    expect(firstRow && isChecked(firstRow)).toBe(true);
    expect(otherRows.every((row) => !isChecked(row))).toBe(true);
    await expect
      .element(screen.getByRole('menuitem', { name: 'View all organizations' }))
      .toBeVisible();
  });

  test('a current organization that sorts past the cap is still present, first', async () => {
    const current = anOrganization('Zzz Foods');
    const eightOthers = Array.from({ length: 8 }, (_, i) =>
      anOrganization(`Org ${String(i).padStart(2, '0')}`),
    );
    const screen = await opened({ current, organizations: eightOthers, hasMore: true });

    const rows = organizationRows(screen);
    expect(rows[0]?.textContent?.trim()).toBe('Zzz Foods');
  });

  test('no current organization: the trigger reads "Choose an organization" and nothing is checked', async () => {
    const screen = await opened({
      current: undefined,
      organizations: [anOrganization('Acme Foodservice'), anOrganization('Northwind Catering')],
      hasMore: false,
    });

    await expect.element(screen.getByText('Choose an organization')).toBeVisible();
    expect(organizationRows(screen).every((row) => !isChecked(row))).toBe(true);
  });

  test('each organization links to organizationHref(id)', async () => {
    const acme = anOrganization('Acme Foodservice', 'org-acme');
    const screen = await opened({ current: undefined, organizations: [acme], hasMore: false });

    await expect
      .element(screen.getByRole('menuitem', { name: 'Acme Foodservice' }))
      .toHaveAttribute('href', organizationHref('org-acme'));
  });
});
