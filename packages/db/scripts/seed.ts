/** Create the phase-one placeholder identity. `TEST_DB=1` targets the test stack.
 *
 *   pnpm seed
 *   TEST_DB=1 pnpm seed
 *
 * Safe to re-run, and necessary after `pnpm truncate`.
 */

import { DATABASE, shutdown } from '../src/env.ts';
import { PLACEHOLDER_ORGANIZATION_NAME, seedPlaceholderIdentity } from '../src/seed.ts';

try {
  await seedPlaceholderIdentity(DATABASE);
  console.log(`seeded the placeholder user and "${PLACEHOLDER_ORGANIZATION_NAME}"`);
} finally {
  await shutdown();
}
