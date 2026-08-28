/** Millisecond durations, named so a call site reads as `3 * MINUTE_MS` instead of `180_000`. */

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/** The moment `ms` before now. Its own function so a call site reads as `msAgo(5 * MINUTE_MS)`
 * rather than `new Date(Date.now() - 5 * MINUTE_MS)`. */
export function msAgo(ms: number): Date {
  return new Date(Date.now() - ms);
}

const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** `now - at`, rounded to the minute — callers needing finer precision than a minute should not
 * use this. */
export function formatElapsed(now: Date, at: Date): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / MINUTE_MS);
  if (minutes < 1) return 'less than a minute ago';
  return RELATIVE_TIME_FORMAT.format(-minutes, 'minute');
}
