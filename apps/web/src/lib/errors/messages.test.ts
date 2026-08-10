import { describe, expect, test } from 'vitest';
import { describeError } from './messages.ts';

const HANDLED_STATUSES = [401, 403, 404, 500, 503];

describe('describeError', () => {
  test('says something different about each status it handles', () => {
    const titles = HANDLED_STATUSES.map((status) => describeError(status).title);

    expect(new Set(titles).size).toBe(HANDLED_STATUSES.length);
  });

  test.for([401, 403, 404])(
    'hides the status code on a %i, whose copy already explains it',
    (status) => {
      expect(describeError(status).showStatus).toBe(false);
    },
  );

  test.for([500, 502, 503, 429])(
    'shows the status code on a %i, so a user can quote it',
    (status) => {
      expect(describeError(status).showStatus).toBe(true);
    },
  );

  test('treats every 5xx but 503 as the same unexpected failure', () => {
    expect(describeError(502)).toEqual(describeError(500));
  });

  test('falls back to generic copy for a status with no copy of its own', () => {
    expect(describeError(429)).toEqual(describeError(400));
    expect(describeError(429).title).not.toBe(describeError(404).title);
  });
});
