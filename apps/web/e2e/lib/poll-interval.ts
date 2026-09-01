/** The app's own poll cadence, for tests to drive Playwright's fake clock through
 * (`@gbd/browser-testing`'s `advancePoll`/`advanceThroughPollFailures`).
 */
export { BASE_POLL_INTERVAL_MS as REPORT_POLL_INTERVAL_MS } from '../../src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/polling/schedule.ts';
