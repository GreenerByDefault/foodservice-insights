import { afterEach, describe, expect, test, vi } from 'vitest';
import { aLastAdminResponse } from '#lib/orgs/testing/fixtures.js';
import { expectFetched, stubFetch } from '#lib/testing/fetch.js';
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
    stubFetch(aLastAdminResponse());

    await expect(changeMemberRole('org-1', 'user-1', 'member')).resolves.toEqual({
      kind: 'last-admin',
    });
  });
});
