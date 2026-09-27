/** Two real sessions against one organization's report. Which requests `requireOrganizationAccess`
 * refuses is unit-tested exhaustively; this proves the wire — a bystander's session cookie, through
 * `identifyUser` and the guards, gets the same 404 whether it reads or writes.
 */

import { expect } from '@playwright/test';
import { cancelReportApiHref, reportApiHref, reportHref } from '../src/lib/hrefs.ts';
import { test } from './fixtures/test.ts';

test("a user outside the organization gets 404 for its report, and can't change it", async ({
  request,
  db,
  org,
  reports,
  users,
}) => {
  const reportId = await reports.create('pending');
  const bystander = (await users.contextFor(await users.create())).request;

  // The owner's own read, so the bystander's 404 cannot be a URL that 404s for everyone.
  expect((await request.get(reportHref(org.slug, reportId))).status()).toBe(200);

  expect((await bystander.get(reportHref(org.slug, reportId))).status()).toBe(404);
  expect((await bystander.post(cancelReportApiHref(org.slug, reportId))).status()).toBe(404);
  expect((await bystander.delete(reportApiHref(org.slug, reportId))).status()).toBe(404);

  const report = await db
    .selectFrom('report')
    .innerJoin('analysisAttempt', 'analysisAttempt.reportId', 'report.id')
    .select(['report.deletedAt', 'analysisAttempt.cancelRequestedAt'])
    .where('report.id', '=', reportId)
    .executeTakeFirstOrThrow();
  expect(report).toEqual({ deletedAt: null, cancelRequestedAt: null });
});
