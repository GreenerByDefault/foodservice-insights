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

import type { AnalysisAttempt } from '../generated/public/AnalysisAttempt.ts';
import type AnalysisAttemptStatus from '../generated/public/AnalysisAttemptStatus.ts';
import type { AppUser } from '../generated/public/AppUser.ts';
import type { InputFile } from '../generated/public/InputFile.ts';
import type { Organization } from '../generated/public/Organization.ts';
import type { Report } from '../generated/public/Report.ts';
import type { DatabaseExecutor } from '../schema.ts';

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
    name: string | null;
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
  overrides: { reportId?: Report['id']; storageKey?: string } = {},
): Promise<InputFile> {
  const reportId = overrides.reportId ?? (await insertReport(database)).id;

  return await database
    .insertInto('inputFile')
    .values({
      reportId,
      storageKey: overrides.storageKey ?? `org/test/${crypto.randomUUID()}.csv`,
      byteSize: 1024,
      contentType: 'text/csv',
      originalFilename: 'procurement.csv',
      checksumSha256: aChecksum(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** An attempt in `status`, with whatever other columns that status's CHECK constraints require —
 * `finished_at` for a terminal status, `worker_id`/`locked_at`/`last_heartbeat_at` for
 * `processing`. See `analysis_attempt` in schema.sql for the constraints themselves.
 */
export async function insertAnalysisAttempt(
  database: DatabaseExecutor,
  overrides: {
    reportId?: Report['id'];
    attemptNumber?: number;
    status?: AnalysisAttemptStatus;
    workerId?: string;
  } = {},
): Promise<AnalysisAttempt> {
  const reportId = overrides.reportId ?? (await insertReport(database)).id;
  const status = overrides.status ?? 'pending';

  const isProcessing = status === 'processing';
  const isTerminal = status === 'succeeded' || status === 'failed' || status === 'canceled';

  return await database
    .insertInto('analysisAttempt')
    .values({
      reportId,
      attemptNumber: overrides.attemptNumber ?? 1,
      status,
      ...(isProcessing
        ? {
            workerId: overrides.workerId ?? 'test-worker',
            lockedAt: new Date(),
            lastHeartbeatAt: new Date(),
          }
        : {}),
      ...(isTerminal
        ? { finishedAt: new Date(), failureReason: status === 'failed' ? 'child_crashed' : null }
        : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
