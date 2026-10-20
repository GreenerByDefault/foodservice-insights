import { describe, expect, test } from 'vitest';
import { requireLocalEndpoint } from './endpoint.ts';

describe('requireLocalEndpoint', () => {
  test.for(['localhost', '127.0.0.1', 'host.docker.internal'])('accepts %s', (host) => {
    expect(() => requireLocalEndpoint(`http://${host}:54321/storage/v1/s3`)).not.toThrow();
  });

  test('refuses a hosted endpoint, naming its host', () => {
    expect(() =>
      requireLocalEndpoint('https://abcdefghijklmnop.supabase.co/storage/v1/s3'),
    ).toThrow('refusing abcdefghijklmnop.supabase.co: not a local blob store');
  });

  test('refuses a local host smuggled into the userinfo of a hosted one', () => {
    expect(() => requireLocalEndpoint('https://localhost@abcdefghijklmnop.supabase.co/s3')).toThrow(
      'refusing abcdefghijklmnop.supabase.co: not a local blob store',
    );
  });

  test('refuses a string that is not a URL', () => {
    expect(() => requireLocalEndpoint('localhost:54321')).toThrow(
      'refusing an unparseable host: not a local blob store',
    );
  });
});
