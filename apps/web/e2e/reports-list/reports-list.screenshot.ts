/** Both images render in a dedicated organization (`e2e/fixtures/organizations.ts`) so their
 * contents are fully controlled, rather than the shared placeholder organization every other
 * spec is also writing reports into.
 *
 * Timestamp stability follows `e2e/fixtures/reports.ts`'s discipline: the row meant to render
 * *relative* ("12 minutes ago") uses `msAgo`, and the row meant to render an *absolute* date uses
 * a fixed past instant, well past `formatWhen`'s 7-day boundary, so the committed image doesn't
 * drift with the day this is regenerated.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS, msAgo, SECOND_MS } from '@gbd/core';
import { insertAppUser } from '@gbd/db/testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

test('a mix of report states', async ({ page, organizations, db }) => {
  const creator = await insertAppUser(db, { displayName: 'Ana Ruiz' });
  const processingCreatedAt = msAgo(12 * MINUTE_MS + 30 * SECOND_MS);
  const succeededCreatedAt = msAgo(3 * DAY_MS + 2 * HOUR_MS);

  const organizationId = await organizations.create({
    name: 'Riverside Foods',
    reports: [
      {
        name: 'Chicken order, March',
        siteName: 'Riverside Cafeteria',
        createdByUserId: creator.id,
        createdAt: processingCreatedAt,
        status: 'processing',
        claimedAt: msAgo(11 * MINUTE_MS),
      },
      {
        name: 'Q1 procurement',
        siteName: 'Riverside Cafeteria',
        createdByUserId: creator.id,
        createdAt: succeededCreatedAt,
        status: 'succeeded',
        claimedAt: msAgo(3 * DAY_MS + 2 * HOUR_MS - 3 * MINUTE_MS),
        finishedAt: msAgo(3 * DAY_MS + 2 * HOUR_MS - 5 * MINUTE_MS),
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
  await expect(page.getByText('Chicken order, March')).toBeVisible();
  await expect(page.getByText('Processing')).toBeVisible();
  await expect(page.getByText('Q1 procurement')).toBeVisible();
  await expect(page.getByText('Ready')).toBeVisible();
  await expect(page.getByText('Winter deliveries')).toBeVisible();
  await expect(page.getByText("Couldn't finish")).toBeVisible();

  // Hover one row so the committed image also shows the hover affordance, not just the resting
  // state every row shares.
  await page.getByText('Q1 procurement').hover();
  await expectScreenshots(page, 'reports-list.png');
});

test('the empty state', async ({ page, organizations }) => {
  // Free of report fixtures entirely, so it's the cheapest image in the suite — worth its own
  // screenshot anyway, since it's a screen invented from scratch and doubles as the first-run
  // experience.
  const organizationId = await organizations.create({ name: 'New Foodservice Co' });

  await page.goto(`/orgs/${organizationId}`);

  await expect(page.getByText('No reports yet', { exact: false })).toBeVisible();
  await expectScreenshots(page, 'reports-list-empty.png');
});
