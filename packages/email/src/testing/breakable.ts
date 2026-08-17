/** An `Emailer` that can be made to genuinely fail and genuinely recover on the same handle.
 *
 * `unreachableEmailer` covers email that never worked. This covers email that worked, broke, and
 * came back.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import type { Breakable } from '@gbd/db/testing';
import type { Emailer, EmailTransport, RenderedEmail } from '../client.ts';
import { initializeEmailer } from '../client.ts';
import { mailpitTransport } from '../transports/mailpit.ts';

export type { Breakable } from '@gbd/db/testing';

/** Short, because a test that breaks email is waiting on this timeout to prove the failure. */
const FAST_TIMEOUT_MS = 1_000;

/** Port 1 is reserved and unused, so a connection to it is refused immediately rather than
 * hanging. */
const NOTHING_LISTENS_HERE = 'http://127.0.0.1:1';

export function breakableEmailer(): Breakable<Emailer> {
  loadLocalEnv();

  const reachable = mailpitTransport({
    endpoint: requireEnv('EMAIL_ENDPOINT'),
    timeoutMs: FAST_TIMEOUT_MS,
  });
  const unreachable = mailpitTransport({
    endpoint: NOTHING_LISTENS_HERE,
    timeoutMs: FAST_TIMEOUT_MS,
  });

  let broken = false;
  const transport: EmailTransport = {
    name: 'breakable-mailpit',
    send: (email: RenderedEmail) => (broken ? unreachable : reachable).send(email),
  };

  return {
    service: initializeEmailer({
      transport,
      from: 'Foodservice Insights <noreply@example.test>',
      siteUrl: 'https://example.test',
      gbdAddress: 'gbd@example.test',
      supportAddress: 'support@example.test',
    }),
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
