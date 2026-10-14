import { insertOrganization, insertOrganizationInvite, withRollback } from '@gbd/db/testing';
import { describe, expect, test } from 'vitest';
import { database } from '#lib/server/db.js';
import { anAuthContext, anEmail, anOrganizationAccess } from '#lib/server/testing/fixtures.js';
import { _organizationsPageRedirect } from './+page.server.ts';

const IN_A_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const A_WEEK_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

describe('_organizationsPageRedirect', () => {
  test('a waiting invite comes before anything else, even for an existing member', async () => {
    await withRollback(database(), async (transaction) => {
      const email = anEmail();
      const { organization } = await insertOrganization(transaction);
      await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email,
        expiresAt: IN_A_WEEK,
      });
      const auth = anAuthContext({
        user: { email },
        memberships: [anOrganizationAccess('Acme Foods')],
      });

      await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBe('/invites');
    });
  });

  test('a member is not sent to an invite past its deadline, however its status still reads', async () => {
    await withRollback(database(), async (transaction) => {
      const email = anEmail();
      const { organization } = await insertOrganization(transaction);
      await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email,
        expiresAt: A_WEEK_AGO,
      });
      const access = anOrganizationAccess('Acme Foods');
      const auth = anAuthContext({ user: { email }, memberships: [access] });

      await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBe(
        `/orgs/${access.organizationSlug}`,
      );
    });
  });

  test('a live invite forwards a member who also holds an expired one', async () => {
    await withRollback(database(), async (transaction) => {
      const email = anEmail();
      const { organization: first } = await insertOrganization(transaction);
      const { organization: second } = await insertOrganization(transaction);
      await insertOrganizationInvite(transaction, {
        organizationId: first.id,
        email,
        expiresAt: IN_A_WEEK,
      });
      await insertOrganizationInvite(transaction, {
        organizationId: second.id,
        email,
        expiresAt: A_WEEK_AGO,
      });
      const auth = anAuthContext({
        user: { email },
        memberships: [anOrganizationAccess('Acme Foods')],
      });

      await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBe('/invites');
    });
  });

  test('somebody who belongs nowhere is shown an invite past its deadline instead of creating an organization', async () => {
    await withRollback(database(), async (transaction) => {
      const email = anEmail();
      const { organization } = await insertOrganization(transaction);
      await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email,
        expiresAt: A_WEEK_AGO,
      });
      const auth = anAuthContext({ user: { email } });

      await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBe('/invites');
    });
  });

  test('a dismissed expired invite no longer stops somebody creating an organization', async () => {
    await withRollback(database(), async (transaction) => {
      const email = anEmail();
      const { organization } = await insertOrganization(transaction);
      await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email,
        expiresAt: A_WEEK_AGO,
        status: 'expired',
      });
      const auth = anAuthContext({ user: { email } });

      await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBe('/orgs/new');
    });
  });

  test('an accepted invite is ignored even though it has not expired', async () => {
    await withRollback(database(), async (transaction) => {
      const email = anEmail();
      const { organization } = await insertOrganization(transaction);
      await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email,
        expiresAt: IN_A_WEEK,
        status: 'accepted',
      });
      const access = anOrganizationAccess('Acme Foods');
      const auth = anAuthContext({ user: { email }, memberships: [access] });

      await expect(_organizationsPageRedirect(transaction, auth)).resolves.toBe(
        `/orgs/${access.organizationSlug}`,
      );
    });
  });

  test('a waiting invite is found regardless of the case the sign-in email arrives in', async () => {
    await withRollback(database(), async (transaction) => {
      const email = anEmail();
      const { organization } = await insertOrganization(transaction);
      await insertOrganizationInvite(transaction, {
        organizationId: organization.id,
        email,
        expiresAt: IN_A_WEEK,
      });
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
        `/orgs/${access.organizationSlug}`,
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
});
