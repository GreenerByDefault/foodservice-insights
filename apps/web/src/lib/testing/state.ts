/** Mocks `$app/state`'s `page`, so a component that reads it doesn't need a real SvelteKit
 * navigation. Import this module in place of `$app/state`:
 * `vi.mock('$app/state', () => import('$lib/testing/state'))`. Set `page.url` (or whichever
 * field the test needs) before rendering — this isn't reactive, so a `$derived` that reads it
 * only sees the value as of mount. */
export const page = { url: new URL('http://localhost/') };

export function resetPageMock() {
  page.url = new URL('http://localhost/');
}
