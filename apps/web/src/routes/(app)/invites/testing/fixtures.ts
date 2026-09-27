import type { OrganizationInviteId } from '@gbd/db';
import type { InviteOffer } from '../+page.server.ts';

const NOW = new Date('2026-01-15T10:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

export function anInviteOffer(overrides: Partial<InviteOffer> = {}): InviteOffer {
  const isExpired = overrides.isExpired ?? false;
  return {
    inviteId: crypto.randomUUID() as OrganizationInviteId,
    organizationName: 'Northgate Provisions',
    role: 'member',
    invitedByName: 'Priya Shah',
    expiresAt: new Date(NOW.getTime() + (isExpired ? -2 : 3) * DAY_MS),
    isExpired,
    now: NOW,
    ...overrides,
  };
}
