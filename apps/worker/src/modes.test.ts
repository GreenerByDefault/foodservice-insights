import { describe, expect, test } from 'vitest';
import { INVOCATION } from './contract/names.ts';
import { resolveWorkerMode } from './modes.ts';

describe('resolveWorkerMode', () => {
  test('off spawns nothing and needs no PYTHON_BIN', () => {
    expect(resolveWorkerMode({ mode: 'off', pythonBin: undefined })).toEqual({ mode: 'off' });
  });

  test('stubbed points at the dev-only entrypoint and a fast config profile', () => {
    const resolved = resolveWorkerMode({ mode: 'stubbed', pythonBin: '/repo/.venv/bin/python' });
    expect(resolved).toEqual({
      mode: 'stubbed',
      childCommand: {
        executable: '/repo/.venv/bin/python',
        leadingArguments: ['-m', 'worker_child.testing'],
      },
      overrides: {
        queuePollIntervalMs: 1_000,
        directIntervalMs: 1_000,
        killAfterNoProgressMs: 30_000,
        killAfterTotalRuntimeMs: 300_000,
        killGraceMs: 5_000,
        reapIntervalMs: 5_000,
        notifyIntervalMs: 5_000,
        claimedCeilingMs: 900_000,
      },
    });
  });

  test('live points at the real module with no overrides', () => {
    expect(resolveWorkerMode({ mode: 'live', pythonBin: '/repo/.venv/bin/python' })).toEqual({
      mode: 'live',
      childCommand: {
        executable: '/repo/.venv/bin/python',
        leadingArguments: ['-m', INVOCATION.module],
      },
      overrides: {},
    });
  });

  test('mock-llm fails at startup with a message naming what to use instead', () => {
    expect(() =>
      resolveWorkerMode({ mode: 'mock-llm', pythonBin: '/repo/.venv/bin/python' }),
    ).toThrow(/mock-llm is not available yet/);
  });

  test.each(['stubbed', 'live'] as const)('%s refuses a missing PYTHON_BIN', (mode) => {
    expect(() => resolveWorkerMode({ mode, pythonBin: undefined })).toThrow(/needs PYTHON_BIN/);
  });

  test('an unknown mode names the valid ones back', () => {
    expect(() => resolveWorkerMode({ mode: 'fast', pythonBin: undefined })).toThrow(
      "Unknown WORKER_MODE 'fast'. Expected one of: stubbed, mock-llm, live, off.",
    );
  });
});
