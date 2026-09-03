import type { ReportId } from '@gbd/db';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, ApiUnreachableError } from '$lib/api/fetch';
import { pollReports } from './poll-reports.ts';

const POLL_HREF = '/orgs/org-1/poll';
const IDS = ['report-1' as ReportId];

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pollReports', () => {
  test('revives each row, leaving everything else untouched', async () => {
    stubFetch(
      jsonResponse({
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

    const data = await pollReports(POLL_HREF, IDS);

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

  test('posts the given ids as the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ reports: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await pollReports(POLL_HREF, IDS);

    expect(fetchMock).toHaveBeenCalledWith(
      POLL_HREF,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ ids: IDS }) }),
    );
  });

  test('an empty list revives to an empty list', async () => {
    stubFetch(jsonResponse({ reports: [] }));

    const data = await pollReports(POLL_HREF, []);

    expect(data.reports).toEqual([]);
  });

  test('a non-2xx response throws ApiError', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Service unavailable' }), { status: 503 }));

    await expect(pollReports(POLL_HREF, IDS)).rejects.toBeInstanceOf(ApiError);
  });

  test('no response at all throws ApiUnreachableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(pollReports(POLL_HREF, IDS)).rejects.toBeInstanceOf(ApiUnreachableError);
  });
});
