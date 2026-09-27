import { describe, expect, test } from 'vitest';
import { MAX_EMAIL_LENGTH } from '$lib/forms/validation';
import { _initialEmail } from './+page.server.ts';

describe('_initialEmail', () => {
  test('no parameter prefills nothing', () => {
    expect(_initialEmail(null)).toBeNull();
  });

  test('a valid address prefills as it is', () => {
    expect(_initialEmail('ada@example.com')).toBe('ada@example.com');
  });

  test('a mixed-case, padded address prefills normalized', () => {
    expect(_initialEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });

  test('an invalid address prefills nothing', () => {
    expect(_initialEmail('nope')).toBeNull();
    expect(_initialEmail('')).toBeNull();
  });

  describe('at the length limit', () => {
    // Every label within DNS's 63 characters, so length is the only thing that can fail it.
    function addressOfLength(length: number): string {
      const fixed = `${'a'.repeat(64)}@.${'c'.repeat(60)}.${'d'.repeat(60)}.test`;
      const first = 'b'.repeat(length - fixed.length);
      return `${'a'.repeat(64)}@${first}.${'c'.repeat(60)}.${'d'.repeat(60)}.test`;
    }

    test('an address exactly at it prefills', () => {
      const address = addressOfLength(MAX_EMAIL_LENGTH);
      expect(_initialEmail(address)).toBe(address);
    });

    test('an address one over prefills nothing', () => {
      expect(_initialEmail(addressOfLength(MAX_EMAIL_LENGTH + 1))).toBeNull();
    });
  });
});
