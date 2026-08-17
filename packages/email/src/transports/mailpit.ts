/** Mailpit, the mail catcher the Supabase CLI runs as `[local_smtp]`.
 *
 * Supabase Auth already delivers its sign-in codes here, so enabling it puts every email the system
 * sends — ours and GoTrue's — in one inbox.
 */

import type { EmailTransport, RenderedEmail } from '../client.ts';
import { emailRequest } from '../errors.ts';
import { parseAddress } from './address.ts';

export type MailpitConfig = {
  /** Mailpit's HTTP origin — `local_smtp.port`, not `smtp_port`. */
  endpoint: string;
  /** How long one send may take. There are no retries: a caller that wants one wants a policy,
   * and only the caller knows whether this email is worth waiting for. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export function mailpitTransport(config: MailpitConfig): EmailTransport {
  const origin = config.endpoint.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: 'mailpit',
    async send(email: RenderedEmail): Promise<void> {
      await emailRequest(`mailpit send to ${email.to}`, async () => {
        const from = parseAddress(email.from);
        const response = await fetch(`${origin}/api/v1/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            From: { Email: from.address, Name: from.name },
            To: [{ Email: email.to }],
            Subject: email.subject,
            Text: email.text,
            HTML: email.html,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        // A 4xx is as much a failed send as a dropped socket, and `fetch` only rejects for the
        // latter, so the status has to be checked for the two to arrive as one kind of failure.
        if (!response.ok) {
          throw new Error(`mailpit answered ${response.status}: ${await response.text()}`);
        }
      });
    },
  };
}
