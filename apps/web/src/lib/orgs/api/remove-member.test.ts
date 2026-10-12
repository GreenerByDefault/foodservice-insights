import { afterEach, describe, expect, test, vi } from 'vitest';
import { aLastAdminResponse } from '#lib/orgs/testing/fixtures.js';
import { expectFetched, stubFetch } from '#lib/testing/fetch.js';
import { removeMember } from './remove-member.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('removeMember', () => {
  test('DELETEs the member', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(removeMember('org-1', 'user-1')).resolves.toEqual({ kind: 'done' });

    expectFetched(fetchMock, { url: '/api/orgs/org-1/members/user-1', method: 'DELETE' });
  });

  test('a write failure is classified by classifyMemberWriteFailure', async () => {
    stubFetch(aLastAdminResponse());

    await expect(removeMember('org-1', 'user-1')).resolves.toEqual({ kind: 'last-admin' });
  });
});
