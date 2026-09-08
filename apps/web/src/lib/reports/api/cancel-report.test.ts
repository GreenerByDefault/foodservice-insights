import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, ApiUnreachableError } from '$lib/api/fetch';
import { stubFetch, stubUnreachableFetch } from '$lib/testing/fetch';
import { cancelReport } from './cancel-report.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cancelReport', () => {
  test('a 204 is "canceled"', async () => {
    stubFetch(new Response(null, { status: 204 }));

    await expect(cancelReport('org-1', 'report-1')).resolves.toBe('canceled');
  });

  test('a 409 — the attempt finished first — is "already-settled", not a thrown error', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'This report already finished' }), {
        status: 409,
      }),
    );

    await expect(cancelReport('org-1', 'report-1')).resolves.toBe('already-settled');
  });

  test('any other status rethrows', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }));

    await expect(cancelReport('org-1', 'report-1')).rejects.toMatchObject({
      constructor: ApiError,
      status: 404,
      message: 'Not found',
    });
  });

  test('an unreachable server rethrows', async () => {
    stubUnreachableFetch();

    await expect(cancelReport('org-1', 'report-1')).rejects.toBeInstanceOf(ApiUnreachableError);
  });
});
