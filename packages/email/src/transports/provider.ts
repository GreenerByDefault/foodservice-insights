/** **Stub:** the production transport, until it sends through Postmark (ARCHITECTURE.md § Email).
 *
 * Everything above the `EmailTransport` seam is written and tested against a stand-in transport,
 * so wiring Postmark up means writing a `send` here — a `fetch` with its body shape — and pointing
 * `EMAIL_TRANSPORT` at it. Its JSON API also leaves MIME handling (`multipart/alternative`,
 * encoded-words, header folding) to Postmark rather than to us.
 */

import type { EmailTransport } from '../client.ts';
import { EmailError } from '../errors.ts';

export function providerTransport(): EmailTransport {
  return {
    name: 'provider',
    send(): Promise<void> {
      return Promise.reject(
        new EmailError(
          'No email provider is configured. Set EMAIL_TRANSPORT=mailpit for local development, ' +
            'or implement providerTransport for Postmark — see ARCHITECTURE.md § Email.',
        ),
      );
    },
  };
}
