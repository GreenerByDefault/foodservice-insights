import { join } from 'node:path';
import { findRepoRoot } from '@gbd/core/env';
import { describe, expect, test } from 'vitest';
import { resolvePythonBin } from './python-bin.ts';

describe('resolvePythonBin', () => {
  test('anchors a relative path to the repo root', () => {
    expect(resolvePythonBin('.venv/bin/python')).toBe(join(findRepoRoot(), '.venv/bin/python'));
  });

  test('leaves an absolute path untouched', () => {
    expect(resolvePythonBin('/opt/venv/bin/python')).toBe('/opt/venv/bin/python');
  });

  test('leaves undefined untouched, for resolveWorkerMode to reject', () => {
    expect(resolvePythonBin(undefined)).toBeUndefined();
  });
});
