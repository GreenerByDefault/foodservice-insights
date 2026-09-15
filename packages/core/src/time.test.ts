import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DAY_MS,
  formatTimestamp,
  formatUntil,
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
  describe('within the last hour', () => {
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
  });

  describe('within the last day', () => {
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
  });

  describe('within the last week', () => {
    it('a day or more switches to days', () => {
      expect(formatWhen(new Date(CREATED_AT.getTime() + DAY_MS), CREATED_AT)).toBe('yesterday');
      expect(formatWhen(new Date(CREATED_AT.getTime() + 3 * DAY_MS), CREATED_AT)).toBe(
        '3 days ago',
      );
    });

    it('just under a week stays relative', () => {
      expect(formatWhen(new Date(CREATED_AT.getTime() + WEEK_MS - SECOND_MS), CREATED_AT)).toBe(
        '6 days ago',
      );
    });
  });

  describe('a week or more', () => {
    it('exactly a week switches to an absolute date', () => {
      expect(formatWhen(new Date(CREATED_AT.getTime() + WEEK_MS), CREATED_AT)).toBe('Jan 15, 2026');
    });

    it('well over a week stays an absolute date, rather than an ever-growing day count', () => {
      expect(formatWhen(new Date(CREATED_AT.getTime() + 412 * DAY_MS), CREATED_AT)).toBe(
        'Jan 15, 2026',
      );
    });
  });
});

describe('formatUntil', () => {
  describe('within the next hour', () => {
    it('under a minute reads as "less than a minute from now"', () => {
      expect(formatUntil(CREATED_AT, new Date(CREATED_AT.getTime() + 59_000))).toBe(
        'less than a minute from now',
      );
    });

    it('exactly one minute', () => {
      expect(formatUntil(CREATED_AT, minutesAfter(CREATED_AT, 1))).toBe('in 1 minute');
    });

    it('several minutes, rounded down', () => {
      expect(formatUntil(CREATED_AT, new Date(CREATED_AT.getTime() + 3 * 60_000 + 30_000))).toBe(
        'in 3 minutes',
      );
    });

    it('just under an hour stays in minutes', () => {
      expect(formatUntil(CREATED_AT, new Date(CREATED_AT.getTime() + 59 * MINUTE_MS))).toBe(
        'in 59 minutes',
      );
    });
  });

  describe('within the next day', () => {
    it('an hour or more switches to hours', () => {
      expect(formatUntil(CREATED_AT, new Date(CREATED_AT.getTime() + HOUR_MS))).toBe('in 1 hour');
      expect(
        formatUntil(CREATED_AT, new Date(CREATED_AT.getTime() + 5 * HOUR_MS + 30 * MINUTE_MS)),
      ).toBe('in 5 hours');
    });

    it('just under a day stays in hours', () => {
      expect(formatUntil(CREATED_AT, new Date(CREATED_AT.getTime() + 23 * HOUR_MS))).toBe(
        'in 23 hours',
      );
    });
  });

  describe('within the next week', () => {
    it('a day or more switches to days', () => {
      expect(formatUntil(CREATED_AT, new Date(CREATED_AT.getTime() + DAY_MS))).toBe('tomorrow');
      expect(formatUntil(CREATED_AT, new Date(CREATED_AT.getTime() + 3 * DAY_MS))).toBe(
        'in 3 days',
      );
    });

    it('just under a week stays relative', () => {
      expect(formatUntil(CREATED_AT, new Date(CREATED_AT.getTime() + WEEK_MS - SECOND_MS))).toBe(
        'in 6 days',
      );
    });
  });

  describe('a week or more', () => {
    it('exactly a week switches to an absolute date', () => {
      expect(formatUntil(CREATED_AT, new Date(CREATED_AT.getTime() + WEEK_MS))).toBe(
        'Jan 22, 2026',
      );
    });

    it('well over a week stays an absolute date, rather than an ever-growing day count', () => {
      expect(formatUntil(CREATED_AT, new Date(CREATED_AT.getTime() + 412 * DAY_MS))).toBe(
        'Mar 3, 2027',
      );
    });

    it('the invite lifetime (14 days) is an absolute date, not "in 14 days"', () => {
      expect(formatUntil(CREATED_AT, new Date(CREATED_AT.getTime() + 14 * DAY_MS))).toBe(
        'Jan 29, 2026',
      );
    });
  });

  it('is the mirror image of formatWhen: swapping now/at round-trips the magnitude', () => {
    const at = new Date(CREATED_AT.getTime() + 3 * DAY_MS);
    expect(formatUntil(CREATED_AT, at)).toBe('in 3 days');
    expect(formatWhen(at, CREATED_AT)).toBe('3 days ago');
  });
});
