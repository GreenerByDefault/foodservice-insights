import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DAY_MS,
  formatTimestamp,
  formatWhen,
  HOUR_MS,
  MINUTE_MS,
  msAgo,
  SECOND_MS,
  WEEK_MS,
} from './time.ts';

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

describe('formatTimestamp', () => {
  it('formats the exact moment in UTC for a title attribute', () => {
    expect(formatTimestamp(CREATED_AT)).toBe('Jan 15, 2026, 10:00 AM UTC');
  });
});

describe('formatWhen', () => {
  it('under a minute reads as "less than a minute ago"', () => {
    expect(formatWhen(new Date(CREATED_AT.getTime() + 59_000), CREATED_AT)).toBe(
      'less than a minute ago',
    );
  });

  it('exactly one minute', () => {
    expect(formatWhen(minutesAfter(CREATED_AT, 1), CREATED_AT)).toBe('1 minute ago');
  });

  it('several minutes, rounded down', () => {
    expect(formatWhen(new Date(CREATED_AT.getTime() + 3 * 60_000 + 30_000), CREATED_AT)).toBe(
      '3 minutes ago',
    );
  });

  it('just under an hour stays in minutes', () => {
    expect(formatWhen(new Date(CREATED_AT.getTime() + 59 * MINUTE_MS), CREATED_AT)).toBe(
      '59 minutes ago',
    );
  });

  it('an hour or more switches to hours', () => {
    expect(formatWhen(new Date(CREATED_AT.getTime() + HOUR_MS), CREATED_AT)).toBe('1 hour ago');
    expect(
      formatWhen(new Date(CREATED_AT.getTime() + 5 * HOUR_MS + 30 * MINUTE_MS), CREATED_AT),
    ).toBe('5 hours ago');
  });

  it('just under a day stays in hours', () => {
    expect(formatWhen(new Date(CREATED_AT.getTime() + 23 * HOUR_MS), CREATED_AT)).toBe(
      '23 hours ago',
    );
  });

  it('a day or more switches to days', () => {
    expect(formatWhen(new Date(CREATED_AT.getTime() + DAY_MS), CREATED_AT)).toBe('yesterday');
    expect(formatWhen(new Date(CREATED_AT.getTime() + 3 * DAY_MS), CREATED_AT)).toBe('3 days ago');
  });

  it('just under a week stays relative', () => {
    expect(formatWhen(new Date(CREATED_AT.getTime() + WEEK_MS - SECOND_MS), CREATED_AT)).toBe(
      '6 days ago',
    );
  });

  it('exactly a week switches to an absolute date', () => {
    expect(formatWhen(new Date(CREATED_AT.getTime() + WEEK_MS), CREATED_AT)).toBe('Jan 15, 2026');
  });

  it('well over a week stays an absolute date, rather than an ever-growing day count', () => {
    expect(formatWhen(new Date(CREATED_AT.getTime() + 412 * DAY_MS), CREATED_AT)).toBe(
      'Jan 15, 2026',
    );
  });
});
