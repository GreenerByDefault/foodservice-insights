import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, formatElapsed, HOUR_MS, MINUTE_MS, msAgo, SECOND_MS, WEEK_MS } from './time.ts';

const CREATED_AT = new Date('2026-01-15T10:00:00Z');

function minutesAfter(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

describe('time constants', () => {
  it('each builds from the one below it', () => {
    expect(SECOND_MS).toBe(1_000);
    expect(MINUTE_MS).toBe(60 * SECOND_MS);
    expect(HOUR_MS).toBe(60 * MINUTE_MS);
    expect(DAY_MS).toBe(24 * HOUR_MS);
    expect(WEEK_MS).toBe(7 * DAY_MS);
  });
});

describe('msAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the moment `ms` before now', () => {
    expect(msAgo(5 * MINUTE_MS)).toEqual(new Date('2026-01-15T09:55:00Z'));
  });

  it('returns now when given zero', () => {
    expect(msAgo(0)).toEqual(new Date('2026-01-15T10:00:00Z'));
  });
});

describe('formatElapsed', () => {
  it('under a minute reads as "less than a minute ago"', () => {
    expect(formatElapsed(new Date(CREATED_AT.getTime() + 59_000), CREATED_AT)).toBe(
      'less than a minute ago',
    );
  });

  it('exactly one minute', () => {
    expect(formatElapsed(minutesAfter(CREATED_AT, 1), CREATED_AT)).toBe('1 minute ago');
  });

  it('several minutes, rounded down', () => {
    expect(formatElapsed(new Date(CREATED_AT.getTime() + 3 * 60_000 + 30_000), CREATED_AT)).toBe(
      '3 minutes ago',
    );
  });
});
