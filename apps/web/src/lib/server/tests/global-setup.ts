/** vitest `globalSetup` for the server test project.
 *
 * Migrating is shared with every other package that tests against the database, so the
 * implementation lives in `@gbd/db`. This file exists only to give `vite.config.ts` a path
 * inside this package to point at.
 */
export { setup } from '@gbd/db/testing';
