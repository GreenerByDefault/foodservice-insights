export const FIELD = {
  email: 'email',
  code: 'code',
} as const;

export const OTP_LENGTH = 6;

/** How long the code step makes a visitor wait before it will send another code. */
export const RESEND_COOLDOWN_S = 60;

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
