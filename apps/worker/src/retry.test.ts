import { aDatabaseError, anUnreachableDatabaseError } from '@gbd/db/testing';
import { aBlobStoreError } from '@gbd/storage/testing';
import { describe, expect, it, vi } from 'vitest';
import { retryOnTransientDbError, TRANSIENT_RETRY_WAITS_MS } from './retry.ts';

function recordingSleep() {
  const waits: number[] = [];
  const sleep = (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };
  return { waits, sleep };
}

function failingThenSucceeding(failures: unknown[]) {
  let calls = 0;
  const fn = () => {
    calls++;
    const failure = failures[calls - 1];
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve('done');
  };
  return { fn, calls: () => calls };
}

describe('retryOnTransientDbError', () => {
  it('returns the result without sleeping when the first attempt succeeds', async () => {
    const { waits, sleep } = recordingSleep();
    const { fn, calls } = failingThenSucceeding([]);

    await expect(retryOnTransientDbError(fn, { action: 'test', sleep })).resolves.toBe('done');
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it('retries transient failures with the configured waits', async () => {
    const { waits, sleep } = recordingSleep();
    const { fn, calls } = failingThenSucceeding([
      anUnreachableDatabaseError(),
      anUnreachableDatabaseError(),
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(retryOnTransientDbError(fn, { action: 'test', sleep })).resolves.toBe('done');
    expect(calls()).toBe(3);
    expect(waits).toEqual([...TRANSIENT_RETRY_WAITS_MS]);
  });

  it('rethrows the last transient error once the attempts are exhausted', async () => {
    const { sleep } = recordingSleep();
    const last = anUnreachableDatabaseError('the last failure');
    const { fn, calls } = failingThenSucceeding([
      anUnreachableDatabaseError(),
      anUnreachableDatabaseError(),
      last,
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(retryOnTransientDbError(fn, { action: 'test', sleep })).rejects.toBe(last);
    expect(calls()).toBe(3);
  });

  it.each([
    ['a statement Postgres refused', aDatabaseError('bad column', '42703')],
    ['a blob store failure', aBlobStoreError()],
    ['an unrelated bug', new TypeError('undefined is not a function')],
  ])('rethrows %s immediately without retrying', async (_name, error) => {
    const { waits, sleep } = recordingSleep();
    const { fn, calls } = failingThenSucceeding([error]);

    await expect(retryOnTransientDbError(fn, { action: 'test', sleep })).rejects.toBe(error);
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });
});
