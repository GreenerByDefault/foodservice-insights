import { newReportId } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { parseCursor } from './pagination.ts';

describe('parseCursor', () => {
  test('no params is the newest page', () => {
    expect(parseCursor(new URLSearchParams())).toEqual({ direction: 'newest' });
  });

  test('an older cursor', () => {
    const reportId = newReportId();

    expect(parseCursor(new URLSearchParams({ older: reportId }))).toEqual({
      direction: 'older',
      cursor: reportId,
    });
  });

  test('a newer cursor', () => {
    const reportId = newReportId();

    expect(parseCursor(new URLSearchParams({ newer: reportId }))).toEqual({
      direction: 'newer',
      cursor: reportId,
    });
  });

  test('both params set prefers older', () => {
    const older = newReportId();
    const newer = newReportId();

    expect(parseCursor(new URLSearchParams({ older, newer }))).toEqual({
      direction: 'older',
      cursor: older,
    });
  });

  test('a malformed older cursor falls back to the newest page', () => {
    expect(parseCursor(new URLSearchParams({ older: 'not-a-uuid' }))).toEqual({
      direction: 'newest',
    });
  });

  test('a malformed older cursor still lets a valid newer cursor through', () => {
    const reportId = newReportId();

    expect(parseCursor(new URLSearchParams({ older: 'not-a-uuid', newer: reportId }))).toEqual({
      direction: 'newer',
      cursor: reportId,
    });
  });

  test('a malformed newer cursor falls back to the newest page', () => {
    expect(parseCursor(new URLSearchParams({ newer: 'not-a-uuid' }))).toEqual({
      direction: 'newest',
    });
  });

  test('an empty older cursor falls back to the newest page', () => {
    expect(parseCursor(new URLSearchParams({ older: '' }))).toEqual({ direction: 'newest' });
  });
});
