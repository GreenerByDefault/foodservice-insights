/** Tests for the invariants that only exist between two transactions.
 *
 * `withRollback` is the rule everywhere else and cannot express these: a single transaction never
 * blocks on its own locks and never sees another snapshot, so a schema whose locking was deleted
 * outright still passes every test written that way. **Wrapping one of these tests in
 * `withRollback` does not fail it — it silently makes it prove nothing.**
 *
 * Committing is safe here despite the no-truncate isolation model (see `global-setup.ts`) because
 * every row a test commits hangs off an organization it created, and `withCommittedFixture` deletes
 * those roots however the test ends. A run killed before teardown is caught by the age-bounded
 * sweep below.
 */

import { type ControlledTransaction, type Kysely, sql, type Transaction } from 'kysely';
import { DatabaseError } from 'pg';
import type { UsersId } from '../generated/auth/Users.ts';
import type { AppUser } from '../generated/public/AppUser.ts';
import type { Organization, OrganizationId } from '../generated/public/Organization.ts';
import {
  POSTGRES_CODE_LOCK_NOT_AVAILABLE,
  POSTGRES_CODE_QUERY_CANCELED,
} from '../postgres-codes.ts';
import type { Database, DatabaseExecutor } from '../schema.ts';
import { insertOrganization } from './fixtures.ts';

/** How long a statement may wait on a lock before the harness gives up on it. Replaces the pool's
 * `idle_in_transaction_session_timeout`, which these transactions have to switch off.
 *
 * Both budgets stay well under vitest's 5s per-test timeout on purpose. A test that hangs where it
 * should not is a result — it means something now blocks that used to run — and it is only legible
 * if the harness is what reports it. */
const LOCK_TIMEOUT_MS = 2_000;

/** How long to wait for a dispatched statement to actually reach the lock it should wait on. */
const BLOCK_TIMEOUT_MS = 2_000;

const POLL_INTERVAL_MS = 5;

/** Fixture organizations carry this prefix so a later run can recognise ones left behind. */
const FIXTURE_NAME_PREFIX = 'Concurrency fixture ';

/** How old an abandoned fixture must be before the sweep will touch it. Long enough that no
 * still-running test could own it, which is what makes sweeping safe at all. */
const FIXTURE_STALE_AFTER = '10 minutes';

// ---------------------------------------------------------------------------
// Concurrent transactions
// ---------------------------------------------------------------------------

/** One open transaction, and the Postgres backend running it. */
export interface ConcurrentTransaction {
  /** Pass this to query helpers as their `DatabaseExecutor`, like any other transaction. */
  readonly transaction: ControlledTransaction<Database>;
  /** Its backend process id. `sendBlockingStatement` uses it to tell a real lock wait from a
   * statement that simply has not been dispatched yet. */
  readonly pid: number;
}

/** Open two transactions at once, and close whichever ones the body leaves open.
 *
 * Cleanup is the whole reason this is a wrapper rather than two `startTransaction()` calls: a
 * transaction that blocks, or whose `COMMIT` fails, does not release its pooled connection on its
 * own, and the pool only has ten.
 */
export async function withConcurrentTransactions<T>(
  database: Kysely<Database>,
  body: (first: ConcurrentTransaction, second: ConcurrentTransaction) => Promise<T>,
): Promise<T> {
  const opened: ConcurrentTransaction[] = [];
  try {
    const first = await openTransaction(database);
    opened.push(first);
    const second = await openTransaction(database);
    opened.push(second);
    return await body(first, second);
  } finally {
    await closeAll(database, opened);
  }
}

async function openTransaction(database: Kysely<Database>): Promise<ConcurrentTransaction> {
  const transaction = await database.startTransaction().execute();

  // These transactions exist to sit idle holding a lock, which is exactly what the pool's
  // `idle_in_transaction_session_timeout` kills — and being killed looks identical to the schema
  // allowing the write the test expected it to refuse. `lock_timeout` takes over the job of
  // bounding the damage, and `asHarnessFailure` labels it so it cannot read as a schema error.
  await sql`SET LOCAL idle_in_transaction_session_timeout = 0`.execute(transaction);
  await sql`SET LOCAL lock_timeout = ${sql.lit(LOCK_TIMEOUT_MS)}`.execute(transaction);

  return { transaction, pid: await backendPid(transaction) };
}

async function closeAll(
  database: Kysely<Database>,
  opened: readonly ConcurrentTransaction[],
): Promise<void> {
  // A committed or rolled back transaction has already handed its connection back to the pool,
  // where another query may be using it by now. Cancelling its backend would then cancel that
  // query instead, so the pid is only safe to touch while the transaction still owns it.
  const dangling = opened.filter(
    ({ transaction }) => !transaction.isCommitted && !transaction.isRolledBack,
  );

  // Cancel from the pool, not from the transaction itself: node-pg serialises queries per
  // connection, so a `ROLLBACK` sent to a backend that is still waiting on a lock queues up behind
  // that wait rather than ending it.
  for (const { pid } of dangling) {
    await sql`SELECT pg_cancel_backend(${pid})`.execute(database).catch(() => {});
  }

  for (const { transaction } of dangling) {
    // Reached by a transaction whose `COMMIT` failed too — Kysely sets neither state flag and
    // releases no connection until one of the two commands resolves, so this rollback is what
    // returns the connection to the pool. The `ROLLBACK` itself is a no-op by then.
    await transaction
      .rollback()
      .execute()
      .catch(() => {});
  }
}

async function backendPid(executor: DatabaseExecutor): Promise<number> {
  const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(executor);
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('concurrency harness: could not read the backend pid');
  return pid;
}

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

/** A statement that is currently waiting on a lock. */
export interface BlockedStatement<T> {
  /** Settles once the blocker commits or rolls back. Await it only after that has happened. */
  readonly result: Promise<T>;
}

/** Dispatch `statement` on `blocked`, and resolve once it is genuinely waiting on a lock held by
 * `blockedBy`.
 *
 * Throwing when the statement *doesn't* block is the point. Every test using this is of the form
 * "the second writer must not get through", and every one of them passes trivially against a
 * schema that lost its locking. Failing here is what stops that.
 *
 * The result is wrapped in an object because an `async` function cannot return a pending promise.
 */
export async function sendBlockingStatement<T>(
  database: Kysely<Database>,
  blocked: ConcurrentTransaction,
  blockedBy: ConcurrentTransaction,
  statement: (transaction: ControlledTransaction<Database>) => Promise<T>,
): Promise<BlockedStatement<T>> {
  // The handler goes on at creation rather than where the caller awaits it: this promise stays
  // pending for the rest of the test and rejects part-way through, which Node reports as an
  // unhandled rejection if nothing is listening by then.
  const result = statement(blocked.transaction).catch((error: unknown) => {
    throw asHarnessFailure(error) ?? error;
  });

  let settled: { error?: unknown } | undefined;
  result.then(
    () => {
      settled = {};
    },
    (error: unknown) => {
      settled = { error };
    },
  );

  const deadline = Date.now() + BLOCK_TIMEOUT_MS;
  for (;;) {
    if (await isBlockedBy(database, blocked.pid, blockedBy.pid)) return { result };

    // Checked after the lock, never before: a statement can only be settled-and-not-blocked, and
    // reporting that as a timeout would hide which of the two happened.
    if (settled) throw neverBlocked(settled.error);
    if (Date.now() > deadline) {
      throw new Error(
        `concurrency harness: backend ${blocked.pid} did not start waiting on backend ` +
          `${blockedBy.pid} within ${BLOCK_TIMEOUT_MS}ms`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** `pg_blocking_pids` rather than a `pg_stat_activity` wait event, for two reasons: it names the
 * blocker, so a test cannot pass on an unrelated wait, and it reads live lock manager state.
 * `pg_stat_activity` caches its backend status array for the whole of a transaction, so a poll loop
 * built on it returns the same stale row until it times out. */
async function isBlockedBy(
  database: Kysely<Database>,
  blockedPid: number,
  blockerPid: number,
): Promise<boolean> {
  const { rows } = await sql<{ blockers: number[] }>`
    SELECT pg_blocking_pids(${blockedPid}) AS blockers
  `.execute(database);
  return rows[0]?.blockers.includes(blockerPid) ?? false;
}

function neverBlocked(error: unknown): Error {
  if (error === undefined) {
    return new Error(
      'concurrency harness: the statement completed instead of blocking, so nothing serialised ' +
        'the two transactions',
    );
  }
  return new Error(
    `concurrency harness: the statement failed instead of blocking: ${String(error)}`,
    { cause: error },
  );
}

/** Neither of these is ever a verdict about the schema: one means the blocker held its lock for
 * longer than the test allows, the other that cleanup cancelled the statement. Left unlabelled they
 * arrive as a `DatabaseError` at an `expect(...).rejects` and read as a genuine rejection. */
function asHarnessFailure(error: unknown): Error | undefined {
  if (!(error instanceof DatabaseError)) return undefined;
  if (error.code === POSTGRES_CODE_LOCK_NOT_AVAILABLE) {
    return new Error(
      `concurrency harness: the blocked statement waited more than ${LOCK_TIMEOUT_MS}ms, so the ` +
        'transaction blocking it never finished',
      { cause: error },
    );
  }
  if (error.code === POSTGRES_CODE_QUERY_CANCELED) {
    return new Error(
      'concurrency harness: the blocked statement was cancelled, which only cleanup does',
      { cause: error },
    );
  }
  return undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ---------------------------------------------------------------------------
// Committed fixtures
// ---------------------------------------------------------------------------

/** Where a test declares the rows teardown has to delete.
 *
 * Only the roots: deleting an organization cascades to its members, invites, reports, and
 * everything hanging off those. `audit_event` has no foreign keys by design, so a test that writes
 * audit rows has to delete them itself.
 */
export interface Trash {
  organization(id: OrganizationId): void;
  user(id: UsersId): void;
}

/** Commit the rows a test needs, run it, then delete them however it ends. */
export async function withCommittedFixture<F, T>(
  database: Kysely<Database>,
  setUp: (transaction: Transaction<Database>, trash: Trash) => Promise<F>,
  body: (fixture: F, trash: Trash) => Promise<T>,
): Promise<T> {
  await sweepStaleFixtures(database);

  const organizationIds: OrganizationId[] = [];
  const userIds: UsersId[] = [];
  const trash: Trash = {
    organization: (id) => {
      organizationIds.push(id);
    },
    user: (id) => {
      userIds.push(id);
    },
  };

  // One transaction rather than statement-level autocommit, because `organization_has_a_member` is
  // deferred to commit: autocommit would end the organization's own insert with no member yet and
  // die there. Nothing is committed if `setUp` throws, so there is nothing to tear down either.
  const fixture = await database
    .transaction()
    .execute(async (transaction) => await setUp(transaction, trash));

  try {
    return await body(fixture, trash);
  } finally {
    // One transaction, so the order of the deletes cannot matter: the at-least-one-admin trigger is
    // deferred, and by commit time the organizations are gone too, which is the case it returns
    // early for. Split them and the order matters again — deleting the users first cascades away
    // the members and strands a live organization with no admin.
    await database.transaction().execute(async (transaction) => {
      if (organizationIds.length > 0) {
        await transaction.deleteFrom('organization').where('id', 'in', organizationIds).execute();
      }
      if (userIds.length > 0) {
        await transaction.deleteFrom('auth.users').where('id', 'in', userIds).execute();
      }
    });
  }
}

export type RaceAgainstCommittedWriteOptions = {
  /** Which side opens its transaction first — decides whether the blocked statement's own `now()`
   * predates the write it is racing. Defaults to the writer opening first, the common case. */
  blockedOpensFirst?: boolean;
};

/** Races `blockedStatement` against `firstWriter`'s commit: `blockedStatement` starts while
 * `firstWriter`'s write is still uncommitted, blocks on it, and only proceeds once that write
 * commits. Use this to test that a statement waits for a concurrent write instead of skipping
 * past it — row-level locking, `SELECT ... FOR UPDATE`, anything where "sees the committed
 * row" is the behavior under test.
 */
export async function raceAgainstCommittedWrite<F, T, R>(
  database: Kysely<Database>,
  setup: (transaction: Transaction<Database>, trash: Trash) => Promise<F>,
  firstWriter: (transaction: ControlledTransaction<Database>, fixture: F) => Promise<void>,
  blockedStatement: (transaction: ControlledTransaction<Database>, fixture: F) => Promise<T>,
  readBack: (database: Kysely<Database>, fixture: F) => Promise<R>,
  options: RaceAgainstCommittedWriteOptions = {},
): Promise<{ result: T; row: R }> {
  return await withCommittedFixture(database, setup, async (fixture) => {
    const result = await withConcurrentTransactions(database, async (alpha, beta) => {
      // `alpha` opens first, so its `now()` is the earlier of the two.
      const [writer, blocked] = options.blockedOpensFirst ? [beta, alpha] : [alpha, beta];
      await firstWriter(writer.transaction, fixture);

      // The blocked statement has to block on the writer's uncommitted row, not skip past it.
      const blockedCall = await sendBlockingStatement(database, blocked, writer, (transaction) =>
        blockedStatement(transaction, fixture),
      );

      await writer.transaction.commit().execute();
      const outcome = await blockedCall.result;
      // Committing here is what makes `readBack`'s result mean anything: a rolled-back
      // statement leaves the row untouched whatever its `WHERE` matched, so a test that only
      // inspects the row afterwards would pass against a statement with no predicate at all.
      await blocked.transaction.commit().execute();
      return outcome;
    });

    return { result, row: await readBack(database, fixture) };
  });
}

/** A name the sweep below will recognise. Use it for any organization a test commits itself. */
export function fixtureOrganizationName(): string {
  return `${FIXTURE_NAME_PREFIX}${crypto.randomUUID()}`;
}

/** `insertOrganization`, named so it can be swept and registered so it is torn down. */
export async function insertFixtureOrganization(
  transaction: Transaction<Database>,
  trash: Trash,
): Promise<{ organization: Organization; admin: AppUser }> {
  const created = await insertOrganization(transaction, { name: fixtureOrganizationName() });
  trash.organization(created.organization.id);
  trash.user(created.admin.id);
  return created;
}

let sweep: Promise<void> | undefined;

/** Delete fixtures an earlier run left behind, after `--bail`, a Ctrl-C, or an OOM kill.
 *
 * Bounded by age rather than by this run's ids, because test files run concurrently against one
 * database: a sweep that could reach a live fixture would break the test beside it. Orphaned
 * `auth.users` rows are left alone — they collide with nothing, and `pnpm test` ends with the e2e
 * suite, which truncates.
 */
function sweepStaleFixtures(database: Kysely<Database>): Promise<void> {
  sweep ??= (async () => {
    await database
      .deleteFrom('organization')
      .where('name', 'like', `${FIXTURE_NAME_PREFIX}%`)
      .where('createdAt', '<', sql<Date>`now() - ${sql.lit(FIXTURE_STALE_AFTER)}::interval`)
      .execute();
  })();
  return sweep;
}
