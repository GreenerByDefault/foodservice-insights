/** The one thing no other layer can check: a real poll, hitting the list's own read endpoint,
 * updating a row in place with no reload.
 *
 * Scoped to a report's own unique name, in the placeholder organization, the same tradeoff
 * `reports-list.e2e.ts` makes — see its doc comment.
 *
 * Everything about the schedule itself is covered by `polling/schedule.test.ts`, and everything
 * about `ReportsView` itself by `reports-view.svelte.test.ts`.
 */

import { advancePoll, ensureHydrated } from '@gbd/browser-testing';
import { withTransaction } from '@gbd/db';
import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import {
  insertAnalysisAttempt,
  insertInputFile,
  insertReport,
  insertResultFile,
} from '@gbd/db/testing';
import { expect } from '@playwright/test';
import { sql } from 'kysely';
import { test } from '../fixtures/test.ts';
import { watchPageLoads } from '../lib/no-reload.ts';
import { POLL_INTERVAL_MS } from '../lib/poll-interval.ts';

test('a report that finishes while the list is open updates in place, without a reload', async ({
  page,
  db,
}) => {
  const name = `E2E list live update ${crypto.randomUUID()}`;

  const reportId = await withTransaction(db, async (transaction) => {
    const report = await insertReport(transaction, {
      organizationId: PLACEHOLDER_ORGANIZATION_ID,
      name,
    });
    await insertInputFile(transaction, { reportId: report.id });
    await insertAnalysisAttempt(transaction, { reportId: report.id, status: 'pending' });
    return report.id;
  });

  try {
    // Installed before navigation so it is in place before the page's own timer is armed on mount.
    await page.clock.install();
    await page.goto(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}`);
    await ensureHydrated(page);

    const loads = watchPageLoads(page);
    // The row's status is repeated in the DOM for mobile vs desktop, so we use `.first()`.
    const row = page.getByRole('link', { name: new RegExp(name) });
    await expect(row.getByText('Queued').first()).toBeVisible();

    const attempt = await db
      .selectFrom('analysisAttempt')
      .select('id')
      .where('reportId', '=', reportId)
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

    await advancePoll(page, POLL_INTERVAL_MS);
    await expect(row.getByText('Ready').first()).toBeVisible();
    expect(loads.count).toBe(0);
  } finally {
    await db.deleteFrom('report').where('id', '=', reportId).execute();
  }
});
