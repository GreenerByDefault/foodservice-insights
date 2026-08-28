import type { Page } from '@playwright/test';

/** Start counting the browser's `load` event from here. A real navigation fires it again;
 * `invalidate()` re-running a page's load client-side does not — the one distinction only a
 * real browser can make, so this backs the e2e assertion that an update landed without a reload.
 */
export function watchPageLoads(page: Page): { readonly count: number } {
  let count = 0;
  page.on('load', () => {
    count++;
  });
  return {
    get count() {
      return count;
    },
  };
}
