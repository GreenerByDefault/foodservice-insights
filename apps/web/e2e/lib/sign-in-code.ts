import { waitForEmail } from '@gbd/email/testing';

/** The code in the newest sign-in email sent to `address`. */
export async function waitForSignInCode(address: string): Promise<string> {
  const email = await waitForEmail(address);
  // GoTrue sends `supabase-dev/supabase/templates/sign-in-code.html` as HTML alone, so there is
  // no text part to read.
  const text = email.html.replaceAll(/<[^>]+>/g, ' ');
  // Anchored on the template's own copy, rather than on the first run of digits: a year in a
  // footer would otherwise do.
  const code = /Enter this code to sign in[^:]*:\s*(\d+)/.exec(text)?.[1];
  if (code === undefined) {
    throw new Error(`The email to ${address} carries no sign-in code:\n${email.html}`);
  }
  return code;
}
