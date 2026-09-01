/** A private organization, for anything that needs to control the *whole* reports list rather
 * than one report inside it — the empty state, pagination, or a screenshot whose contents must be
 * fully known. `reports.ts`'s fixtures all assume the shared placeholder organization, which
 * every other spec is also writing to; see the plan's "Test isolation" section
 * (`.claude/plans/organization-reports-list.md`) for why that split exists.
 *
 * Names collide on `organization_name_unique_ci`, so every caller passes its own unique one — a
 * random suffix for a behavioural spec, a fixed name for a screenshot whose committed image
 * renders it.
 */

import type { AnalysisAttemptStatus, Database, OrganizationId, UserId } from '@gbd/db';
import { withTransaction } from '@gbd/db';
import { PLACEHOLDER_USER_ID } from '@gbd/db/seed';
import {
  insertAnalysisAttempt,
  insertInputFile,
  insertReport,
  insertResultFile,
} from '@gbd/db/testing';
import type { Kysely, Transaction } from 'kysely';

export type OrganizationReportSpec = {
  name: string;
  siteName?: string;
  createdByUserId?: UserId | null;
  createdAt: Date;
  status: AnalysisAttemptStatus;
  claimedAt?: Date;
  finishedAt?: Date;
  cancelRequestedAt?: Date;
};

/** One committed report: the input file (and, for `succeeded`, both result files) have to land
 * in the same transaction as the report — `report_has_an_input_file` and
 * `analysis_attempt_succeeded_has_result_files` are both `DEFERRABLE INITIALLY DEFERRED`, so they
 * only fire at `COMMIT`.
 */
async function insertOrganizationReport(
  tx: Transaction<Database>,
  organizationId: OrganizationId,
  spec: OrganizationReportSpec,
): Promise<void> {
  const report = await insertReport(tx, {
    organizationId,
    name: spec.name,
    siteName: spec.siteName ?? null,
    createdByUserId: spec.createdByUserId ?? null,
    createdAt: spec.createdAt,
  });
  await insertInputFile(tx, { reportId: report.id });
  const attempt = await insertAnalysisAttempt(tx, {
    reportId: report.id,
    status: spec.status,
    createdAt: spec.createdAt,
    claimedAt: spec.claimedAt,
    finishedAt: spec.finishedAt,
    cancelRequestedAt: spec.cancelRequestedAt,
  });
  if (spec.status === 'succeeded') {
    await insertResultFile(tx, { analysisAttemptId: attempt.id, kind: 'pdf' });
    await insertResultFile(tx, { analysisAttemptId: attempt.id, kind: 'xlsx' });
  }
}

/** Commit a private organization with the placeholder user as its only (admin) member — the only
 * identity `identifyUser` can ever produce — and, optionally, its reports. Returns the
 * organization's id.
 */
export async function insertOrganizationFixture(
  db: Kysely<Database>,
  spec: { name: string; reports?: OrganizationReportSpec[] },
): Promise<OrganizationId> {
  return await withTransaction(db, async (tx) => {
    const organization = await tx
      .insertInto('organization')
      .values({ name: spec.name, createdByUserId: PLACEHOLDER_USER_ID })
      .returningAll()
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('organizationMember')
      .values({ userId: PLACEHOLDER_USER_ID, organizationId: organization.id, role: 'admin' })
      .execute();

    for (const report of spec.reports ?? []) {
      await insertOrganizationReport(tx, organization.id, report);
    }

    return organization.id;
  });
}

/** Deletes the organization and everything hanging off it: `organization_member` and `report`
 * both cascade from it, and `report`'s own children cascade from there.
 */
export async function clearOrganizationFixture(
  db: Kysely<Database>,
  organizationId: OrganizationId,
): Promise<void> {
  await db.deleteFrom('organization').where('id', '=', organizationId).execute();
}
