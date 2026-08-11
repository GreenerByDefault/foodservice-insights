/** vitest `globalSetup`. Brings the test database's schema up to date, and nothing else — in
 * particular it must not truncate, for the reason
 * [`@gbd/db`'s own global setup](../../../../packages/db/src/testing/global-setup.ts) gives.
 */

export { setup } from '@gbd/db/testing';
