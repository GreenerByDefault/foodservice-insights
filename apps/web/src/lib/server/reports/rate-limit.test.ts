/** `lockReportRateLimit` and `countReportsSince` already have exhaustive coverage in `@gbd/db`
 * for locking and windowing — see that package's `report-rate-limit.test.ts`. What's untested
 * there is this module's own logic: which scope and window `lockAndCheckReportRateLimit` reports
 * first when more than one is exceeded, and how `describeRateLimitExceeded` turns that into copy.
 */

import { insertOrganization, insertReport, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { HOURLY_REPORT_LIMIT, WEEKLY_REPORT_LIMIT } from '$lib/reports/limits';
import { database } from '$lib/server/db';
import {
  describeRateLimitExceeded,
  lockAndCheckReportRateLimit,
  type RateLimitExceeded,
} from './rate-limit';

describe('lockAndCheckReportRateLimit', () => {
  test('undefined when neither the organization nor the user is near a limit', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);

      const result = await lockAndCheckReportRateLimit(transaction, {
        organizationId: organization.id,
        userId: admin.id,
      });

      expect(result).toBeUndefined();
    });
  });

  test('reports the user, not the organization, once the user alone reaches the hourly limit', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      // `countReportsSince`'s user count isn't scoped to an organization — it's the user's
      // reports everywhere. So the admin can hit their own limit through a different
      // organization while this one, the one being checked, stays empty.
      for (let i = 0; i < HOURLY_REPORT_LIMIT; i++) {
        const elsewhere = await insertOrganization(transaction);
        await insertReport(transaction, {
          organizationId: elsewhere.organization.id,
          createdByUserId: admin.id,
        });
      }

      const result = await lockAndCheckReportRateLimit(transaction, {
        organizationId: organization.id,
        userId: admin.id,
      });

      expect(result).toEqual({
        scope: 'user',
        window: 'hourly',
        limit: HOURLY_REPORT_LIMIT,
      } satisfies RateLimitExceeded);
    });
  });

  test('checks the hourly limit before the weekly one', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      // At the weekly limit too, but the hourly check runs first and should win.
      for (let i = 0; i < WEEKLY_REPORT_LIMIT; i++) {
        await insertReport(transaction, { organizationId: organization.id, createdByUserId: null });
      }

      const result = await lockAndCheckReportRateLimit(transaction, {
        organizationId: organization.id,
        userId: admin.id,
      });

      expect(result).toEqual({
        scope: 'organization',
        window: 'hourly',
        limit: HOURLY_REPORT_LIMIT,
      } satisfies RateLimitExceeded);
    });
  });

  test('falls through to the weekly limit once the hourly count is old enough to fall out of that window', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      for (let i = 0; i < WEEKLY_REPORT_LIMIT; i++) {
        await insertReport(transaction, {
          organizationId: organization.id,
          createdByUserId: null,
          createdAt: twoHoursAgo,
        });
      }

      const result = await lockAndCheckReportRateLimit(transaction, {
        organizationId: organization.id,
        userId: admin.id,
      });

      expect(result).toEqual({
        scope: 'organization',
        window: 'weekly',
        limit: WEEKLY_REPORT_LIMIT,
      } satisfies RateLimitExceeded);
    });
  });
});

describe('describeRateLimitExceeded', () => {
  test.each([
    {
      exceeded: { scope: 'organization', window: 'hourly', limit: 5 } satisfies RateLimitExceeded,
      summary:
        'Your organization has reached its limit of 5 reports per hour. Try again in a little while.',
      rejectionDetail: 'organization at the hourly limit of 5',
    },
    {
      exceeded: { scope: 'user', window: 'hourly', limit: 5 } satisfies RateLimitExceeded,
      summary: "You've reached your limit of 5 reports per hour. Try again in a little while.",
      rejectionDetail: 'user at the hourly limit of 5',
    },
    {
      exceeded: { scope: 'organization', window: 'weekly', limit: 20 } satisfies RateLimitExceeded,
      summary:
        'Your organization has reached its limit of 20 reports per week. Try again next week.',
      rejectionDetail: 'organization at the weekly limit of 20',
    },
    {
      exceeded: { scope: 'user', window: 'weekly', limit: 20 } satisfies RateLimitExceeded,
      summary: "You've reached your limit of 20 reports per week. Try again next week.",
      rejectionDetail: 'user at the weekly limit of 20',
    },
  ])('$exceeded.scope/$exceeded.window', ({ exceeded, summary, rejectionDetail }) => {
    expect(describeRateLimitExceeded(exceeded)).toEqual({
      reason: 'rate_limited',
      summary,
      rejectionDetail,
    });
  });
});
