/** `sign-in-email.png` and `sign-in-code.png` are the flow's two steps; the rest are the errors each
 * step can show.
 *
 * GoTrue is answered by `page.route` throughout, rather than reached: the containerized browser
 * cannot get to it, since it is on the host's 127.0.0.1. An error body carries `error_code`, the
 * field auth-js reads the code `describeAuthError` switches on from.
 */

import { ensureHydrated } from '@gbd/browser-testing';
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures/test.ts';
import { expectScreenshots } from '../lib/screenshots.ts';

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
  // On focus, bits-ui's PinInput arms a zero-delay timer that decides whether a password-manager
  // badge sits over its cells — and its `elementFromPoint` probe always lands on its own hidden
  // `<input>`, so the answer is always yes, and the input is widened by 40px to make room. Under
  // the paused clock that timer fires in some runs and not others. Firing it here makes every run
  // the widened one. Its one visible effect is in the phone-width images, which are 391px wide
  // rather than 375: the widened input overflows the page there. On a real phone it wouldn't —
  // bits-ui re-checks the room every second and keeps the input narrow when there is none — but
  // that check runs on the paused clock too, so it never re-runs after the resize to phone width.
  await page.clock.runFor(1);
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
