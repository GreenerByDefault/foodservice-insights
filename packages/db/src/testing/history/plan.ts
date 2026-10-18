/** Several months of organizations, users, reports and attempts, planned without a database, so a
 * dashboard has a shape to draw before production has one.
 *
 * Every time is an offset into the past from Postgres's `now()` at insertion, so the same seed
 * always plans the same history, shifted to end today. The history goes into the dev database, so
 * nothing in it is a row a dev worker would act on:
 * - only settled attempts, since the worker claims a `pending` one and reaps a `processing` one;
 * - every succeeded or failed attempt already notified, since the notification sweep emails any
 *   that are not.
 *
 * A metric that reads rows this does not plan yet adds them here, or its panel draws nothing.
 */

import type AnalysisFailureReason from '../../generated/public/AnalysisFailureReason.ts';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How far back the history starts. */
export const SYNTHETIC_HISTORY_SPAN_MS = 26 * 7 * DAY_MS;

/** The seed `insertSyntheticHistory` plans with. */
export const SYNTHETIC_HISTORY_SEED = 1;

/** No report is newer than this, so every attempt, retries included, has settled before `now()`. */
const NEWEST_REPORT_MS_AGO = DAY_MS;

/** The latest a retry may be created, leaving room for it to run and settle before `now()`. */
const NEWEST_RETRY_MS_AGO = HOUR_MS;

const MAX_ATTEMPTS = 5;

const ORGANIZATION_NAMES = [
  'Riverside Dining',
  'Northgate Campus Kitchens',
  'Harbor Health Cafeterias',
  'Summit School Meals',
  'Lakeshore Corporate Eats',
  'Valley Senior Living',
];

// A `Record` rather than a list, so a reason added to the enum fails the typecheck until it is
// planned too.
const FAILURE_REASONS = Object.keys({
  child_crashed: null,
  hung: null,
  hard_timeout: null,
  infrastructure: null,
  contract_violation: null,
  upstream_api: null,
  abandoned: null,
  unknown: null,
  shut_down: null,
  unusable_data: null,
} satisfies Record<AnalysisFailureReason, null>) as AnalysisFailureReason[];

export type PlannedUser = { createdMsAgo: number; emailConfirmedMsAgo: number | null };

type Run = { createdMsAgo: number; claimedMsAgo: number; finishedMsAgo: number };

export type PlannedAttempt =
  | ({ status: 'succeeded'; notifiedMsAgo: number } & Run)
  | ({ status: 'failed'; failureReason: AnalysisFailureReason; notifiedMsAgo: number } & Run)
  /** Canceled while still `pending`, so never claimed. */
  | { status: 'canceled'; createdMsAgo: number; finishedMsAgo: number };

/** Created by the organization's admin. `attempts` is in order, the last one settling the report. */
export type PlannedReport = { createdMsAgo: number; attempts: PlannedAttempt[] };

export type PlannedOrganization = {
  name: string;
  createdMsAgo: number;
  admin: PlannedUser;
  members: PlannedUser[];
  reports: PlannedReport[];
};

export type SyntheticHistoryPlan = {
  organizations: PlannedOrganization[];
  /** Requested a sign-in code and never entered it, so `auth.users` has a row but no confirmation. */
  unconfirmedUsers: PlannedUser[];
};

export function planSyntheticHistory(seed: number): SyntheticHistoryPlan {
  const random = seededRandom(seed);
  let failures = 0;

  function planAttempt(createdMsAgo: number): PlannedAttempt {
    const outcome = random.next();
    if (outcome >= 0.94) {
      return {
        status: 'canceled',
        createdMsAgo,
        finishedMsAgo: createdMsAgo - random.between(10_000, 5 * MINUTE_MS),
      };
    }
    // Now and then a backlog, so the queue time has a tail.
    const queueMs = random.chance(0.05)
      ? random.between(10 * MINUTE_MS, 30 * MINUTE_MS)
      : random.between(2_000, 2 * MINUTE_MS);
    const claimedMsAgo = createdMsAgo - queueMs;
    const finishedMsAgo = claimedMsAgo - random.between(MINUTE_MS, 15 * MINUTE_MS);
    const notifiedMsAgo = finishedMsAgo - random.between(1_000, 30_000);
    const run = { createdMsAgo, claimedMsAgo, finishedMsAgo, notifiedMsAgo };
    if (outcome < 0.82) return { status: 'succeeded', ...run };
    // In turn rather than at random, so every reason occurs once there are enough failures.
    const failureReason = FAILURE_REASONS[
      failures++ % FAILURE_REASONS.length
    ] as AnalysisFailureReason;
    return { status: 'failed', failureReason, ...run };
  }

  /** A failure is retried, by hand, about half the time, until an attempt settles the report. */
  function planAttempts(reportCreatedMsAgo: number): PlannedAttempt[] {
    const attempts = [planAttempt(reportCreatedMsAgo)];
    for (;;) {
      const last = attempts[attempts.length - 1] as PlannedAttempt;
      if (last.status !== 'failed' || attempts.length === MAX_ATTEMPTS || !random.chance(0.5)) {
        return attempts;
      }
      const retryMsAgo = last.finishedMsAgo - random.between(10 * MINUTE_MS, 6 * HOUR_MS);
      if (retryMsAgo < NEWEST_RETRY_MS_AGO) return attempts;
      attempts.push(planAttempt(retryMsAgo));
    }
  }

  /** Arrivals at a steady rate per organization, so the total grows as organizations join. */
  function planReports(organizationCreatedMsAgo: number): PlannedReport[] {
    const reports: PlannedReport[] = [];
    let createdMsAgo = organizationCreatedMsAgo - random.between(HOUR_MS, 3 * DAY_MS);
    while (createdMsAgo > NEWEST_REPORT_MS_AGO) {
      reports.push({ createdMsAgo, attempts: planAttempts(createdMsAgo) });
      createdMsAgo -= random.exponential(4 * DAY_MS);
    }
    return reports;
  }

  function planConfirmedUser(createdMsAgo: number): PlannedUser & { emailConfirmedMsAgo: number } {
    return {
      createdMsAgo,
      emailConfirmedMsAgo: createdMsAgo - random.between(30_000, 10 * MINUTE_MS),
    };
  }

  // Joining over the first 60% of the span, so the earliest weeks are sparse and the last ones full.
  const organizations = ORGANIZATION_NAMES.map((name, index): PlannedOrganization => {
    const joinedMsAgo = Math.floor(
      SYNTHETIC_HISTORY_SPAN_MS -
        DAY_MS -
        (index / ORGANIZATION_NAMES.length) * 0.6 * SYNTHETIC_HISTORY_SPAN_MS,
    );
    const admin = planConfirmedUser(joinedMsAgo);
    const createdMsAgo = admin.emailConfirmedMsAgo - random.between(MINUTE_MS, 30 * MINUTE_MS);
    const members = Array.from({ length: random.between(0, 4) }, () =>
      planConfirmedUser(random.between(NEWEST_REPORT_MS_AGO, createdMsAgo)),
    );
    return { name, createdMsAgo, admin, members, reports: planReports(createdMsAgo) };
  });

  const unconfirmedUsers = Array.from({ length: 12 }, () => ({
    createdMsAgo: random.between(NEWEST_REPORT_MS_AGO, SYNTHETIC_HISTORY_SPAN_MS),
    emailConfirmedMsAgo: null,
  }));

  return { organizations, unconfirmedUsers };
}

/** Mulberry32: tiny, and good enough to make a history look unplanned. Offsets are whole
 * milliseconds, so they survive the trip through Postgres's microsecond timestamps exactly. */
function seededRandom(seed: number) {
  let state = seed >>> 0;
  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  }
  return {
    next,
    between: (min: number, max: number) => Math.floor(min + next() * (max - min)),
    chance: (probability: number) => next() < probability,
    exponential: (mean: number) => Math.floor(-Math.log(1 - next()) * mean),
  };
}
