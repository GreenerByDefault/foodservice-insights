/** vitest `globalSetup`. Brings the test database's schema up to date, and nothing else.
 *
 * Delegated to `@gbd/db` rather than repeated here, so that what "the schema is ready" means stays
 * defined in one place — including the reason it must not truncate, which
 * [its own global setup](../../../../packages/db/src/testing/global-setup.ts) explains.
 */

export { setup } from '@gbd/db/testing';
