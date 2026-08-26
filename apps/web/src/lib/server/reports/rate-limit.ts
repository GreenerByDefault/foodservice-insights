/** Enforcing the hourly and weekly report limits.
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
import { HOURLY_REPORT_LIMIT, WEEKLY_REPORT_LIMIT } from '$lib/reports/limits';
import type { RejectedUploadRecord } from '$lib/reports/rejection';

export type RateLimitScope = 'organization' | 'user';
export type RateLimitWindow = 'hourly' | 'weekly';
export type RateLimitExceeded = { scope: RateLimitScope; window: RateLimitWindow; limit: number };

/** Whether `organizationId` or `userId` is at or over its hourly or weekly report limit, as of
 * `now`. `undefined` means neither is.
 *
 * Always locks first, so this is the only way to check the limit — there is no bare
 * `checkReportRateLimit` to call by mistake without the lock. That makes any one call, on its
 * own, race-free against every other call for the same organization or user. It does *not* make a
 * check-then-later-write race-free across two separate transactions: call this again, in the same
 * transaction as the write it's guarding, immediately before that write. See
 * `lockReportRateLimit`'s doc comment in `@gbd/db` for why.
 */
export async function lockAndCheckReportRateLimit(
  database: DatabaseExecutor,
  { organizationId, userId, now }: { organizationId: OrganizationId; userId: UserId; now: Date },
): Promise<RateLimitExceeded | undefined> {
  await lockReportRateLimit(database, { organizationId, userId });

  const hourly = await countReportsSince(database, {
    organizationId,
    userId,
    since: new Date(now.getTime() - HOUR_MS),
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
    since: new Date(now.getTime() - WEEK_MS),
  });
  if (weekly.organizationCount >= WEEKLY_REPORT_LIMIT) {
    return { scope: 'organization', window: 'weekly', limit: WEEKLY_REPORT_LIMIT };
  }
  if (weekly.userCount >= WEEKLY_REPORT_LIMIT) {
    return { scope: 'user', window: 'weekly', limit: WEEKLY_REPORT_LIMIT };
  }

  return undefined;
}

const WINDOW_PHRASE: Record<RateLimitWindow, string> = {
  hourly: 'in the past hour',
  weekly: 'in the past 7 days',
};

const SCOPE_PHRASE: Record<RateLimitScope, string> = {
  organization: 'Your organization has',
  user: "You've",
};

export function describeRateLimitExceeded(exceeded: RateLimitExceeded): RejectedUploadRecord {
  return {
    reason: 'rate_limited',
    summary: `${SCOPE_PHRASE[exceeded.scope]} created ${exceeded.limit} reports ${WINDOW_PHRASE[exceeded.window]}. Try again later.`,
    rejectionDetail: `${exceeded.scope} at the ${exceeded.window} limit of ${exceeded.limit}`,
  };
}
