import type { OrganizationInviteId, UserId } from '@gbd/db';
import { jsonResponse } from '$lib/testing/fetch';
import type { InviteRow, MemberRow } from '../+page.server.ts';

export function aMember(overrides: Partial<MemberRow> = {}): MemberRow {
  return {
    userId: crypto.randomUUID() as UserId,
    displayName: 'Ana Ruiz',
    email: 'ana@example.test',
    role: 'member',
    isYou: false,
    ...overrides,
  };
}

const NOW = new Date('2026-01-15T10:00:00Z');

export function aPendingInvite(overrides: Partial<InviteRow> = {}): InviteRow {
  return {
    inviteId: crypto.randomUUID() as OrganizationInviteId,
    email: 'invitee@example.test',
    role: 'member',
    expiresAt: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000),
    isExpired: false,
    now: NOW,
    ...overrides,
  };
}

/** The 409 every member write answers with when it would leave the organization with no admin. */
export function lastAdminResponse(): Response {
  return jsonResponse({ message: 'Only admin', code: 'last-admin' }, 409);
}
