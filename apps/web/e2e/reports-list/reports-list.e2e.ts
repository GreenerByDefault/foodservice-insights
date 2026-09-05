/** One report's own rendering and linking inside the list, in a dedicated organization
 * (`e2e/fixtures/organizations.ts`) so nothing another spec creates can appear alongside it.
 */

import { dbMsAgo } from '@gbd/db/testing';
import { expect } from '@playwright/test';
import { reportUrl } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';

test('a report appears in the organization list and links to its report page', async ({
  page,
  organizations,
  db,
}) => {
  const name = 'List report';
  const organizationId = await organizations.create({
    name: `Reports list test org ${crypto.randomUUID()}`,
    // Now-dated, unlike `e2e/fixtures/reports.ts`'s backdated catalogue: a fresh organization has
    // its whole `HOURLY_REPORT_LIMIT` budget, so there is nothing here to dodge.
    reports: [{ name, createdAt: dbMsAgo(0), status: 'pending' }],
  });
  const { id: reportId } = await db
    .selectFrom('report')
    .select('id')
    .where('organizationId', '=', organizationId)
    .executeTakeFirstOrThrow();

  await page.goto(`/orgs/${organizationId}`);

  const link = page.getByRole('link', { name: new RegExp(name) });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', reportUrl(reportId, organizationId));

  await link.click();
  await expect(page).toHaveURL(reportUrl(reportId, organizationId));
});
