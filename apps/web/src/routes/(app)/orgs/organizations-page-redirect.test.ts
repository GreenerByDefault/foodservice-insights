import { withRollback } from '@gbd/db/testing';
import { expect, test } from 'vitest';
import { database } from '$lib/server/db';
import {
  anAuthContext,
  anEmail,
  anOrganizationAccess,
  inviteExpiring,
} from '$lib/server/testing/fixtures';
import { _organizationsPageRedirect } from './+page.server.ts';

const IN_A_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const A_WEEK_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

test('a waiting invite comes before anything else, even for an existing member', async () => {
  await withRollback(database(), async (transaction) => {
    const email = anEmail();
    await inviteExpiring(transaction, email, IN_A_WEEK);
    const auth = anAuthContext({
      user: { email },
      memberships: [anOrganizationAccess('Acme Foods')],
    });

    await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBe('/invites');
  });
});

test('an invite past its deadline is ignored, however its status still reads', async () => {
  await withRollback(database(), async (transaction) => {
    const email = anEmail();
    await inviteExpiring(transaction, email, A_WEEK_AGO);
    const access = anOrganizationAccess('Acme Foods');
    const auth = anAuthContext({ user: { email }, memberships: [access] });

    await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBe(
      `/orgs/${access.organizationId}`,
    );
  });
});

test('an accepted invite is ignored even though it has not expired', async () => {
  await withRollback(database(), async (transaction) => {
    const email = anEmail();
    await inviteExpiring(transaction, email, IN_A_WEEK, 'accepted');
    const access = anOrganizationAccess('Acme Foods');
    const auth = anAuthContext({ user: { email }, memberships: [access] });

    await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBe(
      `/orgs/${access.organizationId}`,
    );
  });
});

test('a waiting invite is found regardless of the case the sign-in email arrives in', async () => {
  await withRollback(database(), async (transaction) => {
    const email = anEmail();
    await inviteExpiring(transaction, email, IN_A_WEEK);
    const auth = anAuthContext({ user: { email: email.toUpperCase() } });

    await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBe('/invites');
  });
});

test('somebody who can reach nowhere is sent to create an organization', async () => {
  await withRollback(database(), async (transaction) => {
    const auth = anAuthContext({ user: { email: anEmail() } });

    await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBe('/orgs/new');
  });
});

test('a superadmin with no memberships stays on the picker instead, since they may act everywhere', async () => {
  await withRollback(database(), async (transaction) => {
    const auth = anAuthContext({ user: { email: anEmail(), isSuperadmin: true } });

    await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBeNull();
  });
});

test('one organization skips the picker', async () => {
  await withRollback(database(), async (transaction) => {
    const access = anOrganizationAccess('Acme Foods');
    const auth = anAuthContext({ user: { email: anEmail() }, memberships: [access] });

    await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBe(
      `/orgs/${access.organizationId}`,
    );
  });
});

test('several organizations means staying on the picker', async () => {
  await withRollback(database(), async (transaction) => {
    const auth = anAuthContext({
      user: { email: anEmail() },
      memberships: [anOrganizationAccess('Acme Foods'), anOrganizationAccess('Zenith Dining')],
    });

    await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBeNull();
  });
});
