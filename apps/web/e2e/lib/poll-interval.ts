/** The app's own poll cadence, for tests to drive Playwright's fake clock through
 * (`@gbd/browser-testing`'s `advancePoll`/`advanceThroughPollFailures`). A UI polling cadence
 * doesn't belong in a shared package, so each suite keeps its own copy of this constant —
 * `tests/e2e` cannot reach across the package boundary to reuse this one.
 */
export { BASE_POLL_INTERVAL_MS as REPORT_POLL_INTERVAL_MS } from '../../src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/polling/schedule.ts';
