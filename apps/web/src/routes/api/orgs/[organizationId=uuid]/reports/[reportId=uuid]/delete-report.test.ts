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
import { _deleteReport } from './+server.ts';

/** A report and the one active attempt `_deleteReport` should find on it. */
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

/** The audit rows for `reportId`, in insertion order. */
async function auditEventsFor(transaction: DatabaseExecutor, reportId: ReportId) {
  return await transaction
    .selectFrom('auditEvent')
    .select(['action', 'actorUserId', 'actorKind', 'organizationId', 'targetType', 'targetId'])
    .where('targetId', '=', reportId)
    .orderBy('id')
    .execute();
}

// The 404/403 access checks are `requireReportAccess`'s own guarantee (see guards.test.ts) — these
// only check that _deleteReport wires it up: an allowed caller's delete goes through and a denied
// one leaves nothing written, plus the deletion-specific behavior (the two audit rows).
describe('_deleteReport', () => {
  test('a member can delete their own report, canceling its pending attempt', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const { report, attempt } = await insertReportWithAttempt(transaction, organization.id, {
        createdByUserId: admin.id,
      });

      await _deleteReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        actor: { userId: admin.id, role: 'member' },
      });

      const updatedReport = await transaction
        .selectFrom('report')
        .select(['deletedAt', 'deletedByUserId'])
        .where('id', '=', report.id)
        .executeTakeFirstOrThrow();
      expect(updatedReport.deletedAt).toBeInstanceOf(Date);
      expect(updatedReport.deletedByUserId).toBe(admin.id);

      const updatedAttempt = await transaction
        .selectFrom('analysisAttempt')
        .select(['status', 'cancelRequestedAt'])
        .where('id', '=', attempt.id)
        .executeTakeFirstOrThrow();
      expect(updatedAttempt.status).toBe('pending');
      expect(updatedAttempt.cancelRequestedAt).toBeInstanceOf(Date);

      expect(await auditEventsFor(transaction, report.id)).toEqual([
        {
          action: 'report.deleted',
          actorUserId: admin.id,
          actorKind: 'user',
          organizationId: organization.id,
          targetType: 'report',
          targetId: report.id,
        },
        {
          action: 'report.cancel_requested',
          actorUserId: admin.id,
          actorKind: 'user',
          organizationId: organization.id,
          targetType: 'report',
          targetId: report.id,
        },
      ]);
    });
  });

  test('an admin can delete a report they did not create', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const creator = await insertAppUser(transaction);
      const { report } = await insertReportWithAttempt(transaction, organization.id, {
        createdByUserId: creator.id,
        status: 'processing',
      });

      await _deleteReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        actor: { userId: admin.id, role: 'admin' },
      });

      const updatedReport = await transaction
        .selectFrom('report')
        .select('deletedByUserId')
        .where('id', '=', report.id)
        .executeTakeFirstOrThrow();
      // The audit trail names the admin who acted, not the creator whose report it is.
      expect(updatedReport.deletedByUserId).toBe(admin.id);
    });
  });

  // The full status/no-attempt matrix for "nothing active to cancel" is covered exhaustively by
  // cancelActiveAttempt's own tests (cancel.test.ts); this just checks _deleteReport's wiring
  // when that lookup comes back false.
  test('deleting a report whose attempt already finished still deletes it, with no cancel event', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const { report, attempt } = await insertReportWithAttempt(transaction, organization.id, {
        createdByUserId: admin.id,
        status: 'succeeded',
      });

      await _deleteReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        actor: { userId: admin.id, role: 'admin' },
      });

      const updatedReport = await transaction
        .selectFrom('report')
        .select('deletedAt')
        .where('id', '=', report.id)
        .executeTakeFirstOrThrow();
      expect(updatedReport.deletedAt).toBeInstanceOf(Date);

      const untouchedAttempt = await transaction
        .selectFrom('analysisAttempt')
        .select('cancelRequestedAt')
        .where('id', '=', attempt.id)
        .executeTakeFirstOrThrow();
      expect(untouchedAttempt.cancelRequestedAt).toBeNull();

      expect(await auditEventsFor(transaction, report.id)).toEqual([
        {
          action: 'report.deleted',
          actorUserId: admin.id,
          actorKind: 'user',
          organizationId: organization.id,
          targetType: 'report',
          targetId: report.id,
        },
      ]);
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
          _deleteReport(transaction, {
            organizationId: organization.id,
            reportId: report.id,
            actor: { userId: bystander.id, role: 'member' },
          }),
        ),
      ).resolves.toEqual({ status: 403, code: 'forbidden' });

      const untouchedReport = await transaction
        .selectFrom('report')
        .select('deletedAt')
        .where('id', '=', report.id)
        .executeTakeFirstOrThrow();
      expect(untouchedReport.deletedAt).toBeNull();

      const untouchedAttempt = await transaction
        .selectFrom('analysisAttempt')
        .select('cancelRequestedAt')
        .where('id', '=', attempt.id)
        .executeTakeFirstOrThrow();
      expect(untouchedAttempt.cancelRequestedAt).toBeNull();

      expect(await auditEventsFor(transaction, report.id)).toEqual([]);
    });
  });
});
