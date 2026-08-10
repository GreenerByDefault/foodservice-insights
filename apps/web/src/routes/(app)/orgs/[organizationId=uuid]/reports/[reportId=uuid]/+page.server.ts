import type { PageServerLoad } from './$types';

/** **Stub:** loads nothing yet. It will return everything the result page shows, in one query: the
 * report, its `input_file`, its latest `analysis_attempt`, and that attempt's `result_file` rows.
 *
 * Filter on the report id *and* the organization from the route, so a report belonging to someone
 * else is a 404 rather than a leak.
 *
 * Return the attempt's timestamps raw and let the page derive the timeline from them, so the
 * loading view and the finished view come from one shape and one query.
 */
export const load: PageServerLoad = () => ({});
