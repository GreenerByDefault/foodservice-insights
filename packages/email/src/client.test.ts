import { describe, expect, test } from 'vitest';
import { initializeEmailer } from './client.ts';

const CONFIG = {
  transport: { name: 'noop', send: () => Promise.resolve() },
  from: { address: 'noreply@example.test', name: 'Foodservice Insights' },
  siteUrl: 'https://example.test',
  gbdAddress: 'gbd@example.test',
  supportAddress: 'support@example.test',
};

describe('initializeEmailer', () => {
  test('trims a trailing slash off siteUrl, so a path appended directly is always right', () => {
    const emailer = initializeEmailer({ ...CONFIG, siteUrl: 'https://example.test/' });
    expect(emailer.siteUrl).toBe('https://example.test');
  });

  test('trims more than one trailing slash', () => {
    const emailer = initializeEmailer({ ...CONFIG, siteUrl: 'https://example.test//' });
    expect(emailer.siteUrl).toBe('https://example.test');
  });

  test('leaves a siteUrl with no trailing slash alone', () => {
    const emailer = initializeEmailer(CONFIG);
    expect(emailer.siteUrl).toBe('https://example.test');
  });
});
