import { aDatabaseError, anUnreachableDatabaseError } from '@gbd/db/testing';
import { aBlobStoreError } from '@gbd/storage/testing';
import { describe, expect, it } from 'vitest';
import { classifyAttemptFailure } from './failures.ts';

describe('classifyAttemptFailure', () => {
  it.each([
    ['an unreachable database', anUnreachableDatabaseError(), 'infrastructure', 'database'],
    ['a refused statement', aDatabaseError('duplicate key', '23505'), 'infrastructure', '23505'],
    ['a blob store failure', aBlobStoreError(), 'infrastructure', 'blob store'],
    ['an unrecognised Error', new TypeError('boom'), 'unknown', 'boom'],
    ['a thrown non-Error', 'just a string', 'unknown', 'just a string'],
  ])('maps %s', (_name, error, reason, detailFragment) => {
    const failure = classifyAttemptFailure(error);
    expect(failure.reason).toBe(reason);
    expect(failure.detail).toContain(detailFragment);
  });
});
