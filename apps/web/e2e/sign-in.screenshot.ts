/** `sign-in-email.png` and `sign-in-code.png` are the flow's two steps; the rest are the errors each
 * step can show.
 *
 * GoTrue is answered by `page.route` throughout, rather than reached: the containerized browser
 * cannot get to it, since it is on the host's 127.0.0.1. An error body carries `error_code`, the
 * field auth-js reads the code `describeAuthError` switches on from.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/test.ts';
import { expectScreenshots } from './lib/screenshots.ts';

test.use({ identity: 'anonymous' });

const SEND_URL = '**/auth/v1/otp*';
const VERIFY_URL = '**/auth/v1/verify*';

async function openSignIn(page: Page): Promise<void> {
  // The code step's resend link counts down once a second. `install()` alone leaves the fake clock
  // running in step with the real one, so a capture that straddles a second boundary shows a
  // different number; paused, it moves only when a test calls `runFor`.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  await page.route(SEND_URL, (route) => route.fulfill({ status: 200, json: {} }));

  await page.goto('/sign-in');
  await ensureHydrated(page);
}

/** Submitted with Enter, not a click, so the pointer is not left hovering whatever renders next. */
async function sendCode(page: Page): Promise<void> {
  await page.getByLabel('Email address').fill('sam.cook@example.test');
  await page.getByLabel('Email address').press('Enter');
  await expect(page.getByLabel('Sign-in code')).toBeFocused();
}

function gotrueError(status: number, errorCode: string) {
  return { status, json: { code: status, error_code: errorCode, msg: errorCode } };
}

test('the sign-in form, both steps', async ({ page }) => {
  await openSignIn(page);
  await expectScreenshots(page, 'sign-in-email.png');

  await sendCode(page);
  await expectScreenshots(page, 'sign-in-code.png');
});

test('an address the form refuses', async ({ page }) => {
  await openSignIn(page);

  // No dot in the domain: `type="email"` lets it through, and the schema does not.
  await page.getByLabel('Email address').fill('sam.cook@example');
  await page.getByLabel('Email address').press('Enter');
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();

  await expectScreenshots(page, 'sign-in-email-failed.png');
});

test('a code GoTrue rejects', async ({ page }) => {
  await openSignIn(page);
  await page.route(VERIFY_URL, (route) => route.fulfill(gotrueError(403, 'otp_expired')));
  await sendCode(page);

  await page.getByLabel('Sign-in code').fill('123456');
  await expect(
    page.getByText('That code is wrong or has expired.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('Sign-in code')).toBeFocused();

  await expectScreenshots(page, 'sign-in-code-failed.png');
});

test('a new code GoTrue refuses to send', async ({ page }) => {
  await openSignIn(page);
  await sendCode(page);
  // Registered after the first send's route, so it takes precedence from here on.
  await page.route(SEND_URL, (route) =>
    route.fulfill(gotrueError(429, 'over_email_send_rate_limit')),
  );

  await page.clock.runFor(60_000);
  // The button is disabled while it sends, so it is re-enabled just before the capture, mid-fade
  // back from `disabled:opacity-50`. A fading element gets a compositor layer, and whether Chrome
  // has dropped it by capture time varies run to run; while it hasn't, the last glyph's edge
  // renders a pixel differently. Waiting out the fade still flaked; with no fade, there's no layer.
  await page.addStyleTag({ content: '* { transition: none !important; }' });
  await page.getByRole('button', { name: 'Send a new code' }).click();
  await expect(page.getByText('Too many codes requested.', { exact: false })).toBeVisible();
  // The click left the pointer on the button, which would capture it hovered.
  await page.mouse.move(0, 0);

  await expectScreenshots(page, 'sign-in-resend-failed.png');
});

// GoTrue accepts the code, but the session it hands back is one the server's own `getUser()` then
// refuses, so `/sign-in`'s load does not redirect and the step is still there when
// `invalidateAll()` settles — the same outcome as a cookie the server could not read.
test('a verified code that does not sign in', async ({ page }) => {
  await openSignIn(page);
  await page.route(VERIFY_URL, (route) =>
    route.fulfill({
      status: 200,
      json: {
        access_token: 'not-a-jwt-the-server-will-accept',
        refresh_token: 'unused',
        token_type: 'bearer',
        expires_in: 3600,
        // Real time, not the page's installed clock: the server judges expiry by its own.
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: '00000000-0000-4000-8000-000000000000', email: 'sam.cook@example.test' },
      },
    }),
  );
  await sendCode(page);

  await page.getByLabel('Sign-in code').fill('123456');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeFocused();

  await expectScreenshots(page, 'sign-in-stalled.png');
});
