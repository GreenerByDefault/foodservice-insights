import { afterEach, describe, expect, test, vi } from 'vitest';
import { expectFetched, jsonResponse, stubFetch } from '$lib/testing/fetch';
import { changeMemberRole } from './change-member-role.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('changeMemberRole', () => {
  test('PATCHes the member with the new role', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(changeMemberRole('org-1', 'user-1', 'admin')).resolves.toEqual({ kind: 'done' });

    expectFetched(fetchMock, {
      url: '/api/orgs/org-1/members/user-1',
      method: 'PATCH',
      body: { role: 'admin' },
    });
  });

  test('a write failure is classified by classifyMemberWriteFailure', async () => {
    stubFetch(jsonResponse({ message: 'Only admin', code: 'last-admin' }, 409));

    await expect(changeMemberRole('org-1', 'user-1', 'member')).resolves.toEqual({
      kind: 'last-admin',
    });
  });
});
