import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Problem } from '../csv/describe/index.ts';
import { uploadReport } from './upload.ts';

const PROBLEM: Problem = {
  rule: 'The weight has a unit in it',
  advice: 'Enter plain numbers only.',
  rows: { ranges: [{ start: 2, end: 4 }], total: 3, everyRow: false },
  examples: ['"5 oz"'],
};

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadReport', () => {
  test('a 201 yields the location', async () => {
    stubFetch(
      new Response(JSON.stringify({ reportId: 'report-1' }), {
        status: 201,
        headers: { location: '/orgs/org-1/reports/report-1' },
      }),
    );

    await expect(uploadReport('org-1', new FormData())).resolves.toEqual({
      kind: 'created',
      location: '/orgs/org-1/reports/report-1',
    });
  });

  test('a 400 rejection body yields rejected, with its summary and problems', async () => {
    const body = { summary: 'We found problems in your rows.', rowProblems: [PROBLEM] };
    stubFetch(new Response(JSON.stringify(body), { status: 400 }));

    await expect(uploadReport('org-1', new FormData())).resolves.toEqual({
      kind: 'rejected',
      rejection: body,
    });
  });

  // The regression test for the status-code guard `parseUploadRejection` used to have.
  test('a 429 rejection body also yields rejected, with only its summary', async () => {
    const body = { summary: 'You have created too many reports this hour.' };
    stubFetch(new Response(JSON.stringify(body), { status: 429 }));

    await expect(uploadReport('org-1', new FormData())).resolves.toEqual({
      kind: 'rejected',
      rejection: body,
    });
  });

  test('a 400 that is not a rejection yields unknown', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Bad request' }), { status: 400 }));

    await expect(uploadReport('org-1', new FormData())).resolves.toEqual({ kind: 'unknown' });
  });

  test('a 5xx yields unknown', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Internal error' }), { status: 500 }));

    await expect(uploadReport('org-1', new FormData())).resolves.toEqual({ kind: 'unknown' });
  });

  test('a rejecting fetch yields unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(uploadReport('org-1', new FormData())).resolves.toEqual({ kind: 'unknown' });
  });
});
