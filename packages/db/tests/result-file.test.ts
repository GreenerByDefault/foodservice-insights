/** The pdf and xlsx a succeeded analysis attempt produces. */

import { describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import type { AnalysisAttempt } from '../src/generated/public/AnalysisAttempt.ts';
import type { Report } from '../src/generated/public/Report.ts';
import { POSTGRES_CODE_UNIQUE_VIOLATION } from '../src/postgres-codes.ts';
import { expectConstraintViolation } from '../src/testing/constraints.ts';
import {
  aChecksum,
  insertAnalysisAttempt,
  insertInputFile,
  insertReport,
} from '../src/testing/fixtures.ts';
import { checkDeferredConstraints, withRollback } from '../src/testing/transactions.ts';

type Transaction = Parameters<Parameters<typeof withRollback>[1]>[0];

describe('result_file', () => {
  async function aResultFile(
    transaction: Transaction,
    attemptId: AnalysisAttempt['id'],
    kind: 'pdf' | 'xlsx',
  ) {
    return await transaction
      .insertInto('resultFile')
      .values({
        analysisAttemptId: attemptId,
        kind,
        storageKey: `org/test/${crypto.randomUUID()}.${kind}`,
        byteSize: 2048,
        contentType: 'application/octet-stream',
        checksumSha256: aChecksum(),
      })
      .execute();
  }

  async function aSucceededAttempt(transaction: Transaction, reportId?: Report['id']) {
    return await insertAnalysisAttempt(transaction, { reportId, status: 'succeeded' });
  }

  test('rejects an empty file', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const attempt = await aSucceededAttempt(transaction);
      await transaction
        .insertInto('resultFile')
        .values({
          analysisAttemptId: attempt.id,
          kind: 'pdf',
          storageKey: `org/test/${crypto.randomUUID()}.pdf`,
          byteSize: 0,
          contentType: 'application/pdf',
          checksumSha256: aChecksum(),
        })
        .execute();
    });

    await expectConstraintViolation(insert, 'result_file_byte_size_positive');
  });

  test.each(['pdf' as const, 'xlsx' as const])('allows only one %s per attempt', async (kind) => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const attempt = await aSucceededAttempt(transaction);
      await aResultFile(transaction, attempt.id, kind);
      await aResultFile(transaction, attempt.id, kind);
    });

    await expectConstraintViolation(
      insert,
      `result_file_one_${kind}_per_attempt`,
      POSTGRES_CODE_UNIQUE_VIOLATION,
    );
  });

  test('is deleted with the attempt that produced it', async () => {
    const remaining = await withRollback(DATABASE, async (transaction) => {
      const attempt = await aSucceededAttempt(transaction);
      await aResultFile(transaction, attempt.id, 'pdf');

      await transaction.deleteFrom('analysisAttempt').where('id', '=', attempt.id).execute();

      return await transaction
        .selectFrom('resultFile')
        .select('id')
        .where('analysisAttemptId', '=', attempt.id)
        .execute();
    });

    expect(remaining).toEqual([]);
  });

  describe('a succeeded attempt has a pdf and an xlsx', () => {
    // checkDeferredConstraints also re-checks report_has_an_input_file, since insertReport
    // (which insertAnalysisAttempt falls back on) doesn't attach one — so every test below needs
    // its own report with an input file, not the bare one insertAnalysisAttempt would create.
    async function aReportId(transaction: Transaction): Promise<Report['id']> {
      const report = await insertReport(transaction);
      await insertInputFile(transaction, { reportId: report.id });
      return report.id;
    }

    test('rejects succeeding with neither', async () => {
      const insert = withRollback(DATABASE, async (transaction) => {
        await aSucceededAttempt(transaction, await aReportId(transaction));
        await checkDeferredConstraints(transaction);
      });

      await expectConstraintViolation(insert, 'analysis_attempt_succeeded_has_pdf');
    });

    test('rejects succeeding with a pdf but no xlsx', async () => {
      const insert = withRollback(DATABASE, async (transaction) => {
        const attempt = await aSucceededAttempt(transaction, await aReportId(transaction));
        await aResultFile(transaction, attempt.id, 'pdf');
        await checkDeferredConstraints(transaction);
      });

      await expectConstraintViolation(insert, 'analysis_attempt_succeeded_has_xlsx');
    });

    test('rejects succeeding with an xlsx but no pdf', async () => {
      const insert = withRollback(DATABASE, async (transaction) => {
        const attempt = await aSucceededAttempt(transaction, await aReportId(transaction));
        await aResultFile(transaction, attempt.id, 'xlsx');
        await checkDeferredConstraints(transaction);
      });

      await expectConstraintViolation(insert, 'analysis_attempt_succeeded_has_pdf');
    });

    test('passes once both are attached', async () => {
      await withRollback(DATABASE, async (transaction) => {
        const attempt = await aSucceededAttempt(transaction, await aReportId(transaction));
        await aResultFile(transaction, attempt.id, 'pdf');
        await aResultFile(transaction, attempt.id, 'xlsx');

        await expect(checkDeferredConstraints(transaction)).resolves.toBeUndefined();
      });
    });

    test('does not require a pdf or xlsx while pending', async () => {
      await withRollback(DATABASE, async (transaction) => {
        await insertAnalysisAttempt(transaction, { reportId: await aReportId(transaction) });

        await expect(checkDeferredConstraints(transaction)).resolves.toBeUndefined();
      });
    });

    test('is not retroactively required once the attempt is deleted', async () => {
      await withRollback(DATABASE, async (transaction) => {
        const attempt = await aSucceededAttempt(transaction, await aReportId(transaction));
        await transaction.deleteFrom('analysisAttempt').where('id', '=', attempt.id).execute();

        await expect(checkDeferredConstraints(transaction)).resolves.toBeUndefined();
      });
    });

    test('is enforced on an UPDATE to succeeded, not just an INSERT', async () => {
      // The tests above insert directly as 'succeeded'; this pins down that the trigger fires
      // AFTER UPDATE too, since the real worker path (markAttemptSucceeded) reaches 'succeeded'
      // by updating a 'processing' row.
      const insert = withRollback(DATABASE, async (transaction) => {
        const attempt = await insertAnalysisAttempt(transaction, {
          reportId: await aReportId(transaction),
          status: 'processing',
        });
        await transaction
          .updateTable('analysisAttempt')
          .set({ status: 'succeeded', finishedAt: new Date() })
          .where('id', '=', attempt.id)
          .execute();
        await checkDeferredConstraints(transaction);
      });

      await expectConstraintViolation(insert, 'analysis_attempt_succeeded_has_pdf');
    });
  });
});
