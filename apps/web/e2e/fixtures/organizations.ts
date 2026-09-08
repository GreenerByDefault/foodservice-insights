/** A private organization, for anything that needs to control the *whole* reports list rather
 * than one report inside it — the empty state, pagination, or a screenshot whose contents must be
 * fully known — or that needs the placeholder user in several organizations at once.
 *
 * Names collide on `organization_name_unique_ci`, so every caller passes its own unique one — a
 * random suffix for a behavioural spec, a fixed name for a screenshot whose committed image
 * renders it.
 */

import type {
  Database,
  OrganizationId,
  OrganizationInviteStatus,
  OrganizationRole,
  ReportId,
} from '@gbd/db';
import { withTransaction } from '@gbd/db';
import { PLACEHOLDER_USER_ID } from '@gbd/db/seed';
import { insertAppUser, insertOrganization, insertOrganizationMember } from '@gbd/db/testing';
import { type Kysely, sql, type Transaction } from 'kysely';
import { deriveOrganizationSlug } from '../../src/lib/server/orgs/slug.ts';
import { insertReportWithAttempt, type ReportWithAttemptSpec } from './reports.ts';

export type OrganizationMemberSpec = {
  displayName?: string;
  /** Defaults to a random address — set this for a screenshot spec, whose committed image needs
   * the same text on every run, unlike a behavioural spec that only asserts the row exists. */
  email?: string;
  role?: OrganizationRole;
};

export type OrganizationReportSpec = Omit<ReportWithAttemptSpec, 'organizationId'>;

export type OrganizationInviteSpec = {
  /** Defaults to a random address, the same rationale as `OrganizationMemberSpec.email`. */
  email?: string;
  role?: OrganizationRole;
  status?: OrganizationInviteStatus;
};

/** Commit a private organization the placeholder user belongs to — the only identity
 * `identifyUser` can ever produce — with, optionally, its reports. Returns the organization's id
 * and the ids of the reports it minted, in the order given.
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
    invites?: OrganizationInviteSpec[];
  },
): Promise<{ organizationId: OrganizationId; organizationSlug: string; reportIds: ReportId[] }> {
  const role = spec.role ?? 'admin';
  const slug = deriveOrganizationSlug(spec.name);
  if (slug === null) {
    throw new Error(`insertOrganizationFixture: "${spec.name}" has no slug-legal characters`);
  }

  return await withTransaction(db, async (tx) => {
    const organizationId = await insertOrganizationFor(tx, spec.name, slug, role);

    await tx
      .insertInto('organizationMember')
      .values({ userId: PLACEHOLDER_USER_ID, organizationId, role })
      .execute();

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

/** The organization row, plus — for `member` — the disposable admin that has to own it. */
async function insertOrganizationFor(
  tx: Transaction<Database>,
  name: string,
  slug: string,
  role: OrganizationRole,
): Promise<OrganizationId> {
  if (role === 'member') {
    const { organization } = await insertOrganization(tx, { name, slug });
    return organization.id;
  }

  const organization = await tx
    .insertInto('organization')
    .values({ name, slug, createdByUserId: PLACEHOLDER_USER_ID })
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
