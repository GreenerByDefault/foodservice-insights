/** **Stub:** the production transport, pending the provider decision.
 *
 * ARCHITECTURE.md § Stack still marks the provider **Open**. Everything above the `EmailTransport`
 * seam is written and tested against a stand-in transport, so choosing one means writing a `send`
 * here — a `fetch` with that provider's body shape — and pointing `EMAIL_TRANSPORT` at it. Every
 * candidate — Resend, Postmark, SendGrid, SES — offers a JSON API, which also leaves the provider's
 * MIME handling (`multipart/alternative`, encoded-words, header folding) to the provider rather
 * than to us.
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
            'or implement providerTransport once a provider is chosen — see ARCHITECTURE.md.',
        ),
      );
    },
  };
}
