/** Rows to build a test on top of, so a test about one constraint does not spell out the four
 * parents that constraint's table requires.
 *
 * Every helper takes a `DatabaseExecutor` first, like every other query helper, and creates any
 * parent it was not given and any child the schema requires at `COMMIT`, so its default output
 * commits as-is. A helper that creates a required child takes a `null` override to skip it.
 *
 * Where a table's invariant is enforced by a trigger rather than a plain constraint, the helper
 * goes through that trigger instead of writing the row directly —
 * `insertAppUser` gets its `app_user` from the trigger on `auth.users`, and `insertOrganization`
 * relies on the deferred trigger that requires an admin. A fixture that still works is itself
 * evidence the schema behaves.
 *
 * Values that must be unique are randomised, because tests run concurrently against one database.
 */

export * from './analysis-attempt.ts';
export * from './analysis-attempt-telemetry.ts';
export * from './app-user.ts';
export * from './caches.ts';
export * from './organization.ts';
export * from './report.ts';
export * from './values.ts';
