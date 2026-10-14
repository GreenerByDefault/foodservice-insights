import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '#lib/api/fetch.js';
import {
  expectFetched,
  jsonResponse,
  stubFetch,
  stubUnreachableFetch,
} from '#lib/testing/fetch.js';
import { signInWithSitePassword, signOutOfSite } from './site-session.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('signInWithSitePassword', () => {
  test('POSTs the password', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(signInWithSitePassword('correct-horse-battery')).resolves.toEqual({
      kind: 'signed-in',
    });

    expectFetched(fetchMock, {
      url: '/api/site-session',
      method: 'POST',
      body: { password: 'correct-horse-battery' },
    });
  });

  test('a 401 is the wrong password', async () => {
    stubFetch(jsonResponse({ message: 'Wrong password' }, 401));

    await expect(signInWithSitePassword('guess')).resolves.toEqual({ kind: 'wrong-password' });
  });

  test('any other error response is unknown', async () => {
    stubFetch(jsonResponse({ message: 'Internal Error' }, 500));

    await expect(signInWithSitePassword('guess')).resolves.toEqual({ kind: 'unknown' });
  });

  test('an unreachable server is unknown', async () => {
    stubUnreachableFetch();

    await expect(signInWithSitePassword('guess')).resolves.toEqual({ kind: 'unknown' });
  });
});

describe('signOutOfSite', () => {
  test('DELETEs the session', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await signOutOfSite();

    expectFetched(fetchMock, { url: '/api/site-session', method: 'DELETE' });
  });

  test('rejects on an error response', async () => {
    stubFetch(jsonResponse({ message: 'Internal Error' }, 500));

    await expect(signOutOfSite()).rejects.toBeInstanceOf(ApiError);
  });
});
