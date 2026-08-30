import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, ApiUnreachableError } from '$lib/api/fetch';
import { pollReport } from './poll-report.ts';

const POLL_HREF = '/orgs/org-1/reports/report-1/poll';

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

const BASE = {
  report: { id: 'report-1', name: 'Riverside Diner' },
  cancelButtonHref: '/api/orgs/org-1/reports/report-1/cancel',
  retryButtonHref: '/api/orgs/org-1/reports/report-1/retry',
  deleteAction: { href: '/api/orgs/org-1/reports/report-1', afterHref: '/orgs/org-1' },
  newReportHref: '/orgs/org-1/reports/new',
  pollHref: POLL_HREF,
  inputFile: { href: '/file/input/1', originalFilename: 'orders.csv', byteSize: 100 },
};

describe('pollReport', () => {
  test('revives a pending attempt', async () => {
    stubFetch(
      jsonResponse({
        ...BASE,
        now: '2026-01-15T10:05:00.000Z',
        attempt: { status: 'pending', createdAt: '2026-01-15T10:00:00.000Z' },
      }),
    );

    const data = await pollReport(POLL_HREF);

    expect(data.now).toEqual(new Date('2026-01-15T10:05:00.000Z'));
    expect(data.attempt).toEqual({
      status: 'pending',
      createdAt: new Date('2026-01-15T10:00:00.000Z'),
    });
  });

  test('revives a processing attempt', async () => {
    stubFetch(
      jsonResponse({
        ...BASE,
        now: '2026-01-15T10:05:00.000Z',
        attempt: {
          status: 'processing',
          createdAt: '2026-01-15T10:00:00.000Z',
          claimedAt: '2026-01-15T10:01:00.000Z',
        },
      }),
    );

    const data = await pollReport(POLL_HREF);

    expect(data.attempt).toEqual({
      status: 'processing',
      createdAt: new Date('2026-01-15T10:00:00.000Z'),
      claimedAt: new Date('2026-01-15T10:01:00.000Z'),
    });
  });

  test('revives a succeeded attempt, leaving the files untouched', async () => {
    const files = {
      pdf: { href: '/file/result/1' },
      xlsx: { href: '/file/result/2' },
    };
    stubFetch(
      jsonResponse({
        ...BASE,
        now: '2026-01-15T10:05:00.000Z',
        attempt: {
          status: 'succeeded',
          createdAt: '2026-01-15T10:00:00.000Z',
          claimedAt: '2026-01-15T10:01:00.000Z',
          finishedAt: '2026-01-15T10:04:00.000Z',
          files,
        },
      }),
    );

    const data = await pollReport(POLL_HREF);

    expect(data.attempt).toEqual({
      status: 'succeeded',
      createdAt: new Date('2026-01-15T10:00:00.000Z'),
      claimedAt: new Date('2026-01-15T10:01:00.000Z'),
      finishedAt: new Date('2026-01-15T10:04:00.000Z'),
      files,
    });
  });

  test('revives a failed attempt, leaving the failure copy untouched', async () => {
    const failure = {
      whatHappened: 'Something on our end interrupted the analysis before it could finish.',
      followUpText: 'You can run it again.',
      canRetry: true,
      attemptsExhausted: false,
      contactMailto: 'mailto:support@example.test',
    };
    stubFetch(
      jsonResponse({
        ...BASE,
        now: '2026-01-15T10:05:00.000Z',
        attempt: {
          status: 'failed',
          finishedAt: '2026-01-15T10:04:00.000Z',
          attemptNumber: 1,
          failure,
        },
      }),
    );

    const data = await pollReport(POLL_HREF);

    expect(data.attempt).toEqual({
      status: 'failed',
      finishedAt: new Date('2026-01-15T10:04:00.000Z'),
      attemptNumber: 1,
      failure,
    });
  });

  test('revives a canceled attempt', async () => {
    stubFetch(
      jsonResponse({
        ...BASE,
        now: '2026-01-15T10:05:00.000Z',
        attempt: { status: 'canceled', stoppedAt: '2026-01-15T10:03:00.000Z' },
      }),
    );

    const data = await pollReport(POLL_HREF);

    expect(data.attempt).toEqual({
      status: 'canceled',
      stoppedAt: new Date('2026-01-15T10:03:00.000Z'),
    });
  });

  test('a non-2xx response throws ApiError', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Service unavailable' }), { status: 503 }));

    await expect(pollReport(POLL_HREF)).rejects.toBeInstanceOf(ApiError);
  });

  test('no response at all throws ApiUnreachableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(pollReport(POLL_HREF)).rejects.toBeInstanceOf(ApiUnreachableError);
  });
});
