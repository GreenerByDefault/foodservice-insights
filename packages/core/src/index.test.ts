import { describe, expect, it } from 'vitest';
import { APP_NAME, assertNever, exhaustiveArray } from './index.ts';

describe('APP_NAME', () => {
  it('is the product name', () => {
    expect(APP_NAME).toBe('Foodservice Insights');
  });
});

describe('assertNever', () => {
  it('throws with the offending value', () => {
    expect(() => assertNever('unhandled' as never)).toThrow('Unexpected value: "unhandled"');
  });
});

describe('exhaustiveArray', () => {
  it('returns the array unchanged; the coverage check is at compile time', () => {
    expect(exhaustiveArray<'a' | 'b'>()(['a', 'b'])).toEqual(['a', 'b']);
  });

  // `tsc`, not vitest, is what checks these: `@ts-expect-error` itself fails to typecheck once
  // the line below it no longer errors, so `pnpm check` catches a regression here, not this test.
  it.skip('rejects a missing or an extra member', () => {
    // @ts-expect-error 'b' is missing
    exhaustiveArray<'a' | 'b'>()(['a']);
    // @ts-expect-error 'c' is not a member of 'a' | 'b'
    exhaustiveArray<'a' | 'b'>()(['a', 'b', 'c']);
  });
});
