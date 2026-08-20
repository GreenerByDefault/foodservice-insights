/** An `Emailer` that can be made to genuinely fail and genuinely recover on the same handle.
 *
 * `unreachableEmailer` covers email that never worked. This covers email that worked, broke, and
 * came back.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { UNREACHABLE_LOCALHOST_URL } from '@gbd/core/testing';
import type { Breakable } from '@gbd/db/testing';
import type { Emailer, EmailTransport, RenderedEmail } from '../client.ts';
import { initializeEmailer } from '../client.ts';
import { mailpitTransport } from '../transports/mailpit.ts';
import { TEST_EMAILER_CONFIG } from './recording.ts';

export type { Breakable } from '@gbd/db/testing';

/** Short, because a test that breaks email is waiting on this timeout to prove the failure. */
const FAST_TIMEOUT_MS = 1_000;

export function breakableEmailer(): Breakable<Emailer> {
  loadLocalEnv();

  const reachable = mailpitTransport({
    endpoint: requireEnv('EMAIL_ENDPOINT'),
    testTimeoutOverrideMs: FAST_TIMEOUT_MS,
  });
  const unreachable = mailpitTransport({
    endpoint: UNREACHABLE_LOCALHOST_URL,
    testTimeoutOverrideMs: FAST_TIMEOUT_MS,
  });

  let broken = false;
  const transport: EmailTransport = {
    name: 'breakable-mailpit',
    send: (email: RenderedEmail) => (broken ? unreachable : reachable).send(email),
  };

  return {
    service: initializeEmailer({ transport, ...TEST_EMAILER_CONFIG }),
    break() {
      broken = true;
    },
    restore() {
      broken = false;
    },
    close() {
      // Nothing to release: `fetch` holds no pool this handle owns.
      return Promise.resolve();
    },
  };
}
