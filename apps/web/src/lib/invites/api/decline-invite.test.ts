import { afterEach, describe, expect, test, vi } from 'vitest';
import { expectFetched, jsonResponse, stubFetch, stubUnreachableFetch } from '$lib/testing/fetch';
import { declineInvite } from './decline-invite.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('declineInvite', () => {
  test('POSTs to the invite, and resolves as declined on a 204', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(declineInvite('invite-1')).resolves.toEqual({ kind: 'declined' });

    expectFetched(fetchMock, { url: '/api/invites/invite-1/decline', method: 'POST' });
  });

  test('a 409 is classified as no-longer-valid', async () => {
    stubFetch(jsonResponse({ message: 'No longer valid', code: 'no-longer-valid' }, 409));

    await expect(declineInvite('invite-1')).resolves.toEqual({ kind: 'no-longer-valid' });
  });

  test('a 404 is classified as unknown', async () => {
    stubFetch(jsonResponse({ message: 'Not found', code: 'not_found' }, 404));

    await expect(declineInvite('invite-1')).resolves.toEqual({ kind: 'unknown' });
  });

  test('an unreachable server is classified as unknown', async () => {
    stubUnreachableFetch();

    await expect(declineInvite('invite-1')).resolves.toEqual({ kind: 'unknown' });
  });
});
