import type { ReportId } from '@gbd/db';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { ReportPageData } from '../+page.server.ts';
import { retryableFailure } from '../testing/fixtures.ts';
import ReportView from './view.svelte';

const REPORT_ID = 'report-1' as ReportId;
const POLL_HREF = `/orgs/org-1/reports/${REPORT_ID}/poll`;

const BASE = {
  report: { id: REPORT_ID, name: 'Riverside Diner' },
  cancelButtonHref: '/api/orgs/org-1/reports/report-1/cancel',
  retryButtonHref: '/api/orgs/org-1/reports/report-1/retry',
  newReportHref: '/orgs/org-1/reports/new',
  pollHref: POLL_HREF,
  inputFile: {
    href: '/file/input/1',
    originalFilename: 'orders.csv',
    byteSize: 100,
  },
  now: new Date('2026-01-15T10:05:00Z'),
};

function pendingData(): ReportPageData {
  return { ...BASE, attempt: { status: 'pending', createdAt: new Date('2026-01-15T10:00:00Z') } };
}

function succeededWireBody() {
  return {
    ...BASE,
    now: BASE.now.toISOString(),
    attempt: {
      status: 'succeeded',
      createdAt: '2026-01-15T10:00:00.000Z',
      claimedAt: '2026-01-15T10:01:00.000Z',
      finishedAt: '2026-01-15T10:04:00.000Z',
      files: {
        pdf: { href: '/file/result/1' },
        xlsx: { href: '/file/result/2' },
        charts: [],
      },
    },
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function liveRegionText(screen: Awaited<ReturnType<typeof render>>): string | null | undefined {
  return screen.container.querySelector('[aria-live]')?.textContent;
}

/** Bypasses the real poll interval: toggling the tab hidden then visible makes the component
 * poll immediately, the same path a real backgrounded-then-foregrounded tab takes. */
async function triggerImmediatePoll(): Promise<void> {
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

describe('ReportView', () => {
  test('a pending attempt renders the waiting screen, and the live region names the stage', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const screen = await render(ReportView, { data: pendingData() });

    await expect
      .element(screen.getByText('You can close this page', { exact: false }))
      .toBeVisible();
    await expect.poll(() => liveRegionText(screen)).toBe('Waiting to start');
  });

  test('a processing attempt renders the waiting screen, and the live region names the stage', async () => {
    vi.stubGlobal('fetch', vi.fn());
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
    vi.stubGlobal('fetch', vi.fn());
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
    vi.stubGlobal('fetch', vi.fn());
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
    vi.stubGlobal('fetch', vi.fn());
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

  test('a poll failure keeps the previous screen up; a second failure in a row shows a reconnecting notice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const screen = await render(ReportView, { data: pendingData() });

    await triggerImmediatePoll();
    await expect
      .element(screen.getByText('You can close this page', { exact: false }))
      .toBeVisible();
    await expect
      .element(screen.getByText('Having trouble reaching the server', { exact: false }))
      .not.toBeInTheDocument();

    await triggerImmediatePoll();
    await expect
      .element(screen.getByText('Having trouble reaching the server', { exact: false }))
      .toBeVisible();
  });

  test('a poll success updates the screen in place, and clears a prior reconnecting notice', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(succeededWireBody()));
    vi.stubGlobal('fetch', fetchMock);
    const screen = await render(ReportView, { data: pendingData() });

    await triggerImmediatePoll();
    await triggerImmediatePoll();
    await expect
      .element(screen.getByText('Having trouble reaching the server', { exact: false }))
      .toBeVisible();

    await triggerImmediatePoll();
    await expect.element(screen.getByRole('link', { name: 'Download PDF' })).toBeVisible();
    await expect
      .element(screen.getByText('Having trouble reaching the server', { exact: false }))
      .not.toBeInTheDocument();
  });
});
