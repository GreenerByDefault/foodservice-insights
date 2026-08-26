/** The advisory lock and the windowed counts that close the race `lockReportRateLimit`'s doc
 * comment describes, in `../src/report-rate-limit.ts`. */

import type { ControlledTransaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import type { UsersId } from '../src/generated/auth/Users.ts';
import type { OrganizationId } from '../src/generated/public/Organization.ts';
import { countReportsSince, lockReportRateLimit } from '../src/report-rate-limit.ts';
import type { Database } from '../src/schema.ts';
import {
  sendBlockingStatement,
  withCommittedFixture,
  withConcurrentTransactions,
} from '../src/testing/concurrency.ts';
import { insertInputFile, insertOrganization, insertReport } from '../src/testing/fixtures.ts';
import { withRollback } from '../src/testing/transactions.ts';

describe('lockReportRateLimit', () => {
  test('blocks a second transaction locking the same organization until the first commits', async () => {
    const organizationId = crypto.randomUUID() as OrganizationId;

    await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
      await lockReportRateLimit(alpha.transaction, {
        organizationId,
        userId: crypto.randomUUID() as UsersId,
      });

      const blocked = await sendBlockingStatement(DATABASE, beta, alpha, (transaction) =>
        lockReportRateLimit(transaction, {
          organizationId,
          userId: crypto.randomUUID() as UsersId,
        }),
      );

      await alpha.transaction.commit().execute();
      await expect(blocked.result).resolves.toBeUndefined();
    });
  });

  test('blocks a second transaction locking the same user, even under different organizations', async () => {
    const userId = crypto.randomUUID() as UsersId;

    await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
      await lockReportRateLimit(alpha.transaction, {
        organizationId: crypto.randomUUID() as OrganizationId,
        userId,
      });

      const blocked = await sendBlockingStatement(DATABASE, beta, alpha, (transaction) =>
        lockReportRateLimit(transaction, {
          organizationId: crypto.randomUUID() as OrganizationId,
          userId,
        }),
      );

      await alpha.transaction.commit().execute();
      await expect(blocked.result).resolves.toBeUndefined();
    });
  });

  test('does not block two transactions locking unrelated organizations and users', async () => {
    await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
      await lockReportRateLimit(alpha.transaction, {
        organizationId: crypto.randomUUID() as OrganizationId,
        userId: crypto.randomUUID() as UsersId,
      });

      // If this locked on anything alpha's already holding, it would hang until the harness's
      // own statement timeout, which is what makes this a real assertion and not a no-op.
      await expect(
        lockReportRateLimit(beta.transaction, {
          organizationId: crypto.randomUUID() as OrganizationId,
          userId: crypto.randomUUID() as UsersId,
        }),
      ).resolves.toBeUndefined();
    });
  });
});

describe('countReportsSince', () => {
  test('counts reports for the organization and for the user separately', async () => {
    const counts = await withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const other = await insertOrganization(transaction);
      await insertReport(transaction, {
        organizationId: organization.id,
        createdByUserId: admin.id,
      });
      await insertReport(transaction, { organizationId: organization.id, createdByUserId: null });
      // A different organization's report must not count against this one.
      await insertReport(transaction, {
        organizationId: other.organization.id,
        createdByUserId: other.admin.id,
      });

      return await countReportsSince(transaction, {
        organizationId: organization.id,
        userId: admin.id,
        windowSeconds: 60 * 60,
      });
    });

    expect(counts).toEqual({ organizationCount: 2, userCount: 1 });
  });

  test('excludes reports created before the window', async () => {
    const counts = await withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      await insertReport(transaction, {
        organizationId: organization.id,
        createdByUserId: admin.id,
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      });

      return await countReportsSince(transaction, {
        organizationId: organization.id,
        userId: admin.id,
        windowSeconds: 7 * 24 * 60 * 60,
      });
    });

    expect(counts).toEqual({ organizationCount: 0, userCount: 0 });
  });

  test('still counts a deleted report — the limit is on reports created, not reports that still exist', async () => {
    const counts = await withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const report = await insertReport(transaction, {
        organizationId: organization.id,
        createdByUserId: admin.id,
      });
      await transaction
        .updateTable('report')
        .set({ deletedAt: new Date(), deletedByUserId: admin.id })
        .where('id', '=', report.id)
        .execute();

      return await countReportsSince(transaction, {
        organizationId: organization.id,
        userId: admin.id,
        windowSeconds: 60 * 60,
      });
    });

    expect(counts).toEqual({ organizationCount: 1, userCount: 1 });
  });
});

describe('the count-then-insert race', () => {
  const HOURLY_LIMIT = 5;

  async function attemptUpload(
    transaction: ControlledTransaction<Database>,
    organizationId: OrganizationId,
    userId: UsersId,
  ): Promise<{ inserted: boolean }> {
    await lockReportRateLimit(transaction, { organizationId, userId });
    const { organizationCount } = await countReportsSince(transaction, {
      organizationId,
      userId,
      windowSeconds: 60 * 60,
    });
    if (organizationCount >= HOURLY_LIMIT) return { inserted: false };

    const report = await insertReport(transaction, { organizationId, createdByUserId: userId });
    await insertInputFile(transaction, { reportId: report.id });
    return { inserted: true };
  }

  test('refuses the second of two concurrent uploads at the limit', async () => {
    // Without `lockReportRateLimit` serializing them, both transactions below would count 4,
    // both decide they're under a limit of 5, and both insert.
    await withCommittedFixture(
      DATABASE,
      async (transaction, trash) => {
        const { organization, admin } = await insertOrganization(transaction);
        trash.organization(organization.id);
        for (let i = 0; i < HOURLY_LIMIT - 1; i++) {
          const report = await insertReport(transaction, {
            organizationId: organization.id,
            createdByUserId: admin.id,
          });
          await insertInputFile(transaction, { reportId: report.id });
        }
        return { organization, admin };
      },
      async ({ organization, admin }) => {
        await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
          const alphaResult = await attemptUpload(alpha.transaction, organization.id, admin.id);
          expect(alphaResult).toEqual({ inserted: true });

          const blocked = await sendBlockingStatement(DATABASE, beta, alpha, (transaction) =>
            attemptUpload(transaction, organization.id, admin.id),
          );

          await alpha.transaction.commit().execute();

          await expect(blocked.result).resolves.toEqual({ inserted: false });
        });

        const reports = await DATABASE.selectFrom('report')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('organizationId', '=', organization.id)
          .executeTakeFirstOrThrow();
        expect(Number(reports.count)).toBe(HOURLY_LIMIT);
      },
    );
  });
});
