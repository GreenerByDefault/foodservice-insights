/** A private organization built to a spec — members, invites, a whole list of reports — beyond
 * the plain one `@gbd/browser-testing/fixtures`' `org` already gives every test. For anything
 * that needs to control the *whole* reports list rather than one report inside it, that needs to
 * look at the app through a non-admin's eyes, or that needs the signed-in user in several
 * organizations at once.
 *
 * Names collide on `organization_name_unique_ci`, so every caller passes its own unique one — a
 * random suffix for a behavioural spec, a fixed name for a screenshot whose committed image
 * renders it.
 */

import type {
  Database,
  DatabaseExecutor,
  OrganizationId,
  OrganizationInviteStatus,
  OrganizationRole,
  ReportId,
  UserId,
} from '@gbd/db';
import { withTransaction } from '@gbd/db';
import { insertAppUser, insertOrganization, insertOrganizationMember } from '@gbd/db/testing';
import { type Kysely, sql } from 'kysely';
import { deriveOrganizationSlug } from '../../src/lib/server/orgs/slug.ts';
import { insertReportWithAttempt, type ReportWithAttemptSpec } from './reports.ts';

export type OrganizationMemberSpec = {
  displayName?: string;
  /** Defaults to a random address — set this for a screenshot spec, whose committed image needs
   * the same text on every run, unlike a behavioural spec that only asserts the row exists. */
  email?: string;
  role?: OrganizationRole;
};

/** The disposable user who admins the organization when the signed-in user joins it as a
 * `member`. Left out, that admin keeps the random identity `insertOrganization` mints — which a
 * screenshot spec cannot have, since the roster it captures renders this person's row. */
export type OrganizationAdminSpec = Omit<OrganizationMemberSpec, 'role'>;

export type OrganizationReportSpec = Omit<ReportWithAttemptSpec, 'organizationId'>;

export type OrganizationInviteSpec = {
  /** Defaults to a random address, the same rationale as `OrganizationMemberSpec.email`. */
  email?: string;
  role?: OrganizationRole;
  status?: OrganizationInviteStatus;
};

/** Commit a private organization `userId` belongs to, with, optionally, its reports. Returns the
 * organization's id and the ids of the reports it minted, in the order given.
 *
 * `role` decides who *else* is in it. As an `admin` the user is also the creator and the sole
 * member. As a `member` the organization is created and admin'd by a fresh, disposable user
 * instead — `spec.admin` names that user — which a spec needs whenever it looks at the app
 * through non-admin eyes: a member's view of settings or the roster only proves anything with a
 * real admin sitting elsewhere.
 *
 * Everything commits in one transaction either way. For `member` that is load-bearing rather
 * than tidy: `organization_check_has_member` is `DEFERRABLE INITIALLY DEFERRED`, checked at
 * `COMMIT`, so `insertOrganization`'s own admin-membership insert has to still be uncommitted
 * when this user's runs — two separate auto-committed statements would let the organization row
 * commit with zero members and fail that constraint before this ever adds one.
 */
export async function insertOrganizationFixture(
  db: Kysely<Database>,
  userId: UserId,
  spec: {
    name: string;
    reports?: OrganizationReportSpec[];
    role?: OrganizationRole;
    admin?: OrganizationAdminSpec;
    members?: OrganizationMemberSpec[];
    invites?: OrganizationInviteSpec[];
  },
): Promise<{ organizationId: OrganizationId; organizationSlug: string; reportIds: ReportId[] }> {
  const role = spec.role ?? 'admin';
  const slug = deriveOrganizationSlug(spec.name);
  if (slug === null) {
    throw new Error(`insertOrganizationFixture: "${spec.name}" has no slug-legal characters`);
  }

  return await withTransaction(db, async (tx) => {
    const adminUserId = await resolveAdminUserId(tx, { userId, role, admin: spec.admin });
    const { organization } = await insertOrganization(tx, {
      name: spec.name,
      slug,
      ...(adminUserId === undefined ? {} : { adminUserId }),
    });
    const organizationId = organization.id;

    if (role === 'member') {
      await insertOrganizationMember(tx, { organizationId, userId, role });
    }

    const reportIds: ReportId[] = [];
    for (const report of spec.reports ?? []) {
      reportIds.push(await insertReportWithAttempt(tx, { organizationId, ...report }));
    }

    for (const member of spec.members ?? []) {
      const user = await insertAppUser(tx, {
        displayName: member.displayName,
        email: member.email,
      });
      await insertOrganizationMember(tx, { organizationId, userId: user.id, role: member.role });
    }

    for (const invite of spec.invites ?? []) {
      await tx
        .insertInto('organizationInvite')
        .values({
          organizationId,
          email: invite.email ?? `${crypto.randomUUID()}@example.test`,
          role: invite.role ?? 'member',
          status: invite.status ?? 'pending',
          expiresAt: sql`now() + interval '14 days'`,
        })
        .execute();
    }

    return { organizationId, organizationSlug: slug, reportIds };
  });
}

/** Who to hand `insertOrganization` as its admin: the signed-in user when that's the role they
 * hold here, otherwise the disposable admin `admin` pins — or nothing, leaving `insertOrganization`
 * to mint one with a random identity of its own.
 */
async function resolveAdminUserId(
  tx: DatabaseExecutor,
  params: { userId: UserId; role: OrganizationRole; admin: OrganizationAdminSpec | undefined },
): Promise<UserId | undefined> {
  if (params.role === 'admin') return params.userId;
  if (params.admin === undefined) return undefined;
  return (await insertAppUser(tx, params.admin)).id;
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
