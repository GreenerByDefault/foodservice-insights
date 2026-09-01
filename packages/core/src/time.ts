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

/** `now - at`, in the coarsest unit (minutes, hours, or days) that keeps the count small —
 * "3 days ago" instead of "4,320 minutes ago".
 *
 * Stops at days rather than escalating further to weeks or months: `Intl.RelativeTimeFormat`
 * rounds those to an approximate bucket ("a month ago" could be 27 days or 44), which is less
 * precise than the day count it would replace.
 *
 * Callers needing finer precision than a minute should not use this. */
export function formatElapsed(now: Date, at: Date): string {
  const ms = now.getTime() - at.getTime();
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return RELATIVE_TIME_FORMAT.format(-minutes, 'minute');
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 24) return RELATIVE_TIME_FORMAT.format(-hours, 'hour');
  const days = Math.floor(ms / DAY_MS);
  return RELATIVE_TIME_FORMAT.format(-days, 'day');
}

/** Fixed to UTC, and stated as such, so the formatted value is the same no matter which time
 * zone the code that calls it happens to be running in. */
const TIMESTAMP_FORMAT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

/** The exact moment, spelled out in full. */
export function formatTimestamp(at: Date): string {
  return TIMESTAMP_FORMAT.format(at);
}

/** Fixed to UTC, matching `TIMESTAMP_FORMAT` but without the time — the date alone is what a
 * report older than a week is identified by. */
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** `formatElapsed` under a week old; an absolute date beyond that, since `Intl.RelativeTimeFormat`
 * has no precise notion of weeks or months and "412 days ago" is not useful. */
export function formatWhen(now: Date, at: Date): string {
  const ms = now.getTime() - at.getTime();
  if (ms < WEEK_MS) return formatElapsed(now, at);
  return DATE_FORMAT.format(at);
}
