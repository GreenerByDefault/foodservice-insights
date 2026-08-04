/** Apply pending migrations. `TEST_DB=1` targets the test stack.
 *
 *   pnpm db:migrate
 *   TEST_DB=1 pnpm db:migrate
 */

import { DATABASE, shutdown } from '../src/env.ts';
import { migrateToLatest } from '../src/migrate.ts';

try {
  const applied = await migrateToLatest(DATABASE);
  if (applied.length === 0) console.log('no pending migrations');
} finally {
  await shutdown();
}
