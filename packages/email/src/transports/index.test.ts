import { describe, expect, test } from 'vitest';
import { parseTransportSettings, resolveTransport } from './index.ts';

describe('parseTransportSettings', () => {
  test('accepts mailpit with an endpoint', () => {
    expect(parseTransportSettings({ name: 'mailpit', endpoint: 'http://127.0.0.1:55324' })).toEqual(
      { name: 'mailpit', endpoint: 'http://127.0.0.1:55324' },
    );
  });

  test('accepts provider, which needs no endpoint', () => {
    expect(parseTransportSettings({ name: 'provider', endpoint: undefined })).toEqual({
      name: 'provider',
    });
  });

  test('names what it accepts when EMAIL_TRANSPORT is wrong', () => {
    expect(() => parseTransportSettings({ name: 'sendgrid', endpoint: undefined })).toThrow(
      /mailpit, provider/,
    );
  });

  test('refuses mailpit without an endpoint, rather than failing at the first send', () => {
    expect(() => parseTransportSettings({ name: 'mailpit', endpoint: undefined })).toThrow(
      /EMAIL_ENDPOINT/,
    );
  });
});

describe('resolveTransport', () => {
  test('builds the mailpit transport', () => {
    expect(resolveTransport({ name: 'mailpit', endpoint: 'http://127.0.0.1:55324' })).toMatchObject(
      { name: 'mailpit' },
    );
  });

  test('builds the provider transport', () => {
    expect(resolveTransport({ name: 'provider' })).toMatchObject({ name: 'provider' });
  });
});
