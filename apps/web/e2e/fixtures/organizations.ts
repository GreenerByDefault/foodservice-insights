/** A private organization, for anything that needs to control the *whole* reports list rather
 * than one report inside it — the empty state, pagination, or a screenshot whose contents must be
 * fully known — or that needs the placeholder user in several organizations at once.
 *
 * Names collide on `organization_name_unique_ci`, so every caller passes its own unique one — a
 * random suffix for a behavioural spec, a fixed name for a screenshot whose committed image
 * renders it.
 */

import type {
  AnalysisAttemptStatus,
  Database,
  OrganizationId,
  OrganizationRole,
  UserId,
} from '@gbd/db';
import { withTransaction } from '@gbd/db';
import { PLACEHOLDER_USER_ID } from '@gbd/db/seed';
import {
  insertAnalysisAttempt,
  insertAppUser,
  insertInputFile,
  insertOrganization,
  insertOrganizationMember,
  insertReport,
  insertResultFile,
} from '@gbd/db/testing';
import type { Kysely, RawBuilder, Transaction } from 'kysely';

export type OrganizationMemberSpec = {
  displayName?: string;
  /** Defaults to a random address — set this for a screenshot spec, whose committed image needs
   * the same text on every run, unlike a behavioural spec that only asserts the row exists. */
  email?: string;
  role?: OrganizationRole;
};

export type OrganizationReportSpec = {
  name: string;
  siteName?: string;
  createdByUserId?: UserId | null;
  createdAt: Date | RawBuilder<Date>;
  status: AnalysisAttemptStatus;
  claimedAt?: Date | RawBuilder<Date>;
  finishedAt?: Date | RawBuilder<Date>;
  cancelRequestedAt?: Date | RawBuilder<Date>;
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

/** Commit a private organization the placeholder user belongs to — the only identity
 * `identifyUser` can ever produce — with, optionally, its reports. Returns the organization's id.
 *
 * `role` decides who *else* is in it. As an `admin` the placeholder is also the creator and the
 * sole member. As a `member` the organization is created and admin'd by a fresh, disposable user
 * instead, which a spec needs whenever it looks at the app through non-admin eyes: a member's
 * view of settings or the roster only proves anything with a real admin sitting elsewhere.
 *
 * Everything commits in one transaction either way. For `member` that is load-bearing rather
 * than tidy: `organization_check_has_member` is `DEFERRABLE INITIALLY DEFERRED`, checked at
 * `COMMIT`, so `insertOrganization`'s own admin-membership insert has to still be uncommitted
 * when the placeholder's runs — two separate auto-committed statements would let the
 * organization row commit with zero members and fail that constraint before this ever adds one.
 */
export async function insertOrganizationFixture(
  db: Kysely<Database>,
  spec: {
    name: string;
    reports?: OrganizationReportSpec[];
    role?: OrganizationRole;
    members?: OrganizationMemberSpec[];
  },
): Promise<OrganizationId> {
  const role = spec.role ?? 'admin';

  return await withTransaction(db, async (tx) => {
    const organizationId = await insertOrganizationFor(tx, spec.name, role);

    await tx
      .insertInto('organizationMember')
      .values({ userId: PLACEHOLDER_USER_ID, organizationId, role })
      .execute();

    for (const report of spec.reports ?? []) {
      await insertOrganizationReport(tx, organizationId, report);
    }

    for (const member of spec.members ?? []) {
      const user = await insertAppUser(tx, {
        displayName: member.displayName,
        email: member.email,
      });
      await insertOrganizationMember(tx, { organizationId, userId: user.id, role: member.role });
    }

    return organizationId;
  });
}

/** The organization row, plus — for `member` — the disposable admin that has to own it. */
async function insertOrganizationFor(
  tx: Transaction<Database>,
  name: string,
  role: OrganizationRole,
): Promise<OrganizationId> {
  if (role === 'member') {
    const { organization } = await insertOrganization(tx, { name });
    return organization.id;
  }

  const organization = await tx
    .insertInto('organization')
    .values({ name, createdByUserId: PLACEHOLDER_USER_ID })
    .returning('id')
    .executeTakeFirstOrThrow();
  return organization.id;
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
