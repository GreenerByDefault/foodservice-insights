import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  expectFetched,
  jsonResponse,
  stubFetch,
  stubUnreachableFetch,
} from '#lib/testing/fetch.js';
import { acceptInvite } from './accept-invite.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('acceptInvite', () => {
  test('POSTs to the invite, and resolves with the organization joined', async () => {
    const fetchMock = stubFetch(jsonResponse({ organizationSlug: 'acme' }));

    await expect(acceptInvite('invite-1')).resolves.toEqual({
      kind: 'accepted',
      organizationSlug: 'acme',
    });

    expectFetched(fetchMock, { url: '/api/invites/invite-1/accept', method: 'POST' });
  });

  test('a 409 is classified as no-longer-valid', async () => {
    stubFetch(jsonResponse({ message: 'No longer valid', code: 'no-longer-valid' }, 409));

    await expect(acceptInvite('invite-1')).resolves.toEqual({ kind: 'no-longer-valid' });
  });

  test('a 410 is classified as expired', async () => {
    stubFetch(jsonResponse({ message: 'Expired', code: 'expired' }, 410));

    await expect(acceptInvite('invite-1')).resolves.toEqual({ kind: 'expired' });
  });

  test('a 404 is classified as unknown', async () => {
    stubFetch(jsonResponse({ message: 'Not found', code: 'not_found' }, 404));

    await expect(acceptInvite('invite-1')).resolves.toEqual({ kind: 'unknown' });
  });

  test('an unreachable server is classified as unknown', async () => {
    stubUnreachableFetch();

    await expect(acceptInvite('invite-1')).resolves.toEqual({ kind: 'unknown' });
  });
});
