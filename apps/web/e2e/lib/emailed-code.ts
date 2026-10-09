import { type MailboxMessage, readMailbox } from '@gbd/email/testing';

const TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;

/** Each code email's lead-in, from its template under `supabase-dev/supabase/templates/`.
 * Anchored on the template's own copy, rather than on the first run of digits: a year in a footer
 * would otherwise do. */
const LEAD_IN = {
  'sign-in': /Enter this code to sign in[^:]*:\s*(\d+)/,
  'email-change': /Enter this code to change your Foodservice Insights email[^:]*:\s*(\d+)/,
} as const;

/** The code in the newest sign-in email sent to `address`, waiting for one to arrive. Other mail
 * to the address, such as the invite that led here, is passed over. */
export async function waitForSignInCode(address: string): Promise<string> {
  return await waitForCode(address, 'sign-in');
}

/** The code in the newest email-change confirmation sent to `address`, the new one. */
export async function waitForEmailChangeCode(address: string): Promise<string> {
  return await waitForCode(address, 'email-change');
}

async function waitForCode(address: string, kind: keyof typeof LEAD_IN): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const messages = await readMailbox(address);
    const code = messages
      .map((message) => findCode(message, kind))
      .find((found) => found !== undefined);
    if (code !== undefined) return code;
    if (Date.now() >= deadline) {
      const received = messages.map((message) => message.html).join('\n\n');
      throw new Error(`No ${kind} code reached ${address} within ${TIMEOUT_MS}ms:\n${received}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function findCode(email: MailboxMessage, kind: keyof typeof LEAD_IN): string | undefined {
  // GoTrue sends our templates as HTML alone, so there is no text part to read.
  const text = email.html.replaceAll(/<[^>]+>/g, ' ');
  return LEAD_IN[kind].exec(text)?.[1];
}
