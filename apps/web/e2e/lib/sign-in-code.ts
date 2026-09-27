import { waitForEmail } from '@gbd/email/testing';

/** The code in the newest sign-in email sent to `address`.
 *
 * Anchored on the copy of `supabase-dev/supabase/templates/sign-in-code.html`, the template both
 * stacks point `magic_link` at, rather than on the first run of digits: a year in a footer would
 * otherwise do. GoTrue sends that template as HTML alone, so there is no text part to read.
 */
export async function waitForSignInCode(address: string): Promise<string> {
  const email = await waitForEmail(address);
  const text = email.html.replaceAll(/<[^>]+>/g, ' ');
  const code = /Enter this code to sign in[^:]*:\s*(\d+)/.exec(text)?.[1];
  if (code === undefined) {
    throw new Error(`The email to ${address} carries no sign-in code:\n${email.html}`);
  }
  return code;
}
