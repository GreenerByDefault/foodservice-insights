/** The one thing no other layer can check: a real click hitting the real `POST .../retry`
 * route, converging on the waiting screen without a page reload, and the poll the settled failure
 * screen had stopped picking back up.
 *
 * Everything else about retrying — the feature client's status handling, the failure copy, the
 * cap arithmetic — is unit- and component-tested already.
 */

import { withTransaction } from '@gbd/db';
import { insertResultFile } from '@gbd/db/testing';
import { expect } from '@playwright/test';
import { sql } from 'kysely';
import { reportUrl } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { advancePoll, REPORT_POLL_INTERVAL_MS } from '../lib/fake-poll.ts';
import { ensureHydrated } from '../lib/hydration.ts';
import { watchPageLoads } from '../lib/no-reload.ts';

test('retrying a failed report shows the waiting screen and resumes polling, without a reload', async ({
  page,
  reports,
  db,
}) => {
  // Installed before navigation so it is in place before the retry re-arms the page's timer.
  await page.clock.install();

  const reportId = await reports.create('failed');
  await page.goto(reportUrl(reportId));
  await ensureHydrated(page);

  const loads = watchPageLoads(page);

  await page.getByRole('button', { name: 'Retry' }).click();

  await expect(page.getByText('You can close this page', { exact: false })).toBeVisible();

  // A failed report is settled, so the page had stopped polling. Retrying is the one thing that
  // un-settles it without a poll, and nothing catches that up unless the schedule restarts —
  // so finish the new attempt from underneath the page and require it to notice.
  const attempt = await db
    .selectFrom('analysisAttempt')
    .select('id')
    .where('reportId', '=', reportId)
    .orderBy('attemptNumber', 'desc')
    .executeTakeFirstOrThrow();

  await withTransaction(db, async (transaction) => {
    await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'pdf' });
    await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'xlsx' });
    await transaction
      .updateTable('analysisAttempt')
      .set({ status: 'succeeded', claimedAt: sql<Date>`now()`, finishedAt: sql<Date>`now()` })
      .where('id', '=', attempt.id)
      .execute();
  });

  await advancePoll(page, REPORT_POLL_INTERVAL_MS);
  await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();
  expect(loads.count).toBe(0);
});

test('a report at the attempt cap has no retry button', async ({ page, reports }) => {
  const reportId = await reports.create('failed-at-retry-cap');
  await page.goto(reportUrl(reportId));

  await expect(page.getByText("You've used all", { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).not.toBeVisible();
});
