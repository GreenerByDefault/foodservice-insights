/** The advisory locks and windowed counts that close the check-then-insert race the header of
 * `rate-limits.ts` describes. */

import { DAY_MS, HOUR_MS, WEEK_MS } from '@gbd/core';
import type { ControlledTransaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { DATABASE } from './env.ts';
import type { UsersId } from './generated/auth/Users.ts';
import type { OrganizationId } from './generated/public/Organization.ts';
import {
  countInvitesSince,
  countReportsSince,
  lockInviteRateLimit,
  lockReportRateLimit,
} from './rate-limits.ts';
import type { Database } from './schema.ts';
import {
  sendBlockingStatement,
  withCommittedFixture,
  withConcurrentTransactions,
} from './testing/concurrency.ts';
import {
  insertOrganization,
  insertOrganizationInvite,
  insertReport,
} from './testing/fixtures/index.ts';
import { withRollback } from './testing/transactions.ts';

describe('lockInviteRateLimit', () => {
  test('blocks a second transaction locking the same user until the first commits', async () => {
    const userId = crypto.randomUUID() as UsersId;

    await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
      await lockInviteRateLimit(alpha.transaction, { userId });

      const blocked = await sendBlockingStatement(DATABASE, beta, alpha, (transaction) =>
        lockInviteRateLimit(transaction, { userId }),
      );

      await alpha.transaction.commit().execute();
      await expect(blocked.result).resolves.toBeUndefined();
    });
  });

  test('does not block two transactions locking unrelated users', async () => {
    await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
      await lockInviteRateLimit(alpha.transaction, { userId: crypto.randomUUID() as UsersId });

      // If this locked on anything alpha's already holding, it would hang until the harness's
      // own statement timeout, which is what makes this a real assertion and not a no-op.
      await expect(
        lockInviteRateLimit(beta.transaction, { userId: crypto.randomUUID() as UsersId }),
      ).resolves.toBeUndefined();
    });
  });

  describe('the count-then-insert race', () => {
    const HOURLY_LIMIT = 5;

    async function attemptInvite(
      transaction: ControlledTransaction<Database>,
      userId: UsersId,
      organizationId: OrganizationId,
    ): Promise<{ inserted: boolean }> {
      await lockInviteRateLimit(transaction, { userId });
      const count = await countInvitesSince(transaction, {
        userId,
        windowSeconds: HOUR_MS / 1000,
      });
      if (count >= HOURLY_LIMIT) return { inserted: false };

      await insertOrganizationInvite(transaction, {
        organizationId,
        email: `${crypto.randomUUID()}@example.test`,
        invitedByUserId: userId,
      });
      return { inserted: true };
    }

    test('refuses the second of two concurrent invites at the limit', async () => {
      // Without `lockInviteRateLimit` serializing them, both transactions below would count 4,
      // both decide they're under a limit of 5, and both insert.
      await withCommittedFixture(
        DATABASE,
        async (transaction, trash) => {
          const { organization, admin } = await insertOrganization(transaction);
          trash.organization(organization.id);
          for (let i = 0; i < HOURLY_LIMIT - 1; i++) {
            await insertOrganizationInvite(transaction, {
              organizationId: organization.id,
              email: `${crypto.randomUUID()}@example.test`,
              invitedByUserId: admin.id,
            });
          }
          return { organization, admin };
        },
        async ({ organization, admin }) => {
          await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
            const alphaResult = await attemptInvite(alpha.transaction, admin.id, organization.id);
            expect(alphaResult).toEqual({ inserted: true });

            const blocked = await sendBlockingStatement(DATABASE, beta, alpha, (transaction) =>
              attemptInvite(transaction, admin.id, organization.id),
            );

            await alpha.transaction.commit().execute();

            await expect(blocked.result).resolves.toEqual({ inserted: false });
          });

          const invites = await DATABASE.selectFrom('organizationInvite')
            .select((eb) => eb.fn.countAll<string>().as('count'))
            .where('organizationId', '=', organization.id)
            .executeTakeFirstOrThrow();
          expect(Number(invites.count)).toBe(HOURLY_LIMIT);
        },
      );
    });
  });
});

describe('countInvitesSince', () => {
  test('counts invites sent by the user within the window', async () => {
    const count = await withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const other = await insertOrganization(transaction);
      await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: 'ada@example.test',
        invitedByUserId: admin.id,
      });
      await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: 'grace@example.test',
        invitedByUserId: admin.id,
      });
      // A different user's invite must not count against this one.
      await insertOrganizationInvite(transaction, {
        organizationId: other.organization.id,
        email: 'hedy@example.test',
        invitedByUserId: other.admin.id,
      });

      return await countInvitesSince(transaction, {
        userId: admin.id,
        windowSeconds: HOUR_MS / 1000,
      });
    });

    expect(count).toBe(2);
  });

  test('excludes invites created before the window', async () => {
    const count = await withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: 'ada@example.test',
        invitedByUserId: admin.id,
        expiresAt: new Date(Date.now() - 8 * DAY_MS),
      });

      return await countInvitesSince(transaction, {
        userId: admin.id,
        windowSeconds: HOUR_MS / 1000,
      });
    });

    expect(count).toBe(0);
  });

  test('still counts a superseded invite — the limit is on invites sent, not invites still pending', async () => {
    const count = await withRollback(DATABASE, async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const invite = await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email: 'ada@example.test',
        invitedByUserId: admin.id,
      });
      await transaction
        .updateTable('organizationInvite')
        .set({ status: 'superseded' })
        .where('id', '=', invite.id)
        .execute();

      return await countInvitesSince(transaction, {
        userId: admin.id,
        windowSeconds: HOUR_MS / 1000,
      });
    });

    expect(count).toBe(1);
  });
});

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
        windowSeconds: HOUR_MS / 1000,
      });
      if (organizationCount >= HOURLY_LIMIT) return { inserted: false };

      await insertReport(transaction, { organizationId, createdByUserId: userId });
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
            await insertReport(transaction, {
              organizationId: organization.id,
              createdByUserId: admin.id,
            });
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
        windowSeconds: HOUR_MS / 1000,
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
        createdAt: new Date(Date.now() - 8 * DAY_MS),
      });

      return await countReportsSince(transaction, {
        organizationId: organization.id,
        userId: admin.id,
        windowSeconds: WEEK_MS / 1000,
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
        .set({ deletedAt: new Date() })
        .where('id', '=', report.id)
        .execute();

      return await countReportsSince(transaction, {
        organizationId: organization.id,
        userId: admin.id,
        windowSeconds: HOUR_MS / 1000,
      });
    });

    expect(counts).toEqual({ organizationCount: 1, userCount: 1 });
  });
});
