import { describe, expect, test } from 'vitest';
import { match } from './uuid.ts';

describe('the uuid route matcher', () => {
  test('accepts a UUID', () => {
    expect(match(crypto.randomUUID())).toBe(true);
  });

  test.for([
    ['a word', 'nonsense'],
    ['an empty string', ''],
    ['a UUID with a trailing character', `${crypto.randomUUID()}x`],
    ['a UUID missing its dashes', crypto.randomUUID().replaceAll('-', '')],
    // The shape Postgres would reject with 22P02 while still looking plausible.
    ['a UUID with a non-hex digit', '0000000g-0000-7000-8000-000000000001'],
  ])('rejects %s', ([, param]) => {
    expect(match(param as string)).toBe(false);
  });
});
