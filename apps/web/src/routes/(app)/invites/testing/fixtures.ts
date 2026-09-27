import { DAY_MS } from '@gbd/core';
import type { OrganizationInviteId } from '@gbd/db';
import type { InviteOffer } from '../+page.server.ts';

const NOW = new Date('2026-01-15T10:00:00Z');

/** `expiresAt` follows `now` and `isExpired` unless it is overridden itself, so an override of either
 * still renders a deadline on the matching side of the clock. */
export function anInviteOffer(overrides: Partial<InviteOffer> = {}): InviteOffer {
  const now = overrides.now ?? NOW;
  const isExpired = overrides.isExpired ?? false;
  return {
    inviteId: crypto.randomUUID() as OrganizationInviteId,
    organizationName: 'Northgate Provisions',
    role: 'member',
    invitedByName: 'Priya Shah',
    expiresAt: new Date(now.getTime() + (isExpired ? -2 : 3) * DAY_MS),
    isExpired,
    now,
    ...overrides,
  };
}
