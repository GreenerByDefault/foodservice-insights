import { describe, expect, it } from 'vitest';
import { APP_NAME, assertNever } from './index.ts';

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
