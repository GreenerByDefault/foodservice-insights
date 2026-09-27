import type { AuthChangeEvent } from '@supabase/supabase-js';
import { describe, expect, test, vi } from 'vitest';
import { refreshWhenRestoredByBack, shouldInvalidate } from './follow-session.ts';

describe('shouldInvalidate', () => {
  test('skips the initial session', () => {
    expect(shouldInvalidate('INITIAL_SESSION')).toBe(false);
  });

  test.each<AuthChangeEvent>([
    'SIGNED_IN',
    'SIGNED_OUT',
    'TOKEN_REFRESHED',
    'USER_UPDATED',
    'PASSWORD_RECOVERY',
  ])('invalidates on %s', (event) => {
    expect(shouldInvalidate(event)).toBe(true);
  });
});

describe('refreshWhenRestoredByBack', () => {
  test('refreshes a page Back restored from a snapshot', () => {
    const refresh = vi.fn();

    refreshWhenRestoredByBack(refresh)({ persisted: true });

    expect(refresh).toHaveBeenCalledOnce();
  });

  test('leaves a page loaded afresh alone', () => {
    const refresh = vi.fn();

    refreshWhenRestoredByBack(refresh)({ persisted: false });

    expect(refresh).not.toHaveBeenCalled();
  });
});
