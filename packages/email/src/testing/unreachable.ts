import { UNREACHABLE_LOCALHOST_URL } from '@gbd/core/testing';
import type { Emailer } from '../client.ts';
import { initializeEmailer } from '../client.ts';
import { mailpitTransport } from '../transports/mailpit.ts';
import { TEST_EMAILER_CONFIG } from './recording.ts';

/** An `Emailer` aimed at a port nothing listens on, so every send fails fast with a real
 * `EmailError` out of `fetch` — for tests that need email to genuinely be down, not a mock.
 */
export function unreachableEmailer(): Emailer {
  return initializeEmailer({
    transport: mailpitTransport({
      endpoint: UNREACHABLE_LOCALHOST_URL,
      testTimeoutOverrideMs: 1_000,
    }),
    ...TEST_EMAILER_CONFIG,
  });
}
