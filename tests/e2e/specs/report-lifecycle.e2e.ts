/** The whole chain, end to end. See `README.md` for how this tier differs from `apps/web/e2e` and
 * `apps/worker/src/worker.test.ts`.
 *
 * The worker runs in `WORKER_MODE=mock-llm`: the real analysis, with
 * `gbd_foodservice_insights.testing.KeywordLlmClient` categorizing by keyword. So what each spec
 * uploads is what decides how its run ends.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { type SharedWorkerFixtures, test } from '@gbd/browser-testing/fixtures';
import type { ReportId } from '@gbd/db';
import { readMailbox } from '@gbd/email/testing';
import { expect, type Page } from '@playwright/test';
import { E2E_GIT_SHA } from '../scripts/containers.ts';

/** A product the keyword fake recognizes, so the run produces a real report. */
const RECOGNIZED_CSV = ['product,date,weight', 'beef,2026-01-05,12'].join('\n');

/** A product the keyword fake places in no category, so every row is eliminated and the library
 * declares the data unusable. */
const UNRECOGNIZED_CSV = ['product,date,weight', 'Paper Towels,2026-01-05,12'].join('\n');

/** Long enough for the queue poll, the analysis, the report page's own poll and — for the email —
 * the notification sweep, all at production cadences (`WORKER_DEFAULTS` in
 * `apps/worker/src/config.ts`, `BASE_POLL_INTERVAL_MS` in `apps/web`), with room for a loaded CI
 * machine. These are real waits on a real backend, so nothing here needs a fake clock. */
const LIFECYCLE_TIMEOUT_MS = 60_000;

async function uploadReport(
  page: Page,
  organizationSlug: string,
  reportName: string,
  csv: string,
  { withCounts = true }: { withCounts?: boolean } = {},
): Promise<void> {
  await page.goto(`/orgs/${organizationSlug}/reports/new`);
  await ensureHydrated(page);

  await page.getByLabel('Report name').fill(reportName);
  await page.getByLabel('Choose a CSV or Excel file', { exact: false }).setInputFiles({
    name: 'procurement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  if (withCounts) await page.getByRole('spinbutton', { name: 'January 2026' }).fill('100');
  else await page.getByRole('radio', { name: 'Skip counts' }).click();
  await page.getByRole('radio', { name: 'Pounds (lb)' }).click();
  await page.getByRole('button', { name: 'Upload report' }).click();

  await expect(page).toHaveURL(new RegExp(`/orgs/${organizationSlug}/reports/[0-9a-f-]+$`));
}

test('a report uploaded through the form is analysed, downloadable, and emailed about', async ({
  page,
  user,
  org,
  db,
}) => {
  const reportName = 'Q1 procurement';
  await uploadReport(page, org.slug, reportName, RECOGNIZED_CSV);

  const downloadPdf = page.getByRole('link', { name: 'Download PDF' });
  await expect(downloadPdf).toBeVisible({ timeout: LIFECYCLE_TIMEOUT_MS });

  // `/file/result/<id>` redirects to a signed blob-store URL, which `page.request` follows. Getting
  // the child's own bytes back here is the round trip this tier exists for: the child wrote them,
  // the parent read its manifest and uploaded them, and the app signed a link to them.
  const href = await downloadPdf.getAttribute('href');
  const pdf = await page.request.get(href ?? '');
  expect(pdf.ok()).toBe(true);
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

  // The child's `telemetry.json`, recorded by the parent just after the verdict. `mock-llm` passes
  // its own LLM client, so every stage reports and no call does.
  const reportId = new URL(page.url()).pathname.split('/').at(-1) as ReportId;
  await expect
    .poll(async () => await telemetrySummary(db, reportId), { timeout: LIFECYCLE_TIMEOUT_MS })
    .toEqual({
      inputRows: 1,
      categorizedRows: 1,
      hasReportFigures: true,
      xlsxDurationRecorded: true,
      llmUsageRows: 0,
    });

  // The real child's `new-categorizations.json`, harvested by the real parent after the verdict.
  await expect
    .poll(
      async () =>
        await db
          .selectFrom('productCategorization')
          .select(['category', 'isVerified', 'suggestedBy'])
          .where('product', '=', 'beef')
          .executeTakeFirst(),
      { timeout: LIFECYCLE_TIMEOUT_MS },
    )
    .toEqual({
      category: 'Beef and Buffalo Meat',
      isVerified: false,
      suggestedBy: expect.stringMatching(/^attempt:[0-9a-f-]{36} \S+$/),
    });

  // Set at claim from the image's `GIT_SHA` build arg, which only a real image build exercises.
  const attempt = await db
    .selectFrom('analysisAttempt')
    .select('workerGitSha')
    .where('reportId', '=', reportId)
    .executeTakeFirstOrThrow();
  expect(attempt.workerGitSha).toBe(E2E_GIT_SHA);

  // The run's identity is pointed at a mailbox no other run sends to (`scripts/test-run.ts`), but
  // both tests here share it — so match on the subject rather than taking whatever arrives first.
  await expect
    .poll(async () => (await readMailbox(user.email)).map((message) => message.subject), {
      timeout: LIFECYCLE_TIMEOUT_MS,
    })
    .toContain(`Your report is ready: ${reportName}`);

  // The link the email carries, followed: the guard on `@gbd/email`'s rebuilt report URL.
  const [message] = await readMailbox(user.email, {
    subject: `Your report is ready: ${reportName}`,
  });
  const reportLink = message?.text.match(/https?:\/\/\S+\/orgs\/\S+\/reports\/[0-9a-f-]+/)?.[0];
  expect(reportLink).toBeDefined();
  await page.goto(new URL(reportLink as string).pathname);
  await expect(page.getByRole('heading', { name: reportName })).toBeVisible();
});

async function telemetrySummary(db: SharedWorkerFixtures['db'], reportId: ReportId) {
  const row = await db
    .selectFrom('analysisAttemptTelemetry')
    .selectAll()
    .where('reportId', '=', reportId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const usage = await db
    .selectFrom('analysisAttemptLlmUsage')
    .select('operation')
    .where('analysisAttemptId', '=', row.analysisAttemptId)
    .execute();
  return {
    inputRows: row.inputRows,
    categorizedRows: row.categorizedRows,
    hasReportFigures: row.totalCo2eKg !== null,
    // The last stage, which the database only accepts once every earlier one is set.
    xlsxDurationRecorded: row.xlsxDurationMs !== null,
    llmUsageRows: usage.length,
  };
}

test('a failure the child declares reaches the report page with its own copy', async ({
  page,
  org,
}) => {
  // Without counts, so the real child is also handed a manifest with `counts: null`. The happy path
  // above keeps the counted path covered.
  await uploadReport(page, org.slug, 'Unrecognized procurement', UNRECOGNIZED_CSV, {
    withCounts: false,
  });

  // Written by the real child as a `failure.json` and parsed by the real parent, rather than a
  // status this test wrote into the database itself.
  await expect(page.getByText('We could not make a usable report from this file.')).toBeVisible({
    timeout: LIFECYCLE_TIMEOUT_MS,
  });
  // `unusable_data`'s follow-up is `contact`, not `retry`.
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});
