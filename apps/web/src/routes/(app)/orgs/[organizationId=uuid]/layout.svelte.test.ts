import type { OrganizationId } from '@gbd/db';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, resetPageMock } from '$lib/testing/state';
import Layout from './+layout.svelte';
import type { LayoutProps } from './$types';

vi.mock('$app/state', () => import('$lib/testing/state'));

afterEach(() => {
  resetPageMock();
});

const noChildren = createRawSnippet(() => ({ render: () => '<div></div>' }));

function props(role: LayoutProps['data']['role']): LayoutProps {
  return {
    data: {
      user: { email: 'eric@example.com', displayName: 'Eric' },
      organizations: [],
      hasMoreOrganizations: false,
      organization: { id: 'org-1' as OrganizationId, name: 'Acme Foodservice' },
      role,
    },
    params: { organizationId: 'org-1' },
    children: noChildren,
  };
}

async function currentSectionLabel(pathname: string, role: LayoutProps['data']['role'] = 'admin') {
  page.url = new URL(`http://localhost${pathname}`);
  const screen = await render(Layout, props(role));
  const current = screen
    .getByRole('link')
    .elements()
    .find((element) => element.getAttribute('aria-current') === 'page');
  return current?.textContent?.trim();
}

describe('+layout.svelte currentSection', () => {
  test('the organization root matches Reports', async () => {
    expect(await currentSectionLabel('/orgs/org-1')).toBe('Reports');
  });

  test('a report page still matches Reports, via the prefix', async () => {
    expect(await currentSectionLabel('/orgs/org-1/reports/report-1')).toBe('Reports');
  });

  test('the members page matches Members, not the Reports prefix', async () => {
    expect(await currentSectionLabel('/orgs/org-1/members')).toBe('Members');
  });

  test('the settings page matches Settings, not the Reports prefix', async () => {
    expect(await currentSectionLabel('/orgs/org-1/settings')).toBe('Settings');
  });

  test('a member has no Settings tab, so Reports is the only, and thus current, match', async () => {
    expect(await currentSectionLabel('/orgs/org-1/settings', 'member')).toBe('Reports');
  });
});
