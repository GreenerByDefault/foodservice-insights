import { describe, expect, test } from 'vitest';
import { emailRequest, isEmailError } from './errors.ts';

describe('emailRequest', () => {
  test('relabels a rejection as an EmailError, keeping the original as cause', async () => {
    const original = new Error('socket hang up');

    const thrown = await emailRequest('Send', () => Promise.reject(original)).catch(
      (error: unknown) => error,
    );

    expect(isEmailError(thrown)).toBe(true);
    expect((thrown as Error).message).toBe('Send failed');
    expect((thrown as Error).cause).toBe(original);
  });

  test('resolves with the operation result when it succeeds', async () => {
    await expect(emailRequest('Send', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('isEmailError', () => {
  test('is false for a plain Error', () => {
    expect(isEmailError(new Error('nope'))).toBe(false);
  });
});
