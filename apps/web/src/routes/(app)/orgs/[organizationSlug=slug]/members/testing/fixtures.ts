import type { UserId } from '@gbd/db';
import { jsonResponse } from '$lib/testing/fetch';
import type { MemberRow } from '../+page.server.ts';

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

/** The 409 every member write answers with when it would leave the organization with no admin. */
export function lastAdminResponse(): Response {
  return jsonResponse({ message: 'Only admin', code: 'last-admin' }, 409);
}
