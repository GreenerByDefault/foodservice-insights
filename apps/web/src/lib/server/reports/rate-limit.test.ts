/** Locking and windowing already have exhaustive coverage in `@gbd/db`'s
 * `report-rate-limit.test.ts` — this file only covers this module's own logic on top.
 */

import {
  insertInputFile,
  insertOrganization,
  insertReport,
  sendBlockingStatement,
  withConcurrentTransactions,
  withRollback,
} from '@gbd/db/testing';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { HOURLY_REPORT_LIMIT, WEEKLY_REPORT_LIMIT } from '$lib/reports/limits';
import { database } from '$lib/server/db';
import {
  checkReportRateLimit,
  describeRateLimitExceeded,
  lockAndCheckReportRateLimit,
  type RateLimitExceeded,
} from './rate-limit';

const { mockEnv } = vi.hoisted(() => ({ mockEnv: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

afterEach(() => {
  delete mockEnv.REPORT_RATE_LIMIT;
});

describe('checkReportRateLimit', () => {
  test('undefined when neither the organization nor the user is near a limit', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);

      const result = await checkReportRateLimit(transaction, {
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

      const result = await checkReportRateLimit(transaction, {
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

  test('reports the user, not the organization, once only the user reaches the weekly limit', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      // Old enough to clear the user's hourly window, and under a different organization so the
      // organization's own weekly count stays at zero — isolates the user weekly branch.
      for (let i = 0; i < WEEKLY_REPORT_LIMIT; i++) {
        const elsewhere = await insertOrganization(transaction);
        await insertReport(transaction, {
          organizationId: elsewhere.organization.id,
          createdByUserId: admin.id,
          createdAt: twoHoursAgo,
        });
      }

      const result = await checkReportRateLimit(transaction, {
        organizationId: organization.id,
        userId: admin.id,
      });

      expect(result).toEqual({
        scope: 'user',
        window: 'weekly',
        limit: WEEKLY_REPORT_LIMIT,
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

      const result = await checkReportRateLimit(transaction, {
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

      const result = await checkReportRateLimit(transaction, {
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

  test('REPORT_RATE_LIMIT=off bypasses the limit even at the hourly ceiling', async () => {
    mockEnv.REPORT_RATE_LIMIT = 'off';

    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      for (let i = 0; i < HOURLY_REPORT_LIMIT; i++) {
        await insertReport(transaction, { organizationId: organization.id, createdByUserId: null });
      }

      const result = await checkReportRateLimit(transaction, {
        organizationId: organization.id,
        userId: admin.id,
      });

      expect(result).toBeUndefined();
    });
  });
});

describe('lockAndCheckReportRateLimit', () => {
  test('delegates to checkReportRateLimit', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      for (let i = 0; i < HOURLY_REPORT_LIMIT; i++) {
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

  test('blocks a concurrent call for the same organization until the first commits, and then counts its write', async () => {
    // Proves the lock is real, not just present in the name: without it, both transactions would
    // count the same (limit - 1) reports, both decide they're under the limit, and neither would
    // see the other's insert. `withRollback` can't express this — see this file's header comment.
    await withConcurrentTransactions(database(), async (alpha, beta) => {
      const { organization, admin } = await insertOrganization(alpha.transaction);
      for (let i = 0; i < HOURLY_REPORT_LIMIT - 1; i++) {
        const report = await insertReport(alpha.transaction, {
          organizationId: organization.id,
          createdByUserId: null,
        });
        await insertInputFile(alpha.transaction, { reportId: report.id });
      }

      const alphaResult = await lockAndCheckReportRateLimit(alpha.transaction, {
        organizationId: organization.id,
        userId: admin.id,
      });
      expect(alphaResult).toBeUndefined();

      // Pushes the organization to the limit, but not yet visible to `beta` — it's still
      // uncommitted. `beta`'s check below only reads it correctly because it waits for the lock.
      const lastReport = await insertReport(alpha.transaction, {
        organizationId: organization.id,
        createdByUserId: null,
      });
      await insertInputFile(alpha.transaction, { reportId: lastReport.id });

      const blocked = await sendBlockingStatement(database(), beta, alpha, (transaction) =>
        lockAndCheckReportRateLimit(transaction, {
          organizationId: organization.id,
          userId: admin.id,
        }),
      );

      await alpha.transaction.commit().execute();

      await expect(blocked.result).resolves.toEqual({
        scope: 'organization',
        window: 'hourly',
        limit: HOURLY_REPORT_LIMIT,
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
