/** `report` and the two tables that record an upload: `input_file` for one that was accepted,
 * `rejected_upload` for one that never became a report.
 *
 * The first two tests are about the toolchain rather than the schema — that Kanel's camelCase
 * hook and Kysely's `CamelCasePlugin` still agree, and that `withRollback` leaves nothing behind.
 * They are the pairing most likely to drift silently, so they stay.
 */

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
  test('round-trips camelCase properties, enums, and jsonb', async () => {
    const inserted = await withRollback(DATABASE, async (transaction) => {
      // Every property here is camelCase while every column is snake_case. This only compiles
      // and only runs because Kanel's camelCase hook and Kysely's CamelCasePlugin agree.
      return await insertReport(transaction, {
        name: 'Q1 procurement',
        siteName: 'Main dining hall',
      });
    });

    expect(inserted).toMatchObject({
      name: 'Q1 procurement',
      siteName: 'Main dining hall',
      countsBasis: 'people',
      unitSystem: 'lb',
      monthlyCounts: { '2026-01': 120, '2026-02': 135 },
    });
    expect(inserted.createdAt).toBeInstanceOf(Date);
    expect(inserted.deletedAt).toBeNull();
  });

  test('withRollback commits nothing', async () => {
    const id = await withRollback(DATABASE, async (transaction) => {
      const { id } = await insertReport(transaction);

      // Visible inside the transaction...
      await expect(
        transaction.selectFrom('report').select('id').where('id', '=', id).executeTakeFirst(),
      ).resolves.toMatchObject({ id });

      return id;
    });

    // ...and gone once it rolls back.
    const afterRollback = await DATABASE.selectFrom('report')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    expect(afterRollback).toBeUndefined();
  });

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

    // Naming the constraint proves *this* check fired, not some other failure.
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

  // Stringified because node-postgres renders a JS array as a Postgres array literal rather than
  // as JSON, which the column would reject before the check ever runs.
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
    // REQUIREMENTS.md: deleting an account does not delete that member's reports; the app shows
    // a deleted user instead, and the raw id survives in the audit trail.
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
    // The mirrored columns are unconstrained text on purpose: a row is here precisely because
    // its input was not valid, so it has to hold values no enum or check would accept.
    const stored = await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      return await transaction
        .insertInto('rejectedUpload')
        .values({
          organizationId: organization.id,
          reportCountsBasis: 'sandwiches',
          reportUnitSystem: 'furlongs',
          // `report` requires a jsonb object here; this column takes whatever arrived.
          reportMonthlyCounts: JSON.stringify('not even an object'),
          rejectionReason: 'bad_columns',
          rejectionDetail: 'expected 3 columns, found 7',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    expect(stored).toMatchObject({
      reportCountsBasis: 'sandwiches',
      reportUnitSystem: 'furlongs',
      rejectionReason: 'bad_columns',
    });
  });
});
