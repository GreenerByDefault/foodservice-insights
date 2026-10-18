import { describe, expect, test } from 'vitest';
import { DATABASE } from '../../env.ts';
import { withRollback } from '../transactions.ts';
import { insertOrganization, insertOrganizationInvite } from './organization.ts';

describe('insertOrganizationInvite', () => {
  test('defaults expiresAt to a full lifetime out, and leaves createdAt at its column default', async () => {
    await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: 'ada@example.test',
      });

      expect(invite.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(invite.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(invite.expiresAt.getTime()).toBeGreaterThan(invite.createdAt.getTime());
    });
  });

  test('backdates createdAt a full lifetime before an already-past expiresAt', async () => {
    await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const expiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: 'ada@example.test',
        expiresAt,
      });

      const lifetimeMs = 14 * 24 * 60 * 60 * 1000;
      expect(invite.expiresAt).toEqual(expiresAt);
      expect(invite.createdAt.getTime()).toEqual(expiresAt.getTime() - lifetimeMs);
    });
  });
});
