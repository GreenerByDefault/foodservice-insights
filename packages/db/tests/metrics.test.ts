/** The `metrics` views and `metrics_reader`, the role that reads them. Every view is read as that
 * role, which also proves a view reaches its base tables with its owner's rights, not the role's. */

import { requireEnv } from '@gbd/core/env';
import { type RawBuilder, sql, type Transaction } from 'kysely';
import { afterAll, describe, expect, test } from 'vitest';
import { METRICS_READER_CONNECTION_LIMIT } from '../src/budget.ts';
import { initializeDatabase, shutdownDatabase } from '../src/client.ts';
import { DATABASE } from '../src/env.ts';
import type { UsersId } from '../src/generated/auth/Users.ts';
import type { Database } from '../src/schema.ts';
import { expectConstraintViolation } from '../src/testing/constraints.ts';
import {
  DB_NOW,
  dbMsAgo,
  FINISHED_RUN_TELEMETRY,
  insertAnalysisAttempt,
  insertAppUser,
  insertAttemptLlmUsage,
  insertAttemptQualityCheck,
  insertAttemptTelemetry,
  insertOrganization,
  insertReport,
} from '../src/testing/fixtures/index.ts';
import { withRollback } from '../src/testing/transactions.ts';

/** Text columns whose source has a pattern CHECK making them an identifier, keyed by
 * `view.column`. Anything else textual in `metrics` could carry what a customer typed. */
const IDENTIFIER_TEXT_COLUMNS = new Set([
  // analysis_attempt_worker_git_sha_format: 40 hex characters.
  'attempt.worker_git_sha',
  // purged_attempt_worker_git_sha_format: the same.
  'purged_attempt.worker_git_sha',
  // From metrics.attempt.
  'attempt_telemetry.worker_git_sha',
  'attempt_llm_usage.worker_git_sha',
  // analysis_attempt_llm_usage_requested_model_format and _served_model_format: a model id.
  'attempt_llm_usage.requested_model',
  'attempt_llm_usage.served_model',
  // A Postgres role name, set by us or by Supabase.
  'database_connection.role',
  // app_user_country_format: two capital letters.
  'app_user.country',
  // purged_user_country_country_format: the same.
  'purged_user_country.country',
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
    purgedAt: Date | null;
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
        purgedAt: null,
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
  test('keeps a soft-deleted report live, with its deleted_at', async () => {
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
        purgedAt: null,
      },
    ]);
  });
});

describe('metrics.app_user', () => {
  test('carries a user’s sign-up, confirmation, last sign-in and country', async () => {
    const { user, rows } = await withRollback(DATABASE, async (transaction) => {
      const { id } = await insertAppUser(transaction, { country: 'NL' });
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

    expect(rows).toEqual([{ ...user, purgedAt: null, country: 'NL' }]);
  });
});

describe('metrics.attempt_telemetry', () => {
  type TelemetryRow = Record<string, unknown>;

  function selectTelemetry(id: string): RawBuilder<TelemetryRow> {
    return sql<TelemetryRow>`SELECT * FROM metrics.attempt_telemetry WHERE analysis_attempt_id = ${id}`;
  }

  /** A finished run's telemetry under a real failed attempt, with shares that come out exact. */
  async function insertFailedRun(transaction: Transaction<Database>) {
    const report = await insertReport(transaction);
    // A terminal attempt is immutable, so the worker's commit is set while it runs.
    const { id } = await insertAnalysisAttempt(transaction, {
      reportId: report.id,
      status: 'processing',
    });
    const attempt = await transaction
      .updateTable('analysisAttempt')
      .set({ workerGitSha: 'b'.repeat(40) })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable('analysisAttempt')
      .set({ status: 'failed', failureReason: 'hung', finishedAt: DB_NOW })
      .where('id', '=', id)
      .execute();
    const telemetry = await insertAttemptTelemetry(transaction, {
      analysisAttemptId: attempt.id,
      reportId: report.id,
      organizationId: report.organizationId,
      inputKilograms: 2500,
      categorizedKilograms: 2000,
      cacheNoMatchProducts: 3,
      llmNoMatchProducts: 3,
    });
    return { report, attempt, telemetry };
  }

  test('carries the telemetry, its attempt’s outcome, and what derives from them', async () => {
    const { report, attempt, telemetry, rows } = await withRollback(
      DATABASE,
      async (transaction) => {
        const inserted = await insertFailedRun(transaction);
        const rows = await readAsMetricsReader(transaction, selectTelemetry(inserted.attempt.id));
        return { ...inserted, rows };
      },
    );

    expect(rows).toEqual([
      {
        ...FINISHED_RUN_TELEMETRY,
        analysisAttemptId: attempt.id,
        reportId: report.id,
        organizationId: report.organizationId,
        recordedAt: telemetry.recordedAt,
        status: 'failed',
        failureReason: 'hung',
        workerGitSha: 'b'.repeat(40),
        inputKilograms: 2500,
        categorizedKilograms: 2000,
        cacheNoMatchProducts: 3,
        llmNoMatchProducts: 3,
        qualityStatus: 'pass',
        // (100 + 5) / 120
        cacheHitRate: 0.875,
        // (120 - 3 - 3) / 120
        categorizedProductsShare: 0.95,
        categorizedKilogramsShare: 0.8,
      },
    ]);
  });

  test('keeps the outcome of an attempt deleted with its organization', async () => {
    const rows = await withRollback(DATABASE, async (transaction) => {
      const { report, attempt } = await insertFailedRun(transaction);
      await transaction
        .deleteFrom('organization')
        .where('id', '=', report.organizationId)
        .execute();
      return await readAsMetricsReader(transaction, selectTelemetry(attempt.id));
    });

    expect(rows.map(({ status, failureReason }) => ({ status, failureReason }))).toEqual([
      { status: 'failed', failureReason: 'hung' },
    ]);
  });

  test('has no outcome for an attempt it cannot find', async () => {
    const rows = await withRollback(DATABASE, async (transaction) => {
      const telemetry = await insertAttemptTelemetry(transaction);
      return await readAsMetricsReader(transaction, selectTelemetry(telemetry.analysisAttemptId));
    });

    expect(
      rows.map(({ status, failureReason, workerGitSha }) => ({
        status,
        failureReason,
        workerGitSha,
      })),
    ).toEqual([{ status: null, failureReason: null, workerGitSha: null }]);
  });

  test.each([
    ['no findings pass', [], 'pass'],
    ['a warning makes a warning', ['warning'], 'warning'],
    ['an error makes it invalid, even beside a warning', ['warning', 'error'], 'invalid'],
  ] as const)('quality_status: %s', async (_title, statuses, qualityStatus) => {
    const rows = await withRollback(DATABASE, async (transaction) => {
      const { analysisAttemptId } = await insertAttemptTelemetry(transaction);
      for (const status of statuses) {
        await insertAttemptQualityCheck(transaction, { analysisAttemptId, status });
      }
      return await readAsMetricsReader(transaction, selectTelemetry(analysisAttemptId));
    });

    expect(rows.map((row) => row.qualityStatus)).toEqual([qualityStatus]);
  });

  test('a run that stopped before its report has no quality status or shares', async () => {
    const rows = await withRollback(DATABASE, async (transaction) => {
      const { analysisAttemptId } = await insertAttemptTelemetry(transaction, {
        inputRows: null,
        inputKilograms: null,
        inputUniqueProducts: null,
        categorizationCacheEntries: null,
        cacheRawNameProducts: null,
        cacheCleanedNameProducts: null,
        llmMatchedProducts: null,
        cacheNoMatchProducts: null,
        llmNoMatchProducts: null,
        unrecognizedLlmAnswers: null,
        categorizedRows: null,
        categorizedKilograms: null,
        totalCo2eKg: null,
        co2eKgPerDinerOrMeal: null,
        plantPctByWeight: null,
        plantProteinPctByWeight: null,
        readDurationMs: null,
        categorizeDurationMs: null,
        reportDurationMs: null,
        pdfDurationMs: null,
        xlsxDurationMs: null,
      });
      return await readAsMetricsReader(transaction, selectTelemetry(analysisAttemptId));
    });

    expect(
      rows.map((row) => [
        row.qualityStatus,
        row.cacheHitRate,
        row.categorizedProductsShare,
        row.categorizedKilogramsShare,
      ]),
    ).toEqual([[null, null, null, null]]);
  });

  test('an empty upload has no shares rather than dividing by zero', async () => {
    const rows = await withRollback(DATABASE, async (transaction) => {
      const { analysisAttemptId } = await insertAttemptTelemetry(transaction, {
        inputRows: 0,
        inputKilograms: 0,
        inputUniqueProducts: 0,
        cacheRawNameProducts: 0,
        cacheCleanedNameProducts: 0,
        llmMatchedProducts: 0,
        cacheNoMatchProducts: 0,
        llmNoMatchProducts: 0,
        unrecognizedLlmAnswers: 0,
        categorizedRows: 0,
        categorizedKilograms: 0,
      });
      return await readAsMetricsReader(transaction, selectTelemetry(analysisAttemptId));
    });

    expect(
      rows.map((row) => [
        row.cacheHitRate,
        row.categorizedProductsShare,
        row.categorizedKilogramsShare,
      ]),
    ).toEqual([[null, null, null]]);
  });

  test('keeps a kilogram share above 1 for a panel to clamp', async () => {
    const rows = await withRollback(DATABASE, async (transaction) => {
      const { analysisAttemptId } = await insertAttemptTelemetry(transaction, {
        inputKilograms: 2000,
        categorizedKilograms: 2000.5,
      });
      return await readAsMetricsReader(transaction, selectTelemetry(analysisAttemptId));
    });

    expect(rows.map((row) => row.categorizedKilogramsShare)).toEqual([1.00025]);
  });
});

describe('metrics.attempt_llm_usage', () => {
  test('carries each usage row, in dollars, with its telemetry’s ids and attempt’s outcome', async () => {
    const { report, attempt, telemetry, rows } = await withRollback(
      DATABASE,
      async (transaction) => {
        const report = await insertReport(transaction);
        const attempt = await insertAnalysisAttempt(transaction, {
          reportId: report.id,
          status: 'succeeded',
        });
        const telemetry = await insertAttemptTelemetry(transaction, {
          analysisAttemptId: attempt.id,
          reportId: report.id,
          organizationId: report.organizationId,
        });
        await insertAttemptLlmUsage(transaction, { analysisAttemptId: attempt.id });
        await insertAttemptLlmUsage(transaction, {
          analysisAttemptId: attempt.id,
          operation: 'match',
          servedModel: null,
          costMicroUsd: 1,
        });
        const rows = await readAsMetricsReader(
          transaction,
          sql`SELECT * FROM metrics.attempt_llm_usage WHERE analysis_attempt_id = ${attempt.id} ORDER BY operation`,
        );
        return { report, attempt, telemetry, rows };
      },
    );

    const shared = {
      analysisAttemptId: attempt.id,
      reportId: report.id,
      organizationId: report.organizationId,
      recordedAt: telemetry.recordedAt,
      status: 'succeeded',
      failureReason: null,
      workerGitSha: null,
      requestedModel: 'gpt-4.1-mini',
      calls: 100,
      requests: 103,
      failedRequests: 3,
      rateLimitedRequests: 2,
      truncatedCalls: 1,
      inputTokens: 100_000,
      cachedInputTokens: 80_000,
      outputTokens: 1500,
    };
    expect(rows).toEqual([
      {
        ...shared,
        operation: 'clean',
        servedModel: 'gpt-4.1-mini-2025-04-14',
        costUsd: '0.018400',
      },
      { ...shared, operation: 'match', servedModel: null, costUsd: '0.000001' },
    ]);
  });
});

describe('metrics.attempt_quality_check', () => {
  test('carries each check’s findings, with its telemetry’s ids', async () => {
    const { telemetry, rows } = await withRollback(DATABASE, async (transaction) => {
      const telemetry = await insertAttemptTelemetry(transaction);
      await insertAttemptQualityCheck(transaction, {
        analysisAttemptId: telemetry.analysisAttemptId,
        qualityCheck: 'date_distribution',
        status: 'error',
        findings: 2,
      });
      const rows = await readAsMetricsReader(
        transaction,
        sql`SELECT * FROM metrics.attempt_quality_check WHERE analysis_attempt_id = ${telemetry.analysisAttemptId}`,
      );
      return { telemetry, rows };
    });

    expect(rows).toEqual([
      {
        analysisAttemptId: telemetry.analysisAttemptId,
        reportId: telemetry.reportId,
        organizationId: telemetry.organizationId,
        recordedAt: telemetry.recordedAt,
        qualityCheck: 'date_distribution',
        status: 'error',
        findings: 2,
      },
    ]);
  });
});

describe('metrics.database_connection', () => {
  test('counts the test’s own connection under its role, beside the server’s limit', async () => {
    const { server, rows } = await withRollback(DATABASE, async (transaction) => {
      const server = await transaction
        .selectNoFrom([
          sql<string>`session_user`.as('session'),
          sql<number>`current_setting('max_connections')::integer`.as('maxConnections'),
        ])
        .executeTakeFirstOrThrow();
      const rows = await readAsMetricsReader(
        transaction,
        sql<{
          role: string;
          connections: number;
          connectionLimit: number | null;
          maxConnections: number;
        }>`SELECT * FROM metrics.database_connection`,
      );
      return { server, rows };
    });

    const own = rows.find((row) => row.role === server.session);
    expect(own?.connections).toBeGreaterThanOrEqual(1);
    expect(own?.connectionLimit).toBeNull();
    expect(rows.map((row) => row.maxConnections)).toEqual(rows.map(() => server.maxConnections));
  });
});

// A hard delete leaves the row in its view, as it was, with `purged_at` set. Each case reads the
// rows before and after, so a column the tombstone failed to copy shows up as a difference.
describe('tombstones', () => {
  type Row = Record<string, unknown>;

  async function readNow(transaction: Transaction<Database>): Promise<Date> {
    const { now } = await transaction.selectNoFrom(DB_NOW.as('now')).executeTakeFirstOrThrow();
    return now;
  }

  test('keep a deleted organization’s reports and attempts', async () => {
    const { before, after, now } = await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);
      const requester = await insertAppUser(transaction);
      const report = await insertReport(transaction, {
        organizationId: organization.id,
        createdAt: dbMsAgo(120_000),
      });
      const failed = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'failed',
        failureReason: 'upstream_api',
        requestedByUserId: requester.id,
        createdAt: dbMsAgo(100_000),
        claimedAt: dbMsAgo(90_000),
        finishedAt: dbMsAgo(80_000),
      });
      await transaction
        .updateTable('analysisAttempt')
        .set({
          notificationClaimedAt: dbMsAgo(70_000),
          notificationClaimedByWorkerId: 'test-worker',
          notificationAttempts: 1,
          notificationEmailSentAt: dbMsAgo(60_000),
        })
        .where('id', '=', failed.id)
        .execute();
      const retry = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        attemptNumber: 2,
        status: 'processing',
        createdAt: dbMsAgo(50_000),
        claimedAt: dbMsAgo(40_000),
      });
      await transaction
        .updateTable('analysisAttempt')
        .set({ workerGitSha: 'a'.repeat(40) })
        .where('id', '=', retry.id)
        .execute();
      await transaction
        .updateTable('report')
        .set({ deletedAt: dbMsAgo(10_000) })
        .where('id', '=', report.id)
        .execute();

      async function read() {
        return {
          reports: await readAsMetricsReader(
            transaction,
            sql<Row>`SELECT * FROM metrics.report WHERE id = ${report.id}`,
          ),
          attempts: await readAsMetricsReader(
            transaction,
            sql<Row>`SELECT * FROM metrics.attempt WHERE report_id = ${report.id} ORDER BY attempt_number`,
          ),
        };
      }

      const before = await read();
      await transaction.deleteFrom('organization').where('id', '=', organization.id).execute();
      return { before, after: await read(), now: await readNow(transaction) };
    });

    expect(before.reports).toHaveLength(1);
    expect(before.attempts).toHaveLength(2);
    expect(after).toEqual({
      reports: before.reports.map((row) => ({ ...row, purgedAt: now })),
      attempts: before.attempts.map((row) => ({ ...row, purgedAt: now })),
    });
  });

  test.each([
    ['NL', 'NL'],
    ['no', undefined],
  ])('keep a deleted account with %s country', async (_, country) => {
    const { before, after, now } = await withRollback(DATABASE, async (transaction) => {
      const { id } = await insertAppUser(transaction, {
        ...(country !== undefined && { country }),
      });
      await transaction
        .updateTable('auth.users')
        .set({ emailConfirmedAt: dbMsAgo(50_000), lastSignInAt: dbMsAgo(10_000) })
        .where('id', '=', id)
        .execute();

      const select = sql<Row>`SELECT * FROM metrics.app_user WHERE id = ${id}`;
      const before = await readAsMetricsReader(transaction, select);
      await transaction.deleteFrom('auth.users').where('id', '=', id).execute();
      return {
        before,
        after: await readAsMetricsReader(transaction, select),
        now: await readNow(transaction),
      };
    });

    expect(before.map((row) => row.country)).toEqual([country ?? null]);
    expect(after).toEqual(before.map((row) => ({ ...row, purgedAt: now })));
  });

  // The dev seed's placeholder user is one such id.
  test('keep the first of two accounts deleted under the same id', async () => {
    const { first, rows } = await withRollback(DATABASE, async (transaction) => {
      const id = crypto.randomUUID() as UsersId;
      async function insertAndDelete(createdAt: RawBuilder<Date>, country: string) {
        await insertAppUser(transaction, { id, createdAt, country });
        await transaction.deleteFrom('auth.users').where('id', '=', id).execute();
      }

      await insertAndDelete(dbMsAgo(60_000), 'NL');
      const first = await readAsMetricsReader(
        transaction,
        sql<Row>`SELECT * FROM metrics.app_user WHERE id = ${id}`,
      );
      await insertAndDelete(dbMsAgo(30_000), 'DE');
      const rows = await readAsMetricsReader(
        transaction,
        sql<Row>`SELECT * FROM metrics.app_user WHERE id = ${id}`,
      );
      return { first, rows };
    });

    expect(first.map((row) => row.country)).toEqual(['NL']);
    expect(rows).toEqual(first);
  });

  // Supabase Auth's admin API deletes as `supabase_auth_admin`, which holds nothing in `metrics`.
  // The delete succeeding is the assertion: a tombstone it could not write would fail it. The role
  // cannot read `metrics`, so the cases above check what the tombstone holds.
  describe('as supabase_auth_admin', () => {
    const authAdmin = initializeDatabase({
      connectionString: authAdminConnectionString(),
      limits: { minConnections: 0, maxConnections: 1 },
      log: 'console',
      siteUrl: process.env.SITE_URL,
    });
    afterAll(async () => {
      await shutdownDatabase(authAdmin);
    });

    // The password is the local stacks' own, which opens nothing that is not already open.
    function authAdminConnectionString(): string {
      const url = new URL(requireEnv('DB_CONNECTION_STRING'));
      url.username = 'supabase_auth_admin';
      url.password = 'postgres';
      return url.toString();
    }

    test('a user can still be deleted', async () => {
      const deleted = await withRollback(authAdmin, async (transaction) => {
        const id = crypto.randomUUID() as UsersId;
        await transaction
          .insertInto('auth.users')
          .values({ id, email: `${id}@example.test` })
          .execute();
        const { numDeletedRows } = await transaction
          .deleteFrom('auth.users')
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return numDeletedRows;
      });

      expect(deleted).toBe(1n);
    });
  });

  test('purged_user_country rejects a country that is not two capital letters', async () => {
    await withRollback(DATABASE, async (transaction) => {
      await expectConstraintViolation(
        sql`
          INSERT INTO metrics.purged_user_country (id, country)
          VALUES (${crypto.randomUUID()}, 'nl')
        `.execute(transaction),
        'purged_user_country_country_format',
      );
    });
  });

  test('purged_attempt rejects a worker_git_sha that is not a commit hash', async () => {
    await withRollback(DATABASE, async (transaction) => {
      await expectConstraintViolation(
        sql`
          INSERT INTO metrics.purged_attempt (
            id, report_id, attempt_number, status, created_at, worker_git_sha,
            notification_attempts, has_requester
          )
          VALUES (
            ${crypto.randomUUID()}, ${crypto.randomUUID()}, 1, 'pending', now(), 'main', 0, false
          )
        `.execute(transaction),
        'purged_attempt_worker_git_sha_format',
      );
    });
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
