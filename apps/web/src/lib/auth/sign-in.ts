/** What both steps of the sign-in form agree on, and the one piece of it worth testing without
 * rendering anything. */

export const FIELD = {
  email: 'email',
  code: 'code',
} as const;

/** GoTrue's `otp_length`, left at its default. */
export const OTP_LENGTH = 6;

/** How long the code step makes a visitor wait before it will send another code. Ours, not
 * GoTrue's — GoTrue rate-limits on its own and answers `over_email_send_rate_limit`; this only
 * keeps an impatient visitor from earning that answer. */
export const RESEND_COOLDOWN_S = 60;

/** What to show a visitor for an `AuthError`.
 *
 * Takes the error's `code` rather than the error, so this stays a pure mapping with nothing to
 * construct in a test. Supabase's own `message` is never rendered: it is written for whoever is
 * debugging the call, and for a wrong code it says "Token has expired or is invalid", which reads
 * as though the code we just sent were at fault.
 */
export function describeAuthError(error: { code?: string | null }): string {
  switch (error.code) {
    case 'otp_expired':
      return 'That code is wrong or has expired. Check the latest email, or send a new code.';
    case 'over_email_send_rate_limit':
      return 'Too many codes requested. Wait a minute, then try again.';
    default:
      return 'Something went wrong. Try again.';
  }
}
