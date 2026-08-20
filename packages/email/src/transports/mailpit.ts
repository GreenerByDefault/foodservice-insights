/** Mailpit, the mail catcher the Supabase CLI runs as `[local_smtp]`.
 *
 * Supabase Auth already delivers its sign-in codes here, so enabling it puts every email the system
 * sends — ours and GoTrue's — in one inbox.
 */

import { type EmailTransport, type RenderedEmail, SEND_TIMEOUT_MS } from '../client.ts';
import { emailRequest } from '../errors.ts';

export type MailpitConfig = {
  /** Mailpit's HTTP origin — `local_smtp.port`, not `smtp_port`. */
  endpoint: string;
  testTimeoutOverrideMs?: number;
};

export function mailpitTransport(config: MailpitConfig): EmailTransport {
  const origin = config.endpoint.replace(/\/+$/, '');
  const timeoutMs = config.testTimeoutOverrideMs ?? SEND_TIMEOUT_MS;

  return {
    name: 'mailpit',
    async send(email: RenderedEmail): Promise<void> {
      await emailRequest(`mailpit send to ${email.to}`, async () => {
        const response = await fetch(`${origin}/api/v1/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            From: { Email: email.from.address, Name: email.from.name },
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
