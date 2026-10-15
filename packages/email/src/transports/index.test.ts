import { describe, expect, test } from 'vitest';
import { parseTransportSettings, resolveTransport } from './index.ts';

const UNSET = { endpoint: undefined, postmarkServerToken: undefined };

describe('parseTransportSettings', () => {
  test('accepts mailpit with an endpoint', () => {
    expect(
      parseTransportSettings({ ...UNSET, name: 'mailpit', endpoint: 'http://127.0.0.1:55324' }),
    ).toEqual({ name: 'mailpit', endpoint: 'http://127.0.0.1:55324' });
  });

  test('accepts postmark with a server token', () => {
    expect(
      parseTransportSettings({ ...UNSET, name: 'postmark', postmarkServerToken: 'a-token' }),
    ).toEqual({ name: 'postmark', serverToken: 'a-token' });
  });

  test('accepts provider, which needs no endpoint', () => {
    expect(parseTransportSettings({ ...UNSET, name: 'provider' })).toEqual({ name: 'provider' });
  });

  test('names what it accepts when EMAIL_TRANSPORT is wrong', () => {
    expect(() => parseTransportSettings({ ...UNSET, name: 'sendgrid' })).toThrow(
      /mailpit, postmark, provider/,
    );
  });

  test('refuses mailpit without an endpoint, rather than failing at the first send', () => {
    expect(() => parseTransportSettings({ ...UNSET, name: 'mailpit' })).toThrow(/EMAIL_ENDPOINT/);
  });

  test('refuses postmark without a server token, rather than failing at the first send', () => {
    expect(() => parseTransportSettings({ ...UNSET, name: 'postmark' })).toThrow(
      /POSTMARK_SERVER_TOKEN/,
    );
  });

  test('refuses postmark with an empty server token', () => {
    expect(() =>
      parseTransportSettings({ ...UNSET, name: 'postmark', postmarkServerToken: '' }),
    ).toThrow(/POSTMARK_SERVER_TOKEN/);
  });
});

describe('resolveTransport', () => {
  test('builds the mailpit transport', () => {
    expect(resolveTransport({ name: 'mailpit', endpoint: 'http://127.0.0.1:55324' })).toMatchObject(
      { name: 'mailpit' },
    );
  });

  test('builds the postmark transport', () => {
    expect(resolveTransport({ name: 'postmark', serverToken: 'a-token' })).toMatchObject({
      name: 'postmark',
    });
  });

  test('builds the provider transport', () => {
    expect(resolveTransport({ name: 'provider' })).toMatchObject({ name: 'provider' });
  });
});
