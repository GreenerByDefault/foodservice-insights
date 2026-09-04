import { expect, test } from 'vitest';
import { initials } from './initials.ts';

// `fromCharCode` rather than escapes so these don't sit as literal invisible bytes in the file.
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
const NUL = String.fromCharCode(0x0);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd800);

test('takes the first and last word initials', () => {
  expect(initials('Ana Ruiz')).toBe('AR');
});

test('takes the single initial for a one-word name', () => {
  expect(initials('Cher')).toBe('C');
});

test('ignores middle words', () => {
  expect(initials('María del Carmen García')).toBe('MG');
});

test('trims and collapses surrounding and repeated whitespace', () => {
  expect(initials('  Ana   Ruiz  ')).toBe('AR');
});

test('uppercases lowercase input', () => {
  expect(initials('ana ruiz')).toBe('AR');
});

test('handles a non-ASCII letter', () => {
  expect(initials('Émile Zola')).toBe('ÉZ');
});

test('does not split an astral-plane character in the first word', () => {
  expect(initials('𝕏 Corp')).toBe('𝕏C');
});

test.each([null, '', '   '])('returns null when there is nothing usable (%j)', (input) => {
  expect(initials(input)).toBeNull();
});

test('skips a leading bidi-override character rather than rendering it', () => {
  expect(initials(`${RIGHT_TO_LEFT_OVERRIDE}Ana Ruiz`)).toBe('AR');
});

test('skips a leading NUL byte rather than rendering it', () => {
  expect(initials(`${NUL}Ana`)).toBe('A');
});

test('falls back to the last word when the first is only control characters', () => {
  expect(initials(`${NUL}${NUL} Ruiz`)).toBe('R');
});

test('returns null when every word is only invisible characters', () => {
  // Not `\s`, so it survives as a "word"; long enough to prove the scan terminates.
  expect(initials(ZERO_WIDTH_SPACE.repeat(10_000))).toBeNull();
});

test('does not throw for a lone, malformed surrogate half', () => {
  expect(initials(`${LONE_HIGH_SURROGATE} Ruiz`)).toBe(`${LONE_HIGH_SURROGATE}R`);
});

test('resolves a very long single word without materializing it into an array', () => {
  expect(initials(`${'A'.repeat(50_000)} ${'B'.repeat(50_000)}`)).toBe('AB');
});
