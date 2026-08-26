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
import { requestCancellation } from './cancel';

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

  test('a report in another organization is a 404, not a leak', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization: owner, admin } = await insertOrganization(transaction);
      const { organization: outsider } = await insertOrganization(transaction);
      const { report } = await insertReportWithAttempt(transaction, owner.id, {
        createdByUserId: admin.id,
      });

      await expect(
        statusOf(() =>
          requestCancellation(transaction, {
            organizationId: outsider.id,
            reportId: report.id,
            actor: { userId: admin.id, role: 'admin' },
          }),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
      expect(await auditEventFor(transaction, report.id)).toBeUndefined();
    });
  });

  test('a report that does not exist is a 404', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const reportId = crypto.randomUUID() as ReportId;

      await expect(
        statusOf(() =>
          requestCancellation(transaction, {
            organizationId: organization.id,
            reportId,
            actor: { userId: admin.id, role: 'admin' },
          }),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
      expect(await auditEventFor(transaction, reportId)).toBeUndefined();
    });
  });

  test('a soft-deleted report is a 404, even for the admin who could otherwise cancel it', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const { report } = await insertReportWithAttempt(transaction, organization.id, {
        createdByUserId: admin.id,
      });
      await transaction
        .updateTable('report')
        .set({ deletedAt: new Date(), deletedByUserId: admin.id })
        .where('id', '=', report.id)
        .execute();

      await expect(
        statusOf(() =>
          requestCancellation(transaction, {
            organizationId: organization.id,
            reportId: report.id,
            actor: { userId: admin.id, role: 'admin' },
          }),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
      expect(await auditEventFor(transaction, report.id)).toBeUndefined();
    });
  });

  test('an attempt that already succeeded is a 409, not a false success', async () => {
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

  test('a second cancel on an already-requested attempt is also a 409', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const { report } = await insertReportWithAttempt(transaction, organization.id, {
        createdByUserId: admin.id,
        status: 'canceled',
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

  test('a report with no attempt at all is a 409: the update guard matches no row either way', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const report = await insertReport(transaction, {
        organizationId: organization.id,
        createdByUserId: admin.id,
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
