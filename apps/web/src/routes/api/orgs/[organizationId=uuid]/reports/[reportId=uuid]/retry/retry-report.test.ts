import {
  insertAnalysisAttempt,
  insertAppUser,
  insertOrganization,
  insertReportWithAttempt,
  withRollback,
} from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import type { Actor } from '$lib/server/auth/types';
import { database } from '$lib/server/db';
import { expectedReportAuditEvent, reportAuditEvents } from '$lib/server/tests/audit';
import { statusOf } from '$lib/server/tests/http-error';
import { _retryReport } from './+server.ts';

// The 404/403 access checks are `requireReportAccess`'s own guarantee (see guards.test.ts), and the
// full "only after a failure"/five-attempt-cap matrix is `analysis_attempt`'s own guarantee (see
// packages/db/tests/analysis-attempt.test.ts) — these only check that _retryReport wires both up,
// plus the retry-specific behavior (the new attempt and its audit event).
//
// A case that gets its 409 from the insert itself (rather than from requireReportAccess) leaves the
// transaction aborted, per withTransaction's documented join-not-nest trade-off — so those tests
// don't try to read anything back afterward. withRollback discards the attempt either way.
describe('_retryReport', () => {
  test('a member can retry their own failed report', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const { report } = await insertReportWithAttempt(transaction, {
        organizationId: organization.id,
        createdByUserId: admin.id,
        status: 'failed',
      });
      const retry = (actor: Actor) =>
        _retryReport(transaction, { organizationId: organization.id, reportId: report.id, actor });

      await retry({ userId: admin.id, role: 'member' });

      const attempts = await transaction
        .selectFrom('analysisAttempt')
        .select(['attemptNumber', 'status', 'requestedByUserId'])
        .where('reportId', '=', report.id)
        .orderBy('attemptNumber')
        .execute();
      expect(attempts).toEqual([
        expect.objectContaining({ attemptNumber: 1, status: 'failed' }),
        { attemptNumber: 2, status: 'pending', requestedByUserId: admin.id },
      ]);

      expect(await reportAuditEvents(transaction, report.id)).toEqual([
        expectedReportAuditEvent({
          action: 'report.retry_requested',
          actorUserId: admin.id,
          organizationId: organization.id,
          reportId: report.id,
        }),
      ]);
    });
  });

  test('an admin can retry a report they did not create', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const creator = await insertAppUser(transaction);
      const { report } = await insertReportWithAttempt(transaction, {
        organizationId: organization.id,
        createdByUserId: creator.id,
        status: 'failed',
      });
      const retry = (actor: Actor) =>
        _retryReport(transaction, { organizationId: organization.id, reportId: report.id, actor });

      await retry({ userId: admin.id, role: 'admin' });

      const newest = await transaction
        .selectFrom('analysisAttempt')
        .select(['attemptNumber', 'requestedByUserId'])
        .where('reportId', '=', report.id)
        .orderBy('attemptNumber', 'desc')
        .executeTakeFirstOrThrow();
      expect(newest).toEqual({ attemptNumber: 2, requestedByUserId: admin.id });

      // The audit trail names the admin who acted, not the creator whose report it is.
      expect(await reportAuditEvents(transaction, report.id)).toEqual([
        expectedReportAuditEvent({
          action: 'report.retry_requested',
          actorUserId: admin.id,
          organizationId: organization.id,
          reportId: report.id,
        }),
      ]);
    });
  });

  test('a member who did not create the report gets a 403, and nothing is written', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const creator = await insertAppUser(transaction);
      const bystander = await insertAppUser(transaction);
      const { report } = await insertReportWithAttempt(transaction, {
        organizationId: organization.id,
        createdByUserId: creator.id,
        status: 'failed',
      });
      const retry = (actor: Actor) =>
        _retryReport(transaction, { organizationId: organization.id, reportId: report.id, actor });

      await expect(
        statusOf(() => retry({ userId: bystander.id, role: 'member' })),
      ).resolves.toEqual({
        status: 403,
        code: 'forbidden',
      });

      const attempts = await transaction
        .selectFrom('analysisAttempt')
        .select('attemptNumber')
        .where('reportId', '=', report.id)
        .execute();
      expect(attempts).toEqual([{ attemptNumber: 1 }]);
      expect(await reportAuditEvents(transaction, report.id)).toEqual([]);
    });
  });

  test('a report whose latest attempt is not failed is a 409', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const { report } = await insertReportWithAttempt(transaction, {
        organizationId: organization.id,
        createdByUserId: admin.id,
        status: 'succeeded',
      });
      const retry = (actor: Actor) =>
        _retryReport(transaction, { organizationId: organization.id, reportId: report.id, actor });

      await expect(statusOf(() => retry({ userId: admin.id, role: 'admin' }))).resolves.toEqual({
        status: 409,
      });
    });
  });

  test('a report already at five attempts is a 409', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const { report } = await insertReportWithAttempt(transaction, {
        organizationId: organization.id,
        createdByUserId: admin.id,
        status: 'failed',
      });
      // Every earlier attempt must itself be `failed`, or the "only after a failure" trigger
      // would refuse the next insert before we ever reach the attempt-number cap.
      for (const attemptNumber of [2, 3, 4, 5] as const) {
        await insertAnalysisAttempt(transaction, {
          reportId: report.id,
          attemptNumber,
          status: 'failed',
        });
      }
      const retry = (actor: Actor) =>
        _retryReport(transaction, { organizationId: organization.id, reportId: report.id, actor });

      await expect(statusOf(() => retry({ userId: admin.id, role: 'admin' }))).resolves.toEqual({
        status: 409,
      });
    });
  });
});
