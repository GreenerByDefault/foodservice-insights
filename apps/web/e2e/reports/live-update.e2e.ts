/** The one thing no other layer can check: a real poll, hitting the real read endpoint, updating
 * the screen with no page reload — everything about the schedule itself is covered by
 * `polling/schedule.test.ts`, and everything about the screens themselves by their own component
 * tests.
 */

import { withTransaction } from '@gbd/db';
import { insertResultFile } from '@gbd/db/testing';
import { expect } from '@playwright/test';
import { sql } from 'kysely';
import { reportUrl } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { advancePoll } from '../lib/fake-poll.ts';
import { ensureHydrated } from '../lib/hydration.ts';
import { watchPageLoads } from '../lib/no-reload.ts';
import { BASE_POLL_INTERVAL_MS } from '../lib/schedule.ts';

test('a report that finishes while the page is open updates in place, without a reload', async ({
  page,
  reports,
  db,
}) => {
  // Installed before navigation so it is in place before the page's own timer is armed on mount.
  await page.clock.install();

  const reportId = await reports.create('pending');
  await page.goto(reportUrl(reportId));
  await ensureHydrated(page);

  const loads = watchPageLoads(page);

  const attempt = await db
    .selectFrom('analysisAttempt')
    .select('id')
    .where('reportId', '=', reportId)
    .executeTakeFirstOrThrow();

  // A succeeded row is only ever valid with its pdf and xlsx already present — the deferred
  // constraints `analysis_attempt_succeeded_has_pdf`/`_has_xlsx` check at commit, not at the
  // `UPDATE` itself — so both go in in the same transaction as the status flip.
  await withTransaction(db, async (transaction) => {
    await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'pdf' });
    await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'xlsx' });
    await transaction
      .updateTable('analysisAttempt')
      .set({ status: 'succeeded', claimedAt: sql<Date>`now()`, finishedAt: sql<Date>`now()` })
      .where('id', '=', attempt.id)
      .execute();
  });

  await advancePoll(page, BASE_POLL_INTERVAL_MS);
  await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();
  expect(loads.count).toBe(0);
});
