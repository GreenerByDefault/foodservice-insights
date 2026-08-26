import type {
  AnalysisAttemptStatus,
  DatabaseExecutor,
  OrganizationId,
  ReportId,
  UserId,
} from '@gbd/db';
import {
  insertAnalysisAttempt,
  insertAppUser,
  insertOrganization,
  insertReport,
  withRollback,
} from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { statusOf } from '$lib/server/tests/http-error';
import { cancelActiveAttempt, requestCancellation } from './cancel';

/** A report and the one active attempt `requestCancellation` should find on it. */
async function insertReportWithAttempt(
  transaction: DatabaseExecutor,
  organizationId: OrganizationId,
  overrides: { createdByUserId?: UserId; status?: AnalysisAttemptStatus } = {},
) {
  const report = await insertReport(transaction, {
    organizationId,
    createdByUserId: overrides.createdByUserId ?? null,
  });
  const attempt = await insertAnalysisAttempt(transaction, {
    reportId: report.id,
    status: overrides.status ?? 'pending',
  });
  return { report, attempt };
}

/** The one `report.cancel_requested` audit row for `reportId`, or `undefined` if none was
 * written. */
async function auditEventFor(transaction: DatabaseExecutor, reportId: ReportId) {
  return await transaction
    .selectFrom('auditEvent')
    .select(['action', 'actorUserId', 'actorKind', 'organizationId', 'targetType', 'targetId'])
    .where('targetId', '=', reportId)
    .executeTakeFirst();
}

describe('cancelActiveAttempt', () => {
  test.each(['pending', 'processing'] as const)(
    'sets cancelRequestedAt and returns true for a %s attempt',
    async (status) => {
      await withRollback(database(), async (transaction) => {
        const report = await insertReport(transaction);
        const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id, status });

        await expect(cancelActiveAttempt(transaction, report.id)).resolves.toBe(true);

        const updated = await transaction
          .selectFrom('analysisAttempt')
          .select('cancelRequestedAt')
          .where('id', '=', attempt.id)
          .executeTakeFirstOrThrow();
        expect(updated.cancelRequestedAt).toBeInstanceOf(Date);
      });
    },
  );

  test.each(['succeeded', 'failed', 'canceled'] as const)(
    'leaves a %s attempt untouched and returns false',
    async (status) => {
      await withRollback(database(), async (transaction) => {
        const report = await insertReport(transaction);
        const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id, status });

        await expect(cancelActiveAttempt(transaction, report.id)).resolves.toBe(false);

        const untouched = await transaction
          .selectFrom('analysisAttempt')
          .select('cancelRequestedAt')
          .where('id', '=', attempt.id)
          .executeTakeFirstOrThrow();
        expect(untouched.cancelRequestedAt).toEqual(attempt.cancelRequestedAt);
      });
    },
  );

  test('returns false for a report with no attempt at all', async () => {
    await withRollback(database(), async (transaction) => {
      const report = await insertReport(transaction);

      await expect(cancelActiveAttempt(transaction, report.id)).resolves.toBe(false);
    });
  });

  test('only touches the given report — a pending attempt on another report is untouched', async () => {
    await withRollback(database(), async (transaction) => {
      const target = await insertReport(transaction);
      const other = await insertReport(transaction);
      const otherAttempt = await insertAnalysisAttempt(transaction, {
        reportId: other.id,
        status: 'pending',
      });

      await expect(cancelActiveAttempt(transaction, target.id)).resolves.toBe(false);

      const untouched = await transaction
        .selectFrom('analysisAttempt')
        .select('cancelRequestedAt')
        .where('id', '=', otherAttempt.id)
        .executeTakeFirstOrThrow();
      expect(untouched.cancelRequestedAt).toBeNull();
    });
  });
});

// The 404/403 access checks are `requireReportAccess`'s own guarantee (see guards.test.ts) — these
// only check that requestCancellation wires it up: an allowed caller's cancellation goes through,
// a denied one leaves nothing written, and cancellation-specific behavior (the 409) works.
describe('requestCancellation', () => {
  test('a member can cancel a pending attempt on their own report', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const { report, attempt } = await insertReportWithAttempt(transaction, organization.id, {
        createdByUserId: admin.id,
      });

      await requestCancellation(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        actor: { userId: admin.id, role: 'member' },
      });

      const updated = await transaction
        .selectFrom('analysisAttempt')
        .select(['status', 'cancelRequestedAt'])
        .where('id', '=', attempt.id)
        .executeTakeFirstOrThrow();
      expect(updated.status).toBe('pending');
      expect(updated.cancelRequestedAt).toBeInstanceOf(Date);

      expect(await auditEventFor(transaction, report.id)).toEqual({
        action: 'report.cancel_requested',
        actorUserId: admin.id,
        actorKind: 'user',
        organizationId: organization.id,
        targetType: 'report',
        targetId: report.id,
      });
    });
  });

  test('an admin can cancel a processing attempt on a report they did not create', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const creator = await insertAppUser(transaction);
      const { report, attempt } = await insertReportWithAttempt(transaction, organization.id, {
        createdByUserId: creator.id,
        status: 'processing',
      });

      await requestCancellation(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        actor: { userId: admin.id, role: 'admin' },
      });

      const updated = await transaction
        .selectFrom('analysisAttempt')
        .select('cancelRequestedAt')
        .where('id', '=', attempt.id)
        .executeTakeFirstOrThrow();
      expect(updated.cancelRequestedAt).toBeInstanceOf(Date);

      // The audit trail names the admin who acted, not the creator whose report it is.
      const event = await auditEventFor(transaction, report.id);
      expect(event?.actorUserId).toBe(admin.id);
    });
  });

  test('a member who did not create the report gets a 403, and nothing is written', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const creator = await insertAppUser(transaction);
      const bystander = await insertAppUser(transaction);
      const { report, attempt } = await insertReportWithAttempt(transaction, organization.id, {
        createdByUserId: creator.id,
      });

      await expect(
        statusOf(() =>
          requestCancellation(transaction, {
            organizationId: organization.id,
            reportId: report.id,
            actor: { userId: bystander.id, role: 'member' },
          }),
        ),
      ).resolves.toEqual({ status: 403, code: 'forbidden' });

      const untouched = await transaction
        .selectFrom('analysisAttempt')
        .select('cancelRequestedAt')
        .where('id', '=', attempt.id)
        .executeTakeFirstOrThrow();
      expect(untouched.cancelRequestedAt).toBeNull();
      expect(await auditEventFor(transaction, report.id)).toBeUndefined();
    });
  });

  // Every status/no-attempt permutation of "nothing active to cancel" is covered exhaustively
  // by cancelActiveAttempt's own tests above; this just checks requestCancellation's wiring
  // when that lookup comes back false.
  test('no active attempt to cancel is a 409, and no audit event is written', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const { report } = await insertReportWithAttempt(transaction, organization.id, {
        createdByUserId: admin.id,
        status: 'succeeded',
      });

      await expect(
        statusOf(() =>
          requestCancellation(transaction, {
            organizationId: organization.id,
            reportId: report.id,
            actor: { userId: admin.id, role: 'admin' },
          }),
        ),
      ).resolves.toEqual({ status: 409 });
      expect(await auditEventFor(transaction, report.id)).toBeUndefined();
    });
  });
});
