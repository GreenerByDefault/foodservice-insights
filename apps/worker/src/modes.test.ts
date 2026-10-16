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
    cacheDbConnectionString: undefined,
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
      cacheDatabase: { kind: 'worker', ignoredVariable: false },
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
      cacheDatabase: { kind: 'worker', ignoredVariable: false },
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
      cacheDatabase: { kind: 'worker', ignoredVariable: false },
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

  describe('CACHE_DB_CONNECTION_STRING', () => {
    const HOSTED =
      'postgresql://cache_client:s3cret@db.abc.supabase.co:5432/postgres' +
      '?sslmode=verify-full&sslrootcert=/repo/supabase-ca.crt';

    function cacheDatabase(settings: Parameters<typeof resolve>[0]) {
      const resolved = resolve(settings);
      if (resolved.mode === 'off') throw new Error('expected a spawning mode');
      return resolved.cacheDatabase;
    }

    test('live uses it, logged without the password or the query', () => {
      expect(cacheDatabase({ mode: 'live', cacheDbConnectionString: HOSTED })).toEqual({
        kind: 'separate',
        connectionString: HOSTED,
        redacted: 'cache_client@db.abc.supabase.co:5432/postgres',
      });
    });

    test('a string without a user is logged as the host and database', () => {
      const local = 'postgresql://127.0.0.1:55322/postgres';
      expect(cacheDatabase({ mode: 'live', cacheDbConnectionString: local })).toEqual({
        kind: 'separate',
        connectionString: local,
        redacted: '127.0.0.1:55322/postgres',
      });
    });

    test('live refuses an unparseable string without echoing it', () => {
      expect(() =>
        resolve({ mode: 'live', cacheDbConnectionString: 'cache_client:s3cret@nowhere' }),
      ).toThrow(
        expect.objectContaining({
          message: 'CACHE_DB_CONNECTION_STRING is not a valid postgresql:// URL.',
        }),
      );
    });

    test.each(['', undefined])('live with %j uses the worker database', (value) => {
      expect(cacheDatabase({ mode: 'live', cacheDbConnectionString: value })).toEqual({
        kind: 'worker',
        ignoredVariable: false,
      });
    });

    test.each(['stubbed', 'mock-llm'] as const)('%s ignores it', (mode) => {
      expect(cacheDatabase({ mode, cacheDbConnectionString: HOSTED })).toEqual({
        kind: 'worker',
        ignoredVariable: true,
      });
    });

    test('off ignores it silently', () => {
      expect(resolve({ mode: 'off', cacheDbConnectionString: HOSTED })).toEqual({ mode: 'off' });
    });
  });

  test('an unknown mode names the valid ones back', () => {
    expect(() => resolve({ mode: 'fast' })).toThrow(
      "Unknown WORKER_MODE 'fast'. Expected one of: stubbed, mock-llm, live, off.",
    );
  });
});
