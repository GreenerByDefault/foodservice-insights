import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { BASE_POLL_INTERVAL_MS } from '$lib/polling/schedule';
import { triggerImmediatePoll } from '$lib/polling/testing/trigger-immediate-poll';
import type { ReportListRow, ReportsPageData } from '../+page.server.ts';
import ReportsView from './reports-view.svelte';

const POLL_HREF = '/orgs/org-1/poll';

function aReport(overrides: Partial<ReportListRow> = {}): ReportListRow {
  return {
    id: 'a4f8e2b0-1111-4a11-8111-000000000001' as ReportListRow['id'],
    href: '/orgs/org-1/reports/a4f8e2b0-1111-4a11-8111-000000000001',
    name: 'Q1 procurement',
    siteName: null,
    creator: null,
    createdAt: new Date('2026-01-15T09:48:00Z'),
    status: 'pending',
    now: new Date('2026-01-15T10:00:00Z'),
    ...overrides,
  };
}

function aPageData(reports: ReportListRow[]): ReportsPageData {
  return {
    newReportHref: '/orgs/org-1/reports/new',
    reports,
    olderHref: null,
    newerHref: null,
    pollHref: POLL_HREF,
    pollIntervalMs: BASE_POLL_INTERVAL_MS,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function wireReport(report: ReportListRow) {
  return { ...report, createdAt: report.createdAt.toISOString(), now: report.now.toISOString() };
}

function aPollResponse(reports: ReportListRow[]) {
  return { reports: reports.map((report) => wireReport(report)) };
}

function liveRegionText(screen: Awaited<ReturnType<typeof render>>): string | null | undefined {
  return screen.container.querySelector('[aria-live]')?.textContent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReportsView', () => {
  describe('polling behavior', () => {
    // The backoff threshold, the reconnecting notice, and resuming on a settled→unsettled swap
    // are `createPoller`'s own mechanics, exhaustively covered at that level in
    // `create-poller.svelte.test.ts`. What's left here is the wiring: that a poll result actually
    // flows from `pollReports` back into this page's screen.
    test('a poll success updates the screen in place, and clears a prior reconnecting notice', async () => {
      const pending = aReport({ status: 'pending' });
      const succeeded = { ...pending, status: 'succeeded' as const };
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(jsonResponse(aPollResponse([succeeded])));
      vi.stubGlobal('fetch', fetchMock);
      const screen = await render(ReportsView, { data: aPageData([pending]) });

      await triggerImmediatePoll();
      await triggerImmediatePoll();
      await expect
        .element(screen.getByText('We lost the connection', { exact: false }))
        .toBeVisible();

      await triggerImmediatePoll();
      // The same row is repeated in the DOM for mobile vs desktop — see `ReportRow`.
      await expect.element(screen.getByText('Ready').first()).toBeVisible();
      await expect
        .element(screen.getByText('We lost the connection', { exact: false }))
        .not.toBeInTheDocument();
    });

    test('the live region announces only the report that just settled', async () => {
      const stillPending = aReport({
        id: 'a4f8e2b0-1111-4a11-8111-000000000002' as ReportListRow['id'],
        name: 'Winter deliveries',
        status: 'pending',
      });
      const justFinished = aReport({
        id: 'a4f8e2b0-1111-4a11-8111-000000000001' as ReportListRow['id'],
        name: 'Q1 procurement',
        status: 'pending',
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(aPollResponse([stillPending, { ...justFinished, status: 'succeeded' }])),
        );
      vi.stubGlobal('fetch', fetchMock);
      const screen = await render(ReportsView, { data: aPageData([stillPending, justFinished]) });

      await triggerImmediatePoll();

      await expect.poll(() => liveRegionText(screen)).toBe('Q1 procurement is ready');
    });

    test('a failure and a cancellation settling together each get their own wording, joined', async () => {
      const failed = aReport({
        id: 'a4f8e2b0-1111-4a11-8111-000000000001' as ReportListRow['id'],
        name: 'Q1 procurement',
        status: 'pending',
      });
      const canceled = aReport({
        id: 'a4f8e2b0-1111-4a11-8111-000000000002' as ReportListRow['id'],
        name: 'Winter deliveries',
        status: 'pending',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse(
            aPollResponse([
              { ...failed, status: 'failed' },
              { ...canceled, status: 'canceled' },
            ]),
          ),
        ),
      );
      const screen = await render(ReportsView, { data: aPageData([failed, canceled]) });

      await triggerImmediatePoll();

      await expect
        .poll(() => liveRegionText(screen))
        .toBe("Q1 procurement couldn't finish. Winter deliveries was stopped");
    });

    test('polls with exactly the ids currently on screen', async () => {
      const first = aReport({ name: 'Q1 procurement' });
      const second = aReport({
        id: 'a4f8e2b0-1111-4a11-8111-000000000002' as ReportListRow['id'],
        name: 'Winter deliveries',
      });
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(aPollResponse([first, second])));
      vi.stubGlobal('fetch', fetchMock);
      await render(ReportsView, { data: aPageData([first, second]) });

      await triggerImmediatePoll();

      expect(fetchMock).toHaveBeenCalledWith(
        POLL_HREF,
        expect.objectContaining({ body: JSON.stringify({ ids: [first.id, second.id] }) }),
      );
    });

    test('a report the poll no longer returns (soft-deleted) drops off the screen', async () => {
      const deleted = aReport({ name: 'Q1 procurement' });
      const stillHere = aReport({
        id: 'a4f8e2b0-1111-4a11-8111-000000000002' as ReportListRow['id'],
        name: 'Winter deliveries',
        status: 'succeeded',
      });
      // The poll response omits `deleted` — exactly what `_loadReportsByIds` returns for an id
      // that's been soft-deleted since the last poll.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(aPollResponse([stillHere]))));
      const screen = await render(ReportsView, { data: aPageData([deleted, stillHere]) });

      await triggerImmediatePoll();

      await expect.poll(() => screen.getByText('Q1 procurement').elements().length).toBe(0);
      await expect.element(screen.getByText('Winter deliveries').first()).toBeVisible();
    });
  });
});
