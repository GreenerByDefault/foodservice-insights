import type { Database, OrganizationId } from '@gbd/db';
import { insertOrganization, withRollback } from '@gbd/db/testing';
import type { Transaction } from 'kysely';
import { expect, test } from 'vitest';
import { database } from '$lib/server/db';
import type { OrganizationSummary } from '$lib/server/organizations';
import { anAuthContext } from '$lib/server/tests/fixtures';
import { _resolvePostSignInDestination } from './+page.server.ts';

/** A unique address per test, so no test can see another's invite. */
function anEmail(): string {
  return `${crypto.randomUUID()}@example.test`;
}

function anOrganization(name: string): OrganizationSummary {
  return { id: crypto.randomUUID() as OrganizationId, name };
}

const INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

/** A pending invite for `email` that runs out at `expiresAt`.
 *
 * `created_at` is backdated a full invite lifetime rather than left to default, because
 * `organization_invite_expires_at_after_created_at` refuses a row that is already expired the
 * moment it is written — so this is also the only way to build the expired case.
 */
async function inviteExpiring(
  transaction: Transaction<Database>,
  email: string,
  expiresAt: Date,
): Promise<void> {
  const { organization } = await insertOrganization(transaction);

  await transaction
    .insertInto('organizationInvite')
    .values({
      organizationId: organization.id,
      email,
      role: 'member',
      status: 'pending',
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
    const auth = anAuthContext({ user: { email } });

    await expect(
      _resolvePostSignInDestination(transaction, auth, [anOrganization('Acme Foods')]),
    ).resolves.toBe('/invites');
  });
});

test('an invite past its deadline is ignored, however its status still reads', async () => {
  await withRollback(database(), async (transaction) => {
    const email = anEmail();
    await inviteExpiring(transaction, email, A_WEEK_AGO);
    const auth = anAuthContext({ user: { email } });
    const organization = anOrganization('Acme Foods');

    await expect(_resolvePostSignInDestination(transaction, auth, [organization])).resolves.toBe(
      `/orgs/${organization.id}`,
    );
  });
});

test('somebody who belongs nowhere is sent to create an organization', async () => {
  await withRollback(database(), async (transaction) => {
    const auth = anAuthContext({ user: { email: anEmail() } });

    await expect(_resolvePostSignInDestination(transaction, auth, [])).resolves.toBe('/orgs/new');
  });
});

test('one organization skips the picker', async () => {
  await withRollback(database(), async (transaction) => {
    const auth = anAuthContext({ user: { email: anEmail() } });
    const organization = anOrganization('Acme Foods');

    await expect(_resolvePostSignInDestination(transaction, auth, [organization])).resolves.toBe(
      `/orgs/${organization.id}`,
    );
  });
});

test('several organizations means staying on the picker', async () => {
  await withRollback(database(), async (transaction) => {
    const auth = anAuthContext({ user: { email: anEmail() } });

    await expect(
      _resolvePostSignInDestination(transaction, auth, [
        anOrganization('Acme Foods'),
        anOrganization('Zenith Dining'),
      ]),
    ).resolves.toBeNull();
  });
});
