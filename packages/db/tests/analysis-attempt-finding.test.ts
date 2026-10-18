/** The findings a succeeded attempt's customer sees, stored with the attempt. */

import { describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import { POSTGRES_CODE_UNIQUE_VIOLATION } from '../src/postgres-codes.ts';
import { expectConstraintViolation } from '../src/testing/constraints.ts';
import {
  insertAnalysisAttempt,
  insertAnalysisAttemptFinding,
  insertOrganization,
  insertReport,
} from '../src/testing/fixtures/index.ts';
import { withRollback } from '../src/testing/transactions.ts';

describe('analysis_attempt_finding', () => {
  test('accepts both a warning and an error status', async () => {
    const statuses = await withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'succeeded' });
      const warning = await insertAnalysisAttemptFinding(transaction, attempt.id, { position: 0 });
      const error = await insertAnalysisAttemptFinding(transaction, attempt.id, {
        position: 1,
        status: 'error',
      });
      return [warning.status, error.status];
    });

    expect(statuses).toEqual(['warning', 'error']);
  });

  test('accepts a finding with no sample values, and one with 5', async () => {
    const sizes = await withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'succeeded' });
      const none = await insertAnalysisAttemptFinding(transaction, attempt.id, {
        position: 0,
        sampleValues: [],
      });
      const five = await insertAnalysisAttemptFinding(transaction, attempt.id, {
        position: 1,
        sampleValues: ['a', 'b', 'c', 'd', 'e'],
      });
      return [none.sampleValues.length, five.sampleValues.length];
    });

    expect(sizes).toEqual([0, 5]);
  });

  test.each(['success' as const, 'info' as const])('rejects a status of %s', async (status) => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'succeeded' });
      await insertAnalysisAttemptFinding(transaction, attempt.id, { status });
    });

    await expectConstraintViolation(insert, 'analysis_attempt_finding_status_is_warning_or_error');
  });

  test('rejects an empty message', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'succeeded' });
      await insertAnalysisAttemptFinding(transaction, attempt.id, { message: '' });
    });

    await expectConstraintViolation(insert, 'analysis_attempt_finding_message_not_empty');
  });

  test('rejects 6 sample values', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'succeeded' });
      await insertAnalysisAttemptFinding(transaction, attempt.id, {
        sampleValues: ['a', 'b', 'c', 'd', 'e', 'f'],
      });
    });

    await expectConstraintViolation(insert, 'analysis_attempt_finding_sample_values_at_most_5');
  });

  test('rejects a negative position', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'succeeded' });
      await insertAnalysisAttemptFinding(transaction, attempt.id, { position: -1 });
    });

    await expectConstraintViolation(insert, 'analysis_attempt_finding_position_non_negative');
  });

  test('rejects two findings at the same position in one attempt', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'succeeded' });
      await insertAnalysisAttemptFinding(transaction, attempt.id, { position: 0 });
      await insertAnalysisAttemptFinding(transaction, attempt.id, { position: 0 });
    });

    await expectConstraintViolation(
      insert,
      'analysis_attempt_finding_pkey',
      POSTGRES_CODE_UNIQUE_VIOLATION,
    );
  });

  test("is deleted when its report's organization is deleted", async () => {
    const remaining = await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const report = await insertReport(transaction, { organizationId: organization.id });
      const attempt = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'succeeded',
      });
      await insertAnalysisAttemptFinding(transaction, attempt.id);

      await transaction.deleteFrom('organization').where('id', '=', organization.id).execute();

      return await transaction
        .selectFrom('analysisAttemptFinding')
        .where('analysisAttemptId', '=', attempt.id)
        .selectAll()
        .execute();
    });

    expect(remaining).toEqual([]);
  });
});
