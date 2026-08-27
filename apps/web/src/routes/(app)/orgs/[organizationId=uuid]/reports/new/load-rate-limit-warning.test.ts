/** `rate-limit.test.ts` already checks most of the edge cases; this file is for the wiring. */

import { insertOrganization, insertReport, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { HOURLY_REPORT_LIMIT } from '$lib/reports/limits';
import { database } from '$lib/server/db';
import { describeRateLimitExceeded } from '$lib/server/reports/rate-limit';
import { _loadRateLimitWarning } from './+page.server.ts';

describe('_loadRateLimitWarning', () => {
  test('undefined when neither the organization nor the user is near a limit', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);

      const data = await _loadRateLimitWarning(transaction, {
        organizationId: organization.id,
        userId: admin.id,
      });

      expect(data).toEqual({ rateLimitWarning: undefined });
    });
  });

  test('the forwarded summary once the organization is at its hourly limit', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      for (let i = 0; i < HOURLY_REPORT_LIMIT; i++) {
        await insertReport(transaction, { organizationId: organization.id, createdByUserId: null });
      }

      const data = await _loadRateLimitWarning(transaction, {
        organizationId: organization.id,
        userId: admin.id,
      });

      expect(data).toEqual({
        rateLimitWarning: describeRateLimitExceeded({
          scope: 'organization',
          window: 'hourly',
          limit: HOURLY_REPORT_LIMIT,
        }).summary,
      });
    });
  });
});
