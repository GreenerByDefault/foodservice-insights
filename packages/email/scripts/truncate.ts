/** Delete every message in the local mailbox. `TEST_DB=1` targets the test stack.
 *
 *   pnpm truncate
 *   TEST_DB=1 pnpm truncate
 */

import { clearMailbox } from '../src/testing/mailbox.ts';

await clearMailbox();
console.log('emptied the mailbox');
