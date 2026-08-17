import type { Emailer } from '../client.ts';
import { initializeEmailer } from '../client.ts';
import { mailpitTransport } from '../transports/mailpit.ts';

/** An `Emailer` aimed at a port nothing listens on, so every send fails fast with a real
 * `EmailError` out of `fetch` — for tests that need email to genuinely be down, not a mock. P
 */
export function unreachableEmailer(): Emailer {
  return initializeEmailer({
    // Port 1 is reserved and unused, so the connection is refused immediately rather than hanging until the timeout.
    transport: mailpitTransport({ endpoint: 'http://127.0.0.1:1', timeoutMs: 1_000 }),
    from: 'Foodservice Insights <noreply@example.test>',
    siteUrl: 'https://example.test',
    gbdAddress: 'gbd@example.test',
    supportAddress: 'support@example.test',
  });
}
