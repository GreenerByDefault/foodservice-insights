import { describe, expect, test } from 'vitest';
import { ConfirmActionError } from '$lib/components/confirm-action.svelte';
import { confirmMemberWrite, LAST_ADMIN_MESSAGE } from './member-write.ts';

describe('confirmMemberWrite', () => {
  test('done returns without throwing', () => {
    expect(() => confirmMemberWrite({ kind: 'done' })).not.toThrow();
  });

  test('last-admin throws a ConfirmActionError with LAST_ADMIN_MESSAGE', () => {
    try {
      confirmMemberWrite({ kind: 'last-admin' });
      expect.fail('expected confirmMemberWrite to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfirmActionError);
      expect((error as Error).message).toBe(LAST_ADMIN_MESSAGE);
    }
  });

  test('unknown throws a plain Error, so the dialog falls back to its own errorMessage', () => {
    try {
      confirmMemberWrite({ kind: 'unknown' });
      expect.fail('expected confirmMemberWrite to throw');
    } catch (error) {
      expect(error).not.toBeInstanceOf(ConfirmActionError);
      expect(error).toBeInstanceOf(Error);
    }
  });
});
