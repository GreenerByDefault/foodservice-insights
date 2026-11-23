// The data alerts: `docs/architecture.md` § Alerts. Each check counts rows of a `metrics` view, so
// an alert shares its definition with the dashboards (`009_metrics.ts`). One Better Stack monitor
// polls `/health/data/<name>` per check, so each check opens and resolves its own incident.
//
// Rejected:
// - Grafana Cloud alert rules: the free stack sleeps after some days without a visitor, until a
//   person wakes it, and its rules most likely stop evaluating meanwhile.
// - The worker evaluating: queue wait exists to catch a wedged worker, which cannot report itself.
// - One route for every check: a second check firing during the first's incident sends no email.
//
// Every check counts a state that clears by itself: one that holds now, or an event inside a
// window. Otherwise a single old row would hold its incident open forever. That is also why a
// check of a current state reads live rows only: a tombstone keeps the status its row had when it
// was deleted, so a deleted `pending` attempt would wait in `metrics.attempt` forever.
//
// The worker's timings are copied, not imported, since the web app cannot depend on the worker.
// Each copy names its source in `apps/worker/src/config.ts`; change both together.

import { HOUR_MS, MINUTE_MS } from '@gbd/core';
import type { DatabaseExecutor } from '@gbd/db';
import { type RawBuilder, sql } from 'kysely';

export type Measurement = { count: number; threshold: number };

export type DataCheck = {
  /** What it means that the count is over the threshold, for whoever follows the alert email to
   * the check's page. */
  firing: string;
  measure: (db: DatabaseExecutor) => Promise<Measurement>;
};

/** `claimedCeilingMs + reapIntervalMs`: no attempt the reaper is running for lasts past this. */
const UNREAPED_AFTER_MS = 30 * MINUTE_MS + MINUTE_MS;

/** `maxNotificationAttempts`. `config.test.ts` already pins the worker's copy to the database's. */
const MAX_NOTIFICATION_ATTEMPTS = 5;

/** How long a give-up keeps its incident open. The last send goes out about 75 minutes after the
 * attempt finished (`notificationRetryWindowMs`), so this leaves hours of room for a worker that
 * was down meanwhile, and every give-up is counted once before it ages out. */
const GAVE_UP_WINDOW_MS = 6 * HOUR_MS;

/** Over this share of `max_connections`, the clients are past what `budget.ts` sizes them for.
 * `metrics.database_connection` can read a connection or two high, which this absorbs. */
const CONNECTION_SHARE = 0.8;

function beforeNow(ms: number): RawBuilder<Date> {
  return sql<Date>`now() - make_interval(secs => ${ms / 1000})`;
}

/** A check that fires on any row `query` counts. */
function anyRow(query: RawBuilder<{ count: number }>): DataCheck['measure'] {
  return async (db) => {
    const { rows } = await query.execute(db);
    return { count: rows[0]?.count ?? 0, threshold: 0 };
  };
}

export const DATA_CHECKS = {
  'queue-wait': {
    firing:
      'An attempt has waited over 30 minutes for a worker to claim it. Three slots of 2–15 ' +
      'minutes each means demand beyond capacity, or no worker is claiming.',
    measure: anyRow(sql`
      SELECT count(*)::integer AS count
      FROM metrics.attempt
      WHERE status = 'pending'
        AND purged_at IS NULL
        AND created_at < ${beforeNow(30 * MINUTE_MS)}
    `),
  },

  'failed-attempts': {
    // `unusable_data` is the customer's file, not our failure.
    firing: 'An attempt failed in the last hour for a reason that is ours.',
    measure: anyRow(sql`
      SELECT count(*)::integer AS count
      FROM metrics.attempt
      WHERE status = 'failed'
        AND failure_reason <> 'unusable_data'
        AND finished_at > ${beforeNow(HOUR_MS)}
    `),
  },

  'unreaped-attempts': {
    firing:
      'An attempt is still processing past the longest the reaper allows, so no reaper is running.',
    measure: anyRow(sql`
      SELECT count(*)::integer AS count
      FROM metrics.attempt
      WHERE status = 'processing'
        AND purged_at IS NULL
        AND claimed_at < ${beforeNow(UNREAPED_AFTER_MS)}
    `),
  },

  'notifications-gave-up': {
    // The window is on `finished_at` because the view has no notification claim time.
    firing: `An attempt's result email failed all ${MAX_NOTIFICATION_ATTEMPTS} sends, and the sweep gave up on it.`,
    measure: anyRow(sql`
      SELECT count(*)::integer AS count
      FROM metrics.attempt
      WHERE status <> 'canceled'
        AND purged_at IS NULL
        AND notification_email_sent_at IS NULL
        AND notification_attempts >= ${MAX_NOTIFICATION_ATTEMPTS}
        AND finished_at > ${beforeNow(GAVE_UP_WINDOW_MS)}
    `),
  },

  'notifications-stuck': {
    // The sweep's due predicate (`dueCandidates` in `apps/worker/src/sweeps/notifications.ts`),
    // an hour on. Without its report and requester clauses, an email the sweep rightly never sends
    // would fire forever.
    firing:
      'A result email is still unsent an hour after its attempt finished, with sends left: email ' +
      'is down, or the notification sweep is not running.',
    measure: anyRow(sql`
      SELECT count(*)::integer AS count
      FROM metrics.attempt a
      JOIN metrics.report r ON r.id = a.report_id
      WHERE a.status IN ('succeeded', 'failed')
        AND a.purged_at IS NULL
        AND a.notification_email_sent_at IS NULL
        AND a.notification_attempts < ${MAX_NOTIFICATION_ATTEMPTS}
        AND a.has_requester
        AND r.deleted_at IS NULL
        AND a.finished_at < ${beforeNow(HOUR_MS)}
    `),
  },

  connections: {
    // When the database is truly out, this query cannot connect either, and that answers 503 too.
    firing: `The database's connections are over ${CONNECTION_SHARE * 100}% of max_connections.`,
    measure: async (db) => {
      const { rows } = await sql<Measurement>`
        SELECT
          sum(connections)::integer AS count,
          floor(max(max_connections) * ${CONNECTION_SHARE}::numeric)::integer AS threshold
        FROM metrics.database_connection
      `.execute(db);
      // This query's own connection is always a row.
      const [row] = rows;
      if (row === undefined) throw new Error('metrics.database_connection returned no rows');
      return row;
    },
  },
} as const satisfies Record<string, DataCheck>;

export type DataCheckName = keyof typeof DATA_CHECKS;

export function isDataCheckName(name: string): name is DataCheckName {
  return Object.hasOwn(DATA_CHECKS, name);
}
