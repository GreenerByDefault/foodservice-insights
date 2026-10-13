import { describe, expect, test } from 'vitest';
import {
  BUDGET_SHARE,
  connectionBudgetTotal,
  HOSTED_MAX_CONNECTIONS,
  SUPERUSER_RESERVED_CONNECTIONS,
} from './budget.ts';

describe('CONNECTION_BUDGET', () => {
  test('fits within its share of the connections our roles can reach', () => {
    expect(connectionBudgetTotal()).toBeLessThanOrEqual(
      BUDGET_SHARE * (HOSTED_MAX_CONNECTIONS - SUPERUSER_RESERVED_CONNECTIONS),
    );
  });
});
