/** Stands in for `$app/env` in a component test, where `version` is otherwise `undefined` because
 * no SvelteKit page ever started — so a poll response from `jsonFromThisDeploy` would read as
 * another deploy and reload the test's iframe. Import this module in place of `$app/env`:
 * `vi.mock('$app/env', () => import('#lib/testing/env.js'))`. */
export const browser = true;
export const building = false;
export const dev = true;
export const version = 'test-build';
