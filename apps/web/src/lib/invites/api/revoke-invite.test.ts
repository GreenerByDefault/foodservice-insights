import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, ApiUnreachableError } from '$lib/api/fetch';
import { expectFetched, jsonResponse, stubFetch, stubUnreachableFetch } from '$lib/testing/fetch';
import { revokeInvite } from './revoke-invite.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('revokeInvite', () => {
  test('DELETEs the invite', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await revokeInvite('org-1', 'invite-1');

    expectFetched(fetchMock, { url: '/api/orgs/org-1/invites/invite-1', method: 'DELETE' });
  });

  test('a non-2xx response throws ApiError', async () => {
    stubFetch(jsonResponse({ message: 'Not found', code: 'not_found' }, 404));

    await expect(revokeInvite('org-1', 'invite-1')).rejects.toBeInstanceOf(ApiError);
  });

  test('an unreachable server throws ApiUnreachableError', async () => {
    stubUnreachableFetch();

    await expect(revokeInvite('org-1', 'invite-1')).rejects.toBeInstanceOf(ApiUnreachableError);
  });
});
