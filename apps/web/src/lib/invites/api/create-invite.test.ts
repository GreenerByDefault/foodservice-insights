import { afterEach, describe, expect, test, vi } from 'vitest';
import { expectFetched, jsonResponse, stubFetch, stubUnreachableFetch } from '$lib/testing/fetch';
import { createInvite } from './create-invite.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createInvite', () => {
  test('POSTs the email and role, and resolves with the created outcome', async () => {
    const fetchMock = stubFetch(jsonResponse({ inviteId: 'invite-1', emailSent: true }, 201));

    await expect(createInvite('org-1', 'invitee@example.test', 'member')).resolves.toEqual({
      kind: 'created',
      inviteId: 'invite-1',
      emailSent: true,
    });

    expectFetched(fetchMock, {
      url: '/api/orgs/org-1/invites',
      method: 'POST',
      body: { email: 'invitee@example.test', role: 'member' },
    });
  });

  test('a created invite whose email could not be sent still reports emailSent: false', async () => {
    stubFetch(jsonResponse({ inviteId: 'invite-1', emailSent: false }, 201));

    await expect(createInvite('org-1', 'invitee@example.test', 'member')).resolves.toEqual({
      kind: 'created',
      inviteId: 'invite-1',
      emailSent: false,
    });
  });

  test('a 409 is classified as already-member', async () => {
    stubFetch(jsonResponse({ message: 'Already a member', code: 'already-member' }, 409));

    await expect(createInvite('org-1', 'invitee@example.test', 'member')).resolves.toEqual({
      kind: 'already-member',
    });
  });

  test('a 429 is classified as rate-limited', async () => {
    stubFetch(jsonResponse({ message: 'Too many invites', code: 'rate-limited' }, 429));

    await expect(createInvite('org-1', 'invitee@example.test', 'member')).resolves.toEqual({
      kind: 'rate-limited',
    });
  });

  test('a 500 is classified as unknown', async () => {
    stubFetch(jsonResponse({ message: 'Nope' }, 500));

    await expect(createInvite('org-1', 'invitee@example.test', 'member')).resolves.toEqual({
      kind: 'unknown',
    });
  });

  test('an unreachable server is classified as unknown', async () => {
    stubUnreachableFetch();

    await expect(createInvite('org-1', 'invitee@example.test', 'member')).resolves.toEqual({
      kind: 'unknown',
    });
  });
});
