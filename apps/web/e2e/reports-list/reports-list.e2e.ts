/** The list shows every report in the placeholder organization, so this only proves one report's
 * own rendering and linking — scoped to that report's unique name so it survives running
 * alongside every other spec creating reports in the same organization. See `e2e/README.md` §
 * Database state and the plan's "Test isolation" section for why a fresh organization is needed
 * for anything about the list as a whole (empty state, pagination), which lands in a later PR.
 */

import { withTransaction } from '@gbd/db';
import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import { insertAnalysisAttempt, insertInputFile, insertReport } from '@gbd/db/testing';
import { expect } from '@playwright/test';
import { test } from '../fixtures/test.ts';

test('a report appears in the organization list and links to its report page', async ({
  page,
  db,
}) => {
  const name = `E2E list report ${crypto.randomUUID()}`;

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
    await page.goto(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}`);

    const link = page.getByRole('link', { name: new RegExp(name) });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      'href',
      `/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/${reportId}`,
    );

    await link.click();
    await expect(page).toHaveURL(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/${reportId}`);
  } finally {
    await db.deleteFrom('report').where('id', '=', reportId).execute();
  }
});
