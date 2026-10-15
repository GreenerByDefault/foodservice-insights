import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import {
  BUDGET_SHARE,
  connectionBudgetTotal,
  HOSTED_MAX_CONNECTIONS,
  SUPERUSER_RESERVED_CONNECTIONS,
  WEB_INSTANCES,
  WORKER_INSTANCES,
} from './budget.ts';

describe('CONNECTION_BUDGET', () => {
  test('fits within its share of the connections our roles can reach', () => {
    expect(connectionBudgetTotal()).toBeLessThanOrEqual(
      BUDGET_SHARE * (HOSTED_MAX_CONNECTIONS - SUPERUSER_RESERVED_CONNECTIONS),
    );
  });
});

describe('WEB_INSTANCES and WORKER_INSTANCES', () => {
  async function specInstanceCounts(app: 'web' | 'worker'): Promise<unknown[]> {
    const spec = parse(
      await readFile(new URL(`../../../.do/${app}.yaml`, import.meta.url), 'utf8'),
    );
    return [...(spec.services ?? []), ...(spec.workers ?? [])].map(
      (component) => component.instance_count,
    );
  }

  test.each([
    ['web', WEB_INSTANCES],
    ['worker', WORKER_INSTANCES],
  ] as const)("match %s's App Platform spec", async (app, budgeted) => {
    expect(await specInstanceCounts(app)).toEqual([budgeted]);
  });
});
