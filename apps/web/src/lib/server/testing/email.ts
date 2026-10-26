import { unreachableEmailer } from '@gbd/email/testing';

/** A `vi.mock('#lib/server/email.js', ...)` factory aimed at a port nothing listens on, so a test
 * proves `notifyGbd`'s own catch rather than depending on whatever Mailpit happens to be doing
 * locally.
 *
 * Use as `vi.mock('#lib/server/email.js', (importOriginal) => mockUnreachableEmailer(importOriginal))`
 * — not a bare reference, which vi.mock's hoisting evaluates before this import is initialized. */
export async function mockUnreachableEmailer(
  importOriginal: () => Promise<typeof import('../email.ts')>,
): Promise<typeof import('../email.ts')> {
  const actual = await importOriginal();
  return { ...actual, emailer: () => unreachableEmailer() };
}
