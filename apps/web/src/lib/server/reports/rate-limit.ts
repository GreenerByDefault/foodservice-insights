/** Enforcing the hourly and weekly report limits, and reading them for display.
 *
 * `@gbd/db`'s `lockReportRateLimit` and `countReportsSince` do the work of making the
 * count-then-insert this needs race-free; see that module's doc comment for why.
 */

import { HOUR_MS, WEEK_MS } from '@gbd/core';
import {
  countReportsSince,
  type DatabaseExecutor,
  lockReportRateLimit,
  type OrganizationId,
  type UserId,
} from '@gbd/db';
import { env } from '$env/dynamic/private';
import { HOURLY_REPORT_LIMIT, WEEKLY_REPORT_LIMIT } from '$lib/reports/limits';
import type { RejectedUploadRecord } from '$lib/reports/rejection';

export type RateLimitScope = 'organization' | 'user';
export type RateLimitWindow = 'hourly' | 'weekly';
export type RateLimitExceeded = { scope: RateLimitScope; window: RateLimitWindow; limit: number };

/** Whether `organizationId` or `userId` is at or over its hourly or weekly report limit, from an
 * unlocked read. `undefined` means neither is.
 *
 * A snapshot, not a decision: nothing here is serialized against a concurrent insert, so two
 * callers can each see "under the limit" a moment before both cross it. Fine for an advisory
 * display; never fine for deciding whether to accept an upload — that's `lockAndCheckReportRateLimit`.
 */
export async function checkReportRateLimit(
  database: DatabaseExecutor,
  { organizationId, userId }: { organizationId: OrganizationId; userId: UserId },
): Promise<RateLimitExceeded | undefined> {
  if (env.REPORT_RATE_LIMIT === 'off') return undefined;

  const hourly = await countReportsSince(database, {
    organizationId,
    userId,
    windowSeconds: HOUR_MS / 1000,
  });
  if (hourly.organizationCount >= HOURLY_REPORT_LIMIT) {
    return { scope: 'organization', window: 'hourly', limit: HOURLY_REPORT_LIMIT };
  }
  if (hourly.userCount >= HOURLY_REPORT_LIMIT) {
    return { scope: 'user', window: 'hourly', limit: HOURLY_REPORT_LIMIT };
  }

  const weekly = await countReportsSince(database, {
    organizationId,
    userId,
    windowSeconds: WEEK_MS / 1000,
  });
  if (weekly.organizationCount >= WEEKLY_REPORT_LIMIT) {
    return { scope: 'organization', window: 'weekly', limit: WEEKLY_REPORT_LIMIT };
  }
  if (weekly.userCount >= WEEKLY_REPORT_LIMIT) {
    return { scope: 'user', window: 'weekly', limit: WEEKLY_REPORT_LIMIT };
  }

  return undefined;
}

/** Like `checkReportRateLimit`, but locked first — the only way to check the limit that's safe to
 * act on, since there's no bare `checkReportRateLimit` call that also takes the lock. That makes
 * any one call, on its own, race-free against every other call for the same organization or user.
 * It does *not* make a check-then-later-write race-free across two separate transactions: call
 * this again, in the same transaction as the write it's guarding, immediately before that write.
 * See `lockReportRateLimit`'s doc comment in `@gbd/db` for why.
 */
export async function lockAndCheckReportRateLimit(
  database: DatabaseExecutor,
  { organizationId, userId }: { organizationId: OrganizationId; userId: UserId },
): Promise<RateLimitExceeded | undefined> {
  await lockReportRateLimit(database, { organizationId, userId });
  return checkReportRateLimit(database, { organizationId, userId });
}

const WINDOW_PHRASE: Record<RateLimitWindow, string> = {
  hourly: 'per hour',
  weekly: 'per week',
};

const RETRY_PHRASE: Record<RateLimitWindow, string> = {
  hourly: 'Try again in a little while.',
  weekly: 'Try again next week.',
};

const SCOPE_PHRASE: Record<RateLimitScope, string> = {
  organization: 'Your organization has reached its',
  user: "You've reached your",
};

export function describeRateLimitExceeded(exceeded: RateLimitExceeded): RejectedUploadRecord {
  return {
    reason: 'rate_limited',
    summary: `${SCOPE_PHRASE[exceeded.scope]} limit of ${exceeded.limit} reports ${WINDOW_PHRASE[exceeded.window]}. ${RETRY_PHRASE[exceeded.window]}`,
    rejectionDetail: `${exceeded.scope} at the ${exceeded.window} limit of ${exceeded.limit}`,
  };
}
