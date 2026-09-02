import { expect, type Page, test } from '@playwright/test';
import { SCREENSHOT_VIEWPORTS } from './viewports.ts';

/** Move the pointer out of the way before a touch-width capture.
 *
 * `@media (hover: hover)` is false on a phone or a tablet, so a hovered row in a narrow shot
 * would commit a state no such device can reach. `setViewportSize` alone doesn't clear `:hover` —
 * Chromium holds it until a real pointer move. (0, 0) is the page's top-left corner, which lands
 * in the shell's own padding rather than on anything hoverable.
 */
async function clearHover(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
}

/** Compare `page` against the committed `name` in `e2e/__screenshots__`, at every viewport in
 * `SCREENSHOT_VIEWPORTS`.
 *
 * Goes through here rather than calling `toHaveScreenshot` directly so that the container is an
 * invariant rather than a convention. That's necessary for cross-platform consistency.
 *
 * Every width in one test, on one navigation: resizing is nearly free, a fresh navigation isn't.
 * That holds because nothing in `apps/web/src` responds to width in JavaScript — no `matchMedia`,
 * no `innerWidth`, only Tailwind variants — so a resize re-lays the page out with no re-render.
 *
 * The widest width keeps the bare `name` so that browsing a feature's folder stays a gallery of
 * one image per screen.
 */
export async function expectScreenshots(page: Page, name: string): Promise<void> {
  const { project } = test.info();
  if (!project.use.connectOptions?.wsEndpoint) {
    throw new Error(
      `Project "${project.name}" has no connectOptions.wsEndpoint, so this screenshot would be ` +
        'captured by the host browser instead of the pinned container. Run it under ' +
        '`--project=screenshots`, and see e2e/setup/browser-container.ts for why that matters.',
    );
  }

  for (const [label, viewport] of Object.entries(SCREENSHOT_VIEWPORTS)) {
    await page.setViewportSize(viewport);
    if (label !== 'desktop') await clearHover(page);
    await expect(page).toHaveScreenshot(label === 'desktop' ? name : [label, name], {
      fullPage: true,
    });
  }

  // Restored so the helper leaves no viewport behind it: an assertion added after a capture
  // shouldn't silently run at 390px. Hover deliberately isn't restored — no spec needs it back.
  await page.setViewportSize(SCREENSHOT_VIEWPORTS.desktop);
}
