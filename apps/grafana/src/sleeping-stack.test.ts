import { describe, expect, test } from 'vitest';
import { isSleepingStack } from './sleeping-stack.ts';

const SLEEPING_BODY =
  '{"code":"Loading","message":"Click on the checkbox to continue loading your instance"}';

describe('isSleepingStack', () => {
  test('recognizes the sleeping response', () => {
    expect(isSleepingStack(503, SLEEPING_BODY)).toBe(true);
  });

  test('rejects an ordinary 503', () => {
    expect(isSleepingStack(503, 'Service Unavailable')).toBe(false);
  });

  test('rejects a 503 with another code', () => {
    expect(isSleepingStack(503, '{"code":"Unavailable"}')).toBe(false);
  });

  test('rejects the sleeping body under another status', () => {
    expect(isSleepingStack(200, SLEEPING_BODY)).toBe(false);
  });
});
