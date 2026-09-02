/** Pagination needs the dedicated organization fixture (`e2e/fixtures/organizations.ts`), both to
 * control the page contents and to keep 21 reports out of the shared placeholder organization.
 */

import { MINUTE_MS } from '@gbd/core';
import { expect } from '@playwright/test';
import type { OrganizationReportSpec } from '../fixtures/organizations.ts';
import { test } from '../fixtures/test.ts';

// Matches `_REPORTS_PAGE_SIZE` in `+page.server.ts` — not imported from there, since that route
// module pulls in `$lib/server/db` and `$env`, which resolve only inside the SvelteKit app, not
// this plain Playwright runtime.
const REPORTS_PAGE_SIZE = 20;
const REPORT_COUNT = REPORTS_PAGE_SIZE + 1;

test('paging older then newer through 21 reports', async ({ page, organizations }) => {
  const base = new Date('2026-01-01T00:00:00Z');
  // Oldest first, one minute apart, so `createdAt` alone is already a total order.
  const reports: OrganizationReportSpec[] = Array.from({ length: REPORT_COUNT }, (_, i) => ({
    name: `Pagination report ${i}`,
    createdAt: new Date(base.getTime() + i * MINUTE_MS),
    status: 'succeeded',
  }));

  const organizationId = await organizations.create({
    name: `Pagination test org ${crypto.randomUUID()}`,
    reports,
  });

  await page.goto(`/orgs/${organizationId}`);

  // Newest 20 of 21: reports 1..20, oldest ("report 0") not on this page.
  await expect(page.getByText('Pagination report 20', { exact: true })).toBeVisible();
  await expect(page.getByText('Pagination report 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Pagination report 0', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('link', { name: 'Newer' })).not.toBeVisible();
  const older = page.getByRole('link', { name: 'Older' });
  await expect(older).toBeVisible();

  await older.click();

  await expect(page.getByText('Pagination report 0', { exact: true })).toBeVisible();
  await expect(page.getByText('Pagination report 1', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('link', { name: 'Older' })).not.toBeVisible();
  const newer = page.getByRole('link', { name: 'Newer' });
  await expect(newer).toBeVisible();

  await newer.click();

  await expect(page.getByText('Pagination report 20', { exact: true })).toBeVisible();
  await expect(page.getByText('Pagination report 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Pagination report 0', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('link', { name: 'Newer' })).not.toBeVisible();
  await expect(page.getByRole('link', { name: 'Older' })).toBeVisible();
});
