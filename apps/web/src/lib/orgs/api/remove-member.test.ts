import { afterEach, describe, expect, test, vi } from 'vitest';
import { lastFetchCall, stubFetch, stubUnreachableFetch } from '$lib/testing/fetch';
import { removeMember } from './remove-member.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('removeMember', () => {
  test('DELETEs the member', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(removeMember('org-1', 'user-1')).resolves.toEqual({ kind: 'removed' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = lastFetchCall(fetchMock);
    expect(url).toBe('/api/orgs/org-1/members/user-1');
    expect(options.method).toBe('DELETE');
  });

  test('a 409 is the only-admin case', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'Only admin', code: 'last-admin' }), {
        status: 409,
      }),
    );

    await expect(removeMember('org-1', 'user-1')).resolves.toEqual({ kind: 'last-admin' });
  });

  test('a non-409 failure is unknown', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }));

    await expect(removeMember('org-1', 'user-1')).resolves.toEqual({ kind: 'unknown' });
  });

  test('an unreachable server is unknown', async () => {
    stubUnreachableFetch();

    await expect(removeMember('org-1', 'user-1')).resolves.toEqual({ kind: 'unknown' });
  });
});
