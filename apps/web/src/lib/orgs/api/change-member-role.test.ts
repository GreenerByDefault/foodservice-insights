import { afterEach, describe, expect, test, vi } from 'vitest';
import { lastFetchCall, stubFetch, stubUnreachableFetch } from '$lib/testing/fetch';
import { changeMemberRole } from './change-member-role.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('changeMemberRole', () => {
  test('PATCHes the member with the new role', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(changeMemberRole('org-1', 'user-1', 'admin')).resolves.toEqual({
      kind: 'changed',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = lastFetchCall(fetchMock);
    expect(url).toBe('/api/orgs/org-1/members/user-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ role: 'admin' });
  });

  test('a 409 is the only-admin case', async () => {
    stubFetch(
      new Response(JSON.stringify({ message: 'Only admin', code: 'last-admin' }), {
        status: 409,
      }),
    );

    await expect(changeMemberRole('org-1', 'user-1', 'member')).resolves.toEqual({
      kind: 'last-admin',
    });
  });

  test('a non-409 failure is unknown', async () => {
    stubFetch(new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }));

    await expect(changeMemberRole('org-1', 'user-1', 'admin')).resolves.toEqual({
      kind: 'unknown',
    });
  });

  test('an unreachable server is unknown', async () => {
    stubUnreachableFetch();

    await expect(changeMemberRole('org-1', 'user-1', 'admin')).resolves.toEqual({
      kind: 'unknown',
    });
  });
});
