import { INVITE_LIFETIME_DAYS } from '@gbd/core';
import { type RawBuilder, sql } from 'kysely';
import type { AppUser } from '../../generated/public/AppUser.ts';
import type { Organization } from '../../generated/public/Organization.ts';
import type { OrganizationInvite } from '../../generated/public/OrganizationInvite.ts';
import type OrganizationInviteStatus from '../../generated/public/OrganizationInviteStatus.ts';
import type { OrganizationMember } from '../../generated/public/OrganizationMember.ts';
import type OrganizationRole from '../../generated/public/OrganizationRole.ts';
import type { DatabaseExecutor } from '../../schema.ts';
import { insertAppUser } from './app-user.ts';

/** An organization and the admin it must have. Anything else would fail its deferred trigger.
 *
 * `adminUserId` names an existing user to admin it, for a caller that has one already — a browser
 * test's signed-in identity, say. Left out, a disposable admin is created here. */
export async function insertOrganization(
  database: DatabaseExecutor,
  overrides: {
    name?: string;
    slug?: string;
    adminUserId?: AppUser['id'];
    createdAt?: Date | RawBuilder<Date>;
  } = {},
): Promise<{ organization: Organization; admin: AppUser }> {
  const admin =
    overrides.adminUserId === undefined
      ? await insertAppUser(database)
      : await database
          .selectFrom('appUser')
          .selectAll()
          .where('id', '=', overrides.adminUserId)
          .executeTakeFirstOrThrow();

  const organization = await database
    .insertInto('organization')
    .values({
      name: overrides.name ?? `Test org ${crypto.randomUUID()}`,
      // Slug-legal without deriving one: lowercase hex, already hyphen-free.
      slug: overrides.slug ?? `test-org-${crypto.randomUUID().slice(0, 8)}`,
      createdByUserId: admin.id,
      createdAt: overrides.createdAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await database
    .insertInto('organizationMember')
    .values({ userId: admin.id, organizationId: organization.id, role: 'admin' })
    .execute();

  return { organization, admin };
}

/** A member row on an existing organization — creating the user if none was given, the same way
 * every other fixture creates its parents. Does not create the organization itself; use
 * `insertOrganization` for that, since a member alone can't satisfy `organization_has_a_member`. */
export async function insertOrganizationMember(
  database: DatabaseExecutor,
  overrides: {
    organizationId: Organization['id'];
    userId?: AppUser['id'];
    role?: OrganizationRole;
  },
): Promise<OrganizationMember> {
  const userId = overrides.userId ?? (await insertAppUser(database)).id;

  return await database
    .insertInto('organizationMember')
    .values({
      userId,
      organizationId: overrides.organizationId,
      role: overrides.role ?? 'member',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** A full invite lifetime, as a Postgres interval — shared between `expiresAt`'s default and the
 * backdating below, so the two can't drift apart. */
const INVITE_LIFETIME_INTERVAL = sql`make_interval(days => ${INVITE_LIFETIME_DAYS})`;

/** An `organization_invite` row. `expiresAt` defaults to `INVITE_LIFETIME_DAYS` from Postgres's
 * clock, and accepts a `RawBuilder<Date>` (e.g. `DB_NOW`/`dbMsAgo`) as well as a plain `Date` —
 * whichever it is, `created_at` is computed from it in SQL rather than left to the column's
 * default whenever it falls at or before `now()`, backdated a full lifetime earlier. That's the
 * only way to build the expired case at all:
 * `organization_invite_expires_at_after_created_at` refuses a row whose `created_at` isn't
 * strictly before `expires_at`, and comparing in SQL against Postgres's clock — rather than the
 * process's — is the same reason `DB_NOW`/`dbMsAgo` exist: a JS-clock comparison can land on the
 * wrong side of "now" under load.
 *
 * Pass `createdAt` explicitly (e.g. `dbMsAgo`) whenever a test orders several invites against
 * each other: `now()` is fixed for a whole transaction, so invites left to the default all land
 * on the same `created_at`, and `withRollback` runs the whole test in one transaction.
 */
export async function insertOrganizationInvite(
  database: DatabaseExecutor,
  overrides: {
    organizationId: Organization['id'];
    email: string;
    role?: OrganizationRole;
    status?: OrganizationInviteStatus;
    expiresAt?: Date | RawBuilder<Date>;
    createdAt?: Date | RawBuilder<Date>;
    invitedByUserId?: AppUser['id'] | null;
  },
): Promise<OrganizationInvite> {
  const expiresAt = overrides.expiresAt ?? sql<Date>`now() + ${INVITE_LIFETIME_INTERVAL}`;
  const createdAt =
    overrides.createdAt ??
    sql<Date>`CASE WHEN (${expiresAt})::timestamptz <= now()
        THEN (${expiresAt})::timestamptz - ${INVITE_LIFETIME_INTERVAL}
        ELSE now()
      END`;

  return await database
    .insertInto('organizationInvite')
    .values({
      organizationId: overrides.organizationId,
      email: overrides.email,
      role: overrides.role ?? 'member',
      status: overrides.status ?? 'pending',
      invitedByUserId: overrides.invitedByUserId ?? null,
      expiresAt,
      createdAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
