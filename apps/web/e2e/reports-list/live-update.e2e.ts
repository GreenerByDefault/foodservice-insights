/** The one thing no other layer can check: a real poll, hitting the list's own read endpoint,
 * updating a row in place with no reload. In a dedicated organization
 * (`e2e/fixtures/organizations.ts`) so nothing another spec creates can appear alongside it.
 *
 * Everything about the schedule itself is covered by `polling/schedule.test.ts`, and everything
 * about `ReportsView` itself by `reports-view.svelte.test.ts`.
 */

import { advancePoll, ensureHydrated } from '@gbd/browser-testing';
import { dbMsAgo } from '@gbd/db/testing';
import { expect } from '@playwright/test';
import { succeedLatestAttempt } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { watchPageLoads } from '../lib/no-reload.ts';
import { POLL_INTERVAL_MS } from '../lib/poll-interval.ts';

test('a report that finishes while the list is open updates in place, without a reload', async ({
  page,
  organizations,
  db,
}) => {
  const name = 'Live update report';
  const organizationId = await organizations.create({
    name: `Reports list live update test org ${crypto.randomUUID()}`,
    // Now-dated, unlike `e2e/fixtures/reports.ts`'s backdated catalogue: a report older than
    // `QUEUE_WARNING_AFTER_MS` renders as delayed rather than 'Queued', which the assertion below
    // needs. A fresh organization has its whole `HOURLY_REPORT_LIMIT` budget, so there is nothing
    // to dodge by backdating here.
    reports: [{ name, createdAt: dbMsAgo(0), status: 'pending' }],
  });
  const { id: reportId } = await db
    .selectFrom('report')
    .select('id')
    .where('organizationId', '=', organizationId)
    .executeTakeFirstOrThrow();

  // Installed before navigation so it is in place before the page's own timer is armed on mount.
  await page.clock.install();
  await page.goto(`/orgs/${organizationId}`);
  await ensureHydrated(page);

  const loads = watchPageLoads(page);
  // The row's status is repeated in the DOM for mobile vs desktop, so we use `.first()`.
  const row = page.getByRole('link', { name: new RegExp(name) });
  await expect(row.getByText('Queued').first()).toBeVisible();

  // A pending report is unsettled, so the page keeps polling; finish the attempt from underneath
  // it and require the next poll to notice.
  await succeedLatestAttempt(db, reportId);

  await advancePoll(page, POLL_INTERVAL_MS);
  await expect(row.getByText('Ready').first()).toBeVisible();
  expect(loads.count).toBe(0);
});
