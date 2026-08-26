import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS, WEEK_MS } from './time.ts';

describe('time constants', () => {
  it('each builds from the one below it', () => {
    expect(SECOND_MS).toBe(1_000);
    expect(MINUTE_MS).toBe(60 * SECOND_MS);
    expect(HOUR_MS).toBe(60 * MINUTE_MS);
    expect(DAY_MS).toBe(24 * HOUR_MS);
    expect(WEEK_MS).toBe(7 * DAY_MS);
  });
});
