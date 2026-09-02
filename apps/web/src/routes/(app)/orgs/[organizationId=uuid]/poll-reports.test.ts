import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, ApiUnreachableError } from '$lib/api/fetch';
import { pollReports } from './poll-reports.ts';

const POLL_HREF = '/orgs/org-1/poll';

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE = {
  newReportHref: '/orgs/org-1/reports/new',
  olderHref: null,
  newerHref: null,
  pollHref: POLL_HREF,
  pollIntervalMs: 10_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pollReports', () => {
  test('revives each row, leaving everything else untouched', async () => {
    stubFetch(
      jsonResponse({
        ...BASE,
        reports: [
          {
            id: 'report-1',
            href: '/orgs/org-1/reports/report-1',
            name: 'Q1 Procurement',
            siteName: 'Lakeside Grill',
            creator: { displayName: 'Dana Cook', email: 'dana@example.test' },
            createdAt: '2026-01-15T10:00:00.000Z',
            status: 'succeeded',
            now: '2026-01-15T10:05:00.000Z',
          },
        ],
      }),
    );

    const data = await pollReports(POLL_HREF);

    expect(data.reports).toEqual([
      {
        id: 'report-1',
        href: '/orgs/org-1/reports/report-1',
        name: 'Q1 Procurement',
        siteName: 'Lakeside Grill',
        creator: { displayName: 'Dana Cook', email: 'dana@example.test' },
        createdAt: new Date('2026-01-15T10:00:00.000Z'),
        status: 'succeeded',
        now: new Date('2026-01-15T10:05:00.000Z'),
      },
    ]);
  });

  test('an empty list revives to an empty list', async () => {
    stubFetch(jsonResponse({ ...BASE, reports: [] }));

    const data = await pollReports(POLL_HREF);

    expect(data.reports).toEqual([]);
  });

  test('a non-2xx response throws ApiError', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Service unavailable' }), { status: 503 }));

    await expect(pollReports(POLL_HREF)).rejects.toBeInstanceOf(ApiError);
  });

  test('no response at all throws ApiUnreachableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(pollReports(POLL_HREF)).rejects.toBeInstanceOf(ApiUnreachableError);
  });
});
