import { describe, expect, test } from 'vitest';
import { PENDING_CODE_TTL_MS, parsePendingCode } from './pending-code.ts';

const NOW = 1_800_000_000_000;

function stored(value: unknown): string {
  return JSON.stringify(value);
}

describe('parsePendingCode', () => {
  test('a code sent within its lifetime gives back its address', () => {
    const raw = stored({ email: 'ada@example.com', sentAt: NOW - PENDING_CODE_TTL_MS + 1 });
    expect(parsePendingCode(raw, NOW)).toBe('ada@example.com');
  });

  test('the address is normalized, as the email step would have sent it', () => {
    expect(parsePendingCode(stored({ email: ' Ada@Example.COM ', sentAt: NOW }), NOW)).toBe(
      'ada@example.com',
    );
  });

  test.for([
    ['nothing stored', null],
    ['malformed JSON', '{'],
    ['a JSON value that is not an object', 'null'],
    ['no address', stored({ sentAt: NOW })],
    ['an invalid address', stored({ email: 'not an address', sentAt: NOW })],
    ['no send time', stored({ email: 'ada@example.com' })],
    ['a send time that is not a number', stored({ email: 'ada@example.com', sentAt: '0' })],
    ['a send time in the future', stored({ email: 'ada@example.com', sentAt: NOW + 1 })],
    [
      'a code exactly at its lifetime',
      stored({ email: 'ada@example.com', sentAt: NOW - PENDING_CODE_TTL_MS }),
    ],
  ] as const)('gives null for %s', ([, raw]) => {
    expect(parsePendingCode(raw, NOW)).toBeNull();
  });
});
