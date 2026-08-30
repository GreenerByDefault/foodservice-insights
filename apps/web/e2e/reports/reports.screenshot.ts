import { MAX_ANALYSIS_ATTEMPTS, newReportId } from '@gbd/db';
import { expect } from '@playwright/test';
import { reportUrl } from '../fixtures/reports.ts';
import { test } from '../fixtures/test.ts';
import { advanceThroughPollFailures } from '../lib/fake-poll.ts';
import { ensureHydrated } from '../lib/hydration.ts';
import { expectScreenshot } from '../lib/screenshots.ts';
import { BASE_POLL_INTERVAL_MS } from './schedule.ts';

test('a report waiting to start', async ({ page, reports }) => {
  const reportId = await reports.create('pending');
  await page.goto(reportUrl(reportId));

  await expect(page.locator('[aria-current="step"]')).toContainText('Waiting to start');
  await expectScreenshot(page, 'reports-pending.png');
});

test('a report waiting to start, taking longer than usual', async ({ page, reports }) => {
  const reportId = await reports.create('pending-delayed');
  await page.goto(reportUrl(reportId));

  await expect(page.getByText('It is busier than usual')).toBeVisible();
  await expectScreenshot(page, 'reports-pending-delayed.png');
});

test('a report being analyzed', async ({ page, reports }) => {
  const reportId = await reports.create('processing');
  await page.goto(reportUrl(reportId));

  await expect(page.locator('[aria-current="step"]')).toContainText(
    'Reading your purchases and building your charts',
  );
  await expectScreenshot(page, 'reports-processing.png');
});

test('a report being analyzed, taking longer than usual', async ({ page, reports }) => {
  const reportId = await reports.create('processing-delayed');
  await page.goto(reportUrl(reportId));

  await expect(page.getByText('This is taking longer than usual')).toBeVisible();
  await expectScreenshot(page, 'reports-processing-delayed.png');
});

test('a report that succeeded', async ({ page, reports }) => {
  const reportId = await reports.create('succeeded');
  await page.goto(reportUrl(reportId));

  await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();
  await expectScreenshot(page, 'reports-succeeded.png');
});

test('a report that failed on its first attempt', async ({ page, reports }) => {
  const reportId = await reports.create('failed');
  await page.goto(reportUrl(reportId));

  await expect(
    page.getByText('Something on our end interrupted the analysis before it could finish.'),
  ).toBeVisible();
  await expectScreenshot(page, 'reports-failed.png');
});

test('a report that failed at the attempt cap, for a reason that would otherwise offer a retry', async ({
  page,
  reports,
}) => {
  const reportId = await reports.create('failed-at-retry-cap');
  await page.goto(reportUrl(reportId));

  await expect(
    page.getByText(`You've used all ${MAX_ANALYSIS_ATTEMPTS} attempts for this report.`),
  ).toBeVisible();
  // The follow-up text already states the attempt count, so it shouldn't be repeated below it.
  await expect(page.getByText(`This was attempt ${MAX_ANALYSIS_ATTEMPTS}.`)).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).not.toBeVisible();
  await expectScreenshot(page, 'reports-failed-at-retry-cap.png');
});

test('a report that failed on a retried attempt, below the cap', async ({ page, reports }) => {
  const reportId = await reports.create('failed-retried');
  await page.goto(reportUrl(reportId));

  await expect(page.getByText('This was attempt 2.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expectScreenshot(page, 'reports-failed-retried.png');
});

test('a report that was canceled', async ({ page, reports }) => {
  const reportId = await reports.create('canceled');
  await page.goto(reportUrl(reportId));

  await expect(page.getByText('You stopped this report')).toBeVisible();
  await expectScreenshot(page, 'reports-canceled.png');
});

test('a report whose poll cannot reach the server', async ({ page, reports }) => {
  // Installed before navigation so it is in place before the page's own timer is armed on mount.
  await page.clock.install();

  const reportId = await reports.create('pending');
  await page.goto(reportUrl(reportId));
  await ensureHydrated(page);

  await page.route('**/poll', (route) => route.abort());

  // Two consecutive failures: the base interval, then double it — see `nextPollDelayMs`.
  await advanceThroughPollFailures(page, '/poll', [
    BASE_POLL_INTERVAL_MS,
    BASE_POLL_INTERVAL_MS * 2,
  ]);

  await expect(
    page.getByText('Having trouble reaching the server', { exact: false }),
  ).toBeVisible();
  await expectScreenshot(page, 'reports-reconnecting.png');
});

test('a report that does not exist', async ({ page }) => {
  await page.goto(reportUrl(newReportId()));

  // Proves the org shell's error boundary caught this 404, not the top-level one — the nav here
  // is what a bare `+error.svelte` at the site root would not render.
  await expect(page.getByRole('navigation', { name: 'Organization' })).toBeVisible();
  await expectScreenshot(page, 'reports-not-found.png');
});
