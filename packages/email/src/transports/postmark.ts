/** Postmark, the production provider (ARCHITECTURE.md § Email), through its HTTP API.
 *
 * Each choice below is set per request, so this is the file to edit to reverse one:
 *
 * 1. **Every send goes on the `outbound` stream.** Supabase Auth's sign-in codes go on `auth`,
 *    over SMTP, with a token scoped to that stream. Postmark keeps a suppression list per stream,
 *    so a user who marks a report email as spam can still get sign-in codes.
 * 2. **`Tag` is the email's `kind`**, so Postmark's activity can be filtered by it.
 * 3. **Open and link tracking are off, explicitly**, so a dashboard toggle cannot turn them back
 *    on. A tracking pixel and rewritten links cost deliverability, and a report link rewritten
 *    through Postmark's domain looks like phishing.
 * 4. **An error carries Postmark's `ErrorCode` but never its `Message`, and is labelled with the
 *    kind rather than the recipient.** The message for a suppressed recipient (422, `ErrorCode`
 *    406) names the address, and server code logs ids, never emails. 406 is not special-cased:
 *    the notification sweep spends its remaining attempts on it, which is bounded.
 * 5. **No idempotency key**, because Postmark has none. Result notifications already accept the
 *    occasional duplicate.
 */

import {
  type Address,
  type EmailTransport,
  type RenderedEmail,
  SEND_TIMEOUT_MS,
} from '../client.ts';
import { emailRequest } from '../errors.ts';

const POSTMARK_ORIGIN = 'https://api.postmarkapp.com';

export type PostmarkConfig = {
  /** The Server API token, which can send as any address on the verified domain. */
  serverToken: string;
  testOriginOverride?: string;
  testTimeoutOverrideMs?: number;
};

export function postmarkTransport(config: PostmarkConfig): EmailTransport {
  const origin = config.testOriginOverride ?? POSTMARK_ORIGIN;
  const timeoutMs = config.testTimeoutOverrideMs ?? SEND_TIMEOUT_MS;

  return {
    name: 'postmark',
    async send(email: RenderedEmail): Promise<void> {
      await emailRequest(`postmark send of ${email.kind}`, async () => {
        const response = await fetch(`${origin}/email`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-postmark-server-token': config.serverToken,
          },
          body: JSON.stringify({
            From: formatAddress(email.from),
            To: email.to,
            Subject: email.subject,
            TextBody: email.text,
            HtmlBody: email.html,
            MessageStream: 'outbound',
            Tag: email.kind,
            TrackOpens: false,
            TrackLinks: 'None',
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          throw new Error(
            `postmark answered ${response.status} with ErrorCode ${await errorCode(response)}`,
          );
        }
      });
    },
  };
}

/** `"Name" <address>`. Quoted, so a comma or other special character in the name cannot split
 * the header into two addresses. */
function formatAddress(from: Address): string {
  const name = from.name.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${name}" <${from.address}>`;
}

/** Postmark's numeric `ErrorCode`, or `unknown` when the body is not Postmark's JSON — a proxy's
 * error page, say. */
async function errorCode(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const code =
    typeof body === 'object' && body !== null && 'ErrorCode' in body ? body.ErrorCode : undefined;
  return typeof code === 'number' ? String(code) : 'unknown';
}
