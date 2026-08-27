/** Seed one report per screen state, in the placeholder organization, so there is something to
 * look at on the report page. `TEST_DB=1` targets the test stack.
 *
 *   pnpm seed:reports
 *   TEST_DB=1 pnpm seed:reports
 *
 * Re-runnable: clears what it wrote last time first. Reuses `e2e/fixtures/reports.ts` verbatim,
 * so the states a human walks through by hand are exactly the states the screenshots prove.
 */

import { DATABASE, shutdown } from '@gbd/db/env';
import {
  clearReportFixtures,
  insertReportFixture,
  type ReportState,
  reportUrl,
} from '../e2e/fixtures/reports.ts';

const STATES: readonly ReportState[] = [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'failed-later-attempt',
  'canceled',
];

try {
  await clearReportFixtures(DATABASE);
  for (const state of STATES) {
    const reportId = await insertReportFixture(DATABASE, state);
    console.log(`${state}: ${reportUrl(reportId)}`);
  }
} finally {
  await shutdown();
}
