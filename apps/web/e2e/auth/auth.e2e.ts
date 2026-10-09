import { ensureHydrated } from '@gbd/browser-testing';
import { expect } from '@playwright/test';
import { organizationHref } from '../../src/lib/hrefs.ts';
import { clearOrganizationFixture, insertOrganizationFixture } from '../fixtures/organizations.ts';
import { test } from '../fixtures/test.ts';
import { waitForSignInCode } from '../lib/emailed-code.ts';

// The whole chain in one assertion: a real session cookie, `getUser()` in `identifyUser`, the
// lookup in `hooks.server.ts`, the guard on `(app)`, and the data reaching a component. Goes
// straight to the org rather than through `/` — the fan-out that picks an organization is covered
// exhaustively and hermetically by the pure unit test `resolve-post-sign-in-destination.test.ts`.
test('a signed-in request reaches its organization, which the shell names', async ({
  page,
  user,
  org,
}) => {
  await page.goto(`/orgs/${org.slug}`);
  await ensureHydrated(page);

  await expect(page.getByRole('banner')).toContainText(org.name);

  // The account menu is portalled outside `<header>`, so the email is checked there instead.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByText(user.email)).toBeVisible();
});

test('signing out lands on the marketing page, and Back does not return to the shell', async ({
  page,
  org,
}) => {
  await page.goto(`/orgs/${org.slug}`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(`/orgs/${org.slug}`);
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account menu' })).toHaveCount(0);

  // The cookie is gone too, not just the client's view of it: a fresh request is refused.
  const response = await page.reload();
  expect(response?.status()).toBe(401);
});

test('signing out in one tab signs the other out in place, untouched', async ({ page, org }) => {
  const other = await page.context().newPage();
  await other.goto(`/orgs/${org.slug}`);
  await ensureHydrated(other);
  await page.goto(`/orgs/${org.slug}`);
  await ensureHydrated(page);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/');

  await expect(other.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await expect(other).toHaveURL(`/orgs/${org.slug}`);
  await expect(other.getByRole('button', { name: 'Account menu' })).toHaveCount(0);
});

test.describe('signed out', () => {
  test.use({ identity: 'anonymous' });

  test('/ is the marketing page', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  });

  test('an organization answers 401', async ({ page }) => {
    // Any slug will do: the `(app)` gate refuses before anything looks the organization up.
    const response = await page.goto('/orgs/northgate-provisions');

    expect(response?.status()).toBe(401);
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  });

  test('signing in on the 401 page renders the organization at the URL that was refused', async ({
    page,
    db,
    users,
  }) => {
    const admin = await users.create();
    const name = `Signs In In Place ${crypto.randomUUID()}`;
    const { organizationId, organizationSlug } = await insertOrganizationFixture(db, admin.id, {
      name,
    });
    try {
      const response = await page.goto(organizationHref(organizationSlug));
      expect(response?.status()).toBe(401);
      await ensureHydrated(page);

      await page.getByLabel('Email address').fill(admin.signInEmail);
      await page.getByRole('button', { name: 'Send code' }).click();
      await page.getByLabel('Sign-in code').fill(await waitForSignInCode(admin.signInEmail));

      await expect(page.getByRole('banner')).toContainText(name);
      await expect(page).toHaveURL(organizationHref(organizationSlug));
    } finally {
      await clearOrganizationFixture(db, organizationId);
    }
  });

  // The one spec that signs in the way a person does, with a code GoTrue emailed; every other
  // test's session comes from the fixtures' password sign-in. It signs an existing user *in*, not
  // up: GoTrue writes a new user to the stack's main database, never this run's clone, so the app
  // would find no `app_user` for them (`@gbd/browser-testing`'s `identity.ts`).
  test('signing in with an emailed code, across a reload, lands a user with no organization on creating one', async ({
    page,
    users,
  }) => {
    const person = await users.create();

    await page.goto('/sign-in');
    await ensureHydrated(page);

    await page.getByLabel('Email address').fill(person.signInEmail);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByLabel('Sign-in code')).toBeVisible();

    // As the hop to a mail app can cost a mobile tab: the code already sent must still have a field.
    await page.reload();
    await ensureHydrated(page);
    await expect(page.getByText(`We sent a code to ${person.signInEmail}.`)).toBeVisible();
    await page.getByLabel('Sign-in code').fill(await waitForSignInCode(person.signInEmail));

    // They belong to no organization, so `/orgs` sends them on to make one.
    await expect(page).toHaveURL('/orgs/new');
    await page.getByRole('button', { name: 'Account menu' }).click();
    await expect(page.getByText(person.email)).toBeVisible();
  });
});
