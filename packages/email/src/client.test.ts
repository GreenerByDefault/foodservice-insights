import { describe, expect, test } from 'vitest';
import { initializeEmailer } from './client.ts';

const CONFIG = {
  transport: { name: 'noop', send: () => Promise.resolve() },
  from: 'Foodservice Insights <noreply@example.test>',
  siteUrl: 'https://example.test',
  gbdAddress: 'gbd@example.test',
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
