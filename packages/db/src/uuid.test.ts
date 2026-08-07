import { describe, expect, test } from 'vitest';
import { uuidV7, uuidV7Timestamp } from './uuid.ts';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV7', () => {
  test('has the version and variant fields RFC 9562 requires', () => {
    // The pattern pins both: `7` opens the third group, and the fourth starts with 0b10xx.
    expect(uuidV7()).toMatch(UUID_V7_PATTERN);
  });

  test('embeds the current time', () => {
    const before = Date.now();
    const embedded = uuidV7Timestamp(uuidV7());

    expect(embedded).toBeGreaterThanOrEqual(before);
    expect(embedded).toBeLessThanOrEqual(Date.now());
  });

  test('sorts in creation order', async () => {
    const earlier = uuidV7();
    // A millisecond is the resolution of the timestamp field, so anything less could tie.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const later = uuidV7();

    expect(earlier < later).toBe(true);
  });

  test('does not repeat', () => {
    const ids = new Set(Array.from({ length: 10_000 }, uuidV7));

    expect(ids.size).toBe(10_000);
  });
});
