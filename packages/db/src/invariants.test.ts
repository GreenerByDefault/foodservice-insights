import { describe, expect, test } from 'vitest';
import { requireConstraint } from './invariants.ts';

describe('requireConstraint', () => {
  test('returns a non-null value unchanged', () => {
    expect(requireConstraint('claimed', 'some_constraint')).toBe('claimed');
  });

  test('returns falsy-but-non-null values unchanged', () => {
    expect(requireConstraint(0, 'some_constraint')).toBe(0);
    expect(requireConstraint('', 'some_constraint')).toBe('');
  });

  test('throws naming the constraint when the value is null', () => {
    expect(() => requireConstraint(null, 'analysis_attempt_processing_is_claimed')).toThrow(
      'Expected analysis_attempt_processing_is_claimed to hold, but got null',
    );
  });
});
