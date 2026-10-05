import { vi } from 'vitest';

/** Mocks `svelte-sonner`, so a test can assert on the toast a component raises. Import this
 * module in place of the package:
 * `vi.mock('svelte-sonner', () => import('$lib/testing/toast'))`. */
export const toast = {
  success: vi.fn(),
  error: vi.fn(),
};

export function resetToastMocks() {
  toast.success.mockClear();
  toast.error.mockClear();
}
