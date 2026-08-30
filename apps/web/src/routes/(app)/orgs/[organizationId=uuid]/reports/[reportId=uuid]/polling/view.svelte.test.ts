import type { ReportId } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { ReportPageData } from '../+page.server.ts';
import { retryableFailure } from '../testing/fixtures.ts';
import ReportView from './view.svelte';

const REPORT_ID = 'report-1' as ReportId;

const BASE = {
  report: { id: REPORT_ID, name: 'Riverside Diner' },
  cancelButtonHref: '/api/orgs/org-1/reports/report-1/cancel',
  retryButtonHref: '/api/orgs/org-1/reports/report-1/retry',
  newReportHref: '/orgs/org-1/reports/new',
  inputFile: {
    href: '/file/input/1',
    originalFilename: 'orders.csv',
    byteSize: 100,
  },
  now: new Date('2026-01-15T10:05:00Z'),
};

function liveRegionText(screen: Awaited<ReturnType<typeof render>>): string | null | undefined {
  return screen.container.querySelector('[aria-live]')?.textContent;
}

describe('ReportView', () => {
  test('a pending attempt renders the waiting screen, and the live region names the stage', async () => {
    const data: ReportPageData = {
      ...BASE,
      attempt: { status: 'pending', createdAt: new Date('2026-01-15T10:00:00Z') },
    };
    const screen = await render(ReportView, { data });

    await expect
      .element(screen.getByText('You can close this page', { exact: false }))
      .toBeVisible();
    await expect.poll(() => liveRegionText(screen)).toBe('Waiting to start');
  });

  test('a processing attempt renders the waiting screen, and the live region names the stage', async () => {
    const data: ReportPageData = {
      ...BASE,
      attempt: {
        status: 'processing',
        createdAt: new Date('2026-01-15T10:00:00Z'),
        claimedAt: new Date('2026-01-15T10:01:00Z'),
      },
    };
    const screen = await render(ReportView, { data });

    await expect
      .element(screen.getByText('You can close this page', { exact: false }))
      .toBeVisible();
    await expect
      .poll(() => liveRegionText(screen))
      .toBe('Reading your purchases and building your charts');
  });

  test('a succeeded attempt renders the download links, and the live region says the report is ready', async () => {
    const data: ReportPageData = {
      ...BASE,
      attempt: {
        status: 'succeeded',
        createdAt: new Date('2026-01-15T10:00:00Z'),
        claimedAt: new Date('2026-01-15T10:01:00Z'),
        finishedAt: new Date('2026-01-15T10:04:00Z'),
        files: { pdf: { href: '/file/result/1' }, xlsx: { href: '/file/result/2' }, charts: [] },
      },
    };
    const screen = await render(ReportView, { data });

    await expect.element(screen.getByRole('link', { name: 'Download PDF' })).toBeVisible();
    await expect.poll(() => liveRegionText(screen)).toBe('Your report is ready');
  });

  test('a failed attempt renders the failure copy, and the live region says the report could not finish', async () => {
    const failure = retryableFailure();
    const data: ReportPageData = {
      ...BASE,
      attempt: {
        status: 'failed',
        finishedAt: new Date('2026-01-15T10:04:00Z'),
        attemptNumber: 1,
        failure,
      },
    };
    const screen = await render(ReportView, { data });

    await expect.element(screen.getByText(failure.whatHappened)).toBeVisible();
    await expect.poll(() => liveRegionText(screen)).toBe('Your report could not be finished');
  });

  test('a canceled attempt renders the stopped copy, and the live region says the report was stopped', async () => {
    const data: ReportPageData = {
      ...BASE,
      attempt: { status: 'canceled', stoppedAt: new Date('2026-01-15T10:02:00Z') },
    };
    const screen = await render(ReportView, { data });

    await expect
      .element(screen.getByText('You stopped this report', { exact: false }))
      .toBeVisible();
    await expect.poll(() => liveRegionText(screen)).toBe('This report was stopped');
  });
});
