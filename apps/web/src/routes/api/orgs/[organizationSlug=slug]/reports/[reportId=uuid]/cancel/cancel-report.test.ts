import {
  insertAppUser,
  insertOrganization,
  insertReportWithAttempt,
  withRollback,
} from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '#lib/server/db.js';
import { auditEventsFor, expectedAuditEvent } from '#lib/server/testing/audit.js';
import { statusOf } from '#lib/server/testing/http-error.js';
import { _cancelReport } from './+server.ts';

// The 404/403 access checks are `requireReportAccess`'s own guarantee (see guards.test.ts) — these
// only check that _cancelReport wires it up: an allowed caller's cancellation goes through,
// a denied one leaves nothing written, and cancellation-specific behavior (the 409) works.
describe('_cancelReport', () => {
  test('a member can cancel a pending attempt on their own report', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const { report, attempt } = await insertReportWithAttempt(transaction, {
        organizationId: organization.id,
        createdByUserId: admin.id,
      });

      const response = await _cancelReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        actor: { userId: admin.id, role: 'member' },
      });
      expect(response.status).toBe(204);

      const updated = await transaction
        .selectFrom('analysisAttempt')
        .select(['status', 'cancelRequestedAt'])
        .where('id', '=', attempt.id)
        .executeTakeFirstOrThrow();
      expect(updated.status).toBe('pending');
      expect(updated.cancelRequestedAt).toBeInstanceOf(Date);

      expect(await auditEventsFor(transaction, report.id)).toEqual([
        expectedAuditEvent({
          action: 'report.cancel_requested',
          actorUserId: admin.id,
          target: { type: 'report', id: report.id, organizationId: organization.id },
        }),
      ]);
    });
  });

  test('an admin can cancel a processing attempt on a report they did not create', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const creator = await insertAppUser(transaction);
      const { report, attempt } = await insertReportWithAttempt(transaction, {
        organizationId: organization.id,
        createdByUserId: creator.id,
        status: 'processing',
      });

      const response = await _cancelReport(transaction, {
        organizationId: organization.id,
        reportId: report.id,
        actor: { userId: admin.id, role: 'admin' },
      });
      expect(response.status).toBe(204);

      const updated = await transaction
        .selectFrom('analysisAttempt')
        .select('cancelRequestedAt')
        .where('id', '=', attempt.id)
        .executeTakeFirstOrThrow();
      expect(updated.cancelRequestedAt).toBeInstanceOf(Date);

      // The audit trail names the admin who acted, not the creator whose report it is.
      expect(await auditEventsFor(transaction, report.id)).toEqual([
        expectedAuditEvent({
          action: 'report.cancel_requested',
          actorUserId: admin.id,
          target: { type: 'report', id: report.id, organizationId: organization.id },
        }),
      ]);
    });
  });

  test('a member who did not create the report gets a 403, and nothing is written', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const creator = await insertAppUser(transaction);
      const bystander = await insertAppUser(transaction);
      const { report, attempt } = await insertReportWithAttempt(transaction, {
        organizationId: organization.id,
        createdByUserId: creator.id,
      });

      await expect(
        statusOf(() =>
          _cancelReport(transaction, {
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
      expect(await auditEventsFor(transaction, report.id)).toEqual([]);
    });
  });

  // Every status/no-attempt permutation of "nothing active to cancel" is covered exhaustively
  // by cancelActiveAttempt's own tests (lib/server/reports/cancel.test.ts); this just checks _cancelReport's wiring
  // when that lookup comes back false.
  test('no active attempt to cancel is a 409, and no audit event is written', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const { report } = await insertReportWithAttempt(transaction, {
        organizationId: organization.id,
        createdByUserId: admin.id,
        status: 'succeeded',
      });

      await expect(
        statusOf(() =>
          _cancelReport(transaction, {
            organizationId: organization.id,
            reportId: report.id,
            actor: { userId: admin.id, role: 'admin' },
          }),
        ),
      ).resolves.toEqual({ status: 409 });
      expect(await auditEventsFor(transaction, report.id)).toEqual([]);
    });
  });
});
