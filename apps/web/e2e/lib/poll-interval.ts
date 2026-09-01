/** The app's own poll cadence, for tests to drive Playwright's fake clock through
 * (`@gbd/browser-testing`'s `advancePoll`/`advanceThroughPollFailures`).
 *
 * Resolved the same way the server resolves it for a real page load, from the `WORKER_MODE` the
 * webServer process was started with (`playwright.config.ts`'s `webServer.env`, ultimately
 * `.env.test`).
 */
import { pollIntervalMsForWorkerMode } from '../../src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/polling/schedule.ts';

export const REPORT_POLL_INTERVAL_MS = pollIntervalMsForWorkerMode(process.env.WORKER_MODE);
