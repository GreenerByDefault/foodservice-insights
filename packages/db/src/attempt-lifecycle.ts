/** The worker's timings that the web app's data alerts also judge `analysis_attempt` rows by
 * (`apps/web/src/routes/health/data/[check]/checks.ts`). The worker's `WORKER_DEFAULTS` reads them
 * from here, and `apps/worker/src/config.ts` says what each means and checks its relations. */

import { MINUTE_MS } from '@gbd/core';

/** `claimedCeilingMs`. */
export const CLAIMED_CEILING_MS = 30 * MINUTE_MS;

/** `reapIntervalMs`. */
export const REAP_INTERVAL_MS = MINUTE_MS;

/** `maxNotificationAttempts`. The index `analysis_attempt_notification_pending` hardcodes it, as
 * `tests/analysis-attempt.test.ts` asserts, so changing it takes a migration. */
export const MAX_NOTIFICATION_ATTEMPTS = 5;
