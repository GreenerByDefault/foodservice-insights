import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, ApiUnreachableError } from '$lib/api/fetch';
import { retryReport } from './retry-report.ts';

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('retryReport', () => {
  test('a 204 is "retried"', async () => {
    stubFetch(new Response(null, { status: 204 }));

    await expect(retryReport('/api/orgs/org-1/reports/report-1/retry')).resolves.toBe('retried');
  });

  test('a 409 — another attempt already exists — is "already-retried", not a thrown error', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'This report cannot be retried right now' }), {
        status: 409,
      }),
    );

    await expect(retryReport('/api/orgs/org-1/reports/report-1/retry')).resolves.toBe(
      'already-retried',
    );
  });

  test('any other status rethrows', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }));

    await expect(retryReport('/api/orgs/org-1/reports/report-1/retry')).rejects.toMatchObject({
      constructor: ApiError,
      status: 404,
      message: 'Not found',
    });
  });

  test('an unreachable server rethrows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(retryReport('/api/orgs/org-1/reports/report-1/retry')).rejects.toBeInstanceOf(
      ApiUnreachableError,
    );
  });
});
