import { describe, expect, test } from 'vitest';
import { INVOCATION } from './contract/names.ts';
import { type RawWorkerModeSettings, resolveWorkerMode } from './modes.ts';

const PYTHON_BIN = '/repo/.venv/bin/python';

/** Everything any mode needs, so each test names only the setting it is about. */
function resolve(settings: Partial<RawWorkerModeSettings> & Pick<RawWorkerModeSettings, 'mode'>) {
  return resolveWorkerMode({
    pythonBin: PYTHON_BIN,
    openAiApiKey: 'sk-test',
    platformShutdownGraceMs: 600_000,
    ...settings,
  });
}

describe('resolveWorkerMode', () => {
  test('off spawns nothing and needs no PYTHON_BIN', () => {
    expect(resolve({ mode: 'off', pythonBin: undefined })).toEqual({ mode: 'off' });
  });

  test('stubbed points at the dev-only entrypoint and a fast config profile', () => {
    const resolved = resolve({ mode: 'stubbed' });
    expect(resolved).toEqual({
      mode: 'stubbed',
      childCommand: {
        executable: PYTHON_BIN,
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
    expect(resolve({ mode: 'live' })).toEqual({
      mode: 'live',
      childCommand: {
        executable: PYTHON_BIN,
        leadingArguments: ['-m', INVOCATION.module],
      },
      overrides: {},
    });
  });

  test('mock-llm points at the offline-LLM entrypoint with no overrides', () => {
    expect(resolve({ mode: 'mock-llm' })).toEqual({
      mode: 'mock-llm',
      childCommand: {
        executable: PYTHON_BIN,
        leadingArguments: ['-m', 'worker_child.mock_llm'],
      },
      overrides: {},
    });
  });

  test.each(['stubbed', 'mock-llm', 'live'] as const)('%s refuses a missing PYTHON_BIN', (mode) => {
    expect(() => resolve({ mode, pythonBin: undefined })).toThrow(/needs PYTHON_BIN/);
  });

  describe('live', () => {
    test.each(['', undefined])('refuses OPENAI_API_KEY=%j', (openAiApiKey) => {
      expect(() => resolve({ mode: 'live', openAiApiKey })).toThrow(
        'WORKER_MODE=live needs OPENAI_API_KEY.',
      );
    });

    test('refuses a missing PLATFORM_SHUTDOWN_GRACE_MS', () => {
      expect(() => resolve({ mode: 'live', platformShutdownGraceMs: undefined })).toThrow(
        'WORKER_MODE=live needs PLATFORM_SHUTDOWN_GRACE_MS.',
      );
    });

    test('names every missing variable at once', () => {
      expect(() =>
        resolve({ mode: 'live', openAiApiKey: undefined, platformShutdownGraceMs: undefined }),
      ).toThrow('WORKER_MODE=live needs OPENAI_API_KEY and PLATFORM_SHUTDOWN_GRACE_MS.');
    });
  });

  test.each(['stubbed', 'mock-llm'] as const)(
    '%s needs neither OPENAI_API_KEY nor PLATFORM_SHUTDOWN_GRACE_MS',
    (mode) => {
      expect(
        resolve({ mode, openAiApiKey: undefined, platformShutdownGraceMs: undefined }),
      ).toEqual(resolve({ mode }));
    },
  );

  test('an unknown mode names the valid ones back', () => {
    expect(() => resolve({ mode: 'fast' })).toThrow(
      "Unknown WORKER_MODE 'fast'. Expected one of: stubbed, mock-llm, live, off.",
    );
  });
});
