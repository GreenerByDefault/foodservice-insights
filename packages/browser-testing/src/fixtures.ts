/** The extended Playwright `test` both browser suites build on: the run's signed-in identity, an
 * organization it administers, and the database handle both are written through.
 *
 * Import `@gbd/db/env` only from a spec's own module graph, never from a `playwright.config.ts` —
 * it opens a connection pool at import time, and the config-loading process has no worker fixture
 * to close it again. That's why this is its own entry point (`@gbd/browser-testing/fixtures`)
 * rather than part of the package's index.
 */

import { type Database, type OrganizationId, type UserId, withTransaction } from '@gbd/db';
import { DATABASE, shutdown } from '@gbd/db/env';
import { insertOrganization } from '@gbd/db/testing';
import { test as base } from '@playwright/test';
import { type Kysely, sql } from 'kysely';
import { readRunIdentity, type TestIdentity } from './identity.ts';

export type TestOrganization = {
  id: OrganizationId;
  slug: string;
  /** What the shell's organization switcher renders. */
  name: string;
};

export type SharedTestOptions = {
  /** The name `org` is created with, for a spec that needs it to read a particular way — a
   * screenshot spec, whose committed image is diffed pixel-for-pixel and whose switcher renders
   * this. Defaults to a unique `Test org <uuid>`.
   *
   * **Pinning a name makes the organization shared and run-lived**, not per-test: see
   * `findOrCreateOrganization`. Pin one only from a spec that reads the organization. A spec that
   * renames or deletes it, or that asserts on the whole of its reports list, needs an
   * organization of its own instead.
   */
  orgName: string | undefined;
};

export type SharedTestFixtures = {
  /** Who every request in this run is answered as. */
  user: TestIdentity;

  /** A private organization `user` administers.
   *
   * Unnamed, it belongs to this test alone and is deleted when the test ends, whether it passed or
   * failed. `organization_member` and `report` both cascade from it — and `report`'s own children
   * from there — so whatever the test commits inside goes with it, which is why nothing here has
   * to track rows of its own. Named via `orgName`, it is shared instead; see that option.
   */
  org: TestOrganization;
};

export type SharedWorkerFixtures = {
  db: Kysely<Database>;
};

export const test = base.extend<SharedTestOptions & SharedTestFixtures, SharedWorkerFixtures>({
  orgName: [undefined, { option: true }],

  // Worker-scoped: one pool per Playwright worker process, closed or the worker hangs.
  db: [
    // The empty pattern is required, not vestigial: Playwright statically parses a fixture
    // function's first parameter to learn its dependencies, and rejects anything but an object
    // (destructured or not).
    // biome-ignore lint/correctness/noEmptyPattern: required by Playwright's fixture signature.
    async ({}, use) => {
      await use(DATABASE);
      await shutdown();
    },
    { scope: 'worker' },
  ],

  user: async ({ db }, use) => {
    await use(await readRunIdentity(db));
  },

  org: async ({ db, user, orgName }, use) => {
    if (orgName !== undefined) {
      await use(await findOrCreateOrganization(db, orgName, user.id));
      return;
    }

    const name = `Test org ${crypto.randomUUID()}`;
    // One transaction, because `organization_has_a_member` is deferred to commit: the
    // organization row and its admin membership cannot land as two auto-committed statements.
    const { organization } = await withTransaction(db, (transaction) =>
      insertOrganization(transaction, { name, adminUserId: user.id }),
    );

    await use({ id: organization.id, slug: organization.slug, name });

    await db.deleteFrom('organization').where('id', '=', organization.id).execute();
  },
});

/** The one organization called `name` in this run, creating it if this is the first test to ask.
 *
 * A pinned name cannot belong to one test: `organization_name_unique_ci` is global, so two tests
 * holding it at once is a unique violation — and under `fullyParallel` the tests of one spec file
 * run at once, across workers. Sharing one row is what lets them stay parallel rather than
 * serialized behind a name. It is never deleted for the same reason: another test may still be
 * reading it. The run's database is dropped wholesale afterwards, so nothing leaks past the run.
 *
 * `ON CONFLICT DO NOTHING` untargeted rather than a check-then-insert, which would race. The
 * insert cannot go through `insertOrganization` for that reason, hence the duplicated slug shape.
 * The loser of the race reads the winner's row, so both see one id, one slug and one name.
 *
 * Every request in a run is answered as the same identity today, so an organization an earlier
 * test created already has this `adminUserId` as its admin. Once identities are per-test, this
 * needs a membership row per asking user.
 */
async function findOrCreateOrganization(
  db: Kysely<Database>,
  name: string,
  adminUserId: UserId,
): Promise<TestOrganization> {
  const created = await withTransaction(db, async (transaction) => {
    const organization = await transaction
      .insertInto('organization')
      .values({
        name,
        // Slug-legal without deriving one: lowercase hex, already hyphen-free.
        slug: `test-org-${crypto.randomUUID().slice(0, 8)}`,
        createdByUserId: adminUserId,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning(['id', 'slug'])
      .executeTakeFirst();
    if (organization === undefined) return undefined;

    await transaction
      .insertInto('organizationMember')
      .values({ userId: adminUserId, organizationId: organization.id, role: 'admin' })
      .execute();
    return organization;
  });

  const organization =
    created ??
    (await db
      .selectFrom('organization')
      .select(['id', 'slug'])
      .where(sql`lower(name)`, '=', name.toLowerCase())
      .executeTakeFirstOrThrow());

  return { id: organization.id, slug: organization.slug, name };
}
