import { describe, expect, test } from 'vitest';
import { describeAuthError } from './sign-in.ts';

describe('describeAuthError', () => {
  test.for([
    [
      'otp_expired',
      'That code is wrong or has expired. Check the latest email, or send a new code.',
    ],
    ['over_email_send_rate_limit', 'Too many codes requested. Wait a minute, then try again.'],
  ] as const)('maps %s to its own copy', ([code, message]) => {
    expect(describeAuthError({ code })).toBe(message);
  });

  test.for([
    ['a code we have no copy for', { code: 'unexpected_failure' }],
    ['an error carrying no code at all', {}],
    ['a null code, which is how supabase-js types it', { code: null }],
  ] as const)('falls back for %s', ([, error]) => {
    expect(describeAuthError(error)).toBe('Something went wrong. Try again.');
  });
});
