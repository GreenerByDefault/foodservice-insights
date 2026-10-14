import { reportHref } from '../../src/lib/hrefs.ts';
/** One report's own rendering and linking inside the list, in a dedicated organization
 * (`e2e/fixtures/organizations.ts`) so nothing another spec creates can appear alongside it.
 */

import { dbMsAgo } from '@gbd/db/testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';

test('a report appears in the organization list and links to its report page', async ({
  page,
  organizations,
}) => {
  const name = 'List report';
  const { slug: organizationSlug, reportIds } = await organizations.create({
    name: `Reports list test org ${crypto.randomUUID()}`,
    reports: [{ name, createdAt: dbMsAgo(0), status: 'pending' }],
  });
  const [reportId] = reportIds;
  if (!reportId) throw new Error('no report created');

  await page.goto(`/orgs/${organizationSlug}`);

  const link = page.getByRole('link', { name: new RegExp(name) });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', reportHref(organizationSlug, reportId));

  await link.click();
  await expect(page).toHaveURL(reportHref(organizationSlug, reportId));
});
