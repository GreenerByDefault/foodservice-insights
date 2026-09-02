/** The viewports every screenshot is captured at.
 *
 * Whole devices rather than bare widths, because the app shell is `min-h-svh`: the viewport
 * height sets the minimum height of a `fullPage` capture. `tablet` and `desktop` are one iPad,
 * rotated.
 *
 * `desktop` is 1024 rather than a typical monitor width because the shell is `max-w-4xl` (896px)
 * with `p-8`, so content caps at 832px — every viewport at or above 896 renders *identical*
 * content, and a wider one only adds empty gutter. 1024 is the narrowest width at which the
 * layout is fully realized.
 */
export const SCREENSHOT_VIEWPORTS = {
  desktop: { width: 1024, height: 768 },
  tablet: { width: 768, height: 1024 },
  // iPhone SE (2nd/3rd gen), and Playwright's own `devices['iPhone SE']` size — the narrowest
  // mainstream width, so a shot here is the worst case rather than the modal one.
  mobile: { width: 375, height: 667 },
} as const;
