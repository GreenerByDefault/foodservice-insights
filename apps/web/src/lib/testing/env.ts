/** Mocks `$app/env`, whose `version` is `undefined` in a component test because no SvelteKit app
 * ever started — enough to make a poll response look like it came from another deploy. Import this
 * module in place of `$app/env`: `vi.mock('$app/env', () => import('#lib/testing/env.js'))`. */
export const browser = true;
export const building = false;
export const dev = true;
export const version = 'test-build';
