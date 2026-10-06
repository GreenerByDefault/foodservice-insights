import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  expectFetched,
  jsonResponse,
  stubFetch,
  stubUnreachableFetch,
} from '#lib/testing/fetch.js';
import { renameSelf } from './rename-self.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renameSelf', () => {
  test('PATCHes the account with the new name', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(renameSelf('Sam Cook')).resolves.toEqual({ kind: 'renamed' });

    expectFetched(fetchMock, {
      url: '/api/account',
      method: 'PATCH',
      body: { displayName: 'Sam Cook' },
    });
  });

  test('an error response is unknown', async () => {
    stubFetch(jsonResponse({ message: 'Fix the highlighted field.' }, 400));

    await expect(renameSelf('Sam Cook')).resolves.toEqual({ kind: 'unknown' });
  });

  test('an unreachable server is unknown', async () => {
    stubUnreachableFetch();

    await expect(renameSelf('Sam Cook')).resolves.toEqual({ kind: 'unknown' });
  });
});
