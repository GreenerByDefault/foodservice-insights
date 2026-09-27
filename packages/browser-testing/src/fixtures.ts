/** The extended Playwright `test` both browser suites build on: a signed-in identity, an
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
import { type BrowserContext, test as base } from '@playwright/test';
import { type Kysely, sql } from 'kysely';
import {
  deleteGoTrueUser,
  type MintedUser,
  mintUser,
  readPinnedIdentity,
  readRunIdentity,
  runAuthMode,
  signInCookies,
  type TestIdentity,
} from './identity.ts';

export type TestOrganization = {
  id: OrganizationId;
  slug: string;
  /** What the shell's organization switcher renders. */
  name: string;
};

/** Who a test is. See `SharedTestOptions.identity`. */
export type IdentityOption = 'minted' | 'pinned' | 'anonymous';

export type SharedTestOptions = {
  /** Who this test's browser is signed in as. `placeholder` mode has one identity, the run's, so
   * there anything but the default throws.
   *
   * - `minted` (the default): a GoTrue user of this test's own. Its address is unique, so a
   *   screenshot must not render it.
   * - `pinned`: the run's one shared identity, whose address (`PINNED_IDENTITY_EMAIL`) is fixed,
   *   for a screenshot that renders it. Shared by every test that asks, the way a pinned
   *   `orgName` is, so a spec using it must not mutate it.
   * - `anonymous`: signed out. There is no `user`, so nothing that needs one — `org` included —
   *   can be asked for.
   */
  identity: IdentityOption;

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

/** More people than the one `user` a test is signed in as. `supabase` mode only: `placeholder`
 * has one identity per run. */
export interface UserFactory {
  /** A GoTrue user of this test's own, like `identity: 'minted'`'s. Deleted from GoTrue when the
   * test ends. It belongs to no organization until the spec gives it one. */
  create(): Promise<MintedUser>;

  /** A second browser context signed in as `user`, alongside the test's own `context`. Closed
   * when the test ends. Its `request` carries the session too. */
  contextFor(user: MintedUser): Promise<BrowserContext>;
}

export type SharedTestFixtures = {
  /** Who this test's browser is signed in as; see `identity`. */
  user: TestIdentity;

  /** A private organization `user` administers.
   *
   * Unnamed, it belongs to this test alone and is deleted when the test ends, whether it passed or
   * failed. `organization_member` and `report` both cascade from it — and `report`'s own children
   * from there — so whatever the test commits inside goes with it, which is why nothing here has
   * to track rows of its own. Named via `orgName`, it is shared instead; see that option.
   */
  org: TestOrganization;

  /** `user`, and the GoTrue address its browser signs in with — null in `placeholder` mode, where
   * no request carries a session. Null altogether for `anonymous`. Split out from `user` so that
   * `context` can depend on it without throwing for an anonymous test. */
  signedInAs: { user: TestIdentity; signInEmail: string | null } | null;

  users: UserFactory;
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

  identity: ['minted', { option: true }],

  signedInAs: async ({ db, identity }, use) => {
    if (runAuthMode() === 'placeholder') {
      if (identity !== 'minted') {
        throw new Error(`identity: '${identity}' needs a run in supabase mode.`);
      }
      await use({ user: await readRunIdentity(db), signInEmail: null });
      return;
    }

    switch (identity) {
      case 'anonymous':
        await use(null);
        return;
      case 'pinned': {
        const { signInEmail, ...user } = await readPinnedIdentity(db);
        await use({ user, signInEmail });
        return;
      }
      case 'minted': {
        const { signInEmail, ...user } = await mintUser(db);
        await use({ user, signInEmail });
        await deleteGoTrueUser(user.id);
        return;
      }
    }
  },

  user: async ({ signedInAs }, use) => {
    if (signedInAs === null) {
      throw new Error("identity: 'anonymous' has no user, and nothing that needs one.");
    }
    await use(signedInAs.user);
  },

  context: async ({ context, signedInAs, baseURL }, use) => {
    if (signedInAs?.signInEmail) {
      await signIn(context, signedInAs.signInEmail, baseURL);
    }
    await use(context);
  },

  users: async ({ db, browser, baseURL }, use) => {
    const created: MintedUser[] = [];
    const contexts: BrowserContext[] = [];

    await use({
      create: async () => {
        if (runAuthMode() === 'placeholder') {
          throw new Error('users.create() needs a run in supabase mode.');
        }
        const user = await mintUser(db);
        created.push(user);
        return user;
      },
      contextFor: async (user) => {
        const context = await browser.newContext({ baseURL });
        contexts.push(context);
        await signIn(context, user.signInEmail, baseURL);
        return context;
      },
    });

    await Promise.all(contexts.map((context) => context.close()));
    await Promise.all(created.map((user) => deleteGoTrueUser(user.id)));
  },

  // Playwright's own `request` shares no cookies with the browser, so it would be signed out.
  request: async ({ context }, use) => {
    await use(context.request);
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

async function signIn(
  context: BrowserContext,
  signInEmail: string,
  baseURL: string | undefined,
): Promise<void> {
  if (baseURL === undefined) throw new Error('Signing a browser in needs a baseURL.');
  // The project's own `baseURL`, which is `host.docker.internal` for the screenshots project,
  // so the cookie is scoped to the host that browser actually requests.
  const cookies = await signInCookies(signInEmail);
  await context.addCookies(cookies.map((cookie) => ({ ...cookie, url: baseURL })));
}

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
 * Every asking user is made an admin of it, so each test's own identity can open it. That
 * membership is `ON CONFLICT DO NOTHING` too: the pinned identity, or `placeholder` mode's one
 * user, asks again in every test.
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

  if (created !== undefined) return { id: created.id, slug: created.slug, name };

  const existing = await db
    .selectFrom('organization')
    .select(['id', 'slug'])
    .where(sql`lower(name)`, '=', name.toLowerCase())
    .executeTakeFirstOrThrow();
  await db
    .insertInto('organizationMember')
    .values({ userId: adminUserId, organizationId: existing.id, role: 'admin' })
    .onConflict((conflict) => conflict.doNothing())
    .execute();

  return { id: existing.id, slug: existing.slug, name };
}
