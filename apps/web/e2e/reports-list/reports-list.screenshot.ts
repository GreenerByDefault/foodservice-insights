/** Both images render in a dedicated organization (`e2e/fixtures/organizations.ts`) so their
 * contents are fully controlled, rather than the shared placeholder organization every other
 * spec is also writing reports into.
 *
 * Timestamp stability follows `e2e/fixtures/reports.ts`'s discipline.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@gbd/core';
import { dbMsAgo, insertAppUser } from '@gbd/db/testing';
import { expect } from '@playwright/test';
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
  // Each row renders a mobile and a sm:+ layout, toggled by CSS (see report-row.svelte), so
  // every field exists twice in the DOM regardless of viewport — `.first()` picks whichever
  // copy is visible at the page's current (desktop-sized) viewport.
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
