import { describe, expect, test } from 'vitest';
import { lockRetryDelayMs, MIGRATE_ATTEMPTS, MIGRATE_RETRY_DELAY_MS } from './migrate.ts';
import {
  POSTGRES_CODE_LOCK_NOT_AVAILABLE,
  POSTGRES_CODE_QUERY_CANCELED,
} from './postgres-codes.ts';
import { aDatabaseError, anUnreachableDatabaseError } from './testing/errors.ts';

describe('lockRetryDelayMs', () => {
  const lockTimeout = aDatabaseError(
    'canceling statement due to lock timeout',
    POSTGRES_CODE_LOCK_NOT_AVAILABLE,
  );

  test('a lock timeout is retried until the last attempt', () => {
    const delays = Array.from({ length: MIGRATE_ATTEMPTS }, (_, i) =>
      lockRetryDelayMs(lockTimeout, i + 1),
    );
    expect(delays).toEqual([
      ...Array<number>(MIGRATE_ATTEMPTS - 1).fill(MIGRATE_RETRY_DELAY_MS),
      undefined,
    ]);
  });

  test.each([
    ['a statement timeout', aDatabaseError('canceling statement', POSTGRES_CODE_QUERY_CANCELED)],
    ['a broken migration', aDatabaseError('syntax error', '42601')],
    ['an unreachable database', anUnreachableDatabaseError()],
  ])('%s is not retried', (_, error) => {
    expect(lockRetryDelayMs(error, 1)).toBeUndefined();
  });
});
