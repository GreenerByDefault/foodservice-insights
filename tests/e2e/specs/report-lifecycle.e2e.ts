/** The whole chain, end to end. See `README.md` for how this tier differs from `apps/web/e2e` and
 * `apps/worker/src/worker.test.ts`.
 *
 * The worker runs in `WORKER_MODE=mock-llm`: the real analysis, with
 * `gbd_foodservice_insights.testing.KeywordLlmClient` categorizing by keyword. So what each spec
 * uploads is what decides how its run ends.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { test } from '@gbd/browser-testing/fixtures';
import { readMailbox } from '@gbd/email/testing';
import { expect, type Page } from '@playwright/test';

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
): Promise<void> {
  await page.goto(`/orgs/${organizationSlug}/reports/new`);
  await ensureHydrated(page);

  await page.getByLabel('Report name').fill(reportName);
  await page.getByLabel('Choose a CSV or Excel file', { exact: false }).setInputFiles({
    name: 'procurement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page.getByRole('spinbutton', { name: 'January 2026' }).fill('100');
  await page.getByRole('radio', { name: 'lb' }).click();
  await page.getByRole('button', { name: 'Upload report' }).click();

  await expect(page).toHaveURL(new RegExp(`/orgs/${organizationSlug}/reports/[0-9a-f-]+$`));
}

test('a report uploaded through the form is analysed, downloadable, and emailed about', async ({
  page,
  user,
  org,
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

  // The run's identity is pointed at a mailbox no other run sends to (`scripts/test-run.ts`), but
  // both tests here share it — so match on the subject rather than taking whatever arrives first.
  await expect
    .poll(async () => (await readMailbox(user.email)).map((message) => message.subject), {
      timeout: LIFECYCLE_TIMEOUT_MS,
    })
    .toContain(`Your report is ready: ${reportName}`);
});

test('a failure the child declares reaches the report page with its own copy', async ({
  page,
  org,
}) => {
  await uploadReport(page, org.slug, 'Unrecognized procurement', UNRECOGNIZED_CSV);

  // Written by the real child as a `failure.json` and parsed by the real parent, rather than a
  // status this test wrote into the database itself.
  await expect(page.getByText('We could not make a usable report from this file.')).toBeVisible({
    timeout: LIFECYCLE_TIMEOUT_MS,
  });
  // `unusable_data`'s follow-up is `contact`, not `retry`.
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});
