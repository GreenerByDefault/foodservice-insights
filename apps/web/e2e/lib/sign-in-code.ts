import { type MailboxMessage, readMailbox } from '@gbd/email/testing';

const TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;

/** The code in the newest sign-in email sent to `address`, waiting for one to arrive. Other mail
 * to the address, such as the invite that led here, is passed over. */
export async function waitForSignInCode(address: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const messages = await readMailbox(address);
    const code = messages.map(signInCode).find((found) => found !== undefined);
    if (code !== undefined) return code;
    if (Date.now() >= deadline) {
      const received = messages.map((message) => message.html).join('\n\n');
      throw new Error(`No sign-in code reached ${address} within ${TIMEOUT_MS}ms:\n${received}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function signInCode(email: MailboxMessage): string | undefined {
  // GoTrue sends `supabase-dev/supabase/templates/sign-in-code.html` as HTML alone, so there is
  // no text part to read.
  const text = email.html.replaceAll(/<[^>]+>/g, ' ');
  // Anchored on the template's own copy, rather than on the first run of digits: a year in a
  // footer would otherwise do.
  return /Enter this code to sign in[^:]*:\s*(\d+)/.exec(text)?.[1];
}
