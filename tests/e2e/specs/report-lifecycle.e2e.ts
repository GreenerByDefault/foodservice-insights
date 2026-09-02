/** The whole chain, end to end. See `README.md` for how this tier differs from `apps/web/e2e` and
 * `apps/worker/src/worker.test.ts`.
 *
 * The report's *name* is what selects the scenario the stubbed child plays out; see
 * `python/worker_child/src/worker_child/testing.py` for the grammar.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { PLACEHOLDER_ORGANIZATION_ID } from '@gbd/db/seed';
import { readMailbox } from '@gbd/email/testing';
import { expect, type Page, test } from '@playwright/test';

const CSV = ['product,date,weight', 'beef,2026-01-05,12'].join('\n');

/** What `stub_analysis` writes in place of a real PDF. Copied from
 * `python/gbd_foodservice_insights/src/gbd_foodservice_insights/testing.py`'s `PDF_MAGIC_BYTES`,
 * which is the source of truth. */
const STUB_PDF_MAGIC_BYTES = '%PDF-1.4\n%stub\n';

/** Set by `scripts/test-run.ts`, which points this run's placeholder user at a mailbox no other
 * run sends to. Both tests share it, so match on the subject rather than taking whatever arrives
 * first. */
const RUN_NOTIFICATION_EMAIL = process.env.RUN_NOTIFICATION_EMAIL ?? '';

/** Long enough for the queue poll, the child, and — for the email — the notification sweep, all at
 * the `stubbed` profile's cadences (`STUBBED_OVERRIDES` in `apps/worker/src/modes.ts`), with room
 * for a loaded CI machine. The page polls itself every second, so nothing here needs a fake clock:
 * these are real waits on a real backend. */
const LIFECYCLE_TIMEOUT_MS = 60_000;

async function uploadReport(page: Page, reportName: string): Promise<void> {
  await page.goto(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/new`);
  await ensureHydrated(page);

  await page.getByLabel('Report name').fill(reportName);
  await page.getByLabel('Choose a CSV file', { exact: false }).setInputFiles({
    name: 'procurement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV),
  });
  await page.getByRole('spinbutton', { name: 'January 2026' }).fill('100');
  await page.getByRole('radio', { name: 'lb' }).click();
  await page.getByRole('button', { name: 'Upload report' }).click();

  await expect(page).toHaveURL(
    new RegExp(`/orgs/${PLACEHOLDER_ORGANIZATION_ID}/reports/[0-9a-f-]+$`),
  );
}

test('a report uploaded through the form is analysed, downloadable, and emailed about', async ({
  page,
}) => {
  const reportName = 'Q1 procurement';
  await uploadReport(page, reportName);

  const downloadPdf = page.getByRole('link', { name: 'Download PDF' });
  await expect(downloadPdf).toBeVisible({ timeout: LIFECYCLE_TIMEOUT_MS });

  // `/file/result/<id>` redirects to a signed blob-store URL, which `page.request` follows. Getting
  // the child's own bytes back here is the round trip this tier exists for: the child wrote them,
  // the parent read its manifest and uploaded them, and the app signed a link to them.
  const href = await downloadPdf.getAttribute('href');
  const pdf = await page.request.get(href ?? '');
  expect(pdf.ok()).toBe(true);
  expect((await pdf.body()).subarray(0, STUB_PDF_MAGIC_BYTES.length).toString()).toBe(
    STUB_PDF_MAGIC_BYTES,
  );

  await expect
    .poll(
      async () => (await readMailbox(RUN_NOTIFICATION_EMAIL)).map((message) => message.subject),
      {
        timeout: LIFECYCLE_TIMEOUT_MS,
      },
    )
    .toContain(`Your report is ready: ${reportName}`);
});

test('a failure the child declares reaches the report page with its own copy', async ({ page }) => {
  await uploadReport(page, '!fail:unusable-data');

  // Written by the real child as a `failure.json` and parsed by the real parent, rather than a
  // status this test wrote into the database itself.
  await expect(page.getByText('We could not make a usable report from this file.')).toBeVisible({
    timeout: LIFECYCLE_TIMEOUT_MS,
  });
  // `unusable_data`'s follow-up is `contact`, not `retry`.
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});
