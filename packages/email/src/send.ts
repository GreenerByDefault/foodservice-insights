import type { Emailer } from './client.ts';
import type { EmailMessage } from './messages/index.ts';
import { render } from './messages/index.ts';

/** Send one email.
 *
 * Throws `EmailError` if the service could not be reached or refused the message.
 */
export async function sendEmail(emailer: Emailer, message: EmailMessage): Promise<void> {
  await emailer.transport.send(render(emailer, message));
}
