import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { jsonResponse } from '#lib/testing/fetch.js';
import { jsonFromThisDeploy, reloadIfOtherDeploy } from './deploy-version.ts';

const reload = vi.fn();

beforeEach(() => {
  reload.mockClear();
  vi.stubGlobal('location', { reload });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Whether `promise` has settled once every pending callback has run. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

describe('jsonFromThisDeploy', () => {
  test('sends the data as JSON', async () => {
    const response = jsonFromThisDeploy({ reports: [] });

    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ reports: [] });
  });
});

describe('reloadIfOtherDeploy', () => {
  test('resolves without reloading for a response from this deploy', async () => {
    await reloadIfOtherDeploy(jsonFromThisDeploy({}));

    expect(reload).not.toHaveBeenCalled();
  });

  test('reloads, and never settles, for a response from another deploy', async () => {
    const response = jsonFromThisDeploy({});
    response.headers.set('X-Deploy-Version', 'another-build');

    expect(await hasSettled(reloadIfOtherDeploy(response))).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('treats a response naming no deploy as another one', async () => {
    expect(await hasSettled(reloadIfOtherDeploy(jsonResponse({})))).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
