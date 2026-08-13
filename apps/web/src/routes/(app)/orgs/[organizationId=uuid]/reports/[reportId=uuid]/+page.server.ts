import type { PageServerLoad } from './$types';

/** **Stub:** loads nothing yet. It will return everything the result page shows, in one query: the
 * report, its `input_file`, its latest `analysis_attempt`, and that attempt's `result_file` rows.
 *
 * Filter on the report id *and* the organization from the route, so a report belonging to someone
 * else is a 404 rather than a leak.
 *
 * Return the attempt's timestamps raw and let the page derive the timeline from them, so the
 * loading view and the finished view come from one shape and one query.
 *
 * Still wrapped in `withDbErrorHandling`, but the query here catches `isTransientDatabaseError`
 * itself, inside the callback, rather than letting the wrapper's generic 503 fire. A poll is not
 * an analysis (see ARCHITECTURE.md § Client ↔ server), so a database that cannot be reached
 * returns `{ reachable: false }` next to the report instead of throwing — the page keeps the last
 * known state on screen and says it is reconnecting, rather than `+error.svelte` replacing the
 * timeline on every poll during an outage. A statement Postgres refused is a different failure —
 * our bug, not an outage — and still reaches the wrapper to become its normal 500.
 */
export const load: PageServerLoad = () => ({});
