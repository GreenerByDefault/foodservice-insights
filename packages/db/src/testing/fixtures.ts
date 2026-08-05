/** Rows to build a test on top of, so a test about one constraint does not spell out the four
 * parents that constraint's table requires.
 *
 * Every helper takes a `DatabaseExecutor` first, like every other query helper, and creates any
 * parent it was not given. They insert real rows through the real triggers — `insertAppUser` gets
 * its `app_user` from the trigger on `auth.users` rather than writing one, and
 * `insertAnalysisAttempt` walks the status machine one `UPDATE` at a time — so a fixture that
 * still works is itself evidence the schema behaves.
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
      rawUserMetaData: overrides.displayName ? { display_name: overrides.displayName } : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  // Written by the `on_auth_user_created` trigger, not by us.
  if (overrides.isSuperadmin !== undefined) {
    await database
      .updateTable('appUser')
      .set({ isSuperadmin: overrides.isSuperadmin })
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

/** An attempt in `status`, reached by the transitions the status machine actually permits.
 *
 * Terminal states cannot be inserted directly and cannot be assembled across two statements,
 * because checks are not deferrable — so this walks pending, then processing, then the terminal
 * update, exactly as a worker would.
 */
export async function insertAnalysisAttempt(
  database: DatabaseExecutor,
  overrides: {
    reportId?: Report['id'];
    attemptNumber?: number;
    status?: AnalysisAttemptStatus;
  } = {},
): Promise<AnalysisAttempt> {
  const reportId = overrides.reportId ?? (await insertReport(database)).id;
  const status = overrides.status ?? 'pending';

  const pending = await database
    .insertInto('analysisAttempt')
    .values({
      reportId,
      attemptNumber: overrides.attemptNumber ?? 1,
      status: 'pending',
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  if (status === 'pending') return pending;

  // A `canceled` attempt may never have been claimed, so it skips straight to terminal.
  if (status !== 'canceled') {
    await database
      .updateTable('analysisAttempt')
      .set({
        status: 'processing',
        workerId: 'test-worker',
        lockedAt: new Date(),
        lastHeartbeatAt: new Date(),
      })
      .where('id', '=', pending.id)
      .execute();
  }

  if (status === 'processing') {
    return await database
      .selectFrom('analysisAttempt')
      .selectAll()
      .where('id', '=', pending.id)
      .executeTakeFirstOrThrow();
  }

  return await database
    .updateTable('analysisAttempt')
    .set({
      status,
      finishedAt: new Date(),
      failureReason: status === 'failed' ? 'child_crashed' : null,
    })
    .where('id', '=', pending.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}
