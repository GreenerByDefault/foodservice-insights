import type { Emailer } from './client.ts';
import type { EmailMessage } from './messages/index.ts';
import { render } from './messages/index.ts';

/** Send one email.
 *
 * Throws `EmailError` if the service could not be reached or refused the message. It is the
 * caller's business what that means: ARCHITECTURE.md makes email best effort, but *how* best effort
 * differs — a failed invite is worth telling the admin about, while a failed analysis notice is
 * not worth failing an attempt over. Deciding that here would take the choice away from both.
 */
export async function sendEmail(emailer: Emailer, message: EmailMessage): Promise<void> {
  await emailer.transport.send(render(emailer, message));
}
