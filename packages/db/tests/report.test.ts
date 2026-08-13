/** `report` and the two tables that record an upload: `input_file` for one that was accepted,
 * `rejected_upload` for one that never became a report. */

import { afterAll, describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import {
  POSTGRES_CODE_CHECK_VIOLATION,
  POSTGRES_CODE_UNIQUE_VIOLATION,
} from '../src/postgres-codes.ts';
import {
  aChecksum,
  insertAppUser,
  insertInputFile,
  insertOrganization,
  insertReport,
} from '../src/testing/fixtures.ts';
import { withRollback } from '../src/testing/transactions.ts';

afterAll(async () => {
  await DATABASE.destroy();
});

describe('report', () => {
  test('rejects a soft delete that predates creation', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction, {
        createdAt: new Date('2026-03-01T00:00:00Z'),
      });
      await transaction
        .updateTable('report')
        .set({ deletedAt: new Date('2026-02-01T00:00:00Z') })
        .where('id', '=', report.id)
        .execute();
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'report_deleted_at_after_created_at',
    });
  });

  test('rejects recording who deleted a report that is not deleted', async () => {
    const update = withRollback(DATABASE, async (transaction) => {
      const user = await insertAppUser(transaction);
      const report = await insertReport(transaction);
      await transaction
        .updateTable('report')
        .set({ deletedByUserId: user.id })
        .where('id', '=', report.id)
        .execute();
    });

    await expect(update).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'report_deleted_by_requires_deleted_at',
    });
  });

  test.each([
    ['an array', JSON.stringify([1, 2, 3])],
    ['a bare number', JSON.stringify(42)],
    ['an empty object', JSON.stringify({})],
  ])('rejects monthly counts that are %s', async (_description, monthlyCounts) => {
    const insert = withRollback(DATABASE, async (transaction) => {
      await insertReport(transaction, { monthlyCounts });
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'report_monthly_counts_is_object',
    });
  });

  test('is deleted with its organization', async () => {
    const remaining = await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await insertReport(transaction, { organizationId: organization.id });

      await transaction.deleteFrom('organization').where('id', '=', organization.id).execute();

      return await transaction
        .selectFrom('report')
        .select('id')
        .where('id', '=', report.id)
        .executeTakeFirst();
    });

    expect(remaining).toBeUndefined();
  });

  test('outlives the user who created it, forgetting only who they were', async () => {
    const report = await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const author = await insertAppUser(transaction);
      await transaction
        .insertInto('organizationMember')
        .values({ userId: author.id, organizationId: organization.id, role: 'member' })
        .execute();
      const created = await insertReport(transaction, {
        organizationId: organization.id,
        createdByUserId: author.id,
      });

      await transaction.deleteFrom('auth.users').where('id', '=', author.id).execute();

      return await transaction
        .selectFrom('report')
        .selectAll()
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
    });

    expect(report.createdByUserId).toBeNull();
  });
});

describe('input_file', () => {
  test('allows only one per report', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction);
      await insertInputFile(transaction, { reportId: report.id });
      await insertInputFile(transaction, { reportId: report.id });
    });

    await expect(insert).rejects.toMatchObject({ code: POSTGRES_CODE_UNIQUE_VIOLATION });
  });

  test('rejects a storage key that is already taken', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const storageKey = `org/test/${crypto.randomUUID()}.csv`;
      await insertInputFile(transaction, { storageKey });
      await insertInputFile(transaction, { storageKey });
    });

    await expect(insert).rejects.toMatchObject({ code: POSTGRES_CODE_UNIQUE_VIOLATION });
  });

  test('rejects a checksum that is not 32 bytes', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction);
      await transaction
        .insertInto('inputFile')
        .values({
          reportId: report.id,
          storageKey: `org/test/${crypto.randomUUID()}.csv`,
          byteSize: 1024,
          contentType: 'text/csv',
          originalFilename: 'procurement.csv',
          checksumSha256: Buffer.from('too short'),
          isModified: false,
        })
        .execute();
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'input_file_checksum_sha256_length',
    });
  });

  test('rejects an empty file', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction);
      await transaction
        .insertInto('inputFile')
        .values({
          reportId: report.id,
          storageKey: `org/test/${crypto.randomUUID()}.csv`,
          byteSize: 0,
          contentType: 'text/csv',
          originalFilename: 'procurement.csv',
          checksumSha256: aChecksum(),
          isModified: false,
        })
        .execute();
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'input_file_byte_size_positive',
    });
  });
});

describe('rejected_upload', () => {
  test('stores the metadata that got the upload rejected, however invalid', async () => {
    const stored = await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      return await transaction
        .insertInto('rejectedUpload')
        .values({
          organizationId: organization.id,
          reportCountsBasis: 'sandwiches',
          reportUnitSystem: 'furlongs',
          reportMonthlyCounts: '{oops',
          rejectionReason: 'bad_columns',
          rejectionDetail: 'expected 3 columns, found 7',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    expect(stored).toMatchObject({
      reportCountsBasis: 'sandwiches',
      reportUnitSystem: 'furlongs',
      reportMonthlyCounts: '{oops',
      rejectionReason: 'bad_columns',
    });
  });
});
