/** Every image renders in a dedicated organization (`e2e/fixtures/organizations.ts`) so its
 * contents are fully controlled, rather than the shared placeholder organization every other
 * spec is also writing reports into.
 *
 * Timestamp stability follows `e2e/fixtures/reports.ts`'s discipline.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@gbd/core';
import { dbMsAgo, insertAppUser } from '@gbd/db/testing';
import { expect } from '@playwright/test';
import type { OrganizationReportSpec } from '../fixtures/organizations.ts';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

test('a mix of report states', async ({ page, organizations, db }) => {
  const creator = await insertAppUser(db, { displayName: 'Ana Ruiz' });
  const processingCreatedAt = dbMsAgo(12 * MINUTE_MS + 30 * SECOND_MS);
  const succeededCreatedAt = dbMsAgo(3 * DAY_MS + 2 * HOUR_MS);

  const organizationId = await organizations.create({
    name: 'Riverside Foods',
    reports: [
      {
        name: 'Chicken order, March',
        siteName: 'Riverside Cafeteria',
        createdByUserId: creator.id,
        createdAt: processingCreatedAt,
        status: 'processing',
        claimedAt: dbMsAgo(11 * MINUTE_MS),
      },
      {
        name: 'Q1 procurement',
        siteName: 'Riverside Cafeteria',
        createdByUserId: creator.id,
        createdAt: succeededCreatedAt,
        status: 'succeeded',
        claimedAt: dbMsAgo(3 * DAY_MS + 2 * HOUR_MS - 3 * MINUTE_MS),
        finishedAt: dbMsAgo(3 * DAY_MS + 2 * HOUR_MS - 5 * MINUTE_MS),
      },
      {
        name: 'Winter deliveries',
        createdByUserId: creator.id,
        // Well past the 7-day boundary, so this always renders as an absolute date.
        createdAt: new Date('2026-01-14T09:00:00Z'),
        status: 'failed',
        finishedAt: new Date('2026-01-14T09:02:00Z'),
      },
    ],
  });

  await page.goto(`/orgs/${organizationId}`);

  await expect(page.getByRole('heading', { name: 'Riverside Foods' })).toBeVisible();
  // The same elements are repeated in the DOM for mobile vs desktop, so we use `.first()`.
  await expect(page.getByText('Chicken order, March').first()).toBeVisible();
  await expect(page.getByText('Processing').first()).toBeVisible();
  await expect(page.getByText('Q1 procurement').first()).toBeVisible();
  await expect(page.getByText('Ready').first()).toBeVisible();
  await expect(page.getByText('Winter deliveries').first()).toBeVisible();
  await expect(page.getByText("Couldn't finish").first()).toBeVisible();

  // Hover one row so the committed image also shows the hover affordance.
  await page.getByText('Q1 procurement').first().hover();
  await expectScreenshots(page, 'reports-list.png');
});

test('the empty state', async ({ page, organizations }) => {
  const organizationId = await organizations.create({ name: 'New Foodservice Co' });

  await page.goto(`/orgs/${organizationId}`);

  await expect(page.getByText('No reports yet', { exact: false })).toBeVisible();
  await expectScreenshots(page, 'reports-list-empty.png');
});

test('the pagination nav, with both Newer and Older visible', async ({ page, organizations }) => {
  const base = new Date('2026-01-01T00:00:00Z');
  // More than two full pages, so landing on page 2 leaves reports on both sides of it — the only
  // way to get both nav links on screen at once. Oldest first, a minute apart.
  const reports: OrganizationReportSpec[] = Array.from({ length: 41 }, (_, i) => ({
    name: `Pagination report ${i + 1}`,
    createdAt: new Date(base.getTime() + i * MINUTE_MS),
    status: 'succeeded',
  }));

  const organizationId = await organizations.create({ name: 'Pagination Nav Co', reports });

  await page.goto(`/orgs/${organizationId}`);
  await page.getByRole('link', { name: 'Older' }).click();

  await expect(page.getByRole('link', { name: 'Newer' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Older' })).toBeVisible();
  await expectScreenshots(page, 'reports-list-pagination.png');
});
