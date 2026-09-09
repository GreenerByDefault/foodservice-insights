/** `report` and the two tables that record an upload: `input_file` for one that was accepted,
 * `rejected_upload` for one that never became a report. */

import { describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import { POSTGRES_CODE_UNIQUE_VIOLATION } from '../src/postgres-codes.ts';
import { expectConstraintViolation } from '../src/testing/constraints.ts';
import {
  aChecksum,
  insertAppUser,
  insertInputFile,
  insertOrganization,
  insertReport,
} from '../src/testing/fixtures.ts';
import { checkDeferredConstraints, withRollback } from '../src/testing/transactions.ts';

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

    await expectConstraintViolation(insert, 'report_deleted_at_after_created_at');
  });

  test.each([
    ['an array', JSON.stringify([1, 2, 3])],
    ['a bare number', JSON.stringify(42)],
    ['an empty object', JSON.stringify({})],
  ])('rejects monthly counts that are %s', async (_description, monthlyCounts) => {
    const insert = withRollback(DATABASE, async (transaction) => {
      await insertReport(transaction, { monthlyCounts });
    });

    await expectConstraintViolation(insert, 'report_monthly_counts_is_object');
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

  test('report_has_an_input_file fails with no input file attached', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      await insertReport(transaction);
      await checkDeferredConstraints(transaction);
    });

    await expectConstraintViolation(insert, 'report_has_an_input_file');
  });

  test('report_has_an_input_file passes once the input file is attached', async () => {
    await withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction);
      await insertInputFile(transaction, { reportId: report.id });

      await expect(checkDeferredConstraints(transaction)).resolves.toBeUndefined();
    });
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

    await expectConstraintViolation(
      insert,
      'input_file_report_id_key',
      POSTGRES_CODE_UNIQUE_VIOLATION,
    );
  });

  test('rejects a storage key that is already taken', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const storageKey = `org/test/${crypto.randomUUID()}.csv`;
      await insertInputFile(transaction, { storageKey });
      await insertInputFile(transaction, { storageKey });
    });

    await expectConstraintViolation(
      insert,
      'input_file_storage_key_key',
      POSTGRES_CODE_UNIQUE_VIOLATION,
    );
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

    await expectConstraintViolation(insert, 'input_file_checksum_sha256_length');
  });

  describe('workbook', () => {
    test('accepts a workbook with all three columns set', async () => {
      await withRollback(DATABASE, async (transaction) => {
        const report = await insertReport(transaction);
        const inputFile = await insertInputFile(transaction, {
          reportId: report.id,
          workbook: {},
        });

        expect(inputFile.workbookStorageKey).not.toBeNull();
        expect(inputFile.workbookByteSize).not.toBeNull();
        expect(inputFile.workbookChecksumSha256).not.toBeNull();
      });
    });

    test('rejects a workbook with only some of its three columns set', async () => {
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
            checksumSha256: aChecksum(),
            isModified: false,
            workbookStorageKey: `org/test/${crypto.randomUUID()}.xlsx`,
            // workbookByteSize and workbookChecksumSha256 left unset.
          })
          .execute();
      });

      await expectConstraintViolation(insert, 'input_file_workbook_all_or_none');
    });

    test('rejects a byte size that is not positive', async () => {
      const insert = withRollback(DATABASE, async (transaction) => {
        const report = await insertReport(transaction);
        await insertInputFile(transaction, {
          reportId: report.id,
          workbook: { byteSize: 0 },
        });
      });

      await expectConstraintViolation(insert, 'input_file_workbook_byte_size_positive');
    });

    test('rejects a checksum that is not 32 bytes', async () => {
      const insert = withRollback(DATABASE, async (transaction) => {
        const report = await insertReport(transaction);
        await insertInputFile(transaction, {
          reportId: report.id,
          workbook: { checksumSha256: Buffer.from('too short') },
        });
      });

      await expectConstraintViolation(insert, 'input_file_workbook_checksum_sha256_length');
    });

    test('rejects a storage key that is already taken', async () => {
      const insert = withRollback(DATABASE, async (transaction) => {
        const storageKey = `org/test/${crypto.randomUUID()}.xlsx`;
        await insertInputFile(transaction, { workbook: { storageKey } });
        await insertInputFile(transaction, { workbook: { storageKey } });
      });

      await expectConstraintViolation(
        insert,
        'input_file_workbook_storage_key_key',
        POSTGRES_CODE_UNIQUE_VIOLATION,
      );
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

    await expectConstraintViolation(insert, 'input_file_byte_size_positive');
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
