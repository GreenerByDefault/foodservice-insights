import { describe, expect, test } from 'vitest';
import { resolveTransport } from './index.ts';

describe('resolveTransport', () => {
  test('builds the mailpit transport', () => {
    expect(resolveTransport({ name: 'mailpit', endpoint: 'http://127.0.0.1:55324' })).toMatchObject(
      { name: 'mailpit' },
    );
  });

  test('names what it accepts when EMAIL_TRANSPORT is wrong', () => {
    expect(() => resolveTransport({ name: 'sendgrid' })).toThrow(/mailpit, provider/);
  });

  test('refuses mailpit without an endpoint, rather than failing at the first send', () => {
    expect(() => resolveTransport({ name: 'mailpit' })).toThrow(/EMAIL_ENDPOINT/);
  });
});
