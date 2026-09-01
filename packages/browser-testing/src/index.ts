import { expect, type Page } from '@playwright/test';

/** Fires the page's next scheduled poll.
 *
 * Drives a page's poll loop through Playwright's fake clock, instead of waiting out real poll
 * intervals. Works for any route that re-arms a `setTimeout` from a `finally` block after each
 * poll settles — `page.clock.install()` still belongs in the spec itself, before `page.goto()`,
 * since it has to be in place before the page's own timer is armed on mount.
 *
 * The real `fetch` that timer kicks off still needs real time to settle, which the assertion made
 * afterwards should already retry through (e.g. `expect(...).toBeVisible()`) — so this needs no
 * wait of its own.
 */
export async function advancePoll(page: Page, delayMs: number): Promise<void> {
  await page.clock.runFor(delayMs);
}

/** Advances through a run of consecutive poll failures, one backoff step at a time.
 *
 * Each step waits for the failure to be observed for real, via `requestfailed`, before advancing
 * the clock again. That's needed because `runFor` fires the due timer synchronously, but the
 * next timer isn't armed until the failed fetch's `catch`/`finally` actually runs — real async
 * work the fake clock doesn't wait for. Chaining `runFor` calls back to back can outrun that
 * reschedule and land the second one before the first failure has been recorded.
 *
 * `urlPattern` matches the poll request's URL with a plain substring check. `delaysMs` is every
 * step of the backoff schedule, in order — e.g. `[pollIntervalMs, pollIntervalMs * 2]` for two
 * consecutive failures.
 */
export async function advanceThroughPollFailures(
  page: Page,
  urlPattern: string,
  delaysMs: number[],
): Promise<void> {
  let failures = 0;
  page.on('requestfailed', (request) => {
    if (request.url().includes(urlPattern)) failures += 1;
  });

  for (const [index, delayMs] of delaysMs.entries()) {
    await page.clock.runFor(delayMs);
    await expect.poll(() => failures).toBe(index + 1);
  }
}

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
