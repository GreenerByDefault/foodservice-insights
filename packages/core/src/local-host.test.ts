import { expect, test } from 'vitest';
import { isLocalHost } from './local-host.ts';

test.for(['localhost', '127.0.0.1', 'host.docker.internal'])('%s is local', (host) => {
  expect(isLocalHost(host)).toBe(true);
});

test.for(['abcdefghijklmnop.supabase.co', 'localhost.example.com', ''])(
  '%j is not local',
  (host) => {
    expect(isLocalHost(host)).toBe(false);
  },
);
