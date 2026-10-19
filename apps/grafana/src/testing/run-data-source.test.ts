import { describe, expect, test } from 'vitest';
import { isStaleRunDataSource, newRunDataSourceUid } from './run-data-source.ts';

const HOUR_MS = 60 * 60 * 1000;

describe('isStaleRunDataSource', () => {
  const createdAt = Date.UTC(2026, 9, 19);
  const uid = newRunDataSourceUid(createdAt);

  test('a run data source is stale after two hours', () => {
    expect(isStaleRunDataSource(uid, createdAt + 2 * HOUR_MS)).toBe(false);
    expect(isStaleRunDataSource(uid, createdAt + 2 * HOUR_MS + 1)).toBe(true);
  });

  test('any other data source is never stale', () => {
    const now = createdAt + 100 * HOUR_MS;
    expect(isStaleRunDataSource('metrics', now)).toBe(false);
    expect(isStaleRunDataSource(`${uid}-copy`, now)).toBe(false);
  });
});
