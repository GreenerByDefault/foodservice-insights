/** The `metrics` views and `metrics_reader`, the role that reads them. Every view is read as that
 * role, which also proves a view reaches its base tables with its owner's rights, not the role's. */

import { type RawBuilder, sql, type Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { METRICS_READER_CONNECTION_LIMIT } from '../src/budget.ts';
import { DATABASE } from '../src/env.ts';
import type { Database } from '../src/schema.ts';
import {
  DB_NOW,
  dbMsAgo,
  insertAnalysisAttempt,
  insertAppUser,
  insertReport,
} from '../src/testing/fixtures.ts';
import { withRollback } from '../src/testing/transactions.ts';

/** Text columns whose source has a pattern CHECK making them an identifier, keyed by
 * `view.column`. Anything else textual in `metrics` could carry what a customer typed. */
const IDENTIFIER_TEXT_COLUMNS = new Set([
  // analysis_attempt_worker_git_sha_format: 40 hex characters.
  'attempt.worker_git_sha',
]);

async function readAsMetricsReader<Row>(
  transaction: Transaction<Database>,
  query: RawBuilder<Row>,
): Promise<Row[]> {
  await sql`SET LOCAL ROLE metrics_reader`.execute(transaction);
  const { rows } = await query.execute(transaction);
  await sql`RESET ROLE`.execute(transaction);
  return rows;
}

describe('metrics.attempt', () => {
  type AttemptRow = {
    id: string;
    reportId: string;
    organizationId: string;
    attemptNumber: number;
    status: string;
    failureReason: string | null;
    createdAt: Date;
    claimedAt: Date | null;
    finishedAt: Date | null;
    queueSeconds: number | null;
    runSeconds: number | null;
    totalSeconds: number | null;
    workerGitSha: string | null;
    notificationAttempts: number;
    notificationEmailSentAt: Date | null;
    hasRequester: boolean;
  };

  function selectAttempt(id: string): RawBuilder<AttemptRow> {
    return sql<AttemptRow>`SELECT * FROM metrics.attempt WHERE id = ${id}`;
  }

  test('carries a failed attempt with its reason and all three durations', async () => {
    const { report, attempt, rows } = await withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction);
      const attempt = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'failed',
        failureReason: 'upstream_api',
        createdAt: dbMsAgo(60_000),
        claimedAt: dbMsAgo(45_000),
        finishedAt: dbMsAgo(5_000),
      });
      const rows = await readAsMetricsReader(transaction, selectAttempt(attempt.id));
      return { report, attempt, rows };
    });

    expect(rows).toEqual([
      {
        id: attempt.id,
        reportId: report.id,
        organizationId: report.organizationId,
        attemptNumber: 1,
        status: 'failed',
        failureReason: 'upstream_api',
        createdAt: attempt.createdAt,
        claimedAt: attempt.claimedAt,
        finishedAt: attempt.finishedAt,
        queueSeconds: 15,
        runSeconds: 40,
        totalSeconds: 55,
        workerGitSha: null,
        notificationAttempts: 0,
        notificationEmailSentAt: null,
        hasRequester: false,
      },
    ]);
  });

  test.each([
    ['an unclaimed attempt has none', 'pending', null, null, null],
    ['a processing attempt has only its queue time', 'processing', 20, null, null],
    ['an attempt canceled before its claim has no queue or run time', 'canceled', null, null, 30],
  ] as const)('%s', async (_title, status, queueSeconds, runSeconds, totalSeconds) => {
    const rows = await withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, {
        status,
        createdAt: dbMsAgo(30_000),
        ...(status === 'processing' ? { claimedAt: dbMsAgo(10_000) } : {}),
      });
      return await readAsMetricsReader(transaction, selectAttempt(attempt.id));
    });

    expect(rows.map((row) => [row.queueSeconds, row.runSeconds, row.totalSeconds])).toEqual([
      [queueSeconds, runSeconds, totalSeconds],
    ]);
  });

  test('has_requester turns false once the requester is deleted', async () => {
    const hasRequester = await withRollback(DATABASE, async (transaction) => {
      const user = await insertAppUser(transaction);
      const attempt = await insertAnalysisAttempt(transaction, { requestedByUserId: user.id });
      const before = await readAsMetricsReader(transaction, selectAttempt(attempt.id));
      await transaction.deleteFrom('auth.users').where('id', '=', user.id).execute();
      const after = await readAsMetricsReader(transaction, selectAttempt(attempt.id));
      return [...before, ...after].map((row) => row.hasRequester);
    });

    expect(hasRequester).toEqual([true, false]);
  });
});

describe('metrics.report', () => {
  test('keeps a soft-deleted report, with its deleted_at', async () => {
    const { report, deletedAt, rows } = await withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction, { createdAt: dbMsAgo(60_000) });
      const { deletedAt } = await transaction
        .updateTable('report')
        .set({ deletedAt: DB_NOW })
        .where('id', '=', report.id)
        .returning('deletedAt')
        .executeTakeFirstOrThrow();
      const rows = await readAsMetricsReader(
        transaction,
        sql`SELECT * FROM metrics.report WHERE id = ${report.id}`,
      );
      return { report, deletedAt, rows };
    });

    expect(rows).toEqual([
      {
        id: report.id,
        organizationId: report.organizationId,
        createdAt: report.createdAt,
        deletedAt,
      },
    ]);
  });
});

describe('metrics.app_user', () => {
  test('carries a user’s sign-up, confirmation and last sign-in', async () => {
    const { user, rows } = await withRollback(DATABASE, async (transaction) => {
      const { id } = await insertAppUser(transaction);
      const user = await transaction
        .updateTable('auth.users')
        .set({ emailConfirmedAt: dbMsAgo(50_000), lastSignInAt: dbMsAgo(10_000) })
        .where('id', '=', id)
        .returning(['id', 'createdAt', 'emailConfirmedAt', 'lastSignInAt'])
        .executeTakeFirstOrThrow();
      const rows = await readAsMetricsReader(
        transaction,
        sql`SELECT * FROM metrics.app_user WHERE id = ${id}`,
      );
      return { user, rows };
    });

    expect(rows).toEqual([user]);
  });
});

describe('metrics_reader', () => {
  test('can log in, read-only and time-limited, and do nothing else', async () => {
    const role = await withRollback(DATABASE, async (transaction) => {
      const { rows } = await sql`
        SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication,
               rolbypassrls, rolconnlimit, rolconfig
        FROM pg_roles WHERE rolname = 'metrics_reader'
      `.execute(transaction);
      return rows[0];
    });

    expect(role).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: METRICS_READER_CONNECTION_LIMIT,
      rolconfig: ['default_transaction_read_only=on', 'statement_timeout=15s'],
    });
  });

  // `has_table_privilege` counts what the role holds through PUBLIC as well as its own grants, and
  // never logs in as the role. A view or tombstone table a later migration adds is covered by the
  // same queries.
  describe('privileges', () => {
    async function privileges(schemas: readonly string[]): Promise<string[]> {
      return await withRollback(DATABASE, async (transaction) => {
        const { rows } = await sql<{ grant: string }>`
          WITH privilege (name) AS (
            VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
                   ('TRIGGER'), ('MAINTAIN')
          )
          SELECT n.nspname || '.' || c.relname || ' ' || p.name AS grant
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN privilege p
          WHERE n.nspname IN (${sql.join(schemas)})
            AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND has_table_privilege('metrics_reader', c.oid, p.name)
        `.execute(transaction);
        return rows.map((row) => row.grant).sort();
      });
    }

    test('can read every relation in metrics, and only read it', async () => {
      const relations = await withRollback(DATABASE, async (transaction) => {
        const { rows } = await sql<{ name: string }>`
          SELECT 'metrics.' || c.relname AS name
          FROM pg_class c
          WHERE c.relnamespace = 'metrics'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        `.execute(transaction);
        return rows.map((row) => `${row.name} SELECT`).sort();
      });

      expect(relations).not.toEqual([]);
      expect(await privileges(['metrics'])).toEqual(relations);
    });

    test('has nothing in public or auth', async () => {
      expect(await privileges(['public', 'auth'])).toEqual([]);
    });
  });
});

describe('metrics', () => {
  test('exposes no free text', async () => {
    const columns = await withRollback(DATABASE, async (transaction) => {
      const { rows } = await sql<{ name: string }>`
        SELECT c.relname || '.' || a.attname AS name
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_type t ON t.oid = a.atttypid
        WHERE c.relnamespace = 'metrics'::regnamespace
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND a.attnum > 0
          AND NOT a.attisdropped
          -- String types (text, varchar, char, name), arrays, which could hold either, and the
          -- types that carry a document or raw bytes.
          AND (t.typcategory IN ('S', 'A') OR t.typname IN ('json', 'jsonb', 'bytea', 'xml'))
      `.execute(transaction);
      return rows.map((row) => row.name).sort();
    });

    expect(columns).toEqual([...IDENTIFIER_TEXT_COLUMNS].sort());
  });
});
