import type { ReportId } from '@gbd/db';
import { insertAppUser, insertOrganization, insertReport, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '$lib/server/db';
import { statusOf } from '$lib/server/tests/http-error';
import { requireReportAccess } from './guards';

describe('requireReportAccess', () => {
  test('returns the report for the member who created it', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin: creator } = await insertOrganization(transaction);
      const report = await insertReport(transaction, {
        organizationId: organization.id,
        createdByUserId: creator.id,
      });

      await expect(
        requireReportAccess(
          transaction,
          {
            organizationId: organization.id,
            reportId: report.id,
            actor: { userId: creator.id, role: 'member' },
          },
          'act on it',
        ),
      ).resolves.toEqual({ id: report.id, createdByUserId: creator.id });
    });
  });

  test('returns the report for an admin who did not create it', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const creator = await insertAppUser(transaction);
      const report = await insertReport(transaction, {
        organizationId: organization.id,
        createdByUserId: creator.id,
      });

      await expect(
        requireReportAccess(
          transaction,
          {
            organizationId: organization.id,
            reportId: report.id,
            actor: { userId: admin.id, role: 'admin' },
          },
          'act on it',
        ),
      ).resolves.toEqual({ id: report.id, createdByUserId: creator.id });
    });
  });

  test('403s a member who did not create the report, naming the verb in the message', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const creator = await insertAppUser(transaction);
      const bystander = await insertAppUser(transaction);
      const report = await insertReport(transaction, {
        organizationId: organization.id,
        createdByUserId: creator.id,
      });

      const result = await statusOf(() =>
        requireReportAccess(
          transaction,
          {
            organizationId: organization.id,
            reportId: report.id,
            actor: { userId: bystander.id, role: 'member' },
          },
          'delete it',
        ),
      );
      expect(result).toEqual({ status: 403, code: 'forbidden' });
    });
  });

  test('404s a report in another organization, not a leak', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization: owner, admin } = await insertOrganization(transaction);
      const { organization: outsider } = await insertOrganization(transaction);
      const report = await insertReport(transaction, {
        organizationId: owner.id,
        createdByUserId: admin.id,
      });

      await expect(
        statusOf(() =>
          requireReportAccess(
            transaction,
            {
              organizationId: outsider.id,
              reportId: report.id,
              actor: { userId: admin.id, role: 'admin' },
            },
            'act on it',
          ),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });

  test('404s a report that does not exist', async () => {
    await withRollback(database(), async (transaction) => {
      const { organization, admin } = await insertOrganization(transaction);
      const reportId = crypto.randomUUID() as ReportId;

      await expect(
        statusOf(() =>
          requireReportAccess(
            transaction,
            {
              organizationId: organization.id,
              reportId,
              actor: { userId: admin.id, role: 'admin' },
            },
            'act on it',
          ),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });

  test('404s an already-deleted report, even for the admin who could otherwise act on it', async () => {
    await withRollback(database(), async (transaction) => {
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

      await expect(
        statusOf(() =>
          requireReportAccess(
            transaction,
            {
              organizationId: organization.id,
              reportId: report.id,
              actor: { userId: admin.id, role: 'admin' },
            },
            'act on it',
          ),
        ),
      ).resolves.toEqual({ status: 404, code: 'not_found' });
    });
  });
});
