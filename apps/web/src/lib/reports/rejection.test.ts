import { describe, expect, test } from 'vitest';
import { ApiError, type JsonValue } from '$lib/api/fetch';
import type { Problem } from './csv/describe/index.ts';
import {
  parseUploadRejection,
  type RejectedUploadRecord,
  userFacingRejection,
} from './rejection.ts';

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

    expect(rejection).not.toHaveProperty('rowProblems');
    expect(rejection).not.toHaveProperty('dateOrderProblem');
  });
});

describe('parseUploadRejection', () => {
  test('accepts a 400 whose body has a string summary', () => {
    const body = { summary: 'We found problems.', rowProblems: [PROBLEM] };

    expect(
      parseUploadRejection(new ApiError(400, 'Bad Request', body as unknown as JsonValue)),
    ).toEqual(body);
  });

  test('accepts a 429 whose body has a string summary', () => {
    const body = { summary: 'You have created too many reports this hour.' };

    expect(parseUploadRejection(new ApiError(429, 'Too Many Requests', body))).toEqual(body);
  });

  test('rejects a status that is neither 400 nor 429, even with a rejection-shaped body', () => {
    const body = { summary: 'We found problems.' };

    expect(parseUploadRejection(new ApiError(500, 'Internal Server Error', body))).toBeUndefined();
  });

  test('rejects a 400 body with no summary', () => {
    expect(
      parseUploadRejection(new ApiError(400, 'Not found', { message: 'Not found' })),
    ).toBeUndefined();
  });

  test('rejects a non-object body', () => {
    expect(parseUploadRejection(new ApiError(400, 'oops', 'oops'))).toBeUndefined();
    expect(parseUploadRejection(new ApiError(400, 'oops', null))).toBeUndefined();
    expect(parseUploadRejection(new ApiError(400, 'oops', undefined))).toBeUndefined();
  });

  test('rejects an array body', () => {
    expect(parseUploadRejection(new ApiError(400, 'oops', []))).toBeUndefined();
  });

  test('rejects a summary that is not a string', () => {
    expect(parseUploadRejection(new ApiError(400, 'oops', { summary: 404 }))).toBeUndefined();
  });
});
