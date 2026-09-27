import type { Session } from '@supabase/supabase-js';
import { describe, expect, test, vi } from 'vitest';
import { refreshWhenRestoredByBack, sessionUserChanged } from './follow-session.ts';

function sessionFor(userId: string): Pick<Session, 'user'> {
  return { user: { id: userId } as Session['user'] };
}

describe('sessionUserChanged', () => {
  test('the user the page was rendered for is no change, however often auth-js confirms them', () => {
    expect(sessionUserChanged('ana', sessionFor('ana'))).toBe(false);
  });

  test('no session on a page rendered signed out is no change', () => {
    expect(sessionUserChanged(null, null)).toBe(false);
  });

  test('signing out is a change', () => {
    expect(sessionUserChanged('ana', null)).toBe(true);
  });

  test('signing in is a change', () => {
    expect(sessionUserChanged(null, sessionFor('ana'))).toBe(true);
  });

  test('a different user is a change', () => {
    expect(sessionUserChanged('ana', sessionFor('ben'))).toBe(true);
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
