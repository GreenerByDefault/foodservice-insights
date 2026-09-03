import type { Database, OrganizationId, OrganizationInviteStatus } from '@gbd/db';
import { insertOrganization, withRollback } from '@gbd/db/testing';
import type { Transaction } from 'kysely';
import { expect, test } from 'vitest';
import type { OrganizationAccess } from '$lib/server/auth/types';
import { database } from '$lib/server/db';
import { anAuthContext } from '$lib/server/tests/fixtures';
import { _resolvePostSignInDestination } from './+page.server.ts';

function anEmail(): string {
  // A unique address per test, so no test can see another's invite.
  return `${crypto.randomUUID()}@example.test`;
}

function accessTo(name: string): OrganizationAccess {
  return {
    organizationId: crypto.randomUUID() as OrganizationId,
    organizationName: name,
    role: 'member',
  };
}

const INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

/** An invite for `email` that runs out at `expiresAt`.
 *
 * `created_at` is backdated a full invite lifetime rather than left to default, because
 * `organization_invite_expires_at_after_created_at` refuses a row that is already expired the
 * moment it is written — so this is also the only way to build the expired case.
 */
async function inviteExpiring(
  transaction: Transaction<Database>,
  email: string,
  expiresAt: Date,
  status: OrganizationInviteStatus = 'pending',
): Promise<void> {
  const { organization } = await insertOrganization(transaction);

  await transaction
    .insertInto('organizationInvite')
    .values({
      organizationId: organization.id,
      email,
      role: 'member',
      status,
      createdAt: new Date(expiresAt.getTime() - INVITE_LIFETIME_MS),
      expiresAt,
    })
    .execute();
}

const IN_A_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const A_WEEK_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

test('a waiting invite comes before anything else, even for an existing member', async () => {
  await withRollback(database(), async (transaction) => {
    const email = anEmail();
    await inviteExpiring(transaction, email, IN_A_WEEK);
    const auth = anAuthContext({ user: { email }, memberships: [accessTo('Acme Foods')] });

    await expect(_resolvePostSignInDestination(transaction, auth)).resolves.toBe('/invites');
  });
});

test('an invite past its deadline is ignored, however its status still reads', async () => {
  await withRollback(database(), async (transaction) => {
    const email = anEmail();
    await inviteExpiring(transaction, email, A_WEEK_AGO);
    const access = accessTo('Acme Foods');
    const auth = anAuthContext({ user: { email }, memberships: [access] });

    await expect(_resolvePostSignInDestination(transaction, auth)).resolves.toBe(
      `/orgs/${access.organizationId}`,
    );
  });
});

test('an accepted invite is ignored even though it has not expired', async () => {
  await withRollback(database(), async (transaction) => {
    const email = anEmail();
    await inviteExpiring(transaction, email, IN_A_WEEK, 'accepted');
    const access = accessTo('Acme Foods');
    const auth = anAuthContext({ user: { email }, memberships: [access] });

    await expect(_resolvePostSignInDestination(transaction, auth)).resolves.toBe(
      `/orgs/${access.organizationId}`,
    );
  });
});

test('a waiting invite is found regardless of the case the sign-in email arrives in', async () => {
  await withRollback(database(), async (transaction) => {
    const email = anEmail();
    await inviteExpiring(transaction, email, IN_A_WEEK);
    const auth = anAuthContext({ user: { email: email.toUpperCase() } });

    await expect(_resolvePostSignInDestination(transaction, auth)).resolves.toBe('/invites');
  });
});

test('somebody who can reach nowhere is sent to create an organization', async () => {
  await withRollback(database(), async (transaction) => {
    const auth = anAuthContext({ user: { email: anEmail() } });

    await expect(_resolvePostSignInDestination(transaction, auth)).resolves.toBe('/orgs/new');
  });
});

test('a superadmin with no memberships stays on the picker instead, since they may act everywhere', async () => {
  await withRollback(database(), async (transaction) => {
    const auth = anAuthContext({ user: { email: anEmail(), isSuperadmin: true } });

    await expect(_resolvePostSignInDestination(transaction, auth)).resolves.toBeNull();
  });
});

test('one organization skips the picker', async () => {
  await withRollback(database(), async (transaction) => {
    const access = accessTo('Acme Foods');
    const auth = anAuthContext({ user: { email: anEmail() }, memberships: [access] });

    await expect(_resolvePostSignInDestination(transaction, auth)).resolves.toBe(
      `/orgs/${access.organizationId}`,
    );
  });
});

test('several organizations means staying on the picker', async () => {
  await withRollback(database(), async (transaction) => {
    const auth = anAuthContext({
      user: { email: anEmail() },
      memberships: [accessTo('Acme Foods'), accessTo('Zenith Dining')],
    });

    await expect(_resolvePostSignInDestination(transaction, auth)).resolves.toBeNull();
  });
});
