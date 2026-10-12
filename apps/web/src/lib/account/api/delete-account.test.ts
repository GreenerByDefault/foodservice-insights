import { afterEach, describe, expect, test, vi } from 'vitest';
import { aLastAdminResponse } from '#lib/orgs/testing/fixtures.js';
import { expectFetched, stubFetch } from '#lib/testing/fetch.js';
import { deleteAccount } from './delete-account.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deleteAccount', () => {
  test('DELETEs the account', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(deleteAccount()).resolves.toEqual({ kind: 'done' });

    expectFetched(fetchMock, { url: '/api/account', method: 'DELETE' });
  });

  test('a write failure is classified by classifyMemberWriteFailure', async () => {
    stubFetch(aLastAdminResponse());

    await expect(deleteAccount()).resolves.toEqual({ kind: 'last-admin' });
  });
});
