import { describe, expect, test } from 'vitest';
import { ApiError, ApiUnreachableError } from '$lib/api/fetch';
import { classifyMemberWriteFailure, classifyNameWriteFailure } from './failure.ts';

describe('classifyNameWriteFailure', () => {
  test('a 409 is a name collision', () => {
    expect(classifyNameWriteFailure(new ApiError(409, 'Taken', undefined))).toEqual({
      kind: 'name-taken',
    });
  });

  test('a non-409 ApiError is unknown', () => {
    expect(classifyNameWriteFailure(new ApiError(400, 'Invalid', undefined))).toEqual({
      kind: 'unknown',
    });
  });

  test('an unreachable server is unknown', () => {
    expect(
      classifyNameWriteFailure(new ApiUnreachableError(new TypeError('Failed to fetch'))),
    ).toEqual({
      kind: 'unknown',
    });
  });

  test('rethrows anything else', () => {
    const error = new Error('boom');
    expect(() => classifyNameWriteFailure(error)).toThrow(error);
  });
});

describe('classifyMemberWriteFailure', () => {
  test('a 409 is the last-admin block', () => {
    expect(classifyMemberWriteFailure(new ApiError(409, 'Only admin', undefined))).toEqual({
      kind: 'last-admin',
    });
  });

  test('a non-409 ApiError is unknown', () => {
    expect(classifyMemberWriteFailure(new ApiError(400, 'Invalid', undefined))).toEqual({
      kind: 'unknown',
    });
  });

  test('an unreachable server is unknown', () => {
    expect(
      classifyMemberWriteFailure(new ApiUnreachableError(new TypeError('Failed to fetch'))),
    ).toEqual({
      kind: 'unknown',
    });
  });

  test('rethrows anything else', () => {
    const error = new Error('boom');
    expect(() => classifyMemberWriteFailure(error)).toThrow(error);
  });
});
