import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { findRepoRoot, loadLocalEnv, optionalIntEnv, requireEnv } from './env.ts';

/** A throwaway repo root holding the given env files. */
function fakeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbd-env-'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

const originalCwd = process.cwd();
const touchedVars = ['ONLY_IN_ENV', 'ONLY_IN_TEST_ENV', 'PRESET', 'TEST_DB', 'COUNT'];

afterEach(() => {
  process.chdir(originalCwd);
  for (const name of touchedVars) delete process.env[name];
});

describe('findRepoRoot', () => {
  test('walks up to the workspace marker', () => {
    const root = fakeRepo({});
    expect(findRepoRoot(join(root, 'packages', 'thing', 'src'))).toBe(root);
  });

  test('throws rather than walking off the top of the filesystem', () => {
    expect(() => findRepoRoot('/')).toThrow(/pnpm-workspace\.yaml/);
  });
});

describe('loadLocalEnv', () => {
  test('loads .env by default and .env.test when TEST_DB is set', () => {
    process.chdir(
      fakeRepo({ '.env': 'ONLY_IN_ENV=dev\n', '.env.test': 'ONLY_IN_TEST_ENV=test\n' }),
    );

    loadLocalEnv();
    expect(process.env.ONLY_IN_ENV).toBe('dev');
    expect(process.env.ONLY_IN_TEST_ENV).toBeUndefined();

    process.env.TEST_DB = '1';
    loadLocalEnv();
    expect(process.env.ONLY_IN_TEST_ENV).toBe('test');
  });

  test('the real environment wins over the file', () => {
    process.chdir(fakeRepo({ '.env': 'PRESET=from_file\n' }));
    process.env.PRESET = 'from_environment';

    loadLocalEnv();

    expect(process.env.PRESET).toBe('from_environment');
  });

  test('a missing file is not an error', () => {
    process.chdir(fakeRepo({}));

    expect(() => loadLocalEnv()).not.toThrow();
  });
});

describe('requireEnv', () => {
  test('returns a value that is set', () => {
    process.env.PRESET = 'here';
    expect(requireEnv('PRESET')).toBe('here');
  });

  test('names the variable and where to put it', () => {
    expect(() => requireEnv('PRESET')).toThrow(/'PRESET'.*\.env\.test/s);
  });
});

describe('optionalIntEnv', () => {
  test('returns undefined when unset', () => {
    expect(optionalIntEnv('COUNT')).toBeUndefined();
  });

  test('parses a whole number', () => {
    process.env.COUNT = '3';
    expect(optionalIntEnv('COUNT')).toBe(3);
  });

  test('throws on a set-but-unparseable value, rather than returning NaN', () => {
    process.env.COUNT = 'not-a-number';
    expect(() => optionalIntEnv('COUNT')).toThrow(/COUNT.*whole number.*not-a-number/);
  });

  test('throws on a fractional value', () => {
    process.env.COUNT = '1.5';
    expect(() => optionalIntEnv('COUNT')).toThrow(/COUNT.*whole number.*1\.5/);
  });
});
