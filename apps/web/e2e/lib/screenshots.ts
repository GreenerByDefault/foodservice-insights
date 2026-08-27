import { expect, type Page, test } from '@playwright/test';

/** Compare `page` against the committed `name` in `e2e/__screenshots__`.
 *
 * Goes through here rather than calling `toHaveScreenshot` directly so that the container is an
 * invariant rather than a convention. With no `connectOptions`, Playwright silently launches the
 * host Chromium — which on a Mac writes macOS pixels into `__screenshots__` and looks like it
 * worked, then fails in CI with nothing pointing at the cause.
 */
export async function expectScreenshot(page: Page, name: string): Promise<void> {
  const { project } = test.info();
  if (!project.use.connectOptions?.wsEndpoint) {
    throw new Error(
      `Project "${project.name}" has no connectOptions.wsEndpoint, so this screenshot would be ` +
        'captured by the host browser instead of the pinned container. Run it under ' +
        '`--project=screenshots`, and see e2e/setup/browser-container.ts for why that matters.',
    );
  }

  // `fullPage` is a per-call option only — Playwright ignores it in the config's
  // `toHaveScreenshot` defaults, silently. Below the fold is as much of the design as above it,
  // and this is a gallery as well as a regression check.
  await expect(page).toHaveScreenshot(name, { fullPage: true });
}
