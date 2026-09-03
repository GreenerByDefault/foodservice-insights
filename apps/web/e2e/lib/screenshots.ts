import { expect, type Locator, type Page, test } from '@playwright/test';
import { SCREENSHOT_VIEWPORTS } from './viewports.ts';

/** Move the pointer out of the way before a touch-width capture.
 *
 * `@media (hover: hover)` is false on a phone or a tablet, so a hovered row in a narrow shot
 * would commit a state no such device can reach. `setViewportSize` alone doesn't clear `:hover` —
 * Chromium holds it until a real pointer move.
 */
async function clearHover(page: Page): Promise<void> {
  // The page's top-left corner, which lands in the shell's own padding rather than on
  // anything hoverable.
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
export async function expectScreenshots(
  page: Page,
  name: string,
  options: {
    /** Crop the capture to end just past this locator's bottom edge, instead of the full page.
     *
     * For a listing with no natural bound of its own — the organization switcher and `/orgs`
     * both show *every* organization the signed-in user belongs to, and every spec shares that
     * one identity (see `e2e/fixtures/organizations.ts`) — content after the fixture's own last
     * row is whatever else happens to be committed by a concurrently running spec, not something
     * this test controls. Naming that row here keeps it out of the captured image instead of
     * fighting to make the whole unbounded list deterministic.
     */
    clipBelow?: Locator;
  } = {},
): Promise<void> {
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
    const clip = options.clipBelow && (await clipBelow(options.clipBelow, viewport.width));
    await expect(page).toHaveScreenshot(label === 'desktop' ? name : [label, name], {
      fullPage: !clip,
      clip,
    });
  }

  // Restored so the helper leaves no viewport behind it: an assertion added after a capture
  // shouldn't silently run at mobile. Hover deliberately isn't restored because nothing needs that.
  await page.setViewportSize(SCREENSHOT_VIEWPORTS.desktop);
}

/** The page region from the top down through `locator`'s bottom edge, with a little breathing
 * room so its border or shadow isn't cut against. Re-measured per viewport: reflow can move a
 * row's `y`, even when nothing about its height changes. */
async function clipBelow(
  locator: Locator,
  width: number,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('clipBelow locator has no box — is it actually rendered?');
  return { x: 0, y: 0, width, height: Math.ceil(box.y + box.height) + 8 };
}
