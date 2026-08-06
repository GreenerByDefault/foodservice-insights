/** The schema's invariants that only exist between two transactions.
 *
 * Every other test file in this package uses `withRollback`, and none of them can reach anything in
 * here: a single transaction never blocks on its own locks and never sees another snapshot. Delete
 * the `FOR NO KEY UPDATE` from `organization_member_check_admin_remains`, and all 447 lines of
 * `organization.test.ts` still pass.
 *
 * **These tests commit, and wrapping one in `withRollback` would not fail it — it would make it
 * pass without proving anything.** `src/testing/concurrency.ts` says why, and owns the cleanup that
 * makes committing safe against a database no test truncates.
 *
 * The shape is always the same. One transaction writes and stays open; a second writes the change
 * that must not be allowed alongside it, and the harness waits until that second statement is
 * genuinely waiting on a lock the first one holds — waiting on it *specifically*, not on any lock,
 * and failing loudly if it never waits at all. Then the first commits and the second is asked what
 * happened. Without that middle step each of these tests would pass against a schema with no
 * locking whatsoever.
 */

import { sql } from 'kysely';
import { afterAll, describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import type { AnalysisAttempt } from '../src/generated/public/AnalysisAttempt.ts';
import type { AppUser } from '../src/generated/public/AppUser.ts';
import type { OrganizationId } from '../src/generated/public/Organization.ts';
import type { Report } from '../src/generated/public/Report.ts';
import {
  POSTGRES_CODE_CHECK_VIOLATION,
  POSTGRES_CODE_UNIQUE_VIOLATION,
} from '../src/postgres-codes.ts';
import {
  type ConcurrentTransaction,
  fixtureOrganizationName,
  insertFixtureOrganization,
  sendBlockingStatement,
  withCommittedFixture,
  withConcurrentTransactions,
} from '../src/testing/concurrency.ts';
import { insertAnalysisAttempt, insertAppUser, insertReport } from '../src/testing/fixtures.ts';

afterAll(async () => {
  await DATABASE.destroy();
});

type Transaction = ConcurrentTransaction['transaction'];

describe('an organization keeps an admin under concurrent demotions', () => {
  test('the second demotion is refused rather than committed alongside the first', async () => {
    // Two admins, and two transactions each demoting the other's. Both start out legitimate:
    // whichever runs alone leaves an admin behind. Only together do they empty the organization,
    // and only the row lock the trigger takes can see that.
    await withCommittedFixture(
      DATABASE,
      async (transaction, trash) => {
        const { organization, admin } = await insertFixtureOrganization(transaction, trash);
        const second = await insertAppUser(transaction);
        trash.user(second.id);
        await transaction
          .insertInto('organizationMember')
          .values({ userId: second.id, organizationId: organization.id, role: 'admin' })
          .execute();
        return { organizationId: organization.id, first: admin, second };
      },
      async ({ organizationId, first, second }) => {
        await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
          await demote(alpha.transaction, organizationId, first.id);
          // Fire alpha's deferred trigger now rather than at its commit. It takes the
          // organization's row lock, sees `second` still an admin, and passes — and alpha then
          // holds that lock for the rest of its transaction.
          //
          // `<name> IMMEDIATE`, not `ALL`: `ALL` would also flip `organization_has_a_member` and
          // every foreign key for the rest of the transaction.
          await sql`SET CONSTRAINTS organization_member_at_least_one_admin IMMEDIATE`.execute(
            alpha.transaction,
          );

          await demote(beta.transaction, organizationId, second.id);
          // Beta blocks inside a real COMMIT, not inside a `SET CONSTRAINTS`, so what is under
          // test is the path production takes.
          const blocked = await sendBlockingStatement(DATABASE, beta, alpha, (transaction) =>
            transaction.commit().execute(),
          );

          await alpha.transaction.commit().execute();
          // Alpha's own commit re-checks nothing: `SET CONSTRAINTS` already marked its trigger
          // event done. The invariant rests entirely on beta's lock wait, which is the point.
          expect(alpha.transaction.isCommitted).toBe(true);

          // Beta re-read under a fresh READ COMMITTED snapshot once the lock was granted, and saw
          // alpha's committed demotion next to its own. Neither transaction could see that alone.
          await expect(blocked.result).rejects.toMatchObject({
            code: POSTGRES_CODE_CHECK_VIOLATION,
            constraint: 'organization_member_at_least_one_admin',
          });
        });

        const admins = await DATABASE.selectFrom('organizationMember')
          .select('userId')
          .where('organizationId', '=', organizationId)
          .where('role', '=', 'admin')
          .execute();
        expect(admins.map((row) => row.userId)).toEqual([second.id]);
      },
    );
  });
});

describe('a reaped attempt cannot be reopened by the worker it reaped', () => {
  /** The hung worker, still holding an attempt another worker is about to take away. */
  const ORIGINAL_WORKER = 'worker-a';
  const REAPING_WORKER = 'worker-b';

  /** A committed attempt in `processing`, claimed by `ORIGINAL_WORKER`. */
  async function withProcessingAttempt(
    body: (attempt: AnalysisAttempt) => Promise<void>,
  ): Promise<void> {
    await withCommittedFixture(
      DATABASE,
      async (transaction, trash) => {
        const { organization } = await insertFixtureOrganization(transaction, trash);
        const report = await insertReport(transaction, { organizationId: organization.id });
        return await insertAnalysisAttempt(transaction, {
          reportId: report.id,
          status: 'processing',
          workerId: ORIGINAL_WORKER,
        });
      },
      body,
    );
  }

  /** The reaper's half, identical in both tests: mark the attempt failed and hold the row. */
  async function reap(transaction: Transaction, attempt: AnalysisAttempt): Promise<void> {
    const reaped = await transaction
      .updateTable('analysisAttempt')
      .set({
        status: 'failed',
        finishedAt: new Date(),
        failureReason: 'hung',
        reapedByWorkerId: REAPING_WORKER,
      })
      .where('id', '=', attempt.id)
      .where('status', '=', 'processing')
      .executeTakeFirstOrThrow();
    expect(Number(reaped.numUpdatedRows)).toBe(1);
  }

  test('the guarded update ARCHITECTURE.md prescribes updates nothing, and does not raise', async () => {
    await withProcessingAttempt(async (attempt) => {
      await withConcurrentTransactions(DATABASE, async (reaper, original) => {
        await reap(reaper.transaction, attempt);

        const blocked = await sendBlockingStatement(DATABASE, original, reaper, (transaction) =>
          transaction
            .updateTable('analysisAttempt')
            .set({ status: 'succeeded', finishedAt: new Date() })
            .where('id', '=', attempt.id)
            .where('status', '=', 'processing')
            .where('workerId', '=', ORIGINAL_WORKER)
            .executeTakeFirstOrThrow(),
        );

        await reaper.transaction.commit().execute();

        // Once the lock is granted Postgres re-evaluates the WHERE against the row as it now
        // stands, and `status = 'processing'` no longer holds. Losing the race is a zero-row
        // update, which is exactly what makes the guard worth writing.
        const result = await blocked.result;
        expect(Number(result.numUpdatedRows)).toBe(0);
      });

      const after = await DATABASE.selectFrom('analysisAttempt')
        .select(['status', 'reapedByWorkerId'])
        .where('id', '=', attempt.id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual({ status: 'failed', reapedByWorkerId: REAPING_WORKER });
    });
  });

  test('an unguarded update is refused by the trigger instead', async () => {
    // The backstop for a statement that forgets the guard above.
    //
    // Worth writing down once, because nowhere else will: the trigger's
    // `WHEN (OLD.status IN (...))` sees the re-fetched row rather than the one this statement
    // planned against *only because a BEFORE ROW UPDATE trigger exists*. Postgres takes the row
    // lock and re-evaluates in `GetTupleForTrigger`, before any trigger fires, and the WHEN clause
    // is tested against what that leaves behind. With no BEFORE ROW trigger the retry happens
    // later in `ExecUpdate`, so turning this into a CHECK constraint or a statement-level trigger
    // would silently destroy the property.
    await withProcessingAttempt(async (attempt) => {
      await withConcurrentTransactions(DATABASE, async (reaper, original) => {
        await reap(reaper.transaction, attempt);

        const blocked = await sendBlockingStatement(DATABASE, original, reaper, (transaction) =>
          transaction
            .updateTable('analysisAttempt')
            .set({ status: 'succeeded', finishedAt: new Date() })
            .where('id', '=', attempt.id)
            .executeTakeFirstOrThrow(),
        );

        await reaper.transaction.commit().execute();

        // On the name, not just the code: this update also leaves `failure_reason = 'hung'` beside
        // `status = 'succeeded'`, which independently violates
        // `analysis_attempt_failure_reason_iff_failed`. Both are 23514. The trigger wins because
        // BEFORE ROW triggers run ahead of constraint evaluation, and asserting the name is what
        // holds us to that.
        await expect(blocked.result).rejects.toMatchObject({
          code: POSTGRES_CODE_CHECK_VIOLATION,
          constraint: 'analysis_attempt_terminal_is_final',
        });
      });
    });
  });
});

describe('the worker queue', () => {
  /** The claim from `ARCHITECTURE.md` § Worker queue. The `report_id` filter is the one addition:
   * every test file shares this database, so the queue has to be narrowed to the attempts this
   * test created. */
  async function claim(
    transaction: Transaction,
    workerId: string,
    reportIds: Report['id'][],
  ): Promise<string | undefined> {
    const { rows } = await sql<{ id: string }>`
      UPDATE analysis_attempt
      SET status = 'processing', worker_id = ${workerId}, locked_at = now(), last_heartbeat_at = now()
      WHERE id = (
        SELECT id FROM analysis_attempt
        WHERE status = 'pending' AND report_id = ANY(${reportIds}::uuid[])
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id
    `.execute(transaction);
    return rows[0]?.id;
  }

  /** `count` reports in one organization, each with a pending attempt waiting to be claimed. */
  async function withPendingAttempts(
    count: number,
    body: (reportIds: Report['id'][]) => Promise<void>,
  ): Promise<void> {
    await withCommittedFixture(
      DATABASE,
      async (transaction, trash) => {
        const { organization } = await insertFixtureOrganization(transaction, trash);
        const reportIds: Report['id'][] = [];
        for (let index = 0; index < count; index++) {
          const report = await insertReport(transaction, { organizationId: organization.id });
          await insertAnalysisAttempt(transaction, { reportId: report.id });
          reportIds.push(report.id);
        }
        return reportIds;
      },
      body,
    );
  }

  test('never hands the same attempt to two workers', async () => {
    await withPendingAttempts(1, async (reportIds) => {
      await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
        expect(await claim(alpha.transaction, 'worker-a', reportIds)).toBeDefined();

        // `SKIP LOCKED` steps over the row alpha holds rather than queueing behind it. That this
        // resolves at all is half the assertion: a claim that waited would come back as the
        // harness's `lock_timeout` instead of as nothing, and a worker that blocks on a busy queue
        // is not a working queue.
        expect(await claim(beta.transaction, 'worker-b', reportIds)).toBeUndefined();

        await alpha.transaction.commit().execute();
      });

      const workers = await DATABASE.selectFrom('analysisAttempt')
        .select('workerId')
        .where('reportId', 'in', reportIds)
        .execute();
      expect(workers.map((row) => row.workerId)).toEqual(['worker-a']);
    });
  });

  test('hands two workers different attempts', async () => {
    await withPendingAttempts(2, async (reportIds) => {
      const claimed = await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
        const byAlpha = await claim(alpha.transaction, 'worker-a', reportIds);
        const byBeta = await claim(beta.transaction, 'worker-b', reportIds);
        await alpha.transaction.commit().execute();
        await beta.transaction.commit().execute();
        return [byAlpha, byBeta];
      });

      expect(claimed.filter((id) => id !== undefined)).toHaveLength(2);
      expect(claimed[0]).not.toBe(claimed[1]);

      const workers = await DATABASE.selectFrom('analysisAttempt')
        .select('workerId')
        .where('reportId', 'in', reportIds)
        .orderBy('workerId')
        .execute();
      expect(workers.map((row) => row.workerId)).toEqual(['worker-a', 'worker-b']);
    });
  });
});

describe('retrying a failed report', () => {
  test('two simultaneous retries cannot both become attempt 2', async () => {
    // REQUIREMENTS.md allows one retry at a time per report. The insert trigger cannot enforce
    // that by itself: it reads the latest attempt under its own snapshot, so both of these see
    // attempt 1 failed and both are waved through. What actually serialises them is the unique
    // index they then both write to.
    await withCommittedFixture(
      DATABASE,
      async (transaction, trash) => {
        const { organization } = await insertFixtureOrganization(transaction, trash);
        const report = await insertReport(transaction, { organizationId: organization.id });
        await insertAnalysisAttempt(transaction, { reportId: report.id, status: 'failed' });
        return report;
      },
      async (report) => {
        await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
          await alpha.transaction
            .insertInto('analysisAttempt')
            .values({ reportId: report.id, attemptNumber: 2, status: 'pending' })
            .execute();

          const blocked = await sendBlockingStatement(DATABASE, beta, alpha, (transaction) =>
            transaction
              .insertInto('analysisAttempt')
              .values({ reportId: report.id, attemptNumber: 2, status: 'pending' })
              .execute(),
          );

          await alpha.transaction.commit().execute();

          // Both `analysis_attempt_report_id_attempt_number` and
          // `analysis_attempt_one_active_per_report` are violated here. The composite one reports
          // because Postgres maintains indexes in OID order and it was created first, with the
          // table itself. Callers should surface either as a conflict, not an error.
          await expect(blocked.result).rejects.toMatchObject({
            code: POSTGRES_CODE_UNIQUE_VIOLATION,
            constraint: 'analysis_attempt_report_id_attempt_number',
          });
        });

        const attempts = await DATABASE.selectFrom('analysisAttempt')
          .select('attemptNumber')
          .where('reportId', '=', report.id)
          .orderBy('attemptNumber')
          .execute();
        expect(attempts.map((row) => row.attemptNumber)).toEqual([1, 2]);
      },
    );
  });
});

describe('the organization creation limit', () => {
  test('two simultaneous creations cannot both fit under it', async () => {
    // The abuse limit from REQUIREMENTS.md, and the reason `organizations_created_count` is
    // maintained by a trigger rather than by the app: the trigger's read-modify-write happens
    // inside one UPDATE, so the second creation waits on the first's row lock and then counts from
    // what it committed. An app-side `SELECT` followed by `SET count = 5` would lose one of them
    // and let a sixth organization through.
    await withCommittedFixture(
      DATABASE,
      async (transaction, trash) => {
        const user = await insertAppUser(transaction);
        trash.user(user.id);
        await transaction
          .updateTable('appUser')
          .set({ organizationsCreatedCount: 4 })
          .where('id', '=', user.id)
          .execute();
        return user;
      },
      async (user, trash) => {
        await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
          const fifth = await createOrganization(alpha.transaction, user);

          const blocked = await sendBlockingStatement(DATABASE, beta, alpha, (transaction) =>
            createOrganization(transaction, user),
          );

          await alpha.transaction.commit().execute();
          trash.organization(fifth);

          await expect(blocked.result).rejects.toMatchObject({
            code: POSTGRES_CODE_CHECK_VIOLATION,
            constraint: 'app_user_organizations_created_count_max',
          });
        });

        const after = await DATABASE.selectFrom('appUser')
          .select('organizationsCreatedCount')
          .where('id', '=', user.id)
          .executeTakeFirstOrThrow();
        expect(after.organizationsCreatedCount).toBe(5);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function demote(
  transaction: Transaction,
  organizationId: OrganizationId,
  userId: AppUser['id'],
): Promise<void> {
  await transaction
    .updateTable('organizationMember')
    .set({ role: 'member' })
    .where('organizationId', '=', organizationId)
    .where('userId', '=', userId)
    .execute();
}

/** An organization and its one admin, as the app would write them: two statements in one
 * transaction, which is what `organization_has_a_member` being deferred is for. */
async function createOrganization(
  transaction: Transaction,
  admin: AppUser,
): Promise<OrganizationId> {
  const organization = await transaction
    .insertInto('organization')
    .values({ name: fixtureOrganizationName(), createdByUserId: admin.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto('organizationMember')
    .values({ userId: admin.id, organizationId: organization.id, role: 'admin' })
    .execute();
  return organization.id;
}
