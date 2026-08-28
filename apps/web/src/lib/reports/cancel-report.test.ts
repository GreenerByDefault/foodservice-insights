import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiUnreachableError } from '$lib/api/fetch';
import { cancelReport } from './cancel-report.ts';

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cancelReport', () => {
  test('a 204 is "canceled"', async () => {
    stubFetch(new Response(null, { status: 204 }));

    await expect(cancelReport('/api/orgs/org-1/reports/report-1/cancel')).resolves.toBe('canceled');
  });

  test('a 409 — the attempt finished first — is "already-settled", not a thrown error', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'This report already finished' }), {
        status: 409,
      }),
    );

    await expect(cancelReport('/api/orgs/org-1/reports/report-1/cancel')).resolves.toBe(
      'already-settled',
    );
  });

  test('any other status rethrows', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }));

    await expect(cancelReport('/api/orgs/org-1/reports/report-1/cancel')).rejects.toMatchObject({
      status: 404,
    });
  });

  test('an unreachable server rethrows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(cancelReport('/api/orgs/org-1/reports/report-1/cancel')).rejects.toBeInstanceOf(
      ApiUnreachableError,
    );
  });
});
