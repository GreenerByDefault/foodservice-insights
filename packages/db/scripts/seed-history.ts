/** Replace the synthetic history: several months of organizations, users, reports and attempts,
 * so a dashboard has something to draw. Refuses any database that is not local.
 *
 *   pnpm seed:history
 *
 * Safe to re-run: it replaces the history rather than adding a second one.
 */

import { requireEnv } from '@gbd/core/env';
import { requireLocalConnectionString } from '../src/connection-string.ts';
import { DATABASE, shutdown } from '../src/env.ts';
import { replaceSyntheticHistory } from '../src/testing/history/replace.ts';

try {
  requireLocalConnectionString(requireEnv('DB_CONNECTION_STRING'));
  const { organizationIds, userIds } = await replaceSyntheticHistory(DATABASE);
  console.log(
    `seeded a synthetic history of ${organizationIds.length} organizations and ${userIds.length} users`,
  );
} finally {
  await shutdown();
}
