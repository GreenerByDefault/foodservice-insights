import { expect, type Page } from '@playwright/test';

/** Fails if the page is wider than its viewport at whatever size `page` is currently set to.
 *
 * A screenshot catches this too, but only for the one viewport it was taken at — this is cheap
 * enough to run across several. Allows 1px for subpixel rounding.
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    /** A CSS-ish description of `element`, good enough to find it in the DOM. Not a robust
     * selector (classes aren't escaped, order isn't guaranteed unique) — this is diagnostic
     * text for a failure message, not something meant to be pasted into `page.locator`.
     *
     * Defined inside the callback because `page.evaluate` re-executes only this function's
     * source in the browser — it can't call back out to a helper defined in Node scope. */
    function describe(element: Element): string {
      if (element.id) return `#${element.id}`;
      const classes = typeof element.className === 'string' ? element.className.trim() : '';
      return classes
        ? `${element.tagName.toLowerCase()}.${classes.split(/\s+/).join('.')}`
        : element.tagName.toLowerCase();
    }

    const { scrollWidth, clientWidth } = document.documentElement;
    if (scrollWidth <= clientWidth + 1) return null;

    let offender: Element | null = null;
    let maxRight = clientWidth;
    for (const element of document.querySelectorAll('body *')) {
      const { right } = element.getBoundingClientRect();
      if (right > maxRight) {
        maxRight = right;
        offender = element;
      }
    }

    return {
      scrollWidth,
      clientWidth,
      selector: offender ? describe(offender) : 'unknown element',
    };
  });

  expect(
    overflow,
    overflow
      ? `document is ${overflow.scrollWidth}px wide but the viewport is ${overflow.clientWidth}px ` +
          `(widest element: ${overflow.selector})`
      : undefined,
  ).toBeNull();
}
