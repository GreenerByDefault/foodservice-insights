import type { Page } from '@playwright/test';

/** Wait until the page's event listeners are attached.
 *
 * A `page.goto()` returns as soon as the server-rendered HTML arrives, before Svelte's client
 * runtime has run. A `click()` issued in that window lands on real markup but no handler is
 * listening yet, so the action silently no-ops instead of failing — this closes that race. Only
 * needed before interacting with the page (typing, clicking); a test that only reads
 * server-rendered content has nothing to wait for.
 */
export async function ensureHydrated(page: Page): Promise<void> {
  await page.locator('body[data-hydrated="true"]').waitFor();
}
