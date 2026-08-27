import { expect, type Page, test } from '@playwright/test';

/** Compare `page` against the committed `name` in `e2e/__screenshots__`.
 *
 * Goes through here rather than calling `toHaveScreenshot` directly so that the container is an
 * invariant rather than a convention. That's necessary for cross-platform consistency.
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

  await expect(page).toHaveScreenshot(name, { fullPage: true });
}
