import { describe, expect, test } from 'vitest';
import type { Problem } from './csv/describe/index.ts';
import { asUploadRejection, type RejectedUploadRecord, userFacingRejection } from './rejection.ts';

const PROBLEM: Problem = {
  rule: 'The weight has a unit in it',
  advice: 'Enter plain numbers only.',
  rows: { ranges: [{ start: 2, end: 4 }], total: 3, everyRow: false },
  examples: ['"5 oz"'],
};

const RECORD: RejectedUploadRecord = {
  reason: 'bad_rows',
  summary: 'We found problems in 4 of your 10 rows.',
  rowProblems: [PROBLEM],
  dateOrderProblem: 'Your dates are written both ways.',
  rejectionDetail: 'header dump, byte offset 42',
};

describe('userFacingRejection', () => {
  test('keeps summary, rowProblems, and dateOrderProblem', () => {
    expect(userFacingRejection(RECORD)).toEqual({
      summary: RECORD.summary,
      rowProblems: RECORD.rowProblems,
      dateOrderProblem: RECORD.dateOrderProblem,
    });
  });

  test('never lets rejectionDetail or reason survive', () => {
    const rejection = userFacingRejection(RECORD);

    expect(rejection).not.toHaveProperty('rejectionDetail');
    expect(rejection).not.toHaveProperty('reason');
  });

  test('omits rowProblems and dateOrderProblem when the record has neither', () => {
    const rejection = userFacingRejection({
      reason: 'empty',
      summary: 'Your file has no rows in it.',
    });

    expect(rejection).toEqual({ summary: 'Your file has no rows in it.' });
  });
});

describe('asUploadRejection', () => {
  test('accepts a body whose summary is a string', () => {
    const body = { summary: 'We found problems.', rowProblems: [PROBLEM] };

    expect(asUploadRejection(body)).toEqual(body);
  });

  test('rejects a body with no summary', () => {
    expect(asUploadRejection({ message: 'Not found' })).toBeUndefined();
  });

  test('rejects a non-object body', () => {
    expect(asUploadRejection('oops')).toBeUndefined();
    expect(asUploadRejection(null)).toBeUndefined();
    expect(asUploadRejection(undefined)).toBeUndefined();
  });

  test('rejects a summary that is not a string', () => {
    expect(asUploadRejection({ summary: 404 })).toBeUndefined();
  });
});
