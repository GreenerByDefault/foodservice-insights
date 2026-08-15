/** **Stub:** the production transport, pending the provider decision.
 *
 * ARCHITECTURE.md § Stack still marks the provider **Open**. Everything above the `EmailTransport`
 * seam is written and tested against a stand-in transport, so choosing one means writing a `send`
 * here — a `fetch` with that provider's body shape — and pointing `EMAIL_TRANSPORT` at it.
 *
 * **The seam is HTTP-shaped on purpose.** One SMTP transport would cover every provider at once,
 * which is the tempting alternative, but it makes us responsible for MIME: `multipart/alternative`,
 * quoted-printable, RFC 2047 encoded-words for non-ASCII subjects and display names, header
 * folding. That is the part most likely to be subtly wrong, and it fails as an email that renders
 * badly in one client rather than as a red test. Over HTTP the provider does the MIME and a
 * transport is `fetch` plus JSON, with no dependency to add for a provider we have not chosen.
 * Every candidate — Resend, Postmark, SendGrid, SES — offers a JSON API.
 *
 * *Rejected: an SMTP transport, hand-rolled or via nodemailer.* If GBD ends up somewhere reachable
 * only by SMTP, this seam is what absorbs that, and nodemailer is the answer at that point rather
 * than hand-rolled protocol code.
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
