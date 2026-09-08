import { vi } from 'vitest';

/** Mocks every `$app/navigation` export a test might call, so a component that starts calling
 * one it didn't before stops failing with `undefined is not a function`. Import this module in
 * place of `$app/navigation`:
 * `vi.mock('$app/navigation', () => import('$lib/testing/navigation'))`. */
export const goto = vi.fn();
export const invalidateAll = vi.fn();

export function resetNavigationMocks() {
  goto.mockClear();
  invalidateAll.mockClear();
}
