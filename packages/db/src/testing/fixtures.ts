/** Rows to build a test on top of, so a test about one constraint does not spell out the four
 * parents that constraint's table requires.
 *
 * Every helper takes a `DatabaseExecutor` first, like every other query helper, and creates any
 * parent it was not given. Where a table's invariant is enforced by a trigger rather than a plain
 * constraint, the helper goes through that trigger instead of writing the row directly —
 * `insertAppUser` gets its `app_user` from the trigger on `auth.users`, and `insertOrganization`
 * relies on the deferred trigger that requires an admin. A fixture that still works is itself
 * evidence the schema behaves.
 *
 * Values that must be unique are randomised, because tests run concurrently against one database.
 */

import { sql } from 'kysely';
import type { UsersId } from '../generated/auth/Users.ts';
import type { AnalysisAttempt } from '../generated/public/AnalysisAttempt.ts';
import type AnalysisAttemptStatus from '../generated/public/AnalysisAttemptStatus.ts';
import type AnalysisFailureReason from '../generated/public/AnalysisFailureReason.ts';
import type { AppUser } from '../generated/public/AppUser.ts';
import type { InputFile } from '../generated/public/InputFile.ts';
import type { Organization } from '../generated/public/Organization.ts';
import type { Report } from '../generated/public/Report.ts';
import type { ResultFile } from '../generated/public/ResultFile.ts';
import type ResultFileKind from '../generated/public/ResultFileKind.ts';
import type { DatabaseExecutor } from '../schema.ts';

/** Postgres's clock, not the process's, for any timestamp a fixture means as "now". Pass this,
 * not `new Date()`, to any override below that means "right now" — a `created_at` a caller left
 * defaulted is also Postgres's `now()`, so a JS-clock value raced against it can land on either
 * side of a check constraint under load. */
export const NOW = sql<Date>`now()`;

/** A 32-byte checksum, the only length `checksum_sha256` accepts. */
export function aChecksum(): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
}

export async function insertAppUser(
  database: DatabaseExecutor,
  overrides: { displayName?: string; isSuperadmin?: boolean } = {},
): Promise<AppUser> {
  const { id } = await database
    .insertInto('auth.users')
    .values({
      id: crypto.randomUUID() as AppUser['id'],
      email: `${crypto.randomUUID()}@example.test`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  // The `app_user` row itself is written by the `on_auth_user_created` trigger, not by us.
  // These fields have to be set manually afterwards.
  if (overrides.displayName !== undefined || overrides.isSuperadmin !== undefined) {
    await database
      .updateTable('appUser')
      .set({
        ...(overrides.displayName !== undefined ? { displayName: overrides.displayName } : {}),
        ...(overrides.isSuperadmin !== undefined ? { isSuperadmin: overrides.isSuperadmin } : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  return await database
    .selectFrom('appUser')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

/** `email` lives on `auth.users`, not the `app_user` row `insertAppUser` returns, so this reads
 * it back separately. */
export async function insertAppUserWithEmail(
  database: DatabaseExecutor,
): Promise<{ id: AppUser['id']; email: string }> {
  const user = await insertAppUser(database);
  const { email } = await database
    .selectFrom('auth.users')
    .select('email')
    .where('id', '=', user.id)
    .executeTakeFirstOrThrow();
  return { id: user.id, email: email as string };
}

/** An organization and the admin it must have. Anything else would fail its deferred trigger. */
export async function insertOrganization(
  database: DatabaseExecutor,
  overrides: { name?: string } = {},
): Promise<{ organization: Organization; admin: AppUser }> {
  const admin = await insertAppUser(database);

  const organization = await database
    .insertInto('organization')
    .values({
      name: overrides.name ?? `Test org ${crypto.randomUUID()}`,
      createdByUserId: admin.id,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await database
    .insertInto('organizationMember')
    .values({ userId: admin.id, organizationId: organization.id, role: 'admin' })
    .execute();

  return { organization, admin };
}

export async function insertReport(
  database: DatabaseExecutor,
  overrides: Partial<{
    organizationId: Organization['id'];
    createdByUserId: AppUser['id'] | null;
    name: string;
    siteName: string | null;
    monthlyCounts: unknown;
    createdAt: Date;
  }> = {},
): Promise<Report> {
  const organizationId =
    overrides.organizationId ?? (await insertOrganization(database)).organization.id;

  return await database
    .insertInto('report')
    .values({
      organizationId,
      createdByUserId: overrides.createdByUserId ?? null,
      name: overrides.name ?? 'Q1 procurement',
      siteName: overrides.siteName ?? null,
      countsBasis: 'people',
      monthlyCounts: overrides.monthlyCounts ?? { '2026-01': 120, '2026-02': 135 },
      unitSystem: 'lb',
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function insertInputFile(
  database: DatabaseExecutor,
  overrides: {
    reportId?: Report['id'];
    storageKey?: string;
    object?: { byteSize: number; checksumSha256: Buffer };
  } = {},
): Promise<InputFile> {
  const reportId = overrides.reportId ?? (await insertReport(database)).id;

  return await database
    .insertInto('inputFile')
    .values({
      reportId,
      storageKey: overrides.storageKey ?? `org/test/${crypto.randomUUID()}.csv`,
      byteSize: overrides.object?.byteSize ?? 1024,
      contentType: 'text/csv',
      originalFilename: 'procurement.csv',
      checksumSha256: overrides.object?.checksumSha256 ?? aChecksum(),
      isModified: false,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** An attempt in `status`, with whatever other columns make it a state the app can actually
 * produce:
 * - `finished_at` for any terminal status.
 * - `worker_id`/`claimed_at`/`lease_renewed_at` for `processing`, `succeeded`, and `failed` —
 *   reaching one of those means the worker claimed the attempt first. The CHECK constraints
 *   don't require this; the state machine does.
 * - `canceled` is the exception: `ARCHITECTURE.md` § Canceling allows canceling a `pending`
 *   attempt that was never claimed.
 *
 * See `analysis_attempt` in schema.sql for the constraints themselves.
 */
export async function insertAnalysisAttempt(
  database: DatabaseExecutor,
  overrides: {
    reportId?: Report['id'];
    attemptNumber?: number;
    status?: AnalysisAttemptStatus;
    workerId?: string;
    requestedByUserId?: UsersId | null;
    createdAt?: Date;
    /** Only meaningful for `processing`, `succeeded`, and `failed` — the statuses a claim implies.
     * Defaults to `finishedAt` so a terminal row's claim and finish line up without repeating the
     * timestamp; set this explicitly to backdate a claim on a `processing` row, which has no
     * `finishedAt` of its own. */
    claimedAt?: Date;
    /** Only meaningful for a terminal `status` — once inserted, `analysis_attempt_terminal_is_final`
     * forbids ever moving this by `UPDATE`, so a backdated terminal row has to be born that way. */
    finishedAt?: Date;
    /** Defaults to `NOW` for `status: 'canceled'`, since `analysis_attempt_canceled_requires_request`
     * forbids a canceled row with no request. Set explicitly for a `pending`/`processing` row a test
     * wants to look like a cancel request has already landed on — pass `NOW` rather than `new Date()`
     * unless the test needs a specific value. */
    cancelRequestedAt?: Date | typeof NOW;
    /** Only meaningful for `status: 'failed'` — `analysis_attempt_failure_reason_iff_failed` requires
     * one there and forbids one everywhere else. Defaults to `'child_crashed'`, an arbitrary member of
     * `analysis_failure_reason`; set this to exercise a specific reason's copy. */
    failureReason?: AnalysisFailureReason;
  } = {},
): Promise<AnalysisAttempt> {
  const reportId = overrides.reportId ?? (await insertReport(database)).id;
  const status = overrides.status ?? 'pending';

  const isClaimed = status === 'processing' || status === 'succeeded' || status === 'failed';
  const isTerminal = status === 'succeeded' || status === 'failed' || status === 'canceled';
  const isCanceled = status === 'canceled';

  return await database
    .insertInto('analysisAttempt')
    .values({
      reportId,
      attemptNumber: overrides.attemptNumber ?? 1,
      status,
      requestedByUserId: overrides.requestedByUserId ?? null,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      // A backdated finishedAt still has to satisfy analysis_attempt_finished_at_after_lease_renewed,
      // so a claim added on the caller's behalf must not be later than it — hence claimedAt falling
      // back to finishedAt when the caller only backdated the finish.
      ...(isClaimed
        ? {
            workerId: overrides.workerId ?? 'test-worker',
            claimedAt: overrides.claimedAt ?? overrides.finishedAt ?? NOW,
            leaseRenewedAt: overrides.claimedAt ?? overrides.finishedAt ?? NOW,
          }
        : {}),
      ...(isTerminal
        ? {
            finishedAt: overrides.finishedAt ?? NOW,
            failureReason:
              status === 'failed' ? (overrides.failureReason ?? 'child_crashed') : null,
          }
        : {}),
      ...(overrides.cancelRequestedAt !== undefined
        ? { cancelRequestedAt: overrides.cancelRequestedAt }
        : isCanceled
          ? { cancelRequestedAt: NOW }
          : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** A report and the one attempt on it, for a test about acting on a report rather than about
 * either row's own constraints. Defaults to `pending` — the state a report just submitted is in,
 * and the one an action like canceling or deleting has something to do about.
 */
export async function insertReportWithAttempt(
  database: DatabaseExecutor,
  overrides: {
    organizationId?: Organization['id'];
    createdByUserId?: AppUser['id'] | null;
    status?: AnalysisAttemptStatus;
  } = {},
): Promise<{ report: Report; attempt: AnalysisAttempt }> {
  const report = await insertReport(database, {
    organizationId: overrides.organizationId,
    createdByUserId: overrides.createdByUserId ?? null,
  });
  const attempt = await insertAnalysisAttempt(database, {
    reportId: report.id,
    status: overrides.status ?? 'pending',
  });
  return { report, attempt };
}

export async function readAnalysisAttemptRow(
  database: DatabaseExecutor,
  attemptId: AnalysisAttempt['id'],
): Promise<AnalysisAttempt> {
  return await database
    .selectFrom('analysisAttempt')
    .selectAll()
    .where('id', '=', attemptId)
    .executeTakeFirstOrThrow();
}

const RESULT_FILE_TEST_CONTENT_TYPE: Record<ResultFileKind, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export async function insertResultFile(
  database: DatabaseExecutor,
  overrides: {
    analysisAttemptId?: AnalysisAttempt['id'];
    kind?: ResultFileKind;
    storageKey?: string;
  } = {},
): Promise<ResultFile> {
  const analysisAttemptId =
    overrides.analysisAttemptId ?? (await insertAnalysisAttempt(database)).id;
  const kind = overrides.kind ?? 'pdf';

  return await database
    .insertInto('resultFile')
    .values({
      analysisAttemptId,
      kind,
      storageKey: overrides.storageKey ?? `org/test/${crypto.randomUUID()}.${kind}`,
      byteSize: 1024,
      contentType: RESULT_FILE_TEST_CONTENT_TYPE[kind],
      checksumSha256: aChecksum(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
